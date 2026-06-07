# Checkpoint — Build Specification (for Codex)

**Purpose of this file:** the single source of truth for building Checkpoint. If a task is not traceable to something in here, do not build it. This is a *build* spec, not a pitch — scope, data model, interfaces, and acceptance criteria only.

**What Checkpoint is:** a spec-driven verification and guarded-execution layer for AI agents. A developer writes a typed, machine-checkable definition of how an agent should behave (a **Spec**). Checkpoint proves the agent honors that Spec in CI before release (v1), continuously verifies it against production traffic (v2), and holds a destructive action before it commits if it would violate the Spec (v3).

**Locked product decisions (do not re-litigate):**
- **First vertical: AI SRE / autonomous infrastructure remediation agents.** The company is aimed here.
- **Phase 0 prototype substrate: coding agents.** Ground truth is free (tests pass / diff compiles), no design partner needed. The engine is built and proven here first, then pointed at the SRE vertical.
- **Expansion vertical (later, gated): financial / transaction-action agents.** Not in scope for this build.
- **The engine is vertical-agnostic.** A "vertical" = a spec library + adapters + example traces. Build the engine once.

---

## 0. Scope of THIS build

**In scope now:**
1. `schema` — the Spec format and its Zod schema + serializable representation.
2. `core` — the verification engine: trace model, assertion evaluators (deterministic-first), check runner, verdict model.
3. `cli` — `verify run`, `verify check`, `verify gate` with correct exit codes.
4. `github-action` — thin wrapper over the CLI that fails a PR on a spec violation (v1 CI gate).
5. `collector` — out-of-band production verification SDK that ingests traces and emits drift events (v2 foundation).
6. `examples` — runnable specs + recorded traces for (a) a coding agent (Phase 0) and (b) an SRE remediation agent (target vertical).
7. `guard` — **interface and types only** (v3). Define the `checkpoint → verify → commit/compensate` contract. Do not implement enforcement logic yet.

**Explicitly deferred (do NOT build until a gate is hit):**
- v3 guarded-execution enforcement runtime (interfaces only for now).
- Python SDK (TypeScript first; Python is a fast-follow after the TS SDK ships and a design partner is live).
- Any web dashboard beyond a minimal read-only review surface (and even that is last).
- Multi-region, Kubernetes, autoscaling, microservices.
- A new trace format/standard — ingest OpenTelemetry / OpenInference, never invent one.
- LLM-as-judge for anything a deterministic check can do.

---

## 1. Monorepo layout

TypeScript, ESM, strict mode. pnpm workspace. One shared spec schema all packages bind to.

```
spec-verify/                      (repo root)
├── package.json                  (pnpm workspace root)
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── packages/
│   ├── schema/                   Spec types + Zod schema + (de)serialization
│   ├── core/                     trace model, assertion evaluators, check runner, verdicts
│   ├── cli/                      verify run | check | gate
│   ├── github-action/            CI gate wrapper over cli
│   ├── collector/                v2 out-of-band production verification SDK
│   ├── guard/                    v3 interfaces/types ONLY (no enforcement yet)
│   └── examples/                 coding-agent + sre-agent specs and recorded traces
```

**Conventions:**
- TypeScript strict, ESM only (`"type": "module"`). No CommonJS.
- Build with `tsup` (each package emits ESM + types).
- Validate with `Zod`. Test with `Vitest`.
- Lint/format: ESLint + Prettier; CI runs `lint`, `typecheck`, `test`, `build`.
- License: Apache-2.0. OSS core = `schema`, `core`, `cli`, deterministic scorers.
- Trace interop standardizes on OpenTelemetry / OpenInference semantic conventions.
- Storage (collector/v2): Postgres via **Kysely** (typed query builder), migrations checked in.

---

## 2. Core data model

These types live in `schema` (Spec) and `core` (runtime). Keep them small; the data model *is* the product.

