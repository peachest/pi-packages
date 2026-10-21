import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		// testTimeout is per-test, not per-file: each it() runs one whole fixture
		// suite via execFileSync (its own timeout: 120s) with real git
		// init/commit overhead, so the per-test budget must exceed 120s.
		testTimeout: 300000,
	},
});
