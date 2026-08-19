#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { evaluate, loadRun, loadSpec, type Verdict } from "@checkpoint/core";

export interface CliResult {
  exitCode: 0 | 1 | 2;
}

type Command = "run" | "check" | "gate";

interface ParsedCli {
  command: Command;
  specPath: string;
  tracePattern: string;
  json: boolean;
  quiet: boolean;
  verbose: boolean;
}

export async function runCli(argv = process.argv.slice(2)): Promise<CliResult> {
  try {
    if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
      process.stdout.write(`${usage()}\n`);
      return { exitCode: 0 };
    }

    const parsed = parseCli(argv);
    const tracePaths =
      parsed.command === "run"
        ? [parsed.tracePattern]
        : await expandTracePattern(parsed.tracePattern);

    if (tracePaths.length === 0) {
      throw new UsageError(`No trace files matched "${parsed.tracePattern}".`);
    }

    const spec = await loadSpec(parsed.specPath);
    const verdicts: Verdict[] = [];

    for (const tracePath of tracePaths) {
      const run = await loadRun(tracePath);
      verdicts.push(evaluate(run, spec));
    }

    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(verdicts, null, 2)}\n`);
    } else if (parsed.command === "gate") {
      printGateReport(verdicts, parsed.quiet, parsed.verbose);
    } else {
      printHumanReport(verdicts, parsed.quiet, parsed.verbose);
    }

    const passed = verdicts.every((verdict) => verdict.passed);
    return { exitCode: passed ? 0 : 1 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return { exitCode: 2 };
  }
}

function parseCli(argv: string[]): ParsedCli {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      verbose: { type: "boolean", default: false }
    }
  });

  const [command, specPath, tracePattern, ...rest] = parsed.positionals;

  if (rest.length > 0) {
    throw new UsageError(`Unexpected extra arguments: ${rest.join(" ")}`);
  }

  if (!isCommand(command)) {
    throw new UsageError(usage());
  }

  if (!specPath || !tracePattern) {
    throw new UsageError(usage());
  }

  return {
    command,
    specPath,
    tracePattern,
    json: parsed.values.json ?? false,
    quiet: parsed.values.quiet ?? false,
    verbose: parsed.values.verbose ?? false
  };
}

function isCommand(value: string | undefined): value is Command {
  return value === "run" || value === "check" || value === "gate";
}

function usage(): string {
  return [
    "Usage:",
    "  verify run <spec> <trace> [--json] [--quiet] [--verbose]",
    "  verify check <spec> <glob> [--json] [--quiet] [--verbose]",
    "  verify gate <spec> <glob> [--json] [--quiet] [--verbose]"
  ].join("\n");
}

class UsageError extends Error {}

async function expandTracePattern(pattern: string): Promise<string[]> {
  const absolutePattern = path.resolve(pattern);

  if (!hasGlobSyntax(pattern)) {
    const stats = await stat(absolutePattern);

    if (stats.isDirectory()) {
      return collectJsonFiles(absolutePattern);
    }

    return [absolutePattern];
  }

  const root = globSearchRoot(absolutePattern);
  const regex = globToRegex(absolutePattern);
  const candidates = await collectJsonFiles(root);
  return candidates.filter((candidate) => regex.test(candidate)).sort();
}

function hasGlobSyntax(value: string): boolean {
  return /[*?]/.test(value);
}

function globSearchRoot(absolutePattern: string): string {
  const firstGlob = absolutePattern.search(/[*?]/);
  const prefix = absolutePattern.slice(0, firstGlob);
  const lastSeparator = prefix.lastIndexOf(path.sep);

  if (lastSeparator <= 0) {
    return path.parse(absolutePattern).root;
  }

  return prefix.slice(0, lastSeparator);
}

function globToRegex(absolutePattern: string): RegExp {
  let source = "";

  for (const char of absolutePattern) {
    if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegex(char);
    }
  }

  return new RegExp(`^${source}$`);
}

function escapeRegex(char: string): string {
  return /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
}

async function collectJsonFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectJsonFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(entryPath);
    }
  }

  return files.sort();
}

function printHumanReport(
  verdicts: Verdict[],
  quiet: boolean,
  verbose: boolean
): void {
  for (const verdict of verdicts) {
    if (!quiet) {
      process.stdout.write(
        `${verdict.passed ? "PASS" : "FAIL"} ${verdict.runId} against ${verdict.specId}@${verdict.specVersion}\n`
      );
    }

    const results = quiet
      ? verdict.results.filter((result) => result.status === "fail")
      : verdict.results;

    for (const result of results) {
      process.stdout.write(
        `  ${result.status.toUpperCase()} ${result.severity} ${result.assertionId}: ${result.message}\n`
      );

      if (verbose && result.evidence !== undefined) {
        process.stdout.write(
          `    evidence: ${JSON.stringify(result.evidence)}\n`
        );
      }
    }
  }
}

function printGateReport(
  verdicts: Verdict[],
  quiet: boolean,
  verbose: boolean
): void {
  const failedResults = verdicts.flatMap((verdict) =>
    verdict.results
      .filter((result) => result.status === "fail")
      .map((result) => ({ verdict, result }))
  );
  const passed = verdicts.every((verdict) => verdict.passed);

  if (!quiet || !passed) {
    process.stdout.write(
      `checkpoint gate: ${passed ? "pass" : "fail"} (${verdicts.length} run${verdicts.length === 1 ? "" : "s"})\n`
    );
  }

  for (const { verdict, result } of failedResults) {
    process.stdout.write(
      `  ${verdict.runId} ${result.severity} ${result.assertionId}: ${result.message}\n`
    );

    if (verbose && result.evidence !== undefined) {
      process.stdout.write(
        `    evidence: ${JSON.stringify(result.evidence)}\n`
      );
    }
  }
}

function isEntrypoint(): boolean {
  if (!process.argv[1]) {
    return false;
  }

  return realpathSync(new URL(import.meta.url)) === realpathSync(process.argv[1]);
}

if (isEntrypoint()) {
  const result = await runCli();
  process.exitCode = result.exitCode;
}
