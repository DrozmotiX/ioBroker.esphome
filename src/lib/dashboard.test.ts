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
    /** Delays of the timers started through the adapter */
    timers: number[];
    /** Callbacks of these timers, never run by the timers themselves */
    callbacks: (() => Promise<void>)[];
    warn: string[];
    error: string[];
    /** Calls of updateConnectionState() */
    connectionUpdates: number;
}

/** Docker plugin of the tests, with what the stubbed docker manager was asked */
type TestDockerPlugin = DockerPlugin & {
    readyCalls: number;
    /** Containers stopped through the docker manager */
    stopped: string[];
    /** Run inside instanceIsReady(), before it resolves */
    onReady?: () => void;
};

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
 * @param containerStatus - status of the container after instanceIsReady(), null if it was not created
 */
async function createDockerPlugin(
    config: Record<string, unknown>,
    containerStatus: string | null = 'running',
): Promise<TestDockerPlugin> {
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
    }) as TestDockerPlugin;
    // The instance object is read from the objects database by the plugin
    plugin.getObject = (() => Promise.resolve({ native: config })) as unknown as DockerPlugin['getObject'];
    plugin.readyCalls = 0;
    plugin.stopped = [];
    plugin.instanceIsReady = async (): Promise<void> => {
        plugin.readyCalls++;
        await Promise.resolve();
        plugin.onReady?.();
    };
    const manager = {
        containerList: () =>
            Promise.resolve(
                containerStatus
                    ? plugin.configurations.map(container => ({ names: container.name, status: containerStatus }))
                    : [],
            ),
        containerStop: (name: string) => {
            plugin.stopped.push(name);
            return Promise.resolve({ stdout: '', stderr: '' });
        },
    };
    plugin.getDockerManager = (() => manager) as unknown as DockerPlugin['getDockerManager'];

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
            warn: (msg: string) => logs.warn.push(msg),
            debug: noop,
        },
        getPluginInstance: (name: string) => (name === 'docker' ? plugin : null),
        // The check whether the dashboard answers is only recorded, tests run it themselves
        setTimeout: (callback: () => Promise<void>, ms: number) => {
            logs.timers.push(ms);
            logs.callbacks.push(callback);
            return undefined;
        },
        clearTimeout: noop,
        updateConnectionState: () => {
            logs.connectionUpdates++;
            return Promise.resolve();
        },
        errorHandler: (codepart: string, error: unknown) => logs.error.push(`${codepart} ${String(error)}`),
    } as unknown as DashboardAdapter;
}

