/**
 * ESPHome Dashboard in Docker ("Use Docker Integration", beta)
 *
 * Runs against a real Docker daemon: the docker plugin of ioBroker (@iobroker/plugin-docker) is loaded by
 * js-controller from common.plugins of io-package.json and starts the official ESPHome image. Checks that
 * - the container runs with the selected image, the YAML directory of the instance and the toolchain volume,
 *   and the dashboard answers on the configured port of the host
 * - the container stops together with the instance
 * - a container left behind is removed by a start without Docker Integration
 *
 * Skipped unless ESPHOME_RUN_DOCKER_TESTS=true. Executed by the "Dashboard Integration" workflow, or locally:
 *   ESPHOME_RUN_DOCKER_TESTS=true npm run test:integration -- --grep "Docker"
 */

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { expect } = require('chai');
const { isDashboardReachable } = require('./dashboard_tests');

const execFileAsync = promisify(execFile);

const DASHBOARD_PORT = 6052;
// A fixed version keeps the test reproducible, the image tag is the ESPHome version
const DASHBOARD_VERSION = '2026.10.1';
const IMAGE = `ghcr.io/esphome/esphome:${DASHBOARD_VERSION}`;
// Name the docker plugin gives the service "esphome" of docker-compose.yaml for instance 0
const CONTAINER = 'iob_esphome_0_esphome';
const CACHE_VOLUME = 'iob_esphome_0_esphome_cache';
const CONTAINER_STATE = 'esphome.0._ESPHomeDashboard.dockerContainer';
// The first start pulls the image (about 1 GB)
const START_TIMEOUT_MS = 600000;
const REACHABILITY_CHECK_DELAY_MS = 3000;

/**
 * Run the docker CLI
 *
 * @param {...string} args - arguments of the docker command
 * @returns {Promise<string>} stdout
 */
async function docker(...args) {
    const { stdout } = await execFileAsync('docker', args);
    return stdout.trim();
}

/**
 * Inspect the dashboard container
 *
 * @returns {Promise<any | null>} inspect data, null when the container does not exist
 */
async function inspectContainer() {
    try {
        return JSON.parse(await docker('container', 'inspect', CONTAINER))[0];
    } catch {
        return null;
    }
}

/**
 * Wait until a condition is met
 *
 * @param {() => Promise<boolean>} condition - checked every second
 * @param {number} timeoutMs - maximum time to wait
 * @returns {Promise<boolean>} whether the condition was met in time
 */
async function waitFor(condition, timeoutMs) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        if (await condition()) {
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return false;
}

/** Remove the dashboard container of a previous run */
async function removeContainer() {
    await docker('rm', '-f', CONTAINER).catch(() => undefined);
}

/**
 * Stop the adapter, if it runs
 *
 * @param {any} harness - test harness
 */
async function stopAdapter(harness) {
    try {
        if (harness && harness.isAdapterRunning()) {
            await harness.stopAdapter();
        }
    } catch (error) {
        console.error(`Failed to stop the adapter: ${error instanceof Error ? error.message : String(error)}`);
    }
}

exports.runTests = function (suite) {
    // Each scenario needs its own suite, the harness cannot start the adapter again after stopAdapter()
    suite('ESPHome Dashboard in Docker', getHarness => {
        after(removeContainer);

        it('runs the dashboard container while the instance runs and stops it with the instance', async function () {
            this.timeout(START_TIMEOUT_MS + 120000);
            const harness = getHarness();
            try {
                await removeContainer();
                if (harness.isAdapterRunning()) {
                    await harness.stopAdapter();
                }
                await harness.changeAdapterConfig('esphome', {
                    native: {
                        ESPHomeDashboardEnabled: true,
                        ESPHomeDashboardDocker: true,
                        ESPHomeDashboardPort: DASHBOARD_PORT,
                        ESPHomeDashboardVersion: DASHBOARD_VERSION,
                    },
                });
                await harness.startAdapterAndWait();

                // Host network: the dashboard of the container answers on the port of this host
                const reachable = await isDashboardReachable(
                    DASHBOARD_PORT,
                    Math.floor(START_TIMEOUT_MS / REACHABILITY_CHECK_DELAY_MS),
                    REACHABILITY_CHECK_DELAY_MS,
                );
                expect(reachable, 'dashboard of the container is reachable').to.equal(true);

                const container = await inspectContainer();
                expect(container, `container ${CONTAINER} exists`).to.not.equal(null);
                expect(container.State.Status).to.equal('running');
                expect(container.Config.Image).to.equal(IMAGE);
                expect(container.HostConfig.NetworkMode).to.equal('host');
                expect(container.HostConfig.RestartPolicy.Name).to.equal('no');
                expect(container.Config.Labels.iobroker).to.equal('esphome.0');

                const config = container.Mounts.find(mount => mount.Destination === '/config');
                expect(config.Type).to.equal('bind');
                // the YAML directory of the instance, shared with the YAML file management
                expect(config.Source).to.match(/iobroker-data[/\\]esphome\.0$/);
                const cache = container.Mounts.find(mount => mount.Destination === '/cache');
                expect(cache.Type).to.equal('volume');
                expect(cache.Name).to.equal(CACHE_VOLUME);

                // remembered, so a start without Docker Integration removes it
                const state = await harness.states.getStateAsync(CONTAINER_STATE);
                expect(state && state.val).to.equal(CONTAINER);

                // iobStopOnUnload: the container runs only while the instance runs
                await harness.stopAdapter();
                const stopped = await waitFor(
                    async () => (await inspectContainer())?.State.Status !== 'running',
                    30000,
                );
                expect(stopped, 'container stopped with the instance').to.equal(true);
            } finally {
                await stopAdapter(harness);
            }
        });
    });

    suite('ESPHome Dashboard in Docker: container left behind', getHarness => {
        after(removeContainer);

        it('removes the container on a start without Docker Integration', async function () {
            this.timeout(START_TIMEOUT_MS + 120000);
            const harness = getHarness();
            try {
                // Left behind e.g. when the instance crashed, and Docker Integration was disabled since
                await removeContainer();
                await docker('create', '--name', CONTAINER, '--label', 'iobroker=esphome.0', IMAGE);
                await harness.states.setStateAsync(CONTAINER_STATE, { val: CONTAINER, ack: true });

                if (harness.isAdapterRunning()) {
                    await harness.stopAdapter();
                }
                await harness.changeAdapterConfig('esphome', {
                    native: {
                        ESPHomeDashboardEnabled: false,
                        ESPHomeDashboardDocker: false,
                    },
                });
                await harness.startAdapterAndWait();

                // After the release lists are fetched, so allow some time
                const removed = await waitFor(async () => (await inspectContainer()) === null, 120000);
                expect(removed, `container ${CONTAINER} removed`).to.equal(true);
                const forgotten = await waitFor(async () => {
                    const state = await harness.states.getStateAsync(CONTAINER_STATE);
                    return !!state && state.val === '';
                }, 10000);
                expect(forgotten, 'container no longer remembered').to.equal(true);
            } finally {
                await stopAdapter(harness);
            }
        });
    });
};
