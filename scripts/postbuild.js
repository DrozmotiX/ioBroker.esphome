/**
 * Copies files the TypeScript build does not emit into build/:
 * the translations (src/i18n -> build/i18n), loaded by I18n.init().
 */

const fs = require('node:fs/promises');
const path = require('node:path');

/**
 * Copies the translations
 *
 * @returns {Promise<void>}
 */
async function main() {
    const rootDir = path.resolve(__dirname, '..');
    await fs.cp(path.join(rootDir, 'src', 'i18n'), path.join(rootDir, 'build', 'i18n'), {
        recursive: true,
        force: true,
    });
}

main().catch(error => {
    console.error(`postbuild failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
});
