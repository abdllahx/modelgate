import { defineConfig } from "vitest/config";

// Workspace packages export a "source" condition pointing at their TypeScript,
// so tests run against source without building first.
export default defineConfig({
  resolve: { conditions: ["source"] },
  ssr: { resolve: { conditions: ["source"], externalConditions: ["source"] } },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.{ts,tsx}", "test/**/*.test.ts"],
  },
});
