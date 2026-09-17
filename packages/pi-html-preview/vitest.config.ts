import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// vscode-bridge/*.test.mjs runs under `node --test` (needs a stubbed
		// vscode module via Module._load) — excluded from vitest here
		exclude: ["**/node_modules/**", "**/dist/**", "vscode-bridge/**"],
	},
});