```ts
// ---- Trace / Run -------------------------------------------------------
// A Run is one agent execution captured as an ordered list of Steps.
type StepType = "llm_call" | "tool_call";

interface Step {
  id: string;
  type: StepType;
  name: string;                 // tool name or model/call name
  input: unknown;               // arguments / prompt (JSON-serializable)
  output: unknown;              // result / completion (JSON-serializable)
  startedAt: string;            // ISO 8601
  endedAt: string;              // ISO 8601
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  metadata?: Record<string, unknown>;
}

interface Run {
  id: string;
  agent: string;                // logical agent/workflow id this run belongs to
  source: "ci" | "production" | "simulation";
  steps: Step[];
  startedAt: string;
  endedAt: string;
  metadata?: Record<string, unknown>;
}

// ---- Check / Verdict ---------------------------------------------------
type AssertionStatus = "pass" | "fail" | "skipped";

interface AssertionResult {
  assertionId: string;
  status: AssertionStatus;
  severity: "blocking" | "advisory";
  message: string;              // human-readable, explainable; never a bare score
  evidence?: unknown;           // the step(s)/value that triggered the result
}

interface Verdict {
  runId: string;
  specId: string;
  specVersion: string;
  results: AssertionResult[];
  passed: boolean;              // true iff no blocking assertion failed
  evaluatedAt: string;
}

// ---- Drift event (v2) --------------------------------------------------
interface DriftEvent {
  id: string;
  specId: string;
  specVersion: string;
  runId: string;
  failedAssertions: AssertionResult[];
  detectedAt: string;
}

// ---- Guarded action (v3, interface only for now) -----------------------
interface GuardedActionRequest {
  actionType: string;           // e.g. "k8s.delete", "terraform.apply", "payout"
  payload: unknown;
  run: Run;                     // the run leading up to this action
}
interface GuardDecision {
  decision: "commit" | "hold" | "compensate";
  verdict: Verdict;
  compensatingActionType?: string;
}
```

---

## 3. The Spec format

Authored in TypeScript (typed, IDE autocomplete, no DSL). Declarative core so **the same Spec runs unchanged in CI and in production**. Each assertion is independently pass/fail (explainable). A thin serializable JSON representation exists under the hood (for storage and eventual non-engineer review).

```ts
import { defineSpec } from "@checkpoint/schema";

interface Spec {
  id: string;
  version: string;              // semver; bump on any behavioral change
  agent: string;                // which agent/workflow this governs

  // --- Tool contract ---
  tools?: {
    allowed?: string[];         // only these tools may be called
    forbidden?: string[];       // these tools must never be called
  };

  // --- Sequencing / ordering ---
  sequence?: SequenceRule[];

  // --- Conditions ---
  preconditions?: Assertion[];  // must hold before a target step
  postconditions?: Assertion[]; // must hold after the run / a target step

  // --- Budgets / limits ---
  budget?: {
    maxToolCalls?: number;
    maxTokens?: number;
    maxCostUsd?: number;
    maxDurationMs?: number;
    maxResourcesTouched?: number; // blast-radius limit (SRE-relevant)
  };

  // --- Free-form deterministic assertions ---
  assertions?: Assertion[];
}

interface SequenceRule {
  // "step `step` must be preceded by all of `after`"
  step: string;                 // tool/step name matcher
  after: string[];              // names that must appear, in order, before `step`
  message?: string;
}

interface Assertion {
  id: string;
  severity?: "blocking" | "advisory"; // default "blocking"
  message?: string;
  // A pure, deterministic predicate over the Run. No model in the loop.
  // Return true = pass, false = fail.
  check: (run: Run) => boolean;
  // OPTIONAL escape hatch for genuinely subjective checks only (rare).
  judge?: { prompt: string; model: string };
}
```

**Authoring rules for Codex:**
- Deterministic `check` predicates are the default and the bulk. They cannot hallucinate because no model runs.
- `judge` (LLM-as-judge) is a last resort, only for subjective properties code cannot reach, and must be independent of the model being verified. Do not implement `judge` execution in this build beyond a typed stub that throws "not implemented" — keep the surface, defer the runtime.
- `defineSpec(spec: Spec): Spec` validates against the Zod schema at author time and returns the spec. Throw on invalid specs with a clear message.

---

## 4. The verification engine (`core`)

The engine is identical across verticals.

**Responsibilities:**
1. Accept a `Run` and a `Spec`.
2. Evaluate every rule into `AssertionResult[]`:
   - **Tool contract:** scan steps; fail if any `forbidden` tool was called, or (when `allowed` is set) any tool outside the allowlist was called.
   - **Sequence rules:** for each occurrence of `step`, verify each name in `after` appeared earlier in the run, in order.
   - **Budgets:** sum tool calls / tokens / cost / duration / resources-touched and compare to limits.
   - **Pre/post-conditions and assertions:** run the deterministic `check(run)` predicate.
3. Produce a `Verdict`. `passed = true` iff no **blocking** assertion failed. Advisory failures are reported but do not flip `passed`.
4. Every result carries a human-readable `message` and the triggering `evidence`. **Never emit a single black-box score.**

**Evaluation order:** deterministic checks first (tool/sequence/budget/assertions), `judge` last. Short-circuit nothing — evaluate all assertions so the report is complete, then compute `passed`.

**Public API (core):**
```ts
function evaluate(run: Run, spec: Spec): Verdict;
function loadSpec(path: string): Promise<Spec>;     // import a .ts/.js spec module
function loadRun(path: string): Promise<Run>;       // load a recorded trace (JSON)
```

