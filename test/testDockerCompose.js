'use strict';

/**
 * docker-compose.yaml rendered by `@iobroker/plugin-docker`, as js-controller does it when the instance starts.
 *
 * The plugin only reads the instance object, it does not contact Docker as long as every enabled container
 * waits for the adapter (iobWaitForReady). The manager that stops a disabled container is stubbed, so the
 * tests behave the same with and without Docker on the host.
 */

const { expect } = require('chai');
const path = require('node:path');
const DockerPlugin = require('@iobroker/plugin-docker');
const ioPackage = require('../io-package.json');

const adapterDir = path.join(__dirname, '..');
const configDir = '/opt/iobroker/iobroker-data/esphome.0';

/**
 * @typedef {{type: string, source: string, target: string, iobBackup?: boolean}} Mount
 * @typedef {object} Container - the part of a ContainerConfig of the plugin these tests look at
 * @property {boolean} [iobEnabled] - managed by the plugin
 * @property {boolean} [iobStopOnUnload] - stopped with the instance
 * @property {boolean} [iobAutoImageUpdate] - newer images are pulled
 * @property {boolean} [iobWaitForReady] - created once the adapter calls instanceIsReady()
 * @property {string} image - image with tag
 * @property {string[]} command - arguments for the entrypoint
 * @property {string} [networkMode] - network the container is created in
 * @property {unknown} [ports] - published ports
 * @property {Mount[]} mounts - volumes and bind mounts
 */

/**
 * Render docker-compose.yaml for an instance with the given native configuration
 *
 * @param {Record<string, unknown>} native - native configuration of the instance
 * @returns {Promise<Container[]>} - the containers the plugin manages
 */
async function renderCompose(native) {
    const log = { level: 'silly', silly() {}, debug() {}, info() {}, warn() {}, error() {} };
    const plugin = new DockerPlugin({
        pluginScope: 'adapter',
        parentNamespace: 'system.adapter.esphome.0',
        pluginNamespace: 'system.adapter.esphome.0.plugins.docker',
        pluginLogNamespace: 'esphome.0 Plugin docker',
        log,
        iobrokerConfig: {},
        parentPackage: { name: 'iobroker.esphome' },
        adapterDir,
    });
    plugin.objectsDb = {
        getObjectAsync: async (/** @type {string} */ id) =>
            id === 'system.adapter.esphome.0' ? { _id: id, type: 'instance', common: {}, native } : null,
    };
    // A copy, the plugin writes the resolved Docker API into the configuration it gets
    await plugin.init(JSON.parse(JSON.stringify(ioPackage.common.plugins.docker)));
    return /** @type {Container[]} */ (/** @type {unknown} */ (plugin.configurations));
}

/**
 * Native configuration of a new instance with the given changes
 *
 * @param {Record<string, unknown>} [dockerEsphome] - changes of the Docker settings
 * @param {Record<string, unknown>} [rest] - changes of the other settings
 * @returns {Record<string, unknown>} - native configuration
 */
function nativeWith(dockerEsphome, rest) {
    return {
        ...JSON.parse(JSON.stringify(ioPackage.native)),
        ...rest,
        dockerEsphome: { ...ioPackage.native.dockerEsphome, ...dockerEsphome },
    };
}

describe('docker-compose.yaml (ESPHome Dashboard in Docker)', () => {
    const managerPrototype = DockerPlugin.DockerManagerOfOwnContainers.prototype;
    const originalInit = managerPrototype.init;
    let managersStarted = 0;

    beforeEach(() => {
        managersStarted = 0;
        // Never probe the Docker of the host, see the description at the top
        managerPrototype.init = async function () {
            managersStarted++;
        };
    });

    afterEach(() => {
        managerPrototype.init = originalInit;
    });

    it('is shipped with the adapter and registered in io-package.json', () => {
        const pkg = require('../package.json');
        expect(pkg.files).to.include('docker-compose.yaml');
        expect(pkg.dependencies).to.have.property('@iobroker/plugin-docker');
        expect(ioPackage.common.plugins.docker.iobDockerComposeFiles).to.deep.equal(['docker-compose.yaml']);
    });

    it('creates no container for a new instance', async () => {
        const containers = await renderCompose(nativeWith());

        expect(containers).to.have.length(0);
        // The disabled service is handed to a manager that stops a container left over from before
        expect(managersStarted).to.equal(1);
    });

    it('creates no container for an instance without Docker settings (upgrade)', async () => {
        const native = nativeWith();
        delete native.dockerEsphome;
        const containers = await renderCompose(native);

        expect(containers).to.have.length(0);
    });

    it('runs the dashboard of the selected version in the network of the host', async () => {
        const containers = await renderCompose(nativeWith({ enabled: true, configDir }));

        expect(containers).to.have.length(1);
        const [container] = containers;
        expect(container).to.include({
            iobEnabled: true,
            iobStopOnUnload: false,
            iobAutoImageUpdate: true,
            // the adapter creates the YAML directory first, see startDockerDashboard()
            iobWaitForReady: true,
            image: 'ghcr.io/esphome/esphome:stable',
            networkMode: 'host',
        });
        expect(container.command).to.deep.equal(['dashboard', '--port=6052', '/config']);
        expect(container.ports).to.equal(undefined);
        // no manager before the adapter calls instanceIsReady()
        expect(managersStarted).to.equal(0);
    });

    it('mounts the YAML directory of the instance and keeps the toolchains in a volume', async () => {
        const containers = await renderCompose(nativeWith({ enabled: true, configDir }));
        const mounts = containers[0].mounts;

        expect(mounts.find(m => m.target === '/config')).to.include({ type: 'bind', source: configDir });
        expect(mounts.find(m => m.target === '/cache')).to.include({ type: 'volume', source: 'esphome_cache' });
        // a cache in the backup would only waste space, it is downloaded again
        expect(mounts.some(m => m.iobBackup)).to.equal(false);
    });

    it('takes a Windows path as one bind source', async () => {
        const windowsDir = 'C:\\ioBroker\\iobroker-data\\esphome.0';
        const containers = await renderCompose(nativeWith({ enabled: true, configDir: windowsDir }));
        const mounts = containers[0].mounts;

        expect(mounts.find(m => m.target === '/config')).to.include({ source: windowsDir });
    });

    it('passes version, port and the container options of the instance', async () => {
        const containers = await renderCompose(
            nativeWith(
                { enabled: true, configDir, version: '2026.6.5', stopIfInstanceStopped: true, autoImageUpdate: false },
                // stored as a number by the admin, Docker needs every argument as a string
                { ESPHomeDashboardPort: 6060 },
            ),
        );
        const [container] = containers;

        expect(container.image).to.equal('ghcr.io/esphome/esphome:2026.6.5');
        expect(container.command).to.deep.equal(['dashboard', '--port=6060', '/config']);
        expect(container.iobStopOnUnload).to.equal(true);
        expect(container.iobAutoImageUpdate).to.equal(false);
    });
});
