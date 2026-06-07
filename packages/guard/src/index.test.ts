import { describe, expect, it } from "vitest";
import type { Run, Verdict } from "@checkpoint/core";
import { defineSpec } from "@checkpoint/schema";
import {
  NOT_IMPLEMENTED_GUARD_MESSAGE,
  NotImplementedGuard,
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

describe("NotImplementedGuard", () => {
  it("throws the documented gated v3 message", async () => {
    const guard = new NotImplementedGuard();
    const req: GuardedActionRequest = {
      actionType: "terraform.apply",
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
      "terraform.apply": "terraform.rollback"
    } satisfies CompensatingActionRegistry;

    expect(decision.decision).toBe("commit");
    expect(registry["terraform.apply"]).toBe("terraform.rollback");
  });
});

