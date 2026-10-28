/**
 * Known Device Integration Test
 *
 * Covers tryKnownDevices(): devices adopted earlier are loaded from their device objects on start.
 * The name shown for such a device before it connects comes from the device object; it used to be
 * the string "undefined", because native.name was never written.
 *
 * The device points to an address of TEST-NET-1 (RFC 5737), so the adapter never reaches it and
 * the name from the device object is all it knows. No Python environment or ESPHome device is
 * needed, so this suite runs in the regular CI matrix.
 */

const { expect } = require('chai');

const NAMESPACE = 'esphome.0';
const DEVICE_NAME = 'AABBCCDDEEFF';
const DEVICE_IP = '192.0.2.10';

/**
 * Sends a message to the adapter and resolves with its answer
 *
 * @param {object} harness - Integration test harness
 * @param {string} command - Message command
 * @param {object} message - Message payload
 * @param {number} [timeoutMs] - How long to wait for the answer
 * @returns {Promise<any>} The answer of the adapter
 */
function sendToAdapter(harness, command, message, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`No answer to "${command}" within ${timeoutMs}ms`)), timeoutMs);
        harness.sendTo(NAMESPACE, command, message, response => {
            clearTimeout(timer);
            resolve(response);
        });
    });
}

exports.runTests = function (suite) {
    suite('Known devices - device object written before native.name existed', getHarness => {
        let harness;

        before(async function () {
            this.timeout(60000);
            harness = getHarness();

            // Device object as written by earlier versions: native.name is missing
            await harness.objects.setObjectAsync(`${NAMESPACE}.${DEVICE_NAME}`, {
                type: 'device',
                common: { name: 'kitchen-light' },
                native: {
                    ip: DEVICE_IP,
                    mac: 'AA:BB:CC:DD:EE:FF',
                    deviceName: DEVICE_NAME,
                    deviceFriendlyName: 'kitchen-light',
                    encryptionKeyUsed: false,
                },
            });

            // Pinned versions, so the one-time version migration does not restart the adapter
            await harness.changeAdapterConfig('esphome', {
                native: {
                    autodiscovery: false,
                    ESPHomeDashboardEnabled: false,
                    ESPHomeDashboardVersion: '2026.6.5',
                    PillowVersion: '12.2.0',
                },
            });
            await harness.startAdapterAndWait();
        });

        after(async () => {
            if (harness && harness.isAdapterRunning()) {
                await harness.stopAdapter();
            }
        });

        it('lists the known device with its name instead of "undefined"', async function () {
            this.timeout(60000);

            // The known devices are loaded after the start, ask until the device is listed
            let device;
            const deadline = Date.now() + 30000;
            while (!device && Date.now() < deadline) {
                const response = await sendToAdapter(harness, 'loadDevices', {});
                device = response.native.existingDevicesTable.find(entry => entry.ip === DEVICE_IP);
                if (!device) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }

            expect(device, 'known device in the device table').to.be.ok;
            expect(device.deviceName).to.equal('kitchen-light');
        });
    });
};
