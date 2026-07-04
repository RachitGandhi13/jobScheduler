import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./src/__tests__/setup.ts"],
    testTimeout: 20_000,
    fileParallelism: false,
    // `npm run build` compiles src/__tests__ into dist/__tests__ too (test
    // files aren't excluded from the tsc build, since typecheck needs to
    // still cover them) -- explicitly exclude dist/ so a stale build
    // doesn't get every test double-run, once as .ts and once as the
    // compiled .js sitting in dist/.
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
