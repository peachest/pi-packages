import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules/", "dist/", ".scratch/", ".codegraph/"],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/no-namespace": ["error", { allowDeclarations: true }],
      "no-console": "off",
      "no-restricted-globals": [
        "error",
        { name: "__dirname", message: "Use import.meta.url instead" },
        { name: "__filename", message: "Use import.meta.url instead" },
      ],
      "no-debugger": "warn",
      "no-unused-expressions": "warn",
      "no-var": "error",
      "prefer-const": "warn",
      "prefer-template": "warn",
      eqeqeq: ["warn", "always", { null: "ignore" }],
      curly: ["warn", "multi-line"],
    },
  },

  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },
);