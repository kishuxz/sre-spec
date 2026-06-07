import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import type { Assertion, Spec } from "@checkpoint/schema";

export type StepType = "llm_call" | "tool_call";

export interface Step {
  id: string;
  type: StepType;
  name: string;
  input: unknown;
  output: unknown;
  startedAt: string;
  endedAt: string;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  metadata?: Record<string, unknown>;
}

export interface Run {
  id: string;
  agent: string;
  source: "ci" | "production" | "simulation";
  steps: Step[];
  startedAt: string;
  endedAt: string;
  metadata?: Record<string, unknown>;
}

export type AssertionStatus = "pass" | "fail" | "skipped";

export interface AssertionResult {
  assertionId: string;
  status: AssertionStatus;
  severity: "blocking" | "advisory";
  message: string;
  evidence?: unknown;
}

export interface Verdict {
  runId: string;
  specId: string;
  specVersion: string;
  results: AssertionResult[];
  passed: boolean;
  evaluatedAt: string;
}

export interface DriftEvent {
  id: string;
  specId: string;
  specVersion: string;
  runId: string;
  failedAssertions: AssertionResult[];
  detectedAt: string;
}

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

export type CheckpointSpec = Spec<Run>;

export function evaluate(run: Run, spec: CheckpointSpec): Verdict {
  const deterministicResults: AssertionResult[] = [
    ...evaluateToolContract(run, spec),
    ...evaluateSequenceRules(run, spec),
    ...evaluateBudget(run, spec),
    ...evaluateAssertionGroup("precondition", run, spec.preconditions),
    ...evaluateAssertionGroup("postcondition", run, spec.postconditions),
    ...evaluateAssertionGroup("assertion", run, spec.assertions)
  ];

  const judgeAssertions = [
    ...(spec.preconditions ?? []),
    ...(spec.postconditions ?? []),
    ...(spec.assertions ?? [])
  ].filter((assertion) => assertion.judge);

  if (judgeAssertions.length > 0) {
    throw new Error("LLM judge execution is not implemented");
  }

  const passed = !deterministicResults.some(
    (result) => result.severity === "blocking" && result.status === "fail"
  );

  return {
    runId: run.id,
    specId: spec.id,
    specVersion: spec.version,
    results: deterministicResults,
    passed,
    evaluatedAt: new Date().toISOString()
  };
}

export function evaluateJudge(): never {
  throw new Error("LLM judge execution is not implemented");
}

function evaluateToolContract(
  run: Run,
  spec: CheckpointSpec
): AssertionResult[] {
  const results: AssertionResult[] = [];
  const toolSteps = run.steps.filter((step) => step.type === "tool_call");
  const forbidden = new Set(spec.tools?.forbidden ?? []);
  const allowed = spec.tools?.allowed
    ? new Set(spec.tools.allowed)
    : undefined;

  for (const step of toolSteps) {
    if (forbidden.has(step.name)) {
      results.push({
        assertionId: `tool.forbidden.${step.name}`,
        status: "fail",
        severity: "blocking",
        message: `Forbidden tool "${step.name}" was called.`,
        evidence: { step }
      });
    }

    if (allowed && !allowed.has(step.name)) {
      results.push({
        assertionId: `tool.allowed.${step.name}`,
        status: "fail",
        severity: "blocking",
        message: `Tool "${step.name}" is not in the allowed tool list.`,
        evidence: {
          step,
          allowed: Array.from(allowed)
        }
      });
    }
  }

  if (results.length === 0 && (forbidden.size > 0 || allowed)) {
    results.push({
      assertionId: "tool.contract",
      status: "pass",
      severity: "blocking",
      message: "All tool calls satisfied the tool contract.",
      evidence: {
        checkedToolCalls: toolSteps.map((step) => ({
          id: step.id,
          name: step.name
        }))
      }
    });
  }

  return results;
}

function evaluateSequenceRules(
  run: Run,
  spec: CheckpointSpec
): AssertionResult[] {
  const results: AssertionResult[] = [];

  for (const rule of spec.sequence ?? []) {
    const targetSteps = run.steps.filter((step) => step.name === rule.step);

    if (targetSteps.length === 0) {
      results.push({
        assertionId: `sequence.${rule.step}`,
        status: "skipped",
        severity: "blocking",
        message: `No "${rule.step}" step occurred, so the sequence rule was not applicable.`,
        evidence: { requiredBefore: rule.after }
      });
      continue;
    }

    for (const targetStep of targetSteps) {
      const priorSteps = run.steps.slice(0, run.steps.indexOf(targetStep));
      const matched = matchRequiredOrder(priorSteps, rule.after);

      if (matched.ok) {
        results.push({
          assertionId: `sequence.${rule.step}`,
          status: "pass",
          severity: "blocking",
          message:
            rule.message ??
            `"${rule.step}" was preceded by ${rule.after.join(", ")} in order.`,
          evidence: {
            step: targetStep,
            requiredBefore: rule.after,
            matchedSteps: matched.steps
          }
        });
      } else {
        results.push({
          assertionId: `sequence.${rule.step}`,
          status: "fail",
          severity: "blocking",
          message:
            rule.message ??
            `"${rule.step}" must be preceded by ${rule.after.join(", ")} in order.`,
          evidence: {
            step: targetStep,
            requiredBefore: rule.after,
            missing: matched.missing,
            priorSteps: priorSteps.map((step) => ({
              id: step.id,
              name: step.name
            }))
          }
        });
      }
    }
  }

  return results;
}

