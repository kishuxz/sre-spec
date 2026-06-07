import { runCli } from "@checkpoint/cli";
import { realpathSync } from "node:fs";

function input(name: string, required = false): string {
  const value = process.env[`INPUT_${name.toUpperCase()}`]?.trim() ?? "";

  if (required && value.length === 0) {
    throw new Error(`Missing required input: ${name}`);
  }

  return value;
}

function booleanInput(name: string, defaultValue: boolean): boolean {
  const value = input(name);

  if (value.length === 0) {
    return defaultValue;
  }

  return value.toLowerCase() === "true";
}

export async function runAction(): Promise<void> {
  const spec = input("spec", true);
  const traces = input("traces", true);
  const quiet = booleanInput("quiet", true);
  const args = ["gate", spec, traces];

  if (quiet) {
    args.push("--quiet");
  }

  const result = await runCli(args);
  process.exitCode = result.exitCode;
}

function isEntrypoint(): boolean {
  if (!process.argv[1]) {
    return false;
  }

  return realpathSync(new URL(import.meta.url)) === realpathSync(process.argv[1]);
}

if (isEntrypoint()) {
  await runAction();
}