describe('ESPHome Dashboard in Docker', () => {
    let dir: string;
    let logs: Logs;

    beforeEach(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'esphome-docker-'));
        logs = { info: [], timers: [], callbacks: [], warn: [], error: [], connectionUpdates: 0 };
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
        expect(container.iobMonitoringEnabled).to.equal(true);
        expect(container.networkMode).to.equal('host');
        expect(container.command).to.deep.equal(['dashboard', '--port=6060', '/config']);
        // Docker does not start it while the instance is stopped
        expect(container.restart).to.deep.equal({ policy: 'no' });
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
        expect(container.iobAutoImageUpdate).to.equal(false);
        expect(container.mounts).to.deep.equal([
            { type: 'bind', source: path.join(dir, 'esphome.0'), target: '/config' },
        ]);
        expect((await stat(path.join(dir, 'esphome.0'))).isDirectory()).to.equal(true);
        expect(plugin.readyCalls).to.equal(1);
        expect(logs.error).to.deep.equal([]);
        expect(logs.info.some(msg => msg.includes(`container ${container.name} is running`))).to.equal(true);
        // info.connection waits until the dashboard of the container answers, like with the process
        expect(logs.timers).to.have.length(1);
        expect(dashboard.isReady()).to.equal(false);
    });

    it('uses the newest stable image when no version is known', async () => {
        const config = { ...native, ESPHomeDashboardEnabled: true, ESPHomeDashboardDocker: true };
        const plugin = await createDockerPlugin(config);

        await createDashboard(config, plugin).startDockerContainer('');

        expect(plugin.configurations[0].image).to.equal('ghcr.io/esphome/esphome:stable');
        // "stable" moves on with every release: pulled again on every start
        expect(plugin.configurations[0].iobAutoImageUpdate).to.equal(true);
        expect(plugin.readyCalls).to.equal(1);
    });

    it('reports an error when Docker is not available or the image could not be pulled', async () => {
        const config = { ...native, ESPHomeDashboardEnabled: true, ESPHomeDashboardDocker: true };
        const plugin = await createDockerPlugin(config, null);

        await createDashboard(config, plugin).startDockerContainer('2026.6.5');

        expect(logs.error).to.have.length(1);
        expect(logs.error[0]).to.include('is not running (not created)');
        expect(logs.error[0]).to.include('Docker is not installed or not running');
        expect(logs.timers).to.have.length(0);
    });

    it('reports an error when the container does not run', async () => {
        const config = { ...native, ESPHomeDashboardEnabled: true, ESPHomeDashboardDocker: true };
        const plugin = await createDockerPlugin(config, 'exited');

        await createDashboard(config, plugin).startDockerContainer('2026.6.5');

        expect(logs.error).to.have.length(1);
        expect(logs.error[0]).to.include('is not running (exited)');
        expect(logs.timers).to.have.length(0);
    });

    it('stops the container when the instance unloaded while it was started', async () => {
        const config = { ...native, ESPHomeDashboardEnabled: true, ESPHomeDashboardDocker: true };
        const plugin = await createDockerPlugin(config);
        const dashboard = createDashboard(config, plugin);
        // The plugin already stopped its containers on unload, before this one existed
        plugin.onReady = () => dashboard.stop();

        await dashboard.startDockerContainer('2026.6.5');

        expect(plugin.stopped).to.deep.equal([plugin.configurations[0].name]);
        expect(logs.error).to.deep.equal([]);
        expect(logs.timers).to.have.length(0);
    });

    it('updates info.connection whenever the dashboard of the container starts or stops answering', async () => {
        const config = { ...native, ESPHomeDashboardEnabled: true, ESPHomeDashboardDocker: true };
        const plugin = await createDockerPlugin(config);
        const dashboard = createDashboard(config, plugin);
        let reachable = false;
        (dashboard as unknown as { isReachable: () => Promise<boolean> }).isReachable = () =>
            Promise.resolve(reachable);
        await dashboard.startDockerContainer('2026.6.5');

        /** Run the last check the dashboard scheduled */
        const check = (): Promise<void> => logs.callbacks[logs.callbacks.length - 1]();

        await check();
        expect(dashboard.isReady()).to.equal(false);
        expect(logs.connectionUpdates).to.equal(0);

        reachable = true;
        await check();
        expect(dashboard.isReady()).to.equal(true);
        expect(logs.connectionUpdates).to.equal(1);

        // still checked: the container can stop at any time
        await check();
        expect(logs.connectionUpdates).to.equal(1);
        reachable = false;
        await check();
        expect(dashboard.isReady()).to.equal(false);
        expect(logs.connectionUpdates).to.equal(2);
        expect(logs.warn).to.have.length(1);
        expect(logs.timers).to.have.length(5);

        dashboard.stop();
        await check();
        expect(logs.timers).to.have.length(5);
    });

    it('reports an error and starts nothing without the docker plugin', async () => {
        const config = { ...native, ESPHomeDashboardEnabled: true, ESPHomeDashboardDocker: true };

        await createDashboard(config, null).startDockerContainer('2026.6.5');

        expect(logs.error).to.have.length(1);
        expect(logs.error[0]).to.include('docker plugin of ioBroker is not loaded');
    });
});