---

## 5. Trace ingestion

- Define a canonical internal `Run`/`Step` shape (Section 2).
- Provide **adapters** that map common sources into `Run`:
  - `fromOpenInference(spans)` / `fromOpenTelemetry(spans)` — primary.
  - Thin adapters for LangGraph, CrewAI, OpenAI Agents SDK trace exports.
  - `fromMcpToolCalls(log)` — raw MCP tool-call logs.
- Ingest the standard; never define a proprietary wire format. Adapters live in `core` (or a small `core/adapters` subpath).

---

## 6. CLI (`cli`)

Behaves like a test runner. Exit codes drive CI.

| Command | Purpose | Exit code |
|---|---|---|
| `verify run <spec> <trace>` | Evaluate one recorded/simulated run against a spec; print the per-assertion report. | `0` pass, `1` blocking failure, `2` usage/error |
| `verify check <spec> <glob>` | Evaluate a spec against many recorded runs (a directory/glob of traces). | `0` all pass, `1` any blocking failure |
| `verify gate <spec> <glob>` | CI mode: same as `check` but terse output + machine-readable summary; non-zero blocks the PR. | `0` pass, `1` violation |

- Output: human-readable by default; `--json` emits the `Verdict[]` for tooling.
- `--quiet` for CI logs. Always print which assertions failed and why.

---

## 7. GitHub Action (`github-action`)

- Thin wrapper that installs the CLI and runs `verify gate` against recorded/simulated runs in the repo.
- Inputs: `spec` (path), `traces` (glob), `quiet` (bool).
- Fails the check (non-zero) on any blocking violation, blocking the PR.
- No new infra; it is the v1 adoption foothold.

---

## 8. Collector (`collector`) — v2 foundation

- A lightweight SDK dropped into a running agent that streams `Step`s (or full `Run`s) to the verifier **out-of-band** — observe + alert, **zero added latency**, never in the execution path.
- Runs the *same* Spec used in CI against live runs.
- On a blocking failure, emit a `DriftEvent` and alert via webhook/Slack (pluggable sink — do not build a notification platform).
- Persist runs, checks, drift events, and verdicts to **Postgres via Kysely**. Migrations checked in.
- Each caught production failure is appended to a **failure corpus** (a labeled table) so it can be replayed as a regression case in CI. This loop is the compounding asset — wire it: `drift event → exportable regression trace`.

**Minimal Postgres schema (Kysely migrations):**
```
runs(id, agent, source, started_at, ended_at, payload jsonb, created_at)
checks(id, run_id, spec_id, spec_version, passed bool, results jsonb, evaluated_at)
drift_events(id, spec_id, spec_version, run_id, failed jsonb, detected_at)
failure_corpus(id, vertical, spec_id, run_id, label, trace jsonb, created_at)
```
- Large raw trace payloads may go to S3-compatible object storage; keep a pointer in Postgres. Defer until traces are large enough to matter.

---

## 9. Guard (`guard`) — v3 interfaces ONLY

Define types and the contract; **implement nothing that enforces yet.**

```ts
interface Guard {
  // Hold the action, verify against the spec, decide commit/hold/compensate.
  evaluate(req: GuardedActionRequest, spec: Spec): Promise<GuardDecision>;
}
```
- Document the intended model: `checkpoint → verify → commit`; for non-holdable actions, a registered **compensating action** is the fallback (saga / compensating-transaction pattern).
- Note in code comments: implementation is gated behind v2 catching real drift. Provide a `NotImplementedGuard` stub.

---

## 10. The two example specs (`examples`)

These are how Codex validates the engine end to end.

### 10a. Phase 0 — Coding agent (free ground truth)
A spec for an autonomous coding/dev-pipeline agent. Example assertions:
- Tool contract: `forbidden: ["git.force_push_main", "db.drop_table"]`.
- Sequence: a `merge` step must be preceded by a `run_tests` step (`after: ["run_tests"]`).
- Assertion: any DB migration step has a corresponding down-migration in the diff.
- Budget: `maxToolCalls`, `maxCostUsd` sane caps.
- Provide two recorded traces: one **good** run (passes) and one **bad** run (e.g. merges before tests run, or attempts a forbidden tool) that the engine must block.

