import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./src/__tests__/setup.ts"],
    testTimeout: 20_000,
    // These are integration tests against a real Postgres and genuinely
    // concurrent claim attempts -- running test files in parallel workers
    // would let two files' fixtures race each other for no benefit.
    fileParallelism: false,
    // `npm run build` compiles src/__tests__ into dist/__tests__ too (test
    // files aren't excluded from the tsc build, since typecheck needs to
    // still cover them) -- explicitly exclude dist/ so a stale build
    // doesn't get every test double-run, once as .ts and once as the
    // compiled .js sitting in dist/.
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
