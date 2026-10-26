import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: [
		"src/**/*.test.ts",
		"index.test.ts",
		],
	},
});
