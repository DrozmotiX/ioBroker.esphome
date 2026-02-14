import eslintConfig from "@iobroker/eslint-config";

export default [
  ...eslintConfig,

  {
    // Ignore patterns (from .eslintignore)
    ignores: ["gulpfile.js", "admin/words.js"],
  },
];
