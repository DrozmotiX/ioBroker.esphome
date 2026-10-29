/**
 * End-to-end test against a real ESPHome device
 *
 * test/e2e/esphome-device.yaml is compiled with the ESPHome "host" platform into a native
 * executable. That is real ESPHome firmware with a real native API server (Noise encryption
 * included), it only runs on the CI runner instead of an ESP32. This suite starts that executable,
 * adds it with the "Add device" dialog of the device manager, and then checks both directions:
 *
 *   device -> ioBroker: device object, info states and every entity type end up as states
 *   ioBroker -> device: writing a state (ack=false) sends a command, the device executes it and the
 *                       confirmed value comes back as ack=true
 *
 * Finally the device process is killed and restarted to check the reconnect handling.
 *
 * Building the device needs Python + ESPHome + a C++ toolchain, so the suite is skipped unless
 * ESPHOME_E2E_DEVICE_BINARY points to the compiled executable. It runs in the "E2E" workflow
 * (.github/workflows/e2e.yml), or locally:
 *
 *   pip install esphome
 *   esphome compile test/e2e/esphome-device.yaml
 *   npm run build
 *   ESPHOME_E2E_DEVICE_BINARY=test/e2e/.esphome/build/iobroker-e2e/.pioenvs/iobroker-e2e/program \
 *       npm run test:integration
 */

const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const { expect } = require('chai');
const { NAMESPACE, addDeviceWithDeviceManager, encryptLikeAdapter, sendToAdapter } = require('./deviceManagerHelpers');

// Keep in sync with test/e2e/esphome-device.yaml
const DEVICE_HOST = '127.0.0.1';
const DEVICE_PORT = 6053;
const DEVICE_NAME = 'iobroker-e2e';
const DEVICE_ID = '02E2E0000001'; // MAC 02:E2:E0:00:00:01 without colons
const ENCRYPTION_KEY = '4lNKgD7rXHge2t304JyBOw4qVOF4rY8dphuqyHuDnu4=';

const DEVICE_PREFIX = `${NAMESPACE}.${DEVICE_ID}`;
const ONLINE_STATE = `${DEVICE_PREFIX}.info._online`;

/**
 * Sleeps for the given time
 *
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Polls until the check returns a truthy value
 *
 * @param {() => Promise<any>} check - Returns the result once the condition is met, a falsy value otherwise
 * @param {string} description - Used in the timeout error
 * @param {number} [timeoutMs] - How long to wait before giving up
 * @returns {Promise<any>} The first truthy result of check
 * @throws {Error} When the condition was not met within the timeout
 */
async function waitFor(check, description, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    do {
        try {
            const result = await check();
            if (result) {
                return result;
            }
        } catch (error) {
            lastError = error;
        }
        await delay(250);
    } while (Date.now() < deadline);
    throw new Error(
        `Timed out after ${timeoutMs}ms waiting for ${description}${lastError ? ` (last error: ${lastError})` : ''}`,
    );
}

/**
 * Waits until a state has the expected value with ack=true, i.e. it was confirmed by the device
 *
 * @param {object} harness - Integration test harness
 * @param {string} id - Full state ID
 * @param {(val: any) => boolean} matches - Checks the value
 * @param {string} description - Used in the timeout error
 * @param {number} [timeoutMs] - How long to wait before giving up
 * @returns {Promise<ioBroker.State>} The matching state
 */
