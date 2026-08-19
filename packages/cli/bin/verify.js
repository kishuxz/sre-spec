#!/usr/bin/env node

import { existsSync } from "node:fs";

const cliUrl = new URL("../dist/index.js", import.meta.url);

if (!existsSync(cliUrl)) {
  process.stderr.write(
    "verify is installed, but packages/cli/dist/index.js is missing. Run `pnpm build` before using the CLI.\n"
  );
  process.exitCode = 2;
} else {
  const { runCli } = await import(cliUrl.href);
  const result = await runCli();
  process.exitCode = result.exitCode;
}
