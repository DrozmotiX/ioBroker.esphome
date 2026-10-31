import DockerPlugin from '@iobroker/plugin-docker';
import { expect } from 'chai';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import Dashboard, { type DashboardAdapter } from './dashboard';
import { native } from '../../io-package.json';

/** Root directory of the adapter, docker-compose.yaml lives there */
const adapterDir = path.join(__dirname, '..', '..');

interface Logs {
    info: string[];
    error: string[];
}

/** Silent logger of the docker plugin */
function createPluginLogger(): ioBroker.Logger {
    const noop = (): void => {};
    return { silly: noop, debug: noop, info: noop, warn: noop, error: noop, level: 'info' };
}

/**
 * Create the docker plugin the way the js-controller does, initialized with docker-compose.yaml of the
 * adapter and the given instance configuration. Docker itself is never contacted: the container is not
 * started before instanceIsReady(), which is replaced here.
 *
 * @param config - native part of the instance object
 * @param dockerRunning - what getDockerDaemonInfo() of the docker manager answers
 */
async function createDockerPlugin(
    config: Record<string, unknown>,
    dockerRunning = true,
): Promise<DockerPlugin & { readyCalls: number }> {
    const plugin = new DockerPlugin({
        pluginScope: 'adapter',
        parentNamespace: 'system.adapter.esphome.0',
        pluginNamespace: 'system.adapter.esphome.0.plugins.docker',
        pluginLogNamespace: 'esphome.0 Plugin docker',
        log: createPluginLogger(),
        iobrokerConfig: {} as ioBroker.IoBrokerJson,
        parentPackage: { name: 'iobroker.esphome' },
        controllerVersion: '7.0.0',
        adapterDir,
        jsControllerDir: adapterDir,
    }) as DockerPlugin & { readyCalls: number };
    // The instance object is read from the objects database by the plugin
    plugin.getObject = (() => Promise.resolve({ native: config })) as unknown as DockerPlugin['getObject'];
    plugin.readyCalls = 0;
    plugin.instanceIsReady = async (): Promise<void> => {
        plugin.readyCalls++;
        await Promise.resolve();
    };
    plugin.getDockerManager = (() => ({
        getDockerDaemonInfo: () =>
            Promise.resolve({ daemonRunning: dockerRunning, version: '27.0.0', driver: 'socket' }),
    })) as unknown as DockerPlugin['getDockerManager'];

    await plugin.init({ iobDockerComposeFiles: ['docker-compose.yaml'] });
    return plugin;
}

/**
 * Minimal adapter for the dashboard
 *
 * @param config - adapter configuration
 * @param plugin - docker plugin returned by getPluginInstance('docker')
 * @param logs - collects info and error messages
 */
function createAdapter(config: Record<string, unknown>, plugin: DockerPlugin | null, logs: Logs): DashboardAdapter {
    const noop = (): void => {};
    return {
        instance: 0,
        config,
        log: {
            info: (msg: string) => logs.info.push(msg),
            error: (msg: string) => logs.error.push(msg),
            warn: noop,
            debug: noop,
        },
        getPluginInstance: (name: string) => (name === 'docker' ? plugin : null),
        errorHandler: (codepart: string, error: unknown) => logs.error.push(`${codepart} ${String(error)}`),
    } as unknown as DashboardAdapter;
}

describe('ESPHome Dashboard in Docker', () => {
    let dir: string;
    let logs: Logs;

    beforeEach(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'esphome-docker-'));
        logs = { info: [], error: [] };
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    /**
     * Create a dashboard writing into the temporary directory
     *
     * @param config - adapter configuration
     * @param plugin - docker plugin
     */
    function createDashboard(config: Record<string, unknown>, plugin: DockerPlugin | null): Dashboard {
        const dashboard = new Dashboard(createAdapter(config, plugin, logs));
        dashboard.getConfigDirectory = (): string => path.join(dir, 'esphome.0');
        return dashboard;
    }

    it('docker-compose.yaml declares no container while "Use Docker Integration" is disabled', async () => {
        const plugin = await createDockerPlugin({ ...native });
        expect(native.ESPHomeDashboardDocker).to.equal(false);
        expect(plugin.configurations).to.have.length(0);
    });

    it('docker-compose.yaml declares the dashboard container, waiting for the adapter', async () => {
        const plugin = await createDockerPlugin({
            ...native,
            ESPHomeDashboardDocker: true,
            ESPHomeDashboardPort: 6060,
        });
        expect(plugin.configurations).to.have.length(1);
        const [container] = plugin.configurations;
        expect(container.iobEnabled).to.equal(true);
        expect(container.iobWaitForReady).to.equal(true);
        expect(container.iobStopOnUnload).to.equal(true);
        expect(container.networkMode).to.equal('host');
        expect(container.command).to.deep.equal(['dashboard', '--port=6060', '/config']);
        // not started by the plugin itself
        expect(plugin.readyCalls).to.equal(0);
    });

    it('starts the container with the selected version and the YAML directory of the instance', async () => {
        const config = { ...native, ESPHomeDashboardEnabled: true, ESPHomeDashboardDocker: true };
        const plugin = await createDockerPlugin(config);
        const dashboard = createDashboard(config, plugin);

        await dashboard.startDockerContainer('2026.6.5');

        const [container] = plugin.configurations;
        expect(container.image).to.equal('ghcr.io/esphome/esphome:2026.6.5');
        expect(container.mounts).to.deep.equal([
            { type: 'bind', source: path.join(dir, 'esphome.0'), target: '/config' },
        ]);
        expect((await stat(path.join(dir, 'esphome.0'))).isDirectory()).to.equal(true);
        expect(plugin.readyCalls).to.equal(1);
        expect(logs.error).to.deep.equal([]);
        expect(logs.info.some(msg => msg.includes('Docker 27.0.0'))).to.equal(true);
    });

    it('uses the newest stable image when no version is known', async () => {
        const config = { ...native, ESPHomeDashboardEnabled: true, ESPHomeDashboardDocker: true };
        const plugin = await createDockerPlugin(config);

        await createDashboard(config, plugin).startDockerContainer('');

        expect(plugin.configurations[0].image).to.equal('ghcr.io/esphome/esphome:stable');
        expect(plugin.readyCalls).to.equal(1);
    });

    it('reports an error when Docker is not available', async () => {
        const config = { ...native, ESPHomeDashboardEnabled: true, ESPHomeDashboardDocker: true };
        const plugin = await createDockerPlugin(config, false);

        await createDashboard(config, plugin).startDockerContainer('2026.6.5');

        expect(logs.error).to.have.length(1);
        expect(logs.error[0]).to.include('Docker is not installed or not running');
    });

    it('reports an error and starts nothing without the docker plugin', async () => {
        const config = { ...native, ESPHomeDashboardEnabled: true, ESPHomeDashboardDocker: true };

        await createDashboard(config, null).startDockerContainer('2026.6.5');

        expect(logs.error).to.have.length(1);
        expect(logs.error[0]).to.include('docker plugin of ioBroker is not available');
    });
});