function evaluateBudget(run: Run, spec: CheckpointSpec): AssertionResult[] {
  if (!spec.budget) {
    return [];
  }

  const totals = {
    toolCalls: run.steps.filter((step) => step.type === "tool_call").length,
    tokens: run.steps.reduce(
      (sum, step) => sum + (step.tokensIn ?? 0) + (step.tokensOut ?? 0),
      0
    ),
    costUsd: run.steps.reduce((sum, step) => sum + (step.costUsd ?? 0), 0),
    durationMs: parseTimestamp(run.endedAt) - parseTimestamp(run.startedAt),
    resourcesTouched: countResourcesTouched(run)
  };

  const checks = [
    {
      id: "budget.maxToolCalls",
      label: "tool calls",
      actual: totals.toolCalls,
      limit: spec.budget.maxToolCalls
    },
    {
      id: "budget.maxTokens",
      label: "tokens",
      actual: totals.tokens,
      limit: spec.budget.maxTokens
    },
    {
      id: "budget.maxCostUsd",
      label: "cost USD",
      actual: totals.costUsd,
      limit: spec.budget.maxCostUsd
    },
    {
      id: "budget.maxDurationMs",
      label: "duration ms",
      actual: totals.durationMs,
      limit: spec.budget.maxDurationMs
    },
    {
      id: "budget.maxResourcesTouched",
      label: "resources touched",
      actual: totals.resourcesTouched,
      limit: spec.budget.maxResourcesTouched
    }
  ];

  return checks
    .filter((check): check is typeof check & { limit: number } => {
      return typeof check.limit === "number";
    })
    .map((check) => {
      const passed = check.actual <= check.limit;

      return {
        assertionId: check.id,
        status: passed ? "pass" : "fail",
        severity: "blocking",
        message: passed
          ? `Budget for ${check.label} passed: ${check.actual} <= ${check.limit}.`
          : `Budget for ${check.label} failed: ${check.actual} > ${check.limit}.`,
        evidence: {
          actual: check.actual,
          limit: check.limit,
          totals
        }
      };
    });
}

function evaluateAssertionGroup(
  group: string,
  run: Run,
  assertions: Assertion<Run>[] | undefined
): AssertionResult[] {
  return (assertions ?? []).map((assertion) => {
    const severity = assertion.severity ?? "blocking";

    try {
      const passed = assertion.check(run);

      return {
        assertionId: assertion.id,
        status: passed ? "pass" : "fail",
        severity,
        message:
          assertion.message ??
          `${group} "${assertion.id}" ${passed ? "passed" : "failed"}.`,
        evidence: {
          group,
          assertionId: assertion.id,
          runId: run.id
        }
      };
    } catch (error) {
      return {
        assertionId: assertion.id,
        status: "fail",
        severity,
        message: `${group} "${assertion.id}" threw during deterministic evaluation.`,
        evidence: {
          group,
          assertionId: assertion.id,
          error: error instanceof Error ? error.message : String(error)
        }
      };
    }
  });
}

function matchRequiredOrder(
  steps: Step[],
  requiredNames: string[]
):
  | { ok: true; steps: Array<{ id: string; name: string }> }
  | { ok: false; missing: string } {
  const matchedSteps: Array<{ id: string; name: string }> = [];
  let cursor = 0;

  for (const requiredName of requiredNames) {
    const matchIndex = steps.findIndex(
      (step, index) => index >= cursor && step.name === requiredName
    );

    if (matchIndex === -1) {
      return { ok: false, missing: requiredName };
    }

    const step = steps[matchIndex];
    if (!step) {
      return { ok: false, missing: requiredName };
    }

    matchedSteps.push({ id: step.id, name: step.name });
    cursor = matchIndex + 1;
  }

  return { ok: true, steps: matchedSteps };
}

function parseTimestamp(value: string): number {
  const parsed = Date.parse(value);

  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid ISO 8601 timestamp: ${value}`);
  }

  return parsed;
}

function countResourcesTouched(run: Run): number {
  return run.steps.reduce((sum, step) => {
    const value =
      step.metadata?.resourcesTouched ?? step.metadata?.resources_touched;

    if (typeof value === "number") {
      return sum + value;
    }

    if (Array.isArray(value)) {
      return sum + value.length;
    }

    return sum;
  }, 0);
}

export async function loadSpec(specPath: string): Promise<CheckpointSpec> {
  const absolutePath = path.resolve(specPath);
  const extension = path.extname(absolutePath);
  const module =
    extension === ".ts"
      ? await tsImport(absolutePath, import.meta.url)
      : await import(pathToFileURL(absolutePath).href);
  const candidate = module.default ?? module.spec;

  if (!candidate || typeof candidate !== "object") {
    throw new Error(
      `Spec module ${specPath} must export a default spec or named spec.`
    );
  }

  return candidate as CheckpointSpec;
}

export async function loadRun(runPath: string): Promise<Run> {
  const raw = await readFile(runPath, "utf8");
  return JSON.parse(raw) as Run;
}