### 10b. Target vertical — SRE remediation agent
A spec for an autonomous infrastructure-remediation agent. Example assertions (grounded in real 2026 incidents — recursive prod deletion, over-scoped tokens):
- Tool contract: destructive ops (`k8s.delete`, `terraform.destroy`, `db.drop`) are `forbidden` unless an explicit approval step is present.
- Sequence: any `apply`/`destroy` step must be preceded by a `dry_run` step **and** an `environment_check` step (`after: ["dry_run", "environment_check"]`) — this directly catches the staging-vs-prod context-collapse failure.
- Precondition: a `rollback` action must be preceded by a `health_check`.
- Budget: `maxResourcesTouched` blast-radius cap; fail if a single run would mutate more than N resources.
- Assertion: no destructive op targets a production namespace/identifier without an approval token present in the run.
- Provide a **good** trace (dry-run → env-check → scoped apply) and a **bad** trace (apply with no dry-run, prod target, blast radius over cap) the engine must block.

---

## 11. Tech stack (summary)

- **Language/runtime:** TypeScript (strict, ESM), Node ≥ 20.
- **Schema/validation:** Zod.
- **Build:** tsup. **Test:** Vitest. **Workspace:** pnpm.
- **Trace interop:** OpenTelemetry / OpenInference.
- **Storage (collector/v2):** Postgres via Kysely; S3-compatible object store for large payloads (deferred).
- **Distribution:** OSS core (schema, core, cli, deterministic scorers); hosted v2/v3 later.
- **Infra:** single-region, single Postgres, Docker, boring PaaS. No Kubernetes, no multi-region.
- **License:** Apache-2.0.

---

## 12. Build sequence & acceptance criteria (phase-gated — do not skip ahead)

**Step 1 — `schema` + `core` engine.**
Acceptance: `evaluate(run, spec)` returns a correct `Verdict` for the coding-agent good/bad traces — good passes, bad produces a blocking failure with an explainable message and evidence. Unit tests cover tool contract, sequence, budget, and assertion paths.

**Step 2 — `cli` + `github-action`.**
Acceptance: `verify gate <spec> <glob>` exits `0` on the good trace and `1` on the bad trace. The GitHub Action blocks a PR carrying the bad trace. This is a working **v1** demo.

**Step 3 — SRE example spec.**
Acceptance: the SRE spec (10b) correctly passes the good remediation trace and blocks the bad one (no dry-run / prod target / blast radius exceeded). Engine unchanged — only the spec + traces are new. This proves vertical-agnosticism.

**Step 4 — `collector` (v2 foundation).**
Acceptance: collector ingests an OpenInference/OTel trace, runs the same SRE spec out-of-band, persists run/check/verdict to Postgres (Kysely migrations apply cleanly), and emits a `DriftEvent` to a webhook sink on a blocking failure. A drift event can be exported as a regression trace usable by `verify check`.

**Step 5 — `guard` interfaces.**
Acceptance: types compile, `NotImplementedGuard` stub present and documented. No enforcement logic.

---

## 13. Non-goals / anti-scope (binding)

Do not build, until a named gate is cleared:
- A general observability dashboard / pretty trace UI — minimal read-only review surface only, and last.
- A new trace format/standard — ingest OTel/OpenInference.
- v3 guarded-execution **enforcement** runtime — interfaces only this build.
- Python SDK — after TS SDK ships + first design partner live.
- An agent framework/orchestrator ("the next LangGraph") — never.
- An AI-SRE auto-fixer that takes remediation actions itself — never; we verify and guard *their* agent, we don't replace it.
- An agent-governance/compliance product — compliance evidence is a byproduct we can emit later, not a category we join.
- LLM-as-judge for anything deterministic scorers can check — never.
- Multi-region/Kubernetes/microservices — only under real paying load a single boring deploy can't serve.

**Rule:** if you want to build something not in this file, first write down which acceptance criterion it serves and which step it belongs to. If you can't, it's out of scope.

---

## 14. One-paragraph summary

Build one vertical-agnostic, spec-driven verification engine in TypeScript. A `Spec` is a typed, versioned, declarative definition of correct agent behavior (allowed/forbidden tools, required ordering, pre/post-conditions, budgets, deterministic assertions). The `core` engine evaluates a `Run` (an ordered trace of steps) against a `Spec` and returns an explainable per-assertion `Verdict` — deterministic checks first, LLM-judge only as a deferred stub. Ship it as a CLI and GitHub Action that block PRs on violations (v1), prove it on a coding-agent spec where ground truth is free (Phase 0), then point the unchanged engine at an SRE remediation spec (the target vertical). Add an out-of-band collector that runs the same spec against production traffic, persists to Postgres via Kysely, emits drift events, and feeds caught failures back as regression cases (v2 foundation). Define v3 guarded-action interfaces but implement no enforcement yet. OTel/OpenInference ingest, Zod, tsup, Vitest, Apache-2.0. Everything not in this file is out of scope until an acceptance criterion says otherwise.