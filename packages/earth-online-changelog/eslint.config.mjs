import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      "node_modules/",
      "dist/",
      ".scratch/",
      ".agents/",
      ".codegraph/",
    ],
  },

  // Base JS/TS recommended rules for all files
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Project-specific overrides
  {
    rules: {
      // --- TypeScript ---
      // Too strict for a project without strict TS compilation
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // Allow async functions without await (valid for returning promises)
      "@typescript-eslint/require-await": "off",
      // Allow non-null assertions where intentional
      "@typescript-eslint/no-non-null-assertion": "warn",
      // Allow namespaces for module augmentation patterns
      "@typescript-eslint/no-namespace": ["error", { allowDeclarations: true }],

      // --- Node.js ---
      // Allow console (this is a CLI/agent extension)
      "no-console": "off",
      // Prefer modern import/export
      "no-restricted-globals": [
        "error",
        { name: "__dirname", message: "Use import.meta.url instead" },
        { name: "__filename", message: "Use import.meta.url instead" },
      ],

      // --- General ---
      "no-debugger": "warn",
      "no-unused-expressions": "warn",
      "no-var": "error",
      "prefer-const": "warn",
      "prefer-template": "warn",
      eqeqeq: ["warn", "always", { null: "ignore" }],
      curly: ["warn", "multi-line"],
    },
  },

  // Test files: relax rules for tests
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },
);
