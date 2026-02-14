import tsParser from "@typescript-eslint/parser";

export default [
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { parser: tsParser },
    rules: {
      "no-use-before-define": ["error", {
        functions: false,
        classes: false,
        variables: true,
        allowNamedExports: true,
      }],
    },
  },
];
