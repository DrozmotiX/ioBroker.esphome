import eslintConfig from "@iobroker/eslint-config";
import globals from "globals";

export default [
  ...eslintConfig,

  {
    // Ignore patterns (from .eslintignore)
    ignores: ["gulpfile.js", "admin/words.js"],
  },

  // Add mocha globals for test files
  {
    files: ["**/*.test.js", "test/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.mocha,
      },
    },
  },
];
