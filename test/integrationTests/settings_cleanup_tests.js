/**
 * Obsolete Settings Cleanup Integration Test
 *
 * Covers removeObsoleteSettings() in src/main.ts: settings of earlier versions that nothing reads any
 * more are removed from the instance configuration once. These are the inputs and tables of the device
 * tab of 1.0.0 (replaced by the device manager), the default credentials, unused since 0.6, and the inputs
 * of the YAML Files tab.
 *
 * Its own suite on purpose: writing the configuration ends the adapter process (js-controller would
 * restart it), and the harness refuses a second start, see version_migration_tests.js.
 */

const { expect } = require('chai');

const INSTANCE_OBJECT = 'system.adapter.esphome.0';
const OBSOLETE_SETTINGS = [
    'deviceIP',
    'existingDevicesTable',
    'newDevicesTable',
    'apiPassword',
    'apiPass',
    'encryptionKey',
    // Inputs of the YAML Files tab, saved with the configuration
    'uploadFilename',
    'uploadContent',
    'selectedFilename',
    'yamlFilesTable',
];

/**
 * Reads the current native configuration of the adapter instance
 *
 * @param {object} harness - Integration test harness
 * @returns {Promise<Record<string, unknown>>} The instance "native" configuration
 */
async function readNativeConfig(harness) {
    const instance = await harness.objects.getObjectAsync(INSTANCE_OBJECT);
    if (!instance || !instance.native) {
        throw new Error(`Could not read ${INSTANCE_OBJECT}`);
    }
    return instance.native;
}

exports.runTests = function (suite) {
    suite('Obsolete settings cleanup - settings of version 1.0.0', getHarness => {
        it('removes the settings nothing reads any more and keeps all others', async function () {
            this.timeout(120000);

            const harness = getHarness();

            try {
                // An instance configuration as version 1.0.0 saved it
                await harness.changeAdapterConfig('esphome', {
                    native: {
                        ESPHomeDashboardEnabled: false,
                        // Pinned versions, so the version migration has nothing to do
                        ESPHomeDashboardVersion: '2026.6.5',
                        PillowVersion: 'Auto Detect',
                        reconnectInterval: 7,
                        ignoredDevices: [{ 'IP-Address': '192.0.2.1', name: 'Gateway', description: '' }],
                        // Device tab of 1.0.0
                        deviceIP: '192.0.2.10',
                        apiPassword: '',
                        existingDevicesTable: [
                            {
                                MACAddress: 'AA:BB:CC:DD:EE:FF',
                                deviceName: 'kitchen-light',
                                ip: '192.0.2.10',
                                connectState: 'initialized',
                            },
                        ],
                        newDevicesTable: [{ MACAddress: '11:22:33:44:55:66', deviceName: 'garage', ip: '192.0.2.11' }],
                        // Default credentials of the main tab, stored encrypted
                        apiPass: 'encrypted-password',
                        encryptionKey: 'encrypted-key',
                        // Inputs of the YAML Files tab
                        uploadFilename: 'kitchen.yaml',
                        uploadContent: 'esphome:\n  name: kitchen\n',
                        selectedFilename: 'kitchen.yaml',
                        yamlFilesTable: [{ filename: 'kitchen.yaml', size: '24 Bytes', modified: '1/1/2026' }],
                    },
                });

                await harness.startAdapterAndWait();

                let native = await readNativeConfig(harness);
                const deadline = Date.now() + 60000;
                while (OBSOLETE_SETTINGS.some(key => key in native) && Date.now() < deadline) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                    native = await readNativeConfig(harness);
                }

                for (const key of OBSOLETE_SETTINGS) {
                    expect(native, `${key} removed`).to.not.have.property(key);
                }
                expect(native.reconnectInterval).to.equal(7);
                expect(native.ESPHomeDashboardVersion).to.equal('2026.6.5');
                expect(native.ignoredDevices).to.deep.equal([
                    { 'IP-Address': '192.0.2.1', name: 'Gateway', description: '' },
                ]);
            } finally {
                if (harness.isAdapterRunning()) {
                    await harness.stopAdapter();
                }
            }
        });
    });
};
