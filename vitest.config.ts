import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    // The route test loads the bundle the package ships, so it is built
    // first rather than trusted to be current.
    globalSetup: ["test/build-bundle.ts"],
  },
});