async function waitForAckedState(harness, id, matches, description, timeoutMs = 30000) {
    let last;
    try {
        return await waitFor(
            async () => {
                last = await harness.states.getStateAsync(id);
                return last && last.ack === true && matches(last.val) ? last : null;
            },
            `${id} ${description}`,
            timeoutMs,
        );
    } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : error}, last state: ${JSON.stringify(last)}`);
    }
}

/**
 * Checks whether something accepts TCP connections on the given port
 *
 * @param {string} host - Host to connect to
 * @param {number} port - Port to connect to
 * @returns {Promise<boolean>} true when the connection succeeded
 */
function isPortOpen(host, port) {
    return new Promise(resolve => {
        const socket = net.connect({ host, port });
        const done = result => {
            socket.destroy();
            resolve(result);
        };
        socket.setTimeout(1000, () => done(false));
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
    });
}

/**
 * Runs the compiled ESPHome host executable and keeps its output for failure analysis
 */
class EsphomeDevice {
    /**
     * @param {string} binary - Path to the compiled ESPHome host executable
     */
    constructor(binary) {
        this.binary = path.resolve(binary);
        this.process = null;
        this.output = [];
    }

    /** Starts the device and waits until its API port accepts connections */
    async start() {
        if (await isPortOpen(DEVICE_HOST, DEVICE_PORT)) {
            throw new Error(`Port ${DEVICE_PORT} is already in use, is another ESPHome device running?`);
        }
        const child = spawn(this.binary, [], { stdio: ['ignore', 'pipe', 'pipe'] });
        this.process = child;
        const collect = chunk => {
            this.output.push(...chunk.toString().split('\n').filter(Boolean));
            // Only the tail is interesting when something fails
            if (this.output.length > 500) {
                this.output.splice(0, this.output.length - 500);
            }
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        child.once('exit', (code, signal) => {
            this.output.push(`<device process exited, code ${code}, signal ${signal}>`);
            if (this.process === child) {
                this.process = null;
            }
        });

        await waitFor(
            async () => {
                if (!this.process) {
                    throw new Error('device process exited during start');
                }
                return isPortOpen(DEVICE_HOST, DEVICE_PORT);
            },
            `ESPHome device API on ${DEVICE_HOST}:${DEVICE_PORT}`,
            15000,
        );
    }

    /** Stops the device the hard way, like pulling the plug */
    async stop() {
        const child = this.process;
        if (!child) {
            return;
        }
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGKILL');
        await exited;
        await waitFor(async () => !(await isPortOpen(DEVICE_HOST, DEVICE_PORT)), 'device port to close', 10000);
    }

    /** Prints the last lines the device logged */
    dumpLog() {
        console.log(`----- last ESPHome device output (${this.binary}) -----`);
        for (const line of this.output.slice(-100)) {
            console.log(`  ${line}`);
        }
        console.log('----- end of ESPHome device output -----');
    }
}

/**
 * Finds the state prefix of an entity by its ESPHome name, e.g. esphome.0.02E2E0000001.Switch.123456
 *
 * Entity keys are hashes calculated by ESPHome, so the test looks them up instead of hard coding them.
 *
 * @param {object} harness - Integration test harness
 * @param {string} type - Entity type as reported by the API (Switch, Sensor, ...)
 * @param {string} name - Entity name from the YAML
 * @returns {Promise<string>} The ID of the entity channel
 */
async function findEntity(harness, type, name) {
    return waitFor(async () => {
        const view = await harness.objects.getObjectViewAsync('system', 'channel', {
            startkey: `${DEVICE_PREFIX}.${type}.`,
            endkey: `${DEVICE_PREFIX}.${type}.香`,
        });
        const row = view.rows.find(
            r => r.id.split('.').length === 5 && r.value && r.value.common && r.value.common.name === name,
        );
        return row ? row.id : null;
    }, `${type} entity "${name}"`);
}

/**
 * Writes a command like a user or script would (ack=false)
 *
 * @param {object} harness - Integration test harness
 * @param {string} id - Full state ID
 * @param {any} val - Value to write
 */
async function writeCommand(harness, id, val) {
    await harness.states.setStateAsync(id, { val, ack: false });
}

exports.runTests = function (suite) {
    suite('E2E - real ESPHome device (host platform)', getHarness => {
        const binary = process.env.ESPHOME_E2E_DEVICE_BINARY;
        const device = new EsphomeDevice(binary || '');
        let harness;

        before(async function () {
            this.timeout(120000);
            harness = getHarness();

            await harness.changeAdapterConfig('esphome', {
                native: {
                    // Keep the test independent of the network, the device is added by IP below
                    autodiscovery: false,
                    ESPHomeDashboardEnabled: false,
                    configStates: true,
                    reconnectInterval: 2,
                    pingInterval: 2,
                    pingAttempts: 1,
                },
            });

            await device.start();
            await harness.enableSendTo();
            await harness.startAdapterAndWait();

            // onReady connects all devices already known in the object tree. Adding the device before
            // that finished would let tryKnownDevices() pick up the freshly created device object and
            // open a second connection, so wait for the last object onReady creates.
            await waitFor(
                () => harness.objects.getObjectAsync(`${NAMESPACE}.info.deviceCleanup`),
                'adapter startup (onReady) to finish',
                60000,
            );

            // Same dialog a user goes through when adding a device manually
            const { messages, result } = await addDeviceWithDeviceManager(harness, {
                ip: DEVICE_HOST,
                encryptionKey: ENCRYPTION_KEY,
                apiPassword: '',
            });
            console.log(`Device manager answered ${JSON.stringify(messages)}`);
            expect(result, 'result of the add action').to.deep.equal({ refresh: true });
            expect(messages, 'adding the device failed').to.have.lengthOf(1);
            expect(messages[0]).to.match(/^OK - Device successfully connected/);

            await waitForAckedState(harness, ONLINE_STATE, val => val === true, 'to be true', 60000);
        });

        afterEach(function () {
            if (this.currentTest && this.currentTest.state === 'failed') {
                device.dumpLog();
            }
        });

        after(async function () {
            this.timeout(30000);
            try {
                if (harness && harness.isAdapterRunning()) {
                    await harness.stopAdapter();
                }
            } catch (error) {
                console.error(`Failed to stop adapter: ${error}`);
            }
            await device.stop();
        });

        describe('device -> ioBroker', function () {
            this.timeout(60000);

            it('creates the device object from the device info', async () => {
                const deviceObj = await harness.objects.getObjectAsync(DEVICE_PREFIX);
                expect(deviceObj, 'device object').to.be.ok;
                expect(deviceObj.type).to.equal('device');
                expect(deviceObj.common.name).to.equal(DEVICE_NAME);
                expect(deviceObj.native.ip).to.equal(DEVICE_HOST);
                expect(deviceObj.native.name).to.equal(DEVICE_NAME);
                expect(deviceObj.native.encryptionKeyUsed).to.equal(true);
                // The key is stored encrypted, never in plain text
                expect(deviceObj.native.encryptionKey).to.be.a('string').and.not.equal(ENCRYPTION_KEY);

                await waitForAckedState(
                    harness,
                    `${DEVICE_PREFIX}.info.name`,
                    val => val === DEVICE_NAME,
                    'device name',
                );
                await waitForAckedState(
                    harness,
                    `${DEVICE_PREFIX}.info.macAddress`,
                    val => String(val).toUpperCase() === '02:E2:E0:00:00:01',
                    'MAC address',
                );
                await waitForAckedState(harness, `${DEVICE_PREFIX}.info.model`, val => val === 'host', 'model "host"');
                await waitForAckedState(
                    harness,
                    `${DEVICE_PREFIX}.info.esphomeVersion`,
                    val => /^\d{4}\.\d+\.\d+/.test(String(val)),
                    'an ESPHome version',
                );
            });

            it('reports a Sensor value with unit and rounding', async () => {
                const entity = await findEntity(harness, 'Sensor', 'E2E Temperature');
                const state = await waitForAckedState(harness, `${entity}.state`, val => val === 21.5, 'to be 21.5');
                expect(state.val).to.equal(21.5);
                const obj = await harness.objects.getObjectAsync(`${entity}.state`);
                expect(obj.common.unit).to.equal('°C');
                expect(obj.common.type).to.equal('number');
                expect(obj.common.write).to.equal(false);
            });

            it('reports a BinarySensor value', async () => {
                const entity = await findEntity(harness, 'BinarySensor', 'E2E Binary');
                await waitForAckedState(harness, `${entity}.state`, val => val === true, 'to be true');
            });

            it('reports a TextSensor value', async () => {
                const entity = await findEntity(harness, 'TextSensor', 'E2E Text Sensor');
                await waitForAckedState(
                    harness,
                    `${entity}.state`,
                    val => val === 'hello ioBroker',
                    'to be "hello ioBroker"',
                );
            });

            it('creates the config channel when configStates is enabled', async () => {
                const entity = await findEntity(harness, 'Number', 'E2E Number');
                const max = await waitForAckedState(
                    harness,
                    `${entity}.config.maxValue`,
                    val => val === 100,
                    'to be 100',
                );
                expect(max.val).to.equal(100);
            });
        });

        describe('ioBroker -> device', function () {
            this.timeout(60000);

            it('switches a Switch on and off', async () => {
                const entity = await findEntity(harness, 'Switch', 'E2E Switch');
                const id = `${entity}.state`;
                await waitForAckedState(harness, id, val => val === false, 'to start false');

                await writeCommand(harness, id, true);
                await waitForAckedState(harness, id, val => val === true, 'to be confirmed true');

                await writeCommand(harness, id, false);
                await waitForAckedState(harness, id, val => val === false, 'to be confirmed false');
            });

            it('sets a Number', async () => {
                const entity = await findEntity(harness, 'Number', 'E2E Number');
                const id = `${entity}.state`;
                await waitForAckedState(harness, id, val => val === 10, 'to start at 10');

                await writeCommand(harness, id, 42);
                await waitForAckedState(harness, id, val => val === 42, 'to be confirmed 42');
            });

            it('selects a Select option', async () => {
                const entity = await findEntity(harness, 'Select', 'E2E Select');
                const id = `${entity}.state`;
                await waitForAckedState(harness, id, val => val === 'Alpha', 'to start at Alpha');

                await writeCommand(harness, id, 'Gamma');
                await waitForAckedState(harness, id, val => val === 'Gamma', 'to be confirmed Gamma');
            });

            it('sets a Text', async () => {
                const entity = await findEntity(harness, 'Text', 'E2E Text');
                const id = `${entity}.state`;
                await waitForAckedState(harness, id, val => val === 'initial', 'to start at "initial"');

                await writeCommand(harness, id, 'hello from ioBroker');
                await waitForAckedState(harness, id, val => val === 'hello from ioBroker', 'to be confirmed');
            });

            it('presses a Button', async () => {
                const button = await findEntity(harness, 'Button', 'E2E Button');
                const counter = await findEntity(harness, 'Sensor', 'E2E Button Presses');

                await writeCommand(harness, `${button}.SET`, true);
                // The button increments a counter on the device, which publishes it as sensor
                await waitForAckedState(harness, `${counter}.state`, val => val === 1, 'to count one press');

                await writeCommand(harness, `${button}.SET`, true);
                await waitForAckedState(harness, `${counter}.state`, val => val === 2, 'to count two presses');
            });

            it('turns a Light on with brightness', async () => {
                const entity = await findEntity(harness, 'Light', 'E2E Light');
                await waitForAckedState(harness, `${entity}.state`, val => val === false, 'to start off');

                await writeCommand(harness, `${entity}.state`, true);
                await waitForAckedState(harness, `${entity}.state`, val => val === true, 'to be confirmed on');

                // Brightness is exposed as 0-255
                await writeCommand(harness, `${entity}.brightness`, 128);
                await waitForAckedState(
                    harness,
                    `${entity}.brightness`,
                    val => Math.abs(val - 128) <= 1,
                    'to be confirmed ~128',
                );

                await writeCommand(harness, `${entity}.state`, false);
                await waitForAckedState(harness, `${entity}.state`, val => val === false, 'to be confirmed off');
            });

            it('controls a Fan', async () => {
                const entity = await findEntity(harness, 'Fan', 'E2E Fan');
                await waitForAckedState(harness, `${entity}.state`, val => val === false, 'to start off');

                await writeCommand(harness, `${entity}.state`, true);
                await waitForAckedState(harness, `${entity}.state`, val => val === true, 'to be confirmed on');

                await writeCommand(harness, `${entity}.speedLevel`, 2);
                await waitForAckedState(harness, `${entity}.speedLevel`, val => val === 2, 'to be confirmed 2');
            });

            it('locks and unlocks a Lock', async () => {
                const entity = await findEntity(harness, 'Lock', 'E2E Lock');
                // Lock command: 0=UNLOCK, 1=LOCK | Lock state: 1=LOCKED, 2=UNLOCKED
                await writeCommand(harness, `${entity}.command`, 1);
                await waitForAckedState(harness, `${entity}.state`, val => val === 1, 'to be LOCKED (1)');

                await writeCommand(harness, `${entity}.command`, 0);
                await waitForAckedState(harness, `${entity}.state`, val => val === 2, 'to be UNLOCKED (2)');
            });

            it('moves a Cover to a position', async () => {
                const entity = await findEntity(harness, 'Cover', 'E2E Cover');
                // Position is exposed as 0-100 %
                await writeCommand(harness, `${entity}.position`, 50);
                await waitForAckedState(harness, `${entity}.position`, val => val === 50, 'to be confirmed 50');

                await writeCommand(harness, `${entity}.position`, 0);
                await waitForAckedState(harness, `${entity}.position`, val => val === 0, 'to be confirmed 0');
            });
        });

        describe('connection handling', function () {
            this.timeout(60000);

            it('marks the device offline when it disappears and reconnects when it is back', async function () {
                this.timeout(180000);

                await device.stop();
                await waitForAckedState(harness, ONLINE_STATE, val => val === false, 'to be false', 30000);

                const entity = await findEntity(harness, 'Switch', 'E2E Switch');
                const restartedAt = Date.now();
                await device.start();
                await waitForAckedState(harness, ONLINE_STATE, val => val === true, 'to be true again', 60000);

                // _online turns true with the device info, before the entities are announced again.
                // Wait until the device reported the switch on the new connection, then commands must work again.
                await waitFor(async () => {
                    const state = await harness.states.getStateAsync(`${entity}.state`);
                    return state && state.ack && state.ts >= restartedAt;
                }, 'the switch to be reported again after the reconnect');
                await writeCommand(harness, `${entity}.state`, true);
                await waitForAckedState(harness, `${entity}.state`, val => val === true, 'to be confirmed true');
            });
        });
    });

    // A fresh harness per suite: the harness of the suite above cannot start the adapter again once stopped
    suite('E2E - device added by version 1.0.0', getHarness => {
        const binary = process.env.ESPHOME_E2E_DEVICE_BINARY;
        const device = new EsphomeDevice(binary || '');
        let harness;

        before(async function () {
            this.timeout(120000);
            harness = getHarness();

            // Device object exactly as 1.0.0 wrote it: no native.name, the credentials encrypted by the adapter
            await harness.objects.setObjectAsync(DEVICE_PREFIX, {
                type: 'device',
                common: { name: DEVICE_NAME, statusStates: { onlineId: ONLINE_STATE } },
                native: {
                    ip: DEVICE_HOST,
                    mac: '02:E2:E0:00:00:01',
                    deviceName: DEVICE_ID,
                    deviceFriendlyName: DEVICE_NAME,
                    apiPassword: await encryptLikeAdapter(harness, ''),
                    encryptionKey: await encryptLikeAdapter(harness, ENCRYPTION_KEY),
                    encryptionKeyUsed: true,
                },
            });

            await harness.changeAdapterConfig('esphome', {
                native: {
                    autodiscovery: false,
                    ESPHomeDashboardEnabled: false,
                    reconnectInterval: 2,
                    pingInterval: 2,
                    pingAttempts: 1,
                    // Saved by the device tab of the 1.0.0 settings, no longer used
                    deviceIP: DEVICE_HOST,
                    apiPassword: '',
                    existingDevicesTable: [
                        {
                            MACAddress: '02:E2:E0:00:00:01',
                            deviceName: DEVICE_NAME,
                            ip: DEVICE_HOST,
                            connectState: 'initialized',
                        },
                    ],
                    newDevicesTable: [],
                },
            });

            await device.start();
            await harness.enableSendTo();
            await harness.startAdapterAndWait();
        });

        afterEach(function () {
            if (this.currentTest && this.currentTest.state === 'failed') {
                device.dumpLog();
            }
        });

        after(async function () {
            this.timeout(30000);
            try {
                if (harness && harness.isAdapterRunning()) {
                    await harness.stopAdapter();
                }
            } catch (error) {
                console.error(`Failed to stop adapter: ${error}`);
            }
            await device.stop();
        });

        it('connects with the stored encryption key and lists the device in the device manager', async function () {
            this.timeout(90000);

            await waitForAckedState(harness, ONLINE_STATE, val => val === true, 'to be true', 60000);

            const response = await sendToAdapter(harness, 'dm:loadDevices', {});
            const entry = response.add.find(item => item.id === DEVICE_HOST);
            expect(entry, 'device in the device manager').to.be.ok;
            expect(entry.name).to.equal(DEVICE_NAME);
            expect(entry.group.key).to.equal('known');
            expect(entry.status.connection.stateId).to.equal(ONLINE_STATE);
            expect(entry.actions.map(action => action.id)).to.include.members(['edit', 'delete']);
        });

        it('keeps the stored encryption key when the connection settings are saved unchanged', async function () {
            this.timeout(90000);

            // "Change connection settings" with both fields left empty, then the device must connect again
            await sendToAdapter(harness, 'dm:loadDevices', {});
            let response = await sendToAdapter(harness, 'dm:deviceAction', { deviceId: DEVICE_HOST, actionId: 'edit' });
            const messages = [];
            while (response.type !== 'result') {
                let answer = {};
                if (response.type === 'form') {
                    answer = { data: { ip: DEVICE_HOST, encryptionKey: '', apiPassword: '' } };
                } else if (response.type === 'message') {
                    messages.push(response.message);
                }
                response = await sendToAdapter(
                    harness,
                    'dm:actionProgress',
                    { origin: response.origin, ...answer },
                    60000,
                );
            }
            expect(messages).to.have.lengthOf(1);
            expect(messages[0]).to.match(/^OK - Device successfully connected/);
            await waitForAckedState(harness, ONLINE_STATE, val => val === true, 'to be true again', 60000);
        });
    });
};
