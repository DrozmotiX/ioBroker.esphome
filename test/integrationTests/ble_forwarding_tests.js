/**
 * BLE Forwarding Integration Test
 *
 * Devices with the bluetooth_proxy component receive the advertisements of BLE devices around them. With
 * "Forward BLE advertisements to" set, the adapter asks them for these advertisements and delivers them to
 * the ioBroker.ble adapter over its gateway interface (src/lib/bleForwarder.ts):
 *
 *   sendTo('ble.0', 'gateway:advertisements', { gatewayId, items: [{ address, addressType, rssi, data }] })
 *
 * The suite runs the adapter against a fake Bluetooth proxy (fakeBluetoothProxy.js, real API protocol on
 * 127.0.0.1:6053) and takes the place of ioBroker.ble by reading the messages sent to "ble.0". It checks the
 * whole way: subscription at the device, batching, the payload arriving unchanged, a reconnect and the stop.
 * No Python and no hardware are needed, so it runs in the regular CI matrix.
 */

const { expect } = require('chai');
const { NAMESPACE } = require('./deviceManagerHelpers');
const { FakeBluetoothProxy } = require('./fakeBluetoothProxy');

const PROXY_NAME = 'proxy-og';
const PROXY_MAC = '02:B1:E0:00:00:01';
const PROXY_ID = '02B1E0000001';
const PROXY_HOST = '127.0.0.1';
const ONLINE_STATE = `${NAMESPACE}.${PROXY_ID}.info._online`;

const BLE_INSTANCE = 'ble.0';

/** Real payloads: a BTHome v2 thermometer (battery 100 %, 25.00 °C, 50.55 %) and a RuuviTag (data format 3) */
const BTHOME_HEX = '0201060e16d2fc4000a5016402c40903bf13';
const RUUVI_HEX = '02010611ff990403581b08baa8ffc3004303f90bb3';

/**
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Polls until the check returns a truthy value
 *
 * @param {() => any} check - Returns the result once the condition is met, a falsy value otherwise
 * @param {string} description - Used in the timeout error
 * @param {number} [timeoutMs] - How long to wait before giving up
 * @returns {Promise<any>} The first truthy result of check
 */
