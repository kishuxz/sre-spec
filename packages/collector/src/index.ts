import { randomUUID } from "node:crypto";
import {
  Kysely,
  Migrator,
  PostgresDialect,
  type ColumnType,
  type Generated,
  type Migration,
  type MigrationProvider
} from "kysely";
import pg from "pg";
import {
  evaluate,
  type AssertionResult,
  type CheckpointSpec,
  type DriftEvent,
  type Run,
  type Verdict
} from "@checkpoint/core";

const { Pool } = pg;

type JsonRecord = Record<string, unknown>;

export interface FailureCorpusEntry {
  id: string;
  vertical: string;
  specId: string;
  runId: string;
  label: string;
  trace: Run;
  createdAt: string;
}

export interface Store {
  persistRun(run: Run): Promise<void>;
  persistCheck(verdict: Verdict): Promise<void>;
  persistDriftEvent(event: DriftEvent): Promise<void>;
  appendFailureCorpus(entry: FailureCorpusEntry): Promise<void>;
  exportRegressionTrace(driftEventId: string): Promise<Run>;
}

export interface AlertSink {
  emit(event: DriftEvent): Promise<void>;
}

export interface TraceAdapter<TSource = unknown> {
  toRun(source: TSource): Promise<Run> | Run;
}

export interface CollectorOptions<TSource = unknown> {
  spec: CheckpointSpec;
  store?: Store;
  alertSink?: AlertSink;
  traceAdapter?: TraceAdapter<TSource>;
}

export class Collector<TSource = unknown> {
  private readonly spec: CheckpointSpec;
  private readonly store: Store;
  private readonly alertSink: AlertSink;
  private readonly traceAdapter: TraceAdapter<TSource> | undefined;

  constructor(options: CollectorOptions<TSource>) {
    this.spec = options.spec;
    this.store = options.store ?? new InMemoryStore();
    this.alertSink = options.alertSink ?? new NoopSink();
    this.traceAdapter = options.traceAdapter;
  }

  /**
   * Observes a completed agent run out-of-band. This method verifies and alerts,
   * but it must not sit in the agent execution path or mutate the action being
   * observed.
   */
  async ingest(run: Run): Promise<Verdict> {
    const verdict = evaluate(run, this.spec);
    await this.store.persistRun(run);
    await this.store.persistCheck(verdict);

    const failedAssertions = blockingFailures(verdict);

    if (failedAssertions.length > 0) {
      const event: DriftEvent = {
        id: randomUUID(),
        specId: verdict.specId,
        specVersion: verdict.specVersion,
        runId: verdict.runId,
        failedAssertions,
        detectedAt: new Date().toISOString()
      };

      await this.store.persistDriftEvent(event);
      await this.store.appendFailureCorpus({
        id: randomUUID(),
        vertical: this.spec.agent,
        specId: this.spec.id,
        runId: run.id,
        label: "blocking violation",
        trace: run,
        createdAt: event.detectedAt
      });
      await this.alertSink.emit(event);
    }

    return verdict;
  }

  async ingestTrace(source: TSource): Promise<Verdict> {
    if (this.traceAdapter) {
      return this.ingest(await this.traceAdapter.toRun(source));
    }

    if (isRun(source)) {
      return this.ingest(source);
    }

    throw new Error(
      "No trace adapter configured. Pass a canonical Run or configure an OpenTelemetry/OpenInference adapter."
    );
  }

  async exportRegressionTrace(driftEventId: string): Promise<Run> {
    return this.store.exportRegressionTrace(driftEventId);
  }
}

export class InMemoryStore implements Store {
  readonly runs = new Map<string, Run>();
  readonly checks: Verdict[] = [];
  readonly driftEvents = new Map<string, DriftEvent>();
  readonly failureCorpus: FailureCorpusEntry[] = [];

  async persistRun(run: Run): Promise<void> {
    this.runs.set(run.id, run);
  }

  async persistCheck(verdict: Verdict): Promise<void> {
    this.checks.push(verdict);
  }

  async persistDriftEvent(event: DriftEvent): Promise<void> {
    this.driftEvents.set(event.id, event);
  }

  async appendFailureCorpus(entry: FailureCorpusEntry): Promise<void> {
    this.failureCorpus.push(entry);
  }

