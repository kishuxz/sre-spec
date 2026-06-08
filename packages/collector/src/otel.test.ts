import { describe, expect, it } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor
} from "@opentelemetry/sdk-trace-base";
import sreAgentSpec from "../../examples/src/sre-agent-spec.js";
import { Collector, InMemoryStore } from "./index.js";
import { openTelemetryTraceAdapter } from "./otel.js";

function json(value: unknown): string {
  return JSON.stringify(value);
}

async function runInstrumentedAgent(): Promise<ReturnType<InMemorySpanExporter["getFinishedSpans"]>> {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)]
  });
  const tracer = provider.getTracer("checkpoint-hardening-agent");
  const runAttributes = {
    "checkpoint.run.id": "otel-run-good-0001",
    "checkpoint.agent": "sre-remediation-agent",
    "checkpoint.source": "simulation"
  };

  const triage = tracer.startSpan("triage", {
    attributes: {
      ...runAttributes,
      "checkpoint.step.id": "s1",
      "checkpoint.step.type": "llm_call",
      "checkpoint.step.name": "triage",
      "checkpoint.step.input": json({
        alert: "api latency p99 > 2s, replicas saturated"
      }),
      "checkpoint.step.output": json({
        plan: "scale deployment/api 3->5 in prod"
      }),
      "checkpoint.cost_usd": 0.004,
      "checkpoint.tokens_in": 1800,
      "checkpoint.tokens_out": 220
    }
  });
  triage.end();

  const environmentCheck = tracer.startSpan("environment_check", {
    attributes: {
      ...runAttributes,
      "checkpoint.step.id": "s2",
      "checkpoint.step.type": "tool_call",
      "checkpoint.step.name": "environment_check",
      "checkpoint.step.input": json({ context: "current-kubeconfig" }),
      "checkpoint.step.output": json({
        environment: "production",
        cluster: "prod-us-east-1"
      })
    }
  });
  environmentCheck.end();

  const approval = tracer.startSpan("approval.granted", {
    attributes: {
      ...runAttributes,
      "checkpoint.step.id": "s3",
      "checkpoint.step.type": "tool_call",
      "checkpoint.step.name": "approval.granted",
      "checkpoint.step.input": json({
        change: "scale deployment/api 3->5",
        environment: "production"
      }),
      "checkpoint.step.output": json({
        granted: true,
        token: "test-approval-token",
        approver: "local-test"
      })
    }
  });
  approval.end();

  const dryRun = tracer.startSpan("dry_run", {
    attributes: {
      ...runAttributes,
      "checkpoint.step.id": "s4",
      "checkpoint.step.type": "tool_call",
      "checkpoint.step.name": "dry_run",
      "checkpoint.step.input": json({
        target: "deployment/api",
        environment: "production"
      }),
      "checkpoint.step.output": json({ plan: "+2 replicas", willTouch: 1 }),
      "checkpoint.metadata.resourcesTouched": 0
    }
  });
  dryRun.end();

  const apply = tracer.startSpan("terraform.apply", {
    attributes: {
      ...runAttributes,
      "checkpoint.step.id": "s5",
      "checkpoint.step.type": "tool_call",
      "checkpoint.step.name": "terraform.apply",
      "checkpoint.step.input": json({
        target: "deployment/api",
        environment: "production"
      }),
      "checkpoint.step.output": json({ applied: true }),
      "checkpoint.metadata.resourcesTouched": 1
    }
  });
  apply.end();

  const healthCheck = tracer.startSpan("health_check", {
    attributes: {
      ...runAttributes,
      "checkpoint.step.id": "s6",
      "checkpoint.step.type": "tool_call",
      "checkpoint.step.name": "health_check",
      "checkpoint.step.input": json({ target: "deployment/api" }),
      "checkpoint.step.output": json({ healthy: true, p99Ms: 740 })
    }
  });
  healthCheck.end();

  await provider.forceFlush();
  const spans = exporter.getFinishedSpans();
  await provider.shutdown();

  return spans;
}

describe("OpenTelemetry trace ingestion", () => {
  it("ingests a real emitted OpenTelemetry trace through the collector", async () => {
    const spans = await runInstrumentedAgent();
    const store = new InMemoryStore();
    const collector = new Collector({
      spec: sreAgentSpec,
      store,
      traceAdapter: openTelemetryTraceAdapter
    });

    const verdict = await collector.ingestTrace(spans);

    expect(spans).toHaveLength(6);
    expect(verdict.passed).toBe(true);
    expect(verdict.runId).toBe("otel-run-good-0001");
    expect(store.runs.get("otel-run-good-0001")?.steps.map((step) => step.name)).toEqual([
      "triage",
      "environment_check",
      "approval.granted",
      "dry_run",
      "terraform.apply",
      "health_check"
    ]);
    expect(store.checks).toHaveLength(1);
    expect(store.driftEvents.size).toBe(0);
  });
});
