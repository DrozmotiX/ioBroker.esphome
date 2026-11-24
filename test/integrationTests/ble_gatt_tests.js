/**
 * BLE GATT Integration Test
 *
 * Bluetooth proxies with "bluetooth_proxy: active: true" can connect to BLE devices. ioBroker.ble uses them over
 * the gateway interface ble-gateway/1 (src/lib/bleGattBridge.ts, docs/spec-phase-2-gatt.md in ioBroker.ble):
 *
 *   esphome -> ble: gateway:announce (answered with { protocol, epoch }), gateway:connectionState, gateway:notification
 *   ble -> esphome: gatt:connect, gatt:disconnect, gatt:getServices, gatt:read, gatt:write, gatt:subscribe
 *
 * The suite runs the adapter against a fake Bluetooth proxy (fakeBluetoothProxy.js, real API protocol on
 * 127.0.0.1:6053) and takes the place of ioBroker.ble: it answers "gateway:announce", sends the gatt:* commands
 * in the name of ble.0 and reads what the adapter sends back. No Python, no hardware and no ioBroker.ble needed.
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
const BLE_FROM = `system.adapter.${BLE_INSTANCE}`;
const OTHER_FROM = 'system.adapter.test.0';

/** A pvvx thermometer and a second BLE device */
const DEVICE_MAC = 'a4:c1:38:12:34:56';
const DEVICE_ADDRESS = 0xa4c138123456;
const SECOND_MAC = 'a4:c1:38:65:43:21';
const SECOND_ADDRESS = 0xa4c138654321;

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
 * @param {string} hex - Bytes as hex
 * @returns {string} The bytes base64 encoded, as the gateway interface transports them
 */
function base64(hex) {
    return Buffer.from(hex, 'hex').toString('base64');
}

/**
 * Takes the place of ioBroker.ble: answers "gateway:announce", sends gatt:* commands and collects the messages
 */
class FakeBle {
    /**
     * @param {object} harness - Integration test harness
     */
    constructor(harness) {
        this.harness = harness;
        /** Start time ioBroker.ble answers "gateway:announce" with */
        this.epoch = 1000;
        /** Messages without callback ack in the order they arrived: { command, message, from, callback } */
        this.messages = [];
        this.nextId = 1;
        /** @type {Map<number, (message: any) => void>} */
        this.pending = new Map();
        this.onStateChange = (id, message) => {
            if (!message || (id !== `messagebox.${BLE_FROM}` && id !== `messagebox.${OTHER_FROM}`)) {
                return;
            }
            if (message.callback && message.callback.ack) {
                const resolve = this.pending.get(message.callback.id);
                if (resolve) {
                    this.pending.delete(message.callback.id);
                    resolve(message.message);
                }
                return;
            }
            this.messages.push(message);
            if (message.command === 'gateway:announce' && message.callback) {
                this.push(message.from, {
                    command: message.command,
                    message: { error: null, result: { protocol: 'ble-gateway/1', epoch: this.epoch } },
                    from: BLE_FROM,
                    callback: { ...message.callback, ack: true },
                });
            }
        };
        harness.on('stateChange', this.onStateChange);
        harness.dbConnection.subscribeMessage(BLE_FROM);
        harness.dbConnection.subscribeMessage(OTHER_FROM);
    }

    /** Stops collecting */
    close() {
        this.harness.removeListener('stateChange', this.onStateChange);
    }

    /** Forgets the messages received so far */
    clear() {
        this.messages.length = 0;
    }

    /**
     * @param {string} command - e.g. "gateway:announce"
     * @returns {any[]} The payloads of the messages with this command
     */
    received(command) {
        return this.messages.filter(m => m.command === command).map(m => m.message);
    }

    /**
     * @param {string} target - Messagebox, e.g. "system.adapter.esphome.0"
     * @param {object} obj - The message
     */
    push(target, obj) {
        this.harness.dbConnection.pushMessage(target, obj, () => {});
    }

    /**
     * Sends a gatt:* command to the adapter and resolves with its answer
     *
     * @param {string} command - e.g. "gatt:read"
     * @param {object} message - The payload, gatewayId is added
     * @param {string} [from] - Sender, ble.0 by default
     * @param {number} [timeoutMs] - How long to wait for the answer
     * @returns {Promise<{ error: null | { code: string, message: string }, result?: any }>} The answer
     */
    request(command, message, from = BLE_FROM, timeoutMs = 30000) {
        const id = this.nextId++;
        const payload = { gatewayId: PROXY_NAME, ...message };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`No answer to "${command}" within ${timeoutMs}ms`));
            }, timeoutMs);
            this.pending.set(id, answer => {
                clearTimeout(timer);
                resolve(answer);
            });
            this.push(`system.adapter.${NAMESPACE}`, {
                command,
                message: payload,
                from,
                callback: { message: payload, id, ack: false, time: Date.now() },
            });
        });
    }

    /**
     * @param {string} address - MAC address of the BLE device
     * @returns {Promise<any>} The answer to gatt:connect
     */
    connect(address) {
        return this.request('gatt:connect', { address, addressType: 'public', epoch: this.epoch });
    }
}

