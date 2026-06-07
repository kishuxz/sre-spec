/**
 * v3 guarded execution contract.
 *
 * Intended model: checkpoint -> verify -> commit. For actions that cannot be
 * held before commit, a registered compensating action is the fallback, following
 * the saga / compensating-transaction pattern.
 *
 * This package intentionally defines only interfaces, types, and a documented
 * NotImplementedGuard stub. Enforcement is gated behind v2 catching real drift
 * and is out of scope for this step.
 */
import type { Run, Verdict } from "@checkpoint/core";
import type { Spec } from "@checkpoint/schema";

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

export const NOT_IMPLEMENTED_GUARD_MESSAGE =
  "v3 guarded execution not implemented; gated behind v2 catching real drift";

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
