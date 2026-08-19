import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const cliPath = "packages/cli/src/index.ts";
const specPath = "packages/examples/src/coding-agent-spec.ts";
const goodTrace = "packages/examples/traces/coding-agent/good.json";
const badTrace = "packages/examples/traces/coding-agent/bad.json";
const traceGlob = "packages/examples/traces/coding-agent/*.json";

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runVerify(args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn("pnpm", ["exec", "tsx", cliPath, ...args], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

describe("verify CLI", () => {
  it("runs a good trace with exit code 0", async () => {
    const result = await runVerify(["run", specPath, goodTrace]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("PASS coding-agent-good-001");
    expect(result.stdout).toContain("PASS blocking tool.contract");
    expect(result.stdout).not.toContain("evidence:");
  });

  it("runs a bad trace with exit code 1 and failure output", async () => {
    const result = await runVerify(["run", specPath, badTrace]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("FAIL coding-agent-bad-001");
    expect(result.stdout).toContain("tool.forbidden.git.force_push_main");
    expect(result.stdout).toContain("sequence.merge");
    expect(result.stdout).not.toContain("evidence:");
  });

  it("prints raw evidence only with --verbose", async () => {
    const result = await runVerify(["run", specPath, badTrace, "--verbose"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("FAIL coding-agent-bad-001");
    expect(result.stdout).toContain("evidence:");
    expect(result.stdout).toContain('"step"');
  });

  it("checks a mixed glob with exit code 1", async () => {
    const result = await runVerify(["check", specPath, traceGlob, "--quiet"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("tool.forbidden.git.force_push_main");
    expect(result.stdout).toContain("sequence.merge");
    expect(result.stdout).not.toContain("PASS coding-agent-good-001");
    expect(result.stdout).not.toContain("evidence:");
  });

  it("gates the good trace with exit code 0", async () => {
    const result = await runVerify(["gate", specPath, goodTrace]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("checkpoint gate: pass");
    expect(result.stdout).not.toContain('"passed":true');
  });

  it("gates the bad trace with exit code 1", async () => {
    const result = await runVerify(["gate", specPath, badTrace]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("checkpoint gate: fail");
    expect(result.stdout).toContain("tool.forbidden.git.force_push_main");
  });

  it("emits parseable Verdict arrays with --json", async () => {
    const result = await runVerify(["run", specPath, goodTrace, "--json"]);
    const verdicts = JSON.parse(result.stdout) as Array<{ passed: boolean }>;

    expect(result.code).toBe(0);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.passed).toBe(true);
  });

  it("returns exit code 2 for usage errors", async () => {
    const result = await runVerify(["run", specPath]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Usage:");
  });

  it("prints usage for --help with exit code 0", async () => {
    const result = await runVerify(["--help"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stderr).toBe("");
  });
});
