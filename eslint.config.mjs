// ioBroker eslint template configuration file for js and ts files
// Please note that esm or react based modules need additional modules loaded.
import config from '@iobroker/eslint-config';

export default [
    ...config,
    {
        // specify files to exclude from linting here
        ignores: [
            '.dev-server/',
            '.vscode/',
            '*.test.js',
            'test/**/*.js',
            '*.config.mjs',
            'build',
            'dist',
            'admin/blockly.js',
            '**/adapter-config.d.ts',
            'widgets/**/*.js',
        ],
    },
    {
        // you may disable some 'jsdoc' warnings - but using jsdoc is highly recommended
        // as this improves maintainability. jsdoc warnings will not block build process.
        rules: {
            // 'jsdoc/require-jsdoc': 'off',
            // 'jsdoc/require-param': 'off',
            // 'jsdoc/require-param-description': 'off',
            // 'jsdoc/require-returns-description': 'off',
            // 'jsdoc/require-returns-check': 'off',
        },
    },
    {
        // Files taken over 1:1 from the JavaScript code of v2 that are not migrated to TypeScript yet.
        // They start with "// @ts-nocheck", and these rules only make sense for real TypeScript code.
        // Remove a file from this list (and its "// @ts-nocheck") when migrating it.
        files: [
            'src/main.ts',
            'src/lib/dashboardApi.ts',
            'src/lib/yamlFileManager.ts',
            'src/lib/dashboardApi.test.ts',
            'src/lib/yamlFileManager.test.ts',
        ],
        rules: {
            '@typescript-eslint/ban-ts-comment': 'off',
            '@typescript-eslint/no-require-imports': 'off',
            '@typescript-eslint/explicit-function-return-type': 'off',
            '@typescript-eslint/restrict-template-expressions': 'off',
            '@typescript-eslint/require-await': 'off',
            '@typescript-eslint/dot-notation': 'off',
            '@typescript-eslint/no-base-to-string': 'off',
            '@typescript-eslint/no-floating-promises': 'off',
            '@typescript-eslint/no-for-in-array': 'off',
            // JSDoc carries the types in JavaScript, and the JSDoc casts need their parentheses
            'jsdoc/no-types': 'off',
            'jsdoc/check-tag-names': 'off',
            'prettier/prettier': 'off',
        },
    },
];
