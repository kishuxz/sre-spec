import { afterEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { evaluate, loadRun, type DriftEvent, type Run } from "@checkpoint/core";
import sreAgentSpec from "../../examples/src/sre-agent-spec.js";
import {
  Collector,
  InMemoryStore,
  NoopSink,
  PostgresStore,
  WebhookSink,
  type AlertSink
} from "./index.js";

class RecordingSink implements AlertSink {
  readonly events: DriftEvent[] = [];

  async emit(event: DriftEvent): Promise<void> {
    this.events.push(event);
  }
}

async function loadSreRun(name: "good" | "bad"): Promise<Run> {
  return loadRun(`packages/examples/traces/sre-agent/${name}.json`);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Collector", () => {
  it("ingests the SRE good fixture without drift", async () => {
    const store = new InMemoryStore();
    const sink = new RecordingSink();
    const collector = new Collector({
      spec: sreAgentSpec,
      store,
      alertSink: sink
    });

    const verdict = await collector.ingest(await loadSreRun("good"));

    expect(verdict.passed).toBe(true);
    expect(store.checks).toHaveLength(1);
    expect(store.driftEvents.size).toBe(0);
    expect(store.failureCorpus).toHaveLength(0);
    expect(sink.events).toHaveLength(0);
  });

  it("ingests the SRE bad fixture with one drift event and one failure corpus entry", async () => {
    const store = new InMemoryStore();
    const sink = new RecordingSink();
    const collector = new Collector({
      spec: sreAgentSpec,
      store,
      alertSink: sink
    });

    const verdict = await collector.ingest(await loadSreRun("bad"));
    const event = sink.events[0];

    expect(verdict.passed).toBe(false);
    expect(store.checks).toHaveLength(1);
    expect(store.driftEvents.size).toBe(1);
    expect(store.failureCorpus).toHaveLength(1);
    expect(sink.events).toHaveLength(1);
    expect(event).toEqual(
      expect.objectContaining({
        specId: "sre-remediation-agent",
        specVersion: "0.1.0",
        runId: "run-sre-bad-0001"
      })
    );
    expect(event?.failedAssertions.map((result) => result.assertionId)).toEqual([
      "sequence.terraform.apply",
      "budget.maxResourcesTouched",
      "prod.requires-approval"
    ]);
  });

  it("posts drift events through WebhookSink", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 202 }));
    const sink = new WebhookSink("https://example.test/checkpoint");
    const event: DriftEvent = {
      id: "drift-1",
      specId: "spec-1",
      specVersion: "1.0.0",
      runId: "run-1",
      failedAssertions: [],
      detectedAt: "2026-06-07T00:00:00.000Z"
    };

    await sink.emit(event);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test/checkpoint",
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(event)
      })
    );
  });

  it("exports a regression trace that re-fails under the same spec", async () => {
    const store = new InMemoryStore();
    const collector = new Collector({
      spec: sreAgentSpec,
      store,
      alertSink: new NoopSink()
    });

    await collector.ingest(await loadSreRun("bad"));
    const driftEvent = Array.from(store.driftEvents.values())[0];
    expect(driftEvent).toBeDefined();

    if (!driftEvent) {
      throw new Error("Expected a drift event");
    }

    const exported = await collector.exportRegressionTrace(driftEvent.id);
    const replayVerdict = evaluate(exported, sreAgentSpec);

    expect(exported.id).toBe("run-sre-bad-0001");
    expect(replayVerdict.passed).toBe(false);
  });

  it("ingests canonical Runs through ingestTrace without a custom adapter", async () => {
    const collector = new Collector({ spec: sreAgentSpec });

    const verdict = await collector.ingestTrace(await loadSreRun("good"));

    expect(verdict.passed).toBe(true);
  });
});

const maybePgIt =
  process.env.CHECKPOINT_PG_TEST === "1" && process.env.CHECKPOINT_DATABASE_URL
    ? it
    : it.skip;

describe("PostgresStore", () => {
  maybePgIt("applies migrations and round-trips collector records", async () => {
    const connectionString = process.env.CHECKPOINT_DATABASE_URL;
    expect(connectionString).toBeDefined();

    if (!connectionString) {
      throw new Error("CHECKPOINT_DATABASE_URL is required");
    }

    const store = new PostgresStore({ connectionString });
    const collector = new Collector({
      spec: sreAgentSpec,
      store,
      alertSink: new NoopSink()
    });

    try {
      await store.migrateToLatest();
      await collector.ingest(await loadSreRun("bad"));
      const runRow = await store.db
        .selectFrom("runs")
        .selectAll()
        .where("id", "=", "run-sre-bad-0001")
        .executeTakeFirstOrThrow();
      const checkRow = await store.db
        .selectFrom("checks")
        .selectAll()
        .where("run_id", "=", "run-sre-bad-0001")
        .executeTakeFirstOrThrow();
      const driftEvent = await store.db
        .selectFrom("drift_events")
        .selectAll()
        .where("run_id", "=", "run-sre-bad-0001")
        .executeTakeFirstOrThrow();
      const corpusEntry = await store.db
        .selectFrom("failure_corpus")
        .selectAll()
        .where("run_id", "=", "run-sre-bad-0001")
        .executeTakeFirstOrThrow();
      const jsonbColumns = await sql<
        Array<{ table_name: string; column_name: string; data_type: string }>
      >`
        select table_name, column_name, data_type
        from information_schema.columns
        where table_schema = 'public'
          and table_name in ('runs', 'checks', 'drift_events', 'failure_corpus')
          and column_name in ('payload', 'results', 'failed', 'trace')
        order by table_name, column_name
      `.execute(store.db);
      const exported = await store.exportRegressionTrace(driftEvent.id);

      expect(runRow.payload.id).toBe("run-sre-bad-0001");
      expect(checkRow.results.map((result) => result.assertionId)).toContain(
        "prod.requires-approval"
      );
      expect(driftEvent.failed.map((result) => result.assertionId)).toEqual([
        "sequence.terraform.apply",
        "budget.maxResourcesTouched",
        "prod.requires-approval"
      ]);
      expect(corpusEntry.run_id).toBe("run-sre-bad-0001");
      expect(corpusEntry.trace.id).toBe("run-sre-bad-0001");
      expect(jsonbColumns.rows).toEqual([
        {
          table_name: "checks",
          column_name: "results",
          data_type: "jsonb"
        },
        {
          table_name: "drift_events",
          column_name: "failed",
          data_type: "jsonb"
        },
        {
          table_name: "failure_corpus",
          column_name: "trace",
          data_type: "jsonb"
        },
        {
          table_name: "runs",
          column_name: "payload",
          data_type: "jsonb"
        }
      ]);
      expect(evaluate(exported, sreAgentSpec).passed).toBe(false);
    } finally {
      await store.destroy();
    }
  });
});
