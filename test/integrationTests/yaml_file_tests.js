/**
 * YAML Files tab (issue #419)
 *
 * The admin UI talks to the adapter with sendTo (getYamlFileList, uploadYamlFile, ...).
 * Earlier fixes only unit-tested YamlFileManager with a fake directory and with I18n already
 * initialized by other tests, so they never saw:
 * - I18n.translate() throwing when init() has not finished, which made getYamlFileList answer
 *   { error } instead of { text } and left the tab empty
 * - the real ESPHome directory (getAbsoluteDefaultDataDir() has no trailing slash)
 *
 * No Python / dashboard is needed: files are written to the instance data directory.
 */

const { expect } = require('chai');
const { mkdir, writeFile, readFile } = require('node:fs/promises');
const path = require('node:path');
const { sendToAdapter } = require('./deviceManagerHelpers');

// Same installation @iobroker/testing uses (see AGENTS.md). Do not call
// getAbsoluteDefaultDataDir() here: requiring adapter-core in the mocha process
// exits with "Cannot find js-controller".
const ESPHOME_DIR = path.join('/tmp/test-iobroker.esphome', 'iobroker-data', 'esphome.0');

exports.runTests = function (suite) {
    suite('YAML file management - sendTo of the YAML Files tab', getHarness => {
        let harness;

        before(async function () {
            this.timeout(60000);
            harness = getHarness();
            await harness.changeAdapterConfig('esphome', {
                native: {
                    autodiscovery: false,
                    ESPHomeDashboardEnabled: false,
                    ESPHomeDashboardVersion: '2026.6.5',
                    PillowVersion: 'Auto Detect',
                },
            });
            await harness.enableSendTo();
            await harness.startAdapterAndWait();
        });

        after(async function () {
            this.timeout(30000);
            if (harness && harness.isAdapterRunning()) {
                await harness.stopAdapter();
            }
        });

        it('lists a YAML file that already exists in the ESPHome directory', async function () {
            this.timeout(30000);
            await mkdir(ESPHOME_DIR, { recursive: true });
            await writeFile(path.join(ESPHOME_DIR, 'existing.yaml'), 'esphome:\n  name: existing\n', 'utf8');

            const list = await sendToAdapter(harness, 'getYamlFileList', null);
            expect(list, JSON.stringify(list)).to.have.property('text').that.includes('existing.yaml');
            expect(list).to.not.have.property('error');

            const options = await sendToAdapter(harness, 'getYamlFileOptions', null);
            expect(options).to.be.an('array');
            expect(options.map(entry => entry.value)).to.include('existing.yaml');
        });

        it('uploads multi-line YAML, loads it back and deletes it', async function () {
            this.timeout(30000);
            const content = 'esphome:\n  name: "kitchen"\n  friendly_name: Kitchen\n';

            const upload = await sendToAdapter(harness, 'uploadYamlFile', {
                filename: 'kitchen.yaml',
                content,
            });
            expect(upload, JSON.stringify(upload)).to.have.nested.property('native._selectedFilename', 'kitchen.yaml');
            expect(await readFile(path.join(ESPHOME_DIR, 'kitchen.yaml'), 'utf8')).to.equal(content);

            const loaded = await sendToAdapter(harness, 'loadYamlFile', { filename: 'kitchen.yaml' });
            expect(loaded).to.deep.equal({
                native: { _uploadFilename: 'kitchen.yaml', _uploadContent: content },
            });

            const list = await sendToAdapter(harness, 'getYamlFileList', null);
            expect(list).to.have.property('text').that.includes('kitchen.yaml');

            const deletion = await sendToAdapter(harness, 'deleteYamlFile', { filename: 'kitchen.yaml' });
            expect(deletion).to.have.nested.property('native._selectedFilename', '');

            const after = await sendToAdapter(harness, 'getYamlFileList', null);
            expect(after).to.have.property('text').that.does.not.include('kitchen.yaml');
        });
    });
};
