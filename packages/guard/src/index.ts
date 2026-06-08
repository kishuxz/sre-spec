/**
 * v3 guarded execution contract.
 *
 * Intended model: checkpoint -> verify -> commit. For actions that cannot be
 * held before commit, a registered compensating action is the fallback, following
 * the saga / compensating-transaction pattern.
 *
 * SpecGuard is the first narrow enforcement implementation for one registered
 * action type: terraform.apply. The actual side effect is always injected by the
 * caller; this package never shells out to Terraform and does not implement a
 * saga engine or workflow orchestrator.
 */
import { evaluate } from "@checkpoint/core";
import type { AssertionResult, Run, Verdict } from "@checkpoint/core";
import type { Spec } from "@checkpoint/schema";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface GuardedActionRequest {
  actionType: string;
  payload: unknown;
  run: Run;
}

export interface GuardDecision {
  decision: "commit" | "hold" | "compensate";
  verdict: Verdict;
  compensatingActionType?: string;
}

export interface Guard {
  evaluate(
    req: GuardedActionRequest,
    spec: Spec<Run>
  ): Promise<GuardDecision>;
}

export type CompensatingActionRegistry = Record<string, string>;

export interface GuardedActionRegistration {
  holdable: boolean;
  compensatingActionType?: string;
}

export type GuardedActionRegistry = Record<string, GuardedActionRegistration>;

export interface SpecGuardOptions {
  actions?: GuardedActionRegistry;
  fallbackGuard?: Guard;
}

export interface SpecGuardEvaluateOptions {
  holdable?: boolean;
}

export interface GuardedExecuteOptions<TResult> {
  req: GuardedActionRequest;
  spec: Spec<Run>;
  guard: Guard;
  execute: () => Promise<TResult>;
  holdable?: boolean;
  compensations?: CompensatingActionRegistry;
  runCompensation?: (actionType: string) => Promise<void>;
}

export interface TerraformExecutionResult {
  command: "terraform";
  workingDirectory: string;
  init: ProcessResult;
  apply: ProcessResult;
}

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type SpawnProcess = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
  }
) => ChildProcessWithoutNullStreams;

export interface SandboxedTerraformExecutorOptions {
  workingDirectory: string;
  terraformBin?: string;
  spawnProcess?: SpawnProcess;
}

export type GuardedExecutionResult<TResult = unknown> =
  | {
      committed: true;
      held?: false;
      compensated?: false;
      verdict: Verdict;
      decision: GuardDecision;
      result: TResult;
    }
  | {
      committed: false;
      held: true;
      compensated?: false;
      verdict: Verdict;
      decision: GuardDecision;
      failures: AssertionResult[];
    }
  | {
      committed: false;
      held?: false;
      compensated: true;
      compensatingActionType: string;
      verdict: Verdict;
      decision: GuardDecision;
    };

export const NOT_IMPLEMENTED_GUARD_MESSAGE =
  "v3 guarded execution not implemented; gated behind v2 catching real drift";

export const TERRAFORM_APPLY_ACTION_TYPE = "terraform.apply";
export const TERRAFORM_APPLY_COMPENSATING_ACTION_TYPE = "terraform.plan_revert";

export const DEFAULT_COMPENSATIONS: CompensatingActionRegistry = {
  [TERRAFORM_APPLY_ACTION_TYPE]: TERRAFORM_APPLY_COMPENSATING_ACTION_TYPE
};

export const DEFAULT_GUARDED_ACTIONS: GuardedActionRegistry = {
  [TERRAFORM_APPLY_ACTION_TYPE]: {
    holdable: true,
    compensatingActionType: TERRAFORM_APPLY_COMPENSATING_ACTION_TYPE
  }
};

export class NotImplementedGuard implements Guard {
  async evaluate(
    req: GuardedActionRequest,
    spec: Spec<Run>
  ): Promise<GuardDecision> {
    void req;
    void spec;
    throw new Error(NOT_IMPLEMENTED_GUARD_MESSAGE);
  }
}

