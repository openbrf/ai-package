import { defineConfig } from "vitest/config";

/**
 * The live prompt-injection evaluation, `pnpm eval`: apart from `pnpm test`,
 * because it calls the real API and costs tokens.
 */
export default defineConfig({
  test: {
    include: ["eval/**/*.eval.ts"],
    // A case takes a few calls to the model, each up to two minutes, and a
    // busy provider is waited for.
    testTimeout: 15 * 60_000,
    // Within the provider's rate limits on an ordinary key.
    maxConcurrency: 4,
  },
});
