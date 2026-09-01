import eslint from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
  // src/shared is the build's copy of ../shared, linted with the app.
  {ignores: ["src/shared/**"]},
  eslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        console: "readonly",
        __dirname: "readonly",
        exports: "writable",
        fetch: "readonly",
        require: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      "@typescript-eslint/adjacent-overload-signatures": "error",
      "@typescript-eslint/no-empty-function": "error",
      "@typescript-eslint/no-empty-object-type": "warn",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-namespace": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/prefer-for-of": "warn",
      "@typescript-eslint/triple-slash-reference": "error",
      "@typescript-eslint/unified-signatures": "warn",
      "comma-dangle": ["error", "always-multiline"],
      "no-invalid-this": "error",
      "no-unused-vars": ["error", {"argsIgnorePattern": "^_"}],
      "no-param-reassign": "error",
      "no-shadow": ["error", {"hoist": "all"}],
      "no-throw-literal": "error",
      "no-void": "error",
    },
  },
];