export class SpecGuard implements Guard {
  private readonly actions: GuardedActionRegistry;
  private readonly fallbackGuard: Guard;

  constructor(options: SpecGuardOptions = {}) {
    this.actions = options.actions ?? DEFAULT_GUARDED_ACTIONS;
    this.fallbackGuard = options.fallbackGuard ?? new NotImplementedGuard();
  }

  async evaluate(
    req: GuardedActionRequest,
    spec: Spec<Run>,
    options: SpecGuardEvaluateOptions = {}
  ): Promise<GuardDecision> {
    const registration = this.actions[req.actionType];

    if (!registration) {
      return this.fallbackGuard.evaluate(req, spec);
    }

    const verdict = evaluate(req.run, spec);

    if (verdict.passed) {
      return {
        decision: "commit",
        verdict
      };
    }

    const holdable = options.holdable ?? registration.holdable;

    if (holdable) {
      return {
        decision: "hold",
        verdict
      };
    }

    if (!registration.compensatingActionType) {
      return {
        decision: "hold",
        verdict
      };
    }

    return {
      decision: "compensate",
      verdict,
      compensatingActionType: registration.compensatingActionType
    };
  }
}

export async function guardedExecute<TResult>(
  options: GuardedExecuteOptions<TResult>
): Promise<GuardedExecutionResult<TResult>> {
  const decision =
    options.guard instanceof SpecGuard
      ? await options.guard.evaluate(
          options.req,
          options.spec,
          options.holdable === undefined ? {} : { holdable: options.holdable }
        )
      : await options.guard.evaluate(options.req, options.spec);

  if (decision.decision === "commit") {
    const result = await options.execute();

    return {
      committed: true,
      verdict: decision.verdict,
      decision,
      result
    };
  }

  if (decision.decision === "hold") {
    return {
      committed: false,
      held: true,
      verdict: decision.verdict,
      decision,
      failures: blockingFailures(decision.verdict)
    };
  }

  const compensatingActionType =
    decision.compensatingActionType ??
    options.compensations?.[options.req.actionType] ??
    DEFAULT_COMPENSATIONS[options.req.actionType];

  if (!compensatingActionType) {
    throw new Error(
      `No compensating action registered for ${options.req.actionType}`
    );
  }

  if (!options.runCompensation) {
    throw new Error(
      `No compensation runner provided for ${compensatingActionType}`
    );
  }

  await options.runCompensation(compensatingActionType);

  return {
    committed: false,
    compensated: true,
    compensatingActionType,
    verdict: decision.verdict,
    decision
  };
}

export function createSandboxedTerraformExecutor(
  options: SandboxedTerraformExecutorOptions
): () => Promise<TerraformExecutionResult> {
  const terraformBin = options.terraformBin ?? "terraform";
  const spawnProcess = options.spawnProcess ?? spawn;

  return async () => {
    const init = await runProcess(spawnProcess, terraformBin, ["init", "-input=false"], {
      cwd: options.workingDirectory,
      env: sandboxEnv()
    });
    const apply = await runProcess(
      spawnProcess,
      terraformBin,
      ["apply", "-auto-approve", "-input=false"],
      {
        cwd: options.workingDirectory,
        env: sandboxEnv()
      }
    );

    return {
      command: "terraform",
      workingDirectory: options.workingDirectory,
      init,
      apply
    };
  };
}

function blockingFailures(verdict: Verdict): AssertionResult[] {
  return verdict.results.filter(
    (result) => result.status === "fail" && result.severity === "blocking"
  );
}

function sandboxEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TF_IN_AUTOMATION: "1",
    CHECKPOINT_TERRAFORM_SANDBOX: "1"
  };
}

function runProcess(
  spawnProcess: SpawnProcess,
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
  }
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, options);
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = {
        code: code ?? 1,
        stdout,
        stderr
      };

      if (result.code !== 0) {
        reject(
          new Error(
            `${command} ${args.join(" ")} failed with exit ${result.code}\n${result.stderr}`
          )
        );
        return;
      }

      resolve(result);
    });
  });
}