async function waitFor(check, description, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    do {
        const result = await check();
        if (result) {
            return result;
        }
        await delay(100);
    } while (Date.now() < deadline);
    throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`);
}

/**
 * Takes the place of ioBroker.ble: collects the messages the adapter sends to its instance
 */
class BleInbox {
    /**
     * @param {object} harness - Integration test harness
     */
    constructor(harness) {
        /** Messages in the order they arrived: { command, message, from, callback } */
        this.messages = [];
        this.harness = harness;
        this.onStateChange = (id, message) => {
            if (id === `messagebox.system.adapter.${BLE_INSTANCE}` && message) {
                this.messages.push(message);
            }
        };
        harness.on('stateChange', this.onStateChange);
        harness.dbConnection.subscribeMessage(`system.adapter.${BLE_INSTANCE}`);
    }

    /** Stops collecting */
    close() {
        this.harness.removeListener('stateChange', this.onStateChange);
    }

    /** Forgets the messages received so far */
    clear() {
        this.messages.length = 0;
    }

    /** Batches with advertisements, without the empty ones that only tell a gateway is there */
    get batches() {
        return this.messages.map(entry => entry.message).filter(message => message.items.length > 0);
    }
}

/**
 * Prepares an adapter instance that knows the fake proxy, like after the device was added in the device manager
 *
 * @param {object} harness - Integration test harness
 * @param {Record<string, unknown>} native - Instance settings in addition to the defaults of the tests
 */
async function prepareInstance(harness, native) {
    await harness.objects.setObjectAsync(`${NAMESPACE}.${PROXY_ID}`, {
        type: 'device',
        common: { name: PROXY_NAME },
        native: {
            ip: PROXY_HOST,
            name: PROXY_NAME,
            mac: PROXY_MAC,
            deviceName: PROXY_ID,
            deviceFriendlyName: PROXY_NAME,
            encryptionKeyUsed: false,
        },
    });
    await harness.changeAdapterConfig('esphome', {
        native: {
            autodiscovery: false,
            ESPHomeDashboardEnabled: false,
            // Pinned versions, so the one-time version migration does not restart the adapter
            ESPHomeDashboardVersion: '2026.6.5',
            PillowVersion: 'Auto Detect',
            // Reconnect quickly after the test cut the connection
            reconnectInterval: 1,
            ...native,
        },
    });
}

/**
 * @param {object} harness - Integration test harness
 * @returns {Promise<void>} Resolves once the adapter is connected to the fake proxy
 */
async function waitForProxyOnline(harness) {
    await waitFor(async () => {
        const state = await harness.states.getStateAsync(ONLINE_STATE);
        return state && state.val === true;
    }, 'the adapter to connect to the fake Bluetooth proxy');
}

exports.runTests = function (suite) {
    suite('BLE forwarding - advertisements of a Bluetooth proxy are delivered to ioBroker.ble', getHarness => {
        let harness;
        let proxy;
        let inbox;

        before(async function () {
            this.timeout(60000);
            harness = getHarness();
            proxy = new FakeBluetoothProxy({ name: PROXY_NAME, mac: PROXY_MAC });
            await proxy.start();

            await prepareInstance(harness, { bleForwardInstance: BLE_INSTANCE });
            inbox = new BleInbox(harness);
            await harness.startAdapterAndWait();
        });

        after(async () => {
            if (inbox) {
                inbox.close();
            }
            if (harness && harness.isAdapterRunning()) {
                await harness.stopAdapter();
            }
            if (proxy) {
                await proxy.stop();
            }
        });

        it('asks the proxy for the advertisements it receives, as raw payload', async function () {
            this.timeout(60000);

            await waitForProxyOnline(harness);
            await waitFor(() => proxy.subscribed, 'the adapter to subscribe to the advertisements');

            // Flag 1 = raw advertisements: the payload as received, not parsed by the device
            expect(proxy.subscriptions).to.deep.equal([1]);
        });

        it('announces the proxy as gateway, named after the device', async function () {
            this.timeout(60000);

            const announcement = await waitFor(() => inbox.messages[0], 'the first message to ioBroker.ble');

            expect(announcement.command).to.equal('gateway:advertisements');
            expect(announcement.from).to.equal(`system.adapter.${NAMESPACE}`);
            // No BLE device was received yet: the empty batch only tells ioBroker.ble the gateway is there
            expect(announcement.message).to.deep.equal({ gatewayId: PROXY_NAME, items: [] });
            // Nothing is awaited from ioBroker.ble, it may not even be running
            expect(announcement.callback, 'callback of the message').to.not.be.ok;
        });

        it('delivers the advertisements of several BLE devices in one message, payload unchanged', async function () {
            this.timeout(60000);
            inbox.clear();

            // The proxy sends what it receives in small batches, BLE devices repeat themselves
            proxy.sendAdvertisements([
                { address: 0xa4c138123456, rssi: -70, addressType: 0, hex: BTHOME_HEX },
                { address: 0xc0cd266001a0, rssi: -91, addressType: 1, hex: RUUVI_HEX },
            ]);
            proxy.sendAdvertisements([{ address: 0xa4c138123456, rssi: -67, addressType: 0, hex: BTHOME_HEX }]);

            await waitFor(() => inbox.batches.length > 0, 'the advertisements to be delivered');
            // Everything received within the batch interval arrives together
            await delay(600);
            expect(inbox.batches).to.have.length(1);

            expect(inbox.batches[0]).to.deep.equal({
                gatewayId: PROXY_NAME,
                items: [
                    {
                        // The repeated advertisement is delivered once, with the signal strength measured last
                        address: 'a4:c1:38:12:34:56',
                        addressType: 'public',
                        rssi: -67,
                        data: Buffer.from(BTHOME_HEX, 'hex').toString('base64'),
                    },
                    {
                        address: 'c0:cd:26:60:01:a0',
                        addressType: 'random',
                        rssi: -91,
                        data: Buffer.from(RUUVI_HEX, 'hex').toString('base64'),
                    },
                ],
            });
        });

        it('delivers a new measurement of a BLE device with the next message', async function () {
            this.timeout(60000);
            inbox.clear();

            // Packet 0xa6: 25.50 °C, 49.00 %
            const next = '0201060e16d2fc4000a6016402f609032413';
            proxy.sendAdvertisements([{ address: 0xa4c138123456, rssi: -66, hex: next }]);

            await waitFor(() => inbox.batches.length > 0, 'the advertisement to be delivered');
            expect(inbox.batches[0].items).to.deep.equal([
                {
                    address: 'a4:c1:38:12:34:56',
                    addressType: 'public',
                    rssi: -66,
                    data: Buffer.from(next, 'hex').toString('base64'),
                },
            ]);
        });

        it('subscribes again after the connection to the proxy was lost', async function () {
            this.timeout(60000);
            inbox.clear();

            proxy.dropConnections();
            await waitFor(() => proxy.subscriptions.length === 2, 'the adapter to reconnect and subscribe again');
            expect(proxy.subscriptions).to.deep.equal([1, 1]);

            // The gateway is announced again, advertisements are delivered again
            await waitFor(
                () => inbox.messages.some(entry => entry.message.items.length === 0),
                'the gateway to be announced again',
            );
            proxy.sendAdvertisements([{ address: 0xa4c138123456, rssi: -64, hex: BTHOME_HEX }]);
            await waitFor(() => inbox.batches.length > 0, 'the advertisement to be delivered');
            expect(inbox.batches[0].items[0]).to.include({ address: 'a4:c1:38:12:34:56', rssi: -64 });
        });

        it('tells the proxy to stop sending advertisements when the adapter stops', async function () {
            this.timeout(60000);
            expect(proxy.unsubscriptions).to.equal(0);

            await harness.stopAdapter();

            await waitFor(() => proxy.unsubscriptions === 1, 'the adapter to unsubscribe');
        });
    });

    suite('BLE forwarding - not enabled', getHarness => {
        let harness;
        let proxy;
        let inbox;

        before(async function () {
            this.timeout(60000);
            harness = getHarness();
            proxy = new FakeBluetoothProxy({ name: PROXY_NAME, mac: PROXY_MAC });
            await proxy.start();

            // The default: no instance of ioBroker.ble is selected
            await prepareInstance(harness, { bleForwardInstance: '' });
            inbox = new BleInbox(harness);
            await harness.startAdapterAndWait();
        });

        after(async () => {
            if (inbox) {
                inbox.close();
            }
            if (harness && harness.isAdapterRunning()) {
                await harness.stopAdapter();
            }
            if (proxy) {
                await proxy.stop();
            }
        });

        it('connects to the proxy without asking for its advertisements', async function () {
            this.timeout(60000);

            await waitForProxyOnline(harness);
            // Device information of the proxy, the device is fully initialized
            await waitFor(async () => {
                const state = await harness.states.getStateAsync(
                    `${NAMESPACE}.${PROXY_ID}.info.bluetoothProxyFeatureFlags`,
                );
                return state && state.val > 0;
            }, 'the device information of the proxy');
            await delay(2000);

            expect(proxy.subscriptions).to.deep.equal([]);
            expect(inbox.messages).to.deep.equal([]);
        });
    });

    suite('BLE forwarding - device without bluetooth_proxy', getHarness => {
        let harness;
        let device;
        let inbox;

        before(async function () {
            this.timeout(60000);
            harness = getHarness();
            device = new FakeBluetoothProxy({ name: PROXY_NAME, mac: PROXY_MAC, featureFlags: 0 });
            await device.start();

            await prepareInstance(harness, { bleForwardInstance: BLE_INSTANCE });
            inbox = new BleInbox(harness);
            await harness.startAdapterAndWait();
        });

        after(async () => {
            if (inbox) {
                inbox.close();
            }
            if (harness && harness.isAdapterRunning()) {
                await harness.stopAdapter();
            }
            if (device) {
                await device.stop();
            }
        });

        it('is not asked for advertisements and not announced as gateway', async function () {
            this.timeout(60000);

            await waitForProxyOnline(harness);
            await waitFor(
                () => harness.states.getStateAsync(`${NAMESPACE}.${PROXY_ID}.info.name`),
                'the device information',
            );
            await delay(2000);

            expect(device.subscriptions).to.deep.equal([]);
            expect(inbox.messages).to.deep.equal([]);
        });
    });
};
