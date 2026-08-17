import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliResult } from "@checkpoint/cli";

type RunCli = (argv: string[]) => Promise<CliResult>;

const originalEnv = process.env;
let runCli: ReturnType<typeof vi.fn<RunCli>>;

async function loadAction(): Promise<typeof import("./index.js")> {
  vi.doMock("@checkpoint/cli", () => ({
    runCli
  }));

  return import("./index.js");
}

describe("github action entrypoint", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    process.exitCode = undefined;
    runCli = vi.fn<RunCli>().mockResolvedValue({ exitCode: 0 });
  });

  afterEach(() => {
    vi.doUnmock("@checkpoint/cli");
    process.env = originalEnv;
    process.exitCode = undefined;
  });

  it("maps trimmed INPUT_SPEC and INPUT_TRACES into verify gate arguments", async () => {
    process.env.INPUT_SPEC = " packages/examples/src/sre-agent-spec.ts ";
    process.env.INPUT_TRACES = " packages/examples/traces/sre-agent/good.json ";

    const { runAction } = await loadAction();

    await runAction();

    expect(runCli).toHaveBeenCalledWith([
      "gate",
      "packages/examples/src/sre-agent-spec.ts",
      "packages/examples/traces/sre-agent/good.json",
      "--quiet"
    ]);
  });

  it("defaults INPUT_QUIET to true and omits --quiet when INPUT_QUIET is false", async () => {
    process.env.INPUT_SPEC = "spec.ts";
    process.env.INPUT_TRACES = "trace.json";
    process.env.INPUT_QUIET = "false";

    const { runAction } = await loadAction();

    await runAction();

    expect(runCli).toHaveBeenCalledWith(["gate", "spec.ts", "trace.json"]);
  });

  it("requires INPUT_SPEC and INPUT_TRACES", async () => {
    process.env.INPUT_SPEC = "spec.ts";
    process.env.INPUT_TRACES = " ";

    const { runAction } = await loadAction();

    await expect(runAction()).rejects.toThrow("Missing required input: traces");
    expect(runCli).not.toHaveBeenCalled();
  });

  it("propagates the CLI exit code to process.exitCode", async () => {
    process.env.INPUT_SPEC = "spec.ts";
    process.env.INPUT_TRACES = "bad.json";
    runCli.mockResolvedValue({ exitCode: 1 });

    const { runAction } = await loadAction();

    await runAction();

    expect(process.exitCode).toBe(1);
  });
});