  async exportRegressionTrace(driftEventId: string): Promise<Run> {
    const event = this.driftEvents.get(driftEventId);

    if (!event) {
      throw new Error(`Drift event not found: ${driftEventId}`);
    }

    const entry = this.failureCorpus.find(
      (candidate) => candidate.runId === event.runId
    );

    if (!entry) {
      throw new Error(
        `Failure corpus entry not found for drift event: ${driftEventId}`
      );
    }

    return entry.trace;
  }
}

export class NoopSink implements AlertSink {
  async emit(event: DriftEvent): Promise<void> {
    void event;
    return Promise.resolve();
  }
}

export class WebhookSink implements AlertSink {
  constructor(private readonly url: string) {}

  async emit(event: DriftEvent): Promise<void> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(event)
    });

    if (!response.ok) {
      throw new Error(
        `Webhook sink failed with ${response.status} ${response.statusText}`
      );
    }
  }
}

interface RunTable {
  id: string;
  agent: string;
  source: string;
  started_at: string;
  ended_at: string;
  payload: ColumnType<JsonRecord, JsonRecord, JsonRecord>;
  created_at: Generated<string>;
}

interface CheckTable {
  id: string;
  run_id: string;
  spec_id: string;
  spec_version: string;
  passed: boolean;
  results: ColumnType<JsonRecord[], JsonRecord[], JsonRecord[]>;
  evaluated_at: string;
}

interface DriftEventTable {
  id: string;
  spec_id: string;
  spec_version: string;
  run_id: string;
  failed: ColumnType<JsonRecord[], JsonRecord[], JsonRecord[]>;
  detected_at: string;
}

interface FailureCorpusTable {
  id: string;
  vertical: string;
  spec_id: string;
  run_id: string;
  label: string;
  trace: ColumnType<JsonRecord, JsonRecord, JsonRecord>;
  created_at: Generated<string>;
}

export interface CollectorDatabase {
  runs: RunTable;
  checks: CheckTable;
  drift_events: DriftEventTable;
  failure_corpus: FailureCorpusTable;
}

export class PostgresStore implements Store {
  readonly db: Kysely<CollectorDatabase>;

  constructor(options: { connectionString: string } | { db: Kysely<CollectorDatabase> }) {
    if ("db" in options) {
      this.db = options.db;
      return;
    }

    this.db = new Kysely<CollectorDatabase>({
      dialect: new PostgresDialect({
        pool: new Pool({ connectionString: options.connectionString })
      })
    });
  }

  async migrateToLatest(): Promise<void> {
    const migrator = new Migrator({
      db: this.db,
      provider: createMigrationProvider()
    });
    const { error } = await migrator.migrateToLatest();

    if (error) {
      throw error;
    }
  }

  async destroy(): Promise<void> {
    await this.db.destroy();
  }

  async persistRun(run: Run): Promise<void> {
    await this.db
      .insertInto("runs")
      .values({
        id: run.id,
        agent: run.agent,
        source: run.source,
        started_at: run.startedAt,
        ended_at: run.endedAt,
        payload: runToJson(run)
      })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({
          agent: run.agent,
          source: run.source,
          started_at: run.startedAt,
          ended_at: run.endedAt,
          payload: runToJson(run)
        })
      )
      .execute();
  }

  async persistCheck(verdict: Verdict): Promise<void> {
    await this.db
      .insertInto("checks")
      .values({
        id: randomUUID(),
        run_id: verdict.runId,
        spec_id: verdict.specId,
        spec_version: verdict.specVersion,
        passed: verdict.passed,
        results: verdict.results.map(assertionResultToJson),
        evaluated_at: verdict.evaluatedAt
      })
      .execute();
  }

  async persistDriftEvent(event: DriftEvent): Promise<void> {
    await this.db
      .insertInto("drift_events")
      .values({
        id: event.id,
        spec_id: event.specId,
        spec_version: event.specVersion,
        run_id: event.runId,
        failed: event.failedAssertions.map(assertionResultToJson),
        detected_at: event.detectedAt
      })
      .execute();
  }

  async appendFailureCorpus(entry: FailureCorpusEntry): Promise<void> {
    await this.db
      .insertInto("failure_corpus")
      .values({
        id: entry.id,
        vertical: entry.vertical,
        spec_id: entry.specId,
        run_id: entry.runId,
        label: entry.label,
        trace: runToJson(entry.trace)
      })
      .execute();
  }

  async exportRegressionTrace(driftEventId: string): Promise<Run> {
    const driftEvent = await this.db
      .selectFrom("drift_events")
      .select(["run_id"])
      .where("id", "=", driftEventId)
      .executeTakeFirst();

    if (!driftEvent) {
      throw new Error(`Drift event not found: ${driftEventId}`);
    }

    const entry = await this.db
      .selectFrom("failure_corpus")
      .select(["trace"])
      .where("run_id", "=", driftEvent.run_id)
      .executeTakeFirst();

    if (!entry) {
      throw new Error(
        `Failure corpus entry not found for drift event: ${driftEventId}`
      );
    }

    return entry.trace as unknown as Run;
  }
}

