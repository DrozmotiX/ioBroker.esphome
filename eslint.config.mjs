import eslintConfig from '@iobroker/eslint-config';
import globals from 'globals';

export default [
    ...eslintConfig,

    {
        // Ignore patterns (from .eslintignore)
        ignores: ['.dev-server/**', '.devcontainer/**'],
    },

    {
        // @iobroker/eslint-config builds on jsdoc's "recommended-typescript" preset, which reports
        // "@type" and "@typedef" as redundant because TypeScript would carry the type itself. This
        // adapter is plain JavaScript, type checked through "checkJs" (see tsconfig.json and
        // "npm run check"), so JSDoc is the only place a type can be expressed.
        files: ['**/*.js'],
        rules: {
            'jsdoc/check-tag-names': ['error', { typed: false }],
        },
    },

    // Add mocha globals for test files
    {
        files: ['**/*.test.js', 'test/**/*.js'],
        languageOptions: {
            globals: {
                ...globals.mocha,
            },
        },
    },
];
