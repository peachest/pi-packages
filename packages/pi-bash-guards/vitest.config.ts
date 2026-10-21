import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		// P6 矩阵用例涉及真实 git init/commit（fixture 仓库），单文件超时放宽
		testTimeout: 30000,
	},
});