export function createMigrationProvider(): MigrationProvider {
  return {
    async getMigrations(): Promise<Record<string, Migration>> {
      return {
        "001_initial": {
          async up(db: Kysely<unknown>): Promise<void> {
            await db.schema
              .createTable("runs")
              .ifNotExists()
              .addColumn("id", "text", (col) => col.primaryKey())
              .addColumn("agent", "text", (col) => col.notNull())
              .addColumn("source", "text", (col) => col.notNull())
              .addColumn("started_at", "timestamptz", (col) => col.notNull())
              .addColumn("ended_at", "timestamptz", (col) => col.notNull())
              .addColumn("payload", "jsonb", (col) => col.notNull())
              .addColumn("created_at", "timestamptz", (col) =>
                col.notNull().defaultTo(db.fn("now"))
              )
              .execute();

            await db.schema
              .createTable("checks")
              .ifNotExists()
              .addColumn("id", "text", (col) => col.primaryKey())
              .addColumn("run_id", "text", (col) =>
                col.notNull().references("runs.id")
              )
              .addColumn("spec_id", "text", (col) => col.notNull())
              .addColumn("spec_version", "text", (col) => col.notNull())
              .addColumn("passed", "boolean", (col) => col.notNull())
              .addColumn("results", "jsonb", (col) => col.notNull())
              .addColumn("evaluated_at", "timestamptz", (col) => col.notNull())
              .execute();

            await db.schema
              .createTable("drift_events")
              .ifNotExists()
              .addColumn("id", "text", (col) => col.primaryKey())
              .addColumn("spec_id", "text", (col) => col.notNull())
              .addColumn("spec_version", "text", (col) => col.notNull())
              .addColumn("run_id", "text", (col) =>
                col.notNull().references("runs.id")
              )
              .addColumn("failed", "jsonb", (col) => col.notNull())
              .addColumn("detected_at", "timestamptz", (col) => col.notNull())
              .execute();

            await db.schema
              .createTable("failure_corpus")
              .ifNotExists()
              .addColumn("id", "text", (col) => col.primaryKey())
              .addColumn("vertical", "text", (col) => col.notNull())
              .addColumn("spec_id", "text", (col) => col.notNull())
              .addColumn("run_id", "text", (col) =>
                col.notNull().references("runs.id")
              )
              .addColumn("label", "text", (col) => col.notNull())
              .addColumn("trace", "jsonb", (col) => col.notNull())
              .addColumn("created_at", "timestamptz", (col) =>
                col.notNull().defaultTo(db.fn("now"))
              )
              .execute();
          },
          async down(db: Kysely<unknown>): Promise<void> {
            await db.schema.dropTable("failure_corpus").ifExists().execute();
            await db.schema.dropTable("drift_events").ifExists().execute();
            await db.schema.dropTable("checks").ifExists().execute();
            await db.schema.dropTable("runs").ifExists().execute();
          }
        }
      };
    }
  };
}

function blockingFailures(verdict: Verdict): AssertionResult[] {
  return verdict.results.filter(
    (result) => result.status === "fail" && result.severity === "blocking"
  );
}

function isRun(value: unknown): value is Run {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<Run>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.agent === "string" &&
    Array.isArray(candidate.steps) &&
    typeof candidate.startedAt === "string" &&
    typeof candidate.endedAt === "string"
  );
}

function assertionResultToJson(result: AssertionResult): JsonRecord {
  return {
    assertionId: result.assertionId,
    status: result.status,
    severity: result.severity,
    message: result.message,
    ...(result.evidence !== undefined
      ? { evidence: result.evidence as unknown }
      : {})
  };
}

function runToJson(run: Run): JsonRecord {
  return run as unknown as JsonRecord;
}
