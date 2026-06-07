import { describe, expect, it } from "vitest";
import { defineSpec } from "@checkpoint/schema";
import {
  evaluate,
  loadRun,
  loadSpec,
  type CheckpointSpec,
  type Run
} from "./index.js";
import codingAgentSpec from "../../examples/src/coding-agent-spec.js";

const baseRun: Run = {
  id: "run-1",
  agent: "test-agent",
  source: "ci",
  startedAt: "2026-06-07T00:00:00.000Z",
  endedAt: "2026-06-07T00:00:10.000Z",
  steps: [
    {
      id: "step-1",
      type: "tool_call",
      name: "prepare",
      input: {},
      output: {},
      startedAt: "2026-06-07T00:00:00.000Z",
      endedAt: "2026-06-07T00:00:01.000Z",
      costUsd: 0.1,
      tokensIn: 10,
      tokensOut: 20
    },
    {
      id: "step-2",
      type: "tool_call",
      name: "commit",
      input: {},
      output: {},
      startedAt: "2026-06-07T00:00:02.000Z",
      endedAt: "2026-06-07T00:00:03.000Z",
      costUsd: 0.1,
      tokensIn: 10,
      tokensOut: 20,
      metadata: {
        resourcesTouched: ["file-a", "file-b"]
      }
    }
  ]
};

function spec(overrides: Partial<CheckpointSpec>): CheckpointSpec {
  return defineSpec<Run>({
    id: "test-spec",
    version: "1.0.0",
    agent: "test-agent",
    assertions: [],
    ...overrides
  });
}

describe("evaluate", () => {
  it("fails forbidden tool contract violations with offending step evidence", () => {
    const verdict = evaluate(
      baseRun,
      spec({
        tools: {
          forbidden: ["commit"]
        }
      })
    );

    expect(verdict.passed).toBe(false);
    expect(verdict.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assertionId: "tool.forbidden.commit",
          status: "fail",
          severity: "blocking",
          message: expect.stringContaining("Forbidden tool")
        })
      ])
    );
    expect(verdict.results[0]?.evidence).toEqual(
      expect.objectContaining({
        step: expect.objectContaining({ id: "step-2" })
      })
    );
  });

  it("fails sequence rules when required steps are missing before the target", () => {
    const verdict = evaluate(
      baseRun,
      spec({
        sequence: [{ step: "commit", after: ["test"] }]
      })
    );

    expect(verdict.passed).toBe(false);
    expect(verdict.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assertionId: "sequence.commit",
          status: "fail",
          evidence: expect.objectContaining({
            step: expect.objectContaining({ id: "step-2" }),
            missing: "test"
          })
        })
      ])
    );
  });

  it("evaluates all configured budgets", () => {
    const verdict = evaluate(
      baseRun,
      spec({
        budget: {
          maxToolCalls: 1,
          maxTokens: 100,
          maxCostUsd: 1,
          maxDurationMs: 5000,
          maxResourcesTouched: 1
        }
      })
    );

    expect(verdict.passed).toBe(false);
    expect(verdict.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assertionId: "budget.maxToolCalls",
          status: "fail"
        }),
        expect.objectContaining({
          assertionId: "budget.maxResourcesTouched",
          status: "fail"
        }),
        expect.objectContaining({
          assertionId: "budget.maxTokens",
          status: "pass"
        })
      ])
    );
  });

  it("returns correct verdicts for the coding-agent good and bad fixtures", async () => {
    const goodRun = await loadRun(
      "packages/examples/traces/coding-agent/good.json"
    );
    const badRun = await loadRun(
      "packages/examples/traces/coding-agent/bad.json"
    );

    const goodVerdict = evaluate(goodRun, codingAgentSpec);
    const badVerdict = evaluate(badRun, codingAgentSpec);

    expect(goodVerdict.passed).toBe(true);
    expect(badVerdict.passed).toBe(false);
    expect(badVerdict.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assertionId: "sequence.merge",
          status: "fail",
          severity: "blocking",
          evidence: expect.objectContaining({
            step: expect.objectContaining({ id: "step-2" })
          })
        }),
        expect.objectContaining({
          assertionId: "tool.forbidden.git.force_push_main",
          status: "fail",
          severity: "blocking",
          evidence: expect.objectContaining({
            step: expect.objectContaining({ id: "step-3" })
          })
        }),
        expect.objectContaining({
          assertionId: "migration.has-down",
          status: "fail",
          severity: "blocking"
        })
      ])
    );
  });

  it("reports advisory-only coding-agent failures without failing the verdict", async () => {
    const advisoryRun = await loadRun(
      "packages/examples/traces/coding-agent/advisory.json"
    );

    const verdict = evaluate(advisoryRun, codingAgentSpec);

    expect(verdict.passed).toBe(true);
    expect(verdict.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assertionId: "review.recommended",
          status: "fail",
          severity: "advisory",
          message: "Code review is recommended before merging."
        })
      ])
    );
  });

  it("loads a real TypeScript spec module", async () => {
    const loadedSpec = await loadSpec(
      "packages/examples/src/coding-agent-spec.ts"
    );

    expect(loadedSpec.id).toBe("coding-agent.phase-0");
    expect(loadedSpec.agent).toBe("coding-agent");
  });

  it("loads a real trace JSON file", async () => {
    const run = await loadRun("packages/examples/traces/coding-agent/good.json");

    expect(run.id).toBe("coding-agent-good-001");
    expect(run.steps).toHaveLength(4);
  });
});
