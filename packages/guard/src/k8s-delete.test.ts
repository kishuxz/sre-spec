import { describe, expect, it, vi } from "vitest";
import { loadRun, type Run } from "@checkpoint/core";
import sreK8sDeleteSpec from "../../examples/src/sre-k8s-delete-spec.js";
import {
  DEFAULT_GUARDED_ACTIONS,
  SpecGuard,
  guardedExecute,
  type GuardedActionRequest,
  type GuardedActionRegistry
} from "./index.js";

const K8S_DELETE_ACTION_TYPE = "k8s.delete";
const K8S_RESTORE_MANIFEST_ACTION_TYPE = "k8s.restore_manifest";

const k8sDeleteRegistry = {
  ...DEFAULT_GUARDED_ACTIONS,
  [K8S_DELETE_ACTION_TYPE]: {
    holdable: true,
    compensatingActionType: K8S_RESTORE_MANIFEST_ACTION_TYPE
  }
} satisfies GuardedActionRegistry;

async function loadK8sDeleteRun(name: "good" | "bad"): Promise<Run> {
  return loadRun(`packages/examples/traces/sre-agent/k8s-delete-${name}.json`);
}

function reqFor(run: Run): GuardedActionRequest {
  return {
    actionType: K8S_DELETE_ACTION_TYPE,
    payload: {
      kind: "pod",
      namespace: "production"
    },
    run
  };
}

describe("k8s.delete guarded execution", () => {
  it("commits a passing k8s.delete and calls the injected executor once", async () => {
    const guard = new SpecGuard({ actions: k8sDeleteRegistry });
    const execute = vi.fn<() => Promise<string>>().mockResolvedValue("deleted");
    const compensation = vi.fn<(actionType: string) => Promise<void>>();

    const result = await guardedExecute({
      req: reqFor(await loadK8sDeleteRun("good")),
      spec: sreK8sDeleteSpec,
      guard,
      execute,
      runCompensation: compensation
    });

    expect(result.decision.decision).toBe("commit");
    expect(result.committed).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(compensation).not.toHaveBeenCalled();
  });

  it("holds a failing holdable k8s.delete and never calls the executor", async () => {
    const guard = new SpecGuard({ actions: k8sDeleteRegistry });
    const execute = vi.fn<() => Promise<string>>().mockResolvedValue("deleted");
    const compensation = vi.fn<(actionType: string) => Promise<void>>();

    const result = await guardedExecute({
      req: reqFor(await loadK8sDeleteRun("bad")),
      spec: sreK8sDeleteSpec,
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
      "sequence.k8s.delete",
      "budget.maxResourcesTouched",
      "k8s.delete.prod.requires-approval"
    ]);
  });

  it("compensates a failing non-holdable k8s.delete through the registered fallback", async () => {
    const guard = new SpecGuard({ actions: k8sDeleteRegistry });
    const execute = vi.fn<() => Promise<string>>().mockResolvedValue("deleted");
    const compensation = vi.fn<(actionType: string) => Promise<void>>();

    const result = await guardedExecute({
      req: reqFor(await loadK8sDeleteRun("bad")),
      spec: sreK8sDeleteSpec,
      guard,
      execute,
      holdable: false,
      compensations: {
        [K8S_DELETE_ACTION_TYPE]: K8S_RESTORE_MANIFEST_ACTION_TYPE
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
      K8S_RESTORE_MANIFEST_ACTION_TYPE
    );
    expect(execute).not.toHaveBeenCalled();
    expect(compensation).toHaveBeenCalledOnce();
    expect(compensation).toHaveBeenCalledWith(K8S_RESTORE_MANIFEST_ACTION_TYPE);
  });
});

