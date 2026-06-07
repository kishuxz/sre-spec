import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts"]
  },
  resolve: {
    alias: {
      "@checkpoint/schema": `${root}packages/schema/src/index.ts`,
      "@checkpoint/core": `${root}packages/core/src/index.ts`,
      "@checkpoint/examples": `${root}packages/examples/src/index.ts`,
      "@checkpoint/cli": `${root}packages/cli/src/index.ts`,
      "@checkpoint/github-action": `${root}packages/github-action/src/index.ts`
    }
  }
});