/**
 * Prepares an adapter instance that knows the fake proxy and forwards to ble.0
 *
 * @param {object} harness - Integration test harness
 */
async function prepareInstance(harness) {
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
            reconnectInterval: 1,
            bleForwardInstance: BLE_INSTANCE,
        },
    });
}

/**
 * Starts the fake proxy and the adapter and waits until the proxy is announced with its free slots
 *
 * @param {object} harness - Integration test harness
 * @returns {Promise<{ proxy: FakeBluetoothProxy, ble: FakeBle }>} The fake proxy and the fake ioBroker.ble
 */
async function startWithProxy(harness) {
    const proxy = new FakeBluetoothProxy({ name: PROXY_NAME, mac: PROXY_MAC });
    await proxy.start();
    await prepareInstance(harness);
    const ble = new FakeBle(harness);
    await harness.startAdapterAndWait();
    await waitFor(async () => {
        const state = await harness.states.getStateAsync(ONLINE_STATE);
        return state && state.val === true;
    }, 'the adapter to connect to the fake Bluetooth proxy');
    await waitFor(
        () => ble.received('gateway:announce').some(m => m.gateways.some(g => g.freeSlots === 3)),
        'the proxy to be announced with its free slots',
    );
    return { proxy, ble };
}

exports.runTests = function (suite) {
    suite('BLE GATT - connections through a Bluetooth proxy', getHarness => {
        let harness;
        let proxy;
        let ble;

        before(async function () {
            this.timeout(90000);
            harness = getHarness();
            ({ proxy, ble } = await startWithProxy(harness));
        });

        after(async () => {
            if (ble) {
                ble.close();
            }
            if (harness && harness.isAdapterRunning()) {
                await harness.stopAdapter();
            }
            if (proxy) {
                await proxy.stop();
            }
        });

        it('announces the proxy as gateway that can connect, with its free slots', function () {
            const announce = ble.messages.find(
                m => m.command === 'gateway:announce' && m.message.gateways.some(g => g.freeSlots === 3),
            );
            expect(announce.from).to.equal(`system.adapter.${NAMESPACE}`);
            expect(announce.callback, 'the answer is awaited').to.be.ok;
            expect(announce.message).to.deep.equal({
                protocol: 'ble-gateway/1',
                gateways: [{ gatewayId: PROXY_NAME, connect: true, freeSlots: 3, slotLimit: 3 }],
            });
        });

        it('connects to a BLE device and announces the slot it takes', async function () {
            this.timeout(60000);
            ble.clear();

            const answer = await ble.connect(DEVICE_MAC);

            expect(answer).to.deep.equal({ error: null, result: { mtu: 247 } });
            expect([...proxy.bleConnections]).to.deep.equal([DEVICE_ADDRESS]);
            await waitFor(
                () => ble.received('gateway:announce').some(m => m.gateways[0].freeSlots === 2),
                'the announcement with one slot less',
            );
        });

        it('lists the services with canonical UUIDs', async function () {
            this.timeout(30000);

            const answer = await ble.request('gatt:getServices', { address: DEVICE_MAC });

            expect(answer).to.deep.equal({
                error: null,
                result: {
                    services: [
                        {
                            uuid: '00001f10-0000-1000-8000-00805f9b34fb',
                            handle: 30,
                            characteristics: [
                                {
                                    uuid: '00001f1f-0000-1000-8000-00805f9b34fb',
                                    handle: 32,
                                    properties: 0x1a,
                                    descriptors: [{ uuid: '00002902-0000-1000-8000-00805f9b34fb', handle: 33 }],
                                },
                            ],
                        },
                    ],
                },
            });
        });

        it('reads and writes a characteristic', async function () {
            this.timeout(30000);
            proxy.setValue(32, '55aa01');

            expect(await ble.request('gatt:read', { address: DEVICE_MAC, handle: 32 })).to.deep.equal({
                error: null,
                result: { data: base64('55aa01') },
            });

            const written = await ble.request('gatt:write', {
                address: DEVICE_MAC,
                handle: 32,
                data: base64('23e8f3a066'),
                withResponse: true,
            });
            expect(written).to.deep.equal({ error: null, result: {} });
            expect(proxy.values.get(32)).to.equal('23e8f3a066');

            expect(await ble.request('gatt:read', { address: DEVICE_MAC, handle: 32 })).to.deep.equal({
                error: null,
                result: { data: base64('23e8f3a066') },
            });
        });

        it('subscribes to notifications and forwards them', async function () {
            this.timeout(30000);
            ble.clear();

            const answer = await ble.request('gatt:subscribe', { address: DEVICE_MAC, handle: 32 });

            expect(answer).to.deep.equal({ error: null, result: {} });
            // Notify (0x10) is set: the CCCD gets 01 00
            await waitFor(() => proxy.descriptorWrites.length > 0, 'the CCCD write');
            expect(proxy.descriptorWrites).to.deep.equal([{ address: DEVICE_ADDRESS, handle: 33, hex: '0100' }]);

            proxy.notify(DEVICE_ADDRESS, 32, '33a10b');
            const notifications = await waitFor(() => {
                const received = ble.received('gateway:notification');
                return received.length > 0 && received;
            }, 'the notification');
            expect(notifications).to.deep.equal([
                { gatewayId: PROXY_NAME, address: DEVICE_MAC, handle: 32, data: base64('33a10b') },
            ]);
        });

        it('reports a connection the BLE device ended', async function () {
            this.timeout(30000);
            ble.clear();

            proxy.dropBleConnection(DEVICE_ADDRESS);

            const states = await waitFor(() => {
                const received = ble.received('gateway:connectionState');
                return received.length > 0 && received;
            }, 'the connection state');
            expect(states).to.deep.equal([{ gatewayId: PROXY_NAME, address: DEVICE_MAC, connected: false, error: 19 }]);

            const answer = await ble.request('gatt:read', { address: DEVICE_MAC, handle: 32 });
            expect(answer.error.code).to.equal('NOT_CONNECTED');
        });

        it('disconnects when asked to, without reporting it back', async function () {
            this.timeout(30000);
            expect((await ble.connect(DEVICE_MAC)).error).to.equal(null);
            ble.clear();

            const answer = await ble.request('gatt:disconnect', { address: DEVICE_MAC });

            expect(answer).to.deep.equal({ error: null, result: {} });
            expect(proxy.bleConnections.size).to.equal(0);
            await delay(1000);
            expect(ble.received('gateway:connectionState')).to.deep.equal([]);
        });

        it('accepts commands only from the configured instance of ioBroker.ble', async function () {
            this.timeout(30000);
            const connects = proxy.gattLog.filter(entry => entry.startsWith('connect')).length;

            const answer = await ble.request(
                'gatt:connect',
                { address: DEVICE_MAC, addressType: 'public', epoch: ble.epoch },
                OTHER_FROM,
            );

            expect(answer.error.code).to.equal('INVALID_PAYLOAD');
            expect(proxy.gattLog.filter(entry => entry.startsWith('connect')).length).to.equal(connects);
        });

        it('reports a failed connection attempt', async function () {
            this.timeout(30000);
            proxy.failNextConnect(133);

            const answer = await ble.connect(DEVICE_MAC);

            expect(answer.error.code).to.equal('CONNECT_FAILED');
            expect(proxy.bleConnections.size).to.equal(0);
        });
    });

    suite('BLE GATT - connections are closed when ioBroker.ble does not need them any more', getHarness => {
        let harness;
        let proxy;
        let ble;

        before(async function () {
            this.timeout(90000);
            harness = getHarness();
            ({ proxy, ble } = await startWithProxy(harness));
        });

        after(async () => {
            if (ble) {
                ble.close();
            }
            if (harness && harness.isAdapterRunning()) {
                await harness.stopAdapter();
            }
            if (proxy) {
                await proxy.stop();
            }
        });

        it('closes the connections when ioBroker.ble stops', async function () {
            this.timeout(30000);
            expect((await ble.connect(DEVICE_MAC)).error).to.equal(null);

            await harness.states.setStateAsync(`${BLE_FROM}.alive`, { val: false, ack: true });

            await waitFor(() => proxy.bleConnections.size === 0, 'the disconnect', 5000);
            expect(proxy.gattLog).to.include(`disconnect ${DEVICE_ADDRESS}`);
        });

        it('closes the connections of an earlier start of ioBroker.ble', async function () {
            this.timeout(30000);
            await harness.states.setStateAsync(`${BLE_FROM}.alive`, { val: true, ack: true });
            expect((await ble.connect(DEVICE_MAC)).error).to.equal(null);

            // ioBroker.ble was restarted: it connects with a new epoch and knows nothing of the first connection
            ble.epoch = 2000;
            expect((await ble.connect(SECOND_MAC)).error).to.equal(null);

            await waitFor(() => !proxy.bleConnections.has(DEVICE_ADDRESS), 'the disconnect of the first device');
            expect([...proxy.bleConnections]).to.deep.equal([SECOND_ADDRESS]);
        });

        it('closes the connections when the adapter stops', async function () {
            this.timeout(30000);

            await harness.stopAdapter();

            expect(proxy.gattLog).to.include(`disconnect ${SECOND_ADDRESS}`);
            expect(proxy.bleConnections.size).to.equal(0);
        });
    });
};
