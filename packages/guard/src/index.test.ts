import { describe, expect, it, vi } from "vitest";
import { loadRun, type Run, type Verdict } from "@checkpoint/core";
import { defineSpec } from "@checkpoint/schema";
import sreAgentSpec from "../../examples/src/sre-agent-spec.js";
import {
  NOT_IMPLEMENTED_GUARD_MESSAGE,
  NotImplementedGuard,
  SpecGuard,
  TERRAFORM_APPLY_ACTION_TYPE,
  TERRAFORM_APPLY_COMPENSATING_ACTION_TYPE,
  guardedExecute,
  type CompensatingActionRegistry,
  type GuardDecision,
  type GuardedActionRequest
} from "./index.js";

const run: Run = {
  id: "run-guard-1",
  agent: "guard-test-agent",
  source: "simulation",
  startedAt: "2026-06-07T00:00:00.000Z",
  endedAt: "2026-06-07T00:00:01.000Z",
  steps: []
};

const verdict: Verdict = {
  runId: run.id,
  specId: "guard-test-spec",
  specVersion: "1.0.0",
  results: [],
  passed: true,
  evaluatedAt: "2026-06-07T00:00:01.000Z"
};

async function loadSreRun(name: "good" | "bad"): Promise<Run> {
  return loadRun(`packages/examples/traces/sre-agent/${name}.json`);
}

function reqFor(runForRequest: Run): GuardedActionRequest {
  return {
    actionType: TERRAFORM_APPLY_ACTION_TYPE,
    payload: { target: "deployment/api" },
    run: runForRequest
  };
}

describe("NotImplementedGuard", () => {
  it("throws the documented gated v3 message", async () => {
    const guard = new NotImplementedGuard();
    const req: GuardedActionRequest = {
      actionType: TERRAFORM_APPLY_ACTION_TYPE,
      payload: { target: "deployment/api" },
      run
    };
    const spec = defineSpec<Run>({
      id: "guard-test-spec",
      version: "1.0.0",
      agent: "guard-test-agent",
      assertions: []
    });

    await expect(guard.evaluate(req, spec)).rejects.toThrow(
      NOT_IMPLEMENTED_GUARD_MESSAGE
    );
  });

  it("exports guard decision and compensating registry types", () => {
    const decision = {
      decision: "commit",
      verdict
    } satisfies GuardDecision;
    const registry = {
      [TERRAFORM_APPLY_ACTION_TYPE]: TERRAFORM_APPLY_COMPENSATING_ACTION_TYPE
    } satisfies CompensatingActionRegistry;

    expect(decision.decision).toBe("commit");
    expect(registry[TERRAFORM_APPLY_ACTION_TYPE]).toBe(
      TERRAFORM_APPLY_COMPENSATING_ACTION_TYPE
    );
  });
});

describe("SpecGuard", () => {
  it("commits a passing terraform.apply and calls the injected executor once", async () => {
    const guard = new SpecGuard();
    const execute = vi.fn<() => Promise<string>>().mockResolvedValue("applied");
    const compensation = vi.fn<(actionType: string) => Promise<void>>();

    const result = await guardedExecute({
      req: reqFor(await loadSreRun("good")),
      spec: sreAgentSpec,
      guard,
      execute,
      runCompensation: compensation
    });

    expect(result.decision.decision).toBe("commit");
    expect(result.committed).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(compensation).not.toHaveBeenCalled();
  });

  it("holds a failing holdable terraform.apply and never calls the executor", async () => {
    const guard = new SpecGuard();
    const execute = vi.fn<() => Promise<string>>().mockResolvedValue("applied");
    const compensation = vi.fn<(actionType: string) => Promise<void>>();

    const result = await guardedExecute({
      req: reqFor(await loadSreRun("bad")),
      spec: sreAgentSpec,
      guard,
      execute,
      holdable: true,
      runCompensation: compensation
    });

    expect(result.decision.decision).toBe("hold");
    expect(result.committed).toBe(false);
    expect(result.held).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(compensation).not.toHaveBeenCalled();

    if (!result.held) {
      throw new Error("Expected hold result");
    }

    expect(result.failures.map((failure) => failure.assertionId)).toEqual([
      "sequence.terraform.apply",
      "budget.maxResourcesTouched",
      "prod.requires-approval"
    ]);
  });

  it("compensates a failing non-holdable terraform.apply through the registered fallback", async () => {
    const guard = new SpecGuard();
    const execute = vi.fn<() => Promise<string>>().mockResolvedValue("applied");
    const compensation = vi.fn<(actionType: string) => Promise<void>>();

    const result = await guardedExecute({
      req: reqFor(await loadSreRun("bad")),
      spec: sreAgentSpec,
      guard,
      execute,
      holdable: false,
      compensations: {
        [TERRAFORM_APPLY_ACTION_TYPE]: TERRAFORM_APPLY_COMPENSATING_ACTION_TYPE
      },
      runCompensation: compensation
    });

    expect(result.decision.decision).toBe("compensate");
    expect(result.committed).toBe(false);
    expect(result.compensated).toBe(true);

    if (!result.compensated) {
      throw new Error("Expected compensate result");
    }

    expect(result.compensatingActionType).toBe(
      TERRAFORM_APPLY_COMPENSATING_ACTION_TYPE
    );
    expect(execute).not.toHaveBeenCalled();
    expect(compensation).toHaveBeenCalledOnce();
    expect(compensation).toHaveBeenCalledWith(
      TERRAFORM_APPLY_COMPENSATING_ACTION_TYPE
    );
  });

  it("keeps NotImplementedGuard fallback behavior for unregistered action types", async () => {
    const guard = new SpecGuard();
    const req: GuardedActionRequest = {
      actionType: "k8s.delete",
      payload: { target: "pod/api-1" },
      run: await loadSreRun("good")
    };

    await expect(guard.evaluate(req, sreAgentSpec)).rejects.toThrow(
      NOT_IMPLEMENTED_GUARD_MESSAGE
    );
  });

  it("keeps evaluate pure by never invoking execution or compensation callbacks", async () => {
    const guard = new SpecGuard();
    const execute = vi.fn<() => Promise<string>>().mockResolvedValue("applied");
    const compensation = vi.fn<(actionType: string) => Promise<void>>();

    const decision = await guard.evaluate(reqFor(await loadSreRun("bad")), sreAgentSpec);

    expect(decision.decision).toBe("hold");
    expect(execute).not.toHaveBeenCalled();
    expect(compensation).not.toHaveBeenCalled();
  });
});
