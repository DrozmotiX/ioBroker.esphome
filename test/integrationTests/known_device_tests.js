/**
 * Known Device Integration Test
 *
 * Covers the upgrade of existing installations: devices adopted by earlier versions are loaded from
 * their device objects on start (tryKnownDevices()) and listed in the ioBroker device manager
 * (src/lib/deviceManagement.ts). Both object formats are used: 0.6 - 1.0 (no native.name, which
 * made the device show up as "undefined") and 0.3 / 0.4 (API password in native.passWord). The
 * instance settings contain what the removed device tab of 1.0.0 saved.
 *
 * The devices point to addresses of TEST-NET-1 (RFC 5737), so the adapter never reaches them and
 * the names from the device objects are all it knows. The E2E suite covers the reconnect of a device
 * object written by 1.0.0 with a real (encrypted) device. No Python environment or ESPHome device is
 * needed, so this suite runs in the regular CI matrix.
 */

const { expect } = require('chai');
const { NAMESPACE, addDeviceWithDeviceManager, sendToAdapter } = require('./deviceManagerHelpers');

const DEVICE_NAME = 'AABBCCDDEEFF';
const DEVICE_IP = '192.0.2.10';
// Device added by version 0.3 / 0.4, those stored the API password in native.passWord
const OLD_DEVICE_NAME = '112233445566';
const OLD_DEVICE_IP = '192.0.2.11';

exports.runTests = function (suite) {
    suite('Known devices - device objects and settings of earlier versions', getHarness => {
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

            // Device object as written by version 0.3 / 0.4
            await harness.objects.setObjectAsync(`${NAMESPACE}.${OLD_DEVICE_NAME}`, {
                type: 'device',
                common: { name: 'garage-door' },
                native: {
                    ip: OLD_DEVICE_IP,
                    name: 'garage-door',
                    mac: '11:22:33:44:55:66',
                    deviceName: OLD_DEVICE_NAME,
                    // Encrypted by the adapter, the value does not matter as the device is never reached
                    passWord: 'not-a-real-encrypted-password',
                },
            });

            // Pinned versions, so the one-time version migration does not restart the adapter
            await harness.changeAdapterConfig('esphome', {
                native: {
                    autodiscovery: false,
                    ESPHomeDashboardEnabled: false,
                    ESPHomeDashboardVersion: '2026.6.5',
                    PillowVersion: '12.2.0',
                    // Saved by the device tab of the 1.0.0 settings, no longer used
                    deviceIP: DEVICE_IP,
                    apiPassword: '',
                    existingDevicesTable: [
                        {
                            MACAddress: 'AA:BB:CC:DD:EE:FF',
                            deviceName: 'kitchen-light',
                            ip: DEVICE_IP,
                            connectState: 'unreachable',
                        },
                    ],
                    newDevicesTable: [],
                },
            });
            await harness.startAdapterAndWait();
        });

        after(async () => {
            if (harness && harness.isAdapterRunning()) {
                await harness.stopAdapter();
            }
        });

        it('offers adding devices in the device manager', async function () {
            this.timeout(60000);

            const info = await sendToAdapter(harness, 'dm:instanceInfo', {});

            expect(info.apiVersion).to.equal('v3');
            expect(info.actions.map(action => action.id)).to.deep.equal(['add']);
            // Translations come from build/i18n, copied there by scripts/postbuild.js
            expect(info.actions[0].title).to.deep.include({ en: 'Add device', de: 'Gerät hinzufügen' });
        });

        it('lists the known device with its name instead of "undefined"', async function () {
            this.timeout(60000);

            // The known devices are loaded after the start, ask until the device is listed
            let device;
            const deadline = Date.now() + 30000;
            while (!device && Date.now() < deadline) {
                const response = await sendToAdapter(harness, 'dm:loadDevices', {});
                device = response.add.find(entry => entry.id === DEVICE_IP);
                if (!device) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }

            expect(device, 'known device in the device manager').to.be.ok;
            expect(device.name).to.equal('kitchen-light');
            expect(device.group.key).to.equal('known');
            expect(device.status.connection.stateId).to.equal(`${NAMESPACE}.${DEVICE_NAME}.info._online`);
            expect(device.actions.map(action => action.id)).to.deep.equal(['edit', 'delete']);
        });

        it('lists a device added by version 0.3 / 0.4 in the device manager', async function () {
            this.timeout(60000);

            const response = await sendToAdapter(harness, 'dm:loadDevices', {});
            const device = response.add.find(entry => entry.id === OLD_DEVICE_IP);

            expect(device, 'old device in the device manager').to.be.ok;
            expect(device.name).to.equal('garage-door');
            expect(device.group.key).to.equal('known');
            expect(device.status.connection.stateId).to.equal(`${NAMESPACE}.${OLD_DEVICE_NAME}.info._online`);
            expect(device.actions.map(action => action.id)).to.deep.equal(['edit', 'delete']);
        });

        it('walks through the add dialog of the device manager and reports an invalid IP address', async function () {
            this.timeout(60000);

            // Same dialog sequence the E2E test uses to add its device, which needs a compiled ESPHome device
            const { messages, result } = await addDeviceWithDeviceManager(harness, {
                ip: 'not-an-ip',
                encryptionKey: '',
                apiPassword: '',
            });

            expect(messages).to.deep.equal([
                'Format of IP-Address is incorrect, please provide an valid IPV4 IP-Address',
            ]);
            expect(result).to.deep.equal({ refresh: false });
        });

        it('deletes the device from the device manager after confirmation', async function () {
            this.timeout(60000);

            // Actions are only accepted for devices of the last loaded list
            await sendToAdapter(harness, 'dm:loadDevices', {});
            const confirm = await sendToAdapter(harness, 'dm:deviceAction', {
                deviceId: DEVICE_IP,
                actionId: 'delete',
            });
            expect(confirm.type).to.equal('confirm');

            const result = await sendToAdapter(harness, 'dm:actionProgress', { origin: confirm.origin, confirm: true });
            expect(result.type).to.equal('result');
            expect(result.result).to.deep.equal({ refresh: 'devices' });

            expect(await harness.objects.getObjectAsync(`${NAMESPACE}.${DEVICE_NAME}`)).to.not.be.ok;
            const response = await sendToAdapter(harness, 'dm:loadDevices', {});
            expect(response.add.find(entry => entry.id === DEVICE_IP)).to.be.undefined;
        });
    });
};
