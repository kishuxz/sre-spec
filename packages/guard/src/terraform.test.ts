import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { loadRun, type Run } from "@checkpoint/core";
import sreAgentSpec from "../../examples/src/sre-agent-spec.js";
import {
  SpecGuard,
  TERRAFORM_APPLY_ACTION_TYPE,
  createSandboxedTerraformExecutor,
  guardedExecute,
  type GuardedActionRequest,
  type SpawnProcess
} from "./index.js";

const maybeTerraformIt =
  process.env.CHECKPOINT_TERRAFORM_TEST === "1" && process.env.TERRAFORM_BIN
    ? it
    : it.skip;

async function loadSreRun(name: "good" | "bad"): Promise<Run> {
  return loadRun(`packages/examples/traces/sre-agent/${name}.json`);
}

function reqFor(run: Run): GuardedActionRequest {
  return {
    actionType: TERRAFORM_APPLY_ACTION_TYPE,
    payload: { target: "local terraform_data checkpoint" },
    run
  };
}

async function createLocalOnlyTerraformDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "checkpoint-tf-"));
  await writeFile(
    path.join(directory, "main.tf"),
    [
      'terraform { required_version = ">= 1.4.0" }',
      "",
      'resource "terraform_data" "checkpoint" {',
      '  input = "checkpoint-local-only"',
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
  return directory;
}

describe("sandboxed Terraform executor", () => {
  maybeTerraformIt("commits good traces with real local Terraform and holds bad traces before spawning", async () => {
    const terraformBin = process.env.TERRAFORM_BIN;

    if (!terraformBin) {
      throw new Error("TERRAFORM_BIN is required");
    }

    const guard = new SpecGuard();
    const directory = await createLocalOnlyTerraformDir();
    let goodSpawnCount = 0;
    let badSpawnCount = 0;
    const goodSpawn: SpawnProcess = (command, args, options) => {
      goodSpawnCount += 1;
      return spawn(command, args, options);
    };
    const badSpawn: SpawnProcess = (command, args, options) => {
      badSpawnCount += 1;
      return spawn(command, args, options);
    };

    try {
      const goodResult = await guardedExecute({
        req: reqFor(await loadSreRun("good")),
        spec: sreAgentSpec,
        guard,
        execute: createSandboxedTerraformExecutor({
          workingDirectory: directory,
          terraformBin,
          spawnProcess: goodSpawn
        })
      });

      expect(goodResult.decision.decision).toBe("commit");
      expect(goodResult.committed).toBe(true);

      if (!goodResult.committed) {
        throw new Error("Expected committed Terraform result");
      }

      expect(goodSpawnCount).toBe(2);
      expect(goodResult.result.init.code).toBe(0);
      expect(goodResult.result.apply.code).toBe(0);
      expect(await readFile(path.join(directory, "terraform.tfstate"), "utf8")).toContain(
        "checkpoint-local-only"
      );

      const badResult = await guardedExecute({
        req: reqFor(await loadSreRun("bad")),
        spec: sreAgentSpec,
        guard,
        execute: createSandboxedTerraformExecutor({
          workingDirectory: directory,
          terraformBin,
          spawnProcess: badSpawn
        }),
        holdable: true
      });

      expect(badResult.decision.decision).toBe("hold");
      expect(badResult.committed).toBe(false);
      expect(badResult.held).toBe(true);
      expect(badSpawnCount).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
