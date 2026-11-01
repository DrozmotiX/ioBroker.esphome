import DockerPlugin from '@iobroker/plugin-docker';
import { expect } from 'chai';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import Dashboard, { type DashboardAdapter, ownContainerName } from './dashboard';
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
    /** Values of the states written by stateSetCreate(), by id */
    states: Record<string, unknown>;
}

/** Docker plugin of the tests, with what the stubbed docker manager was asked */
type TestDockerPlugin = DockerPlugin & {
    readyCalls: number;
    /** Containers stopped through the docker manager */
    stopped: string[];
    /** Run inside instanceIsReady(), before it resolves */
    onReady?: () => void;
    /** Status of the container the stubbed docker manager reports, null if it was not created */
    status: string | null;
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
    plugin.status = containerStatus;
    plugin.instanceIsReady = async (): Promise<void> => {
        plugin.readyCalls++;
        await Promise.resolve();
        plugin.onReady?.();
    };
    const manager = {
        containerList: () =>
            Promise.resolve(
                plugin.status
                    ? plugin.configurations.map(container => ({ names: container.name, status: plugin.status }))
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
        namespace: 'esphome.0',
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
        stateSetCreate: (id: string, _name: string, value: unknown) => {
            logs.states[id] = value;
            return Promise.resolve();
        },
        getStateAsync: (id: string) => Promise.resolve(id in logs.states ? { val: logs.states[id], ack: true } : null),
        errorHandler: (codepart: string, error: unknown) => logs.error.push(`${codepart} ${String(error)}`),
    } as unknown as DashboardAdapter;
}

describe('ESPHome Dashboard in Docker', () => {
    let dir: string;
    let logs: Logs;

    beforeEach(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'esphome-docker-'));
        logs = { info: [], timers: [], callbacks: [], warn: [], error: [], connectionUpdates: 0, states: {} };
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
        // the healthcheck of the image asks port 6052
        expect(container.healthcheck?.test).to.deep.equal([
            'CMD',
            'curl',
            '--fail',
            'http://localhost:6060/version',
            '-A',
            'HealthCheck',
        ]);
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
            // toolchains are kept out of the YAML directory, which is in iobroker-data
            { type: 'volume', source: 'esphome_cache', target: '/cache' },
        ]);
        expect((await stat(path.join(dir, 'esphome.0'))).isDirectory()).to.equal(true);
        expect(plugin.readyCalls).to.equal(1);
        expect(logs.error).to.deep.equal([]);
        expect(logs.info.some(msg => msg.includes(`container ${container.name} is running`))).to.equal(true);
        // info.connection waits until the dashboard of the container answers, like with the process
        expect(logs.timers).to.have.length(1);
        expect(dashboard.isReady()).to.equal(false);
        // removed by the next start without Docker Integration
        expect(logs.states['_ESPHomeDashboard.dockerContainer']).to.equal(container.name);
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
        expect(logs.error[0]).to.include('was not created');
        expect(logs.error[0]).to.include('Docker is not installed or not running');
        expect(logs.timers).to.have.length(0);
        // Recorded before the start, a later start without Docker Integration finds nothing to remove then
        expect(logs.states).to.deep.equal({ '_ESPHomeDashboard.dockerContainer': 'iob_esphome_0_esphome' });
    });

    it('records the container before it can exist, so a container created while the process ends is removed later', async () => {
        const config = { ...native, ESPHomeDashboardEnabled: true, ESPHomeDashboardDocker: true };
        const plugin = await createDockerPlugin(config);
        let recorded: unknown;
        plugin.onReady = () => (recorded = logs.states['_ESPHomeDashboard.dockerContainer']);

        await createDashboard(config, plugin).startDockerContainer('2026.6.5');

        // the name the docker plugin gives the service "esphome" of instance 0
        expect(recorded).to.equal('iob_esphome_0_esphome');
    });

    it('knows the container name the docker plugin uses', () => {
        expect(ownContainerName('esphome.0', 'esphome')).to.equal('iob_esphome_0_esphome');
        expect(ownContainerName('esphome.12', 'esphome')).to.equal('iob_esphome_12_esphome');
        // already renamed by the docker plugin
        expect(ownContainerName('esphome.0', 'iob_esphome_0_esphome')).to.equal('iob_esphome_0_esphome');
        expect(ownContainerName('esphome.0', undefined)).to.equal('iob_esphome_0');
    });

    it('reports an error when the container does not run, but keeps checking it', async () => {
        const config = { ...native, ESPHomeDashboardEnabled: true, ESPHomeDashboardDocker: true };
        const plugin = await createDockerPlugin(config, 'exited');

        await createDashboard(config, plugin).startDockerContainer('2026.6.5');

        expect(logs.error).to.have.length(1);
        expect(logs.error[0]).to.include('is not running (exited)');
        // the docker plugin starts it again, info.connection follows once the dashboard answers
        expect(logs.timers).to.have.length(1);
        expect(logs.states['_ESPHomeDashboard.dockerContainer']).to.equal(plugin.configurations[0].name);
    });

    it('stops the container when the instance unloaded while it was started', async () => {
        const config = { ...native, ESPHomeDashboardEnabled: true, ESPHomeDashboardDocker: true };
        const plugin = await createDockerPlugin(config);
        const dashboard = createDashboard(config, plugin);
        // The plugin already stopped its containers on unload, before this one existed
        plugin.onReady = () => void dashboard.stop();

        await dashboard.startDockerContainer('2026.6.5');

        expect(plugin.stopped).to.deep.equal([plugin.configurations[0].name]);
        expect(logs.error).to.deep.equal([]);
        expect(logs.timers).to.have.length(0);
    });

    it('unloads only after a pending container start stopped the container', async () => {
        const config = { ...native, ESPHomeDashboardEnabled: true, ESPHomeDashboardDocker: true };
        const plugin = await createDockerPlugin(config);
        const dashboard = createDashboard(config, plugin);
        // The image is still being pulled when the instance unloads
        let pulled: () => void = () => {};
        plugin.instanceIsReady = (): Promise<void> => new Promise(resolve => (pulled = resolve));
        (dashboard as unknown as { dockerStart: Promise<void> }).dockerStart =
            dashboard.startDockerContainer('2026.6.5');

        let unloaded = false;
        const stopped = dashboard.stop().then(() => (unloaded = true));
        await new Promise(resolve => setImmediate(resolve));
        expect(unloaded).to.equal(false);

        pulled();
        await stopped;
        expect(plugin.stopped).to.deep.equal([plugin.configurations[0].name]);
    });

    it('does not wait on unload when no container is being started', async () => {
        const dashboard = createDashboard({ ...native }, null);
        await dashboard.stop();
        expect(logs.error).to.deep.equal([]);
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

        await dashboard.stop();
        await check();
        expect(logs.timers).to.have.length(5);
    });

    it('is not ready while the container does not run, although something answers on its port', async () => {
        const config = { ...native, ESPHomeDashboardEnabled: true, ESPHomeDashboardDocker: true };
        const plugin = await createDockerPlugin(config);
        const dashboard = createDashboard(config, plugin);
        // e.g. another dashboard holds the port, the container of this instance cannot bind it
        (dashboard as unknown as { isReachable: () => Promise<boolean> }).isReachable = () => Promise.resolve(true);
        await dashboard.startDockerContainer('2026.6.5');
        const check = (): Promise<void> => logs.callbacks[logs.callbacks.length - 1]();

        plugin.status = 'exited';
        await check();
        expect(dashboard.isReady()).to.equal(false);
        expect(logs.connectionUpdates).to.equal(0);

        // started again by the docker plugin
        plugin.status = 'running';
        await check();
        expect(dashboard.isReady()).to.equal(true);
        expect(logs.connectionUpdates).to.equal(1);
    });

    it('reports an error and starts nothing without the docker plugin', async () => {
        const config = { ...native, ESPHomeDashboardEnabled: true, ESPHomeDashboardDocker: true };

        await createDashboard(config, null).startDockerContainer('2026.6.5');

        expect(logs.error).to.have.length(1);
        expect(logs.error[0]).to.include('docker plugin of ioBroker is not loaded');
    });

    describe('container left behind', () => {
        /** Docker manager created by removeLeftoverContainer(), with what it was asked */
        interface TestManager {
            containers: { names: string; status: string }[];
            removed: string[];
            removeError: string;
            /** containerRemove() throws, like with the Docker API */
            removeThrows?: boolean;
            /** containerList() throws, like the Docker API when the daemon cannot be reached */
            listThrows?: boolean;
            /** Result of getDockerDaemonInfo(), driver "socket" (Docker API) if not set */
            daemon?: { driver: string; daemonRunning: boolean };
            destroyed?: number;
        }

        /**
         * Dashboard with a stubbed docker manager
         *
         * @param manager - what the docker manager knows and records
         * @param created - counts the created docker managers
         * @param created.count - number of created docker managers
         */
        function createCleanupDashboard(manager: TestManager, created: { count: number }): Dashboard {
            const dashboard = createDashboard({ ...native }, null);
            dashboard.createDockerManager = () => {
                created.count++;
                return {
                    isReady: () => Promise.resolve(),
                    containerList: () =>
                        manager.listThrows
                            ? Promise.reject(new Error('connect ENOENT /var/run/docker.sock'))
                            : Promise.resolve(manager.containers),
                    getDockerDaemonInfo: () =>
                        Promise.resolve(manager.daemon ?? { driver: 'socket', daemonRunning: true }),
                    containerRemove: (name: string) => {
                        manager.removed.push(name);
                        if (manager.removeThrows) {
                            return Promise.reject(new Error(manager.removeError));
                        }
                        return Promise.resolve({ stdout: '', stderr: manager.removeError });
                    },
                    destroy: () => {
                        manager.destroyed = (manager.destroyed ?? 0) + 1;
                        return Promise.resolve();
                    },
                } as unknown as ReturnType<Dashboard['createDockerManager']>;
            };
            return dashboard;
        }

        it('does not contact Docker when no container was created before', async () => {
            const created = { count: 0 };
            await createCleanupDashboard(
                { containers: [], removed: [], removeError: '' },
                created,
            ).removeLeftoverContainer();
            expect(created.count).to.equal(0);
        });

        it('removes the container of the instance', async () => {
            const created = { count: 0 };
            const manager = {
                containers: [
                    { names: 'other', status: 'running' },
                    { names: 'iob_esphome_0_esphome', status: 'running' },
                ],
                removed: [],
                removeError: '',
            };
            logs.states['_ESPHomeDashboard.dockerContainer'] = 'iob_esphome_0_esphome';

            await createCleanupDashboard(manager, created).removeLeftoverContainer();

            expect(manager.removed).to.deep.equal(['iob_esphome_0_esphome']);
            expect(logs.states['_ESPHomeDashboard.dockerContainer']).to.equal('');
            expect(logs.error).to.deep.equal([]);
        });

        it('forgets a container which no longer exists', async () => {
            const created = { count: 0 };
            const manager = { containers: [], removed: [], removeError: '' };
            logs.states['_ESPHomeDashboard.dockerContainer'] = 'iob_esphome_0_esphome';

            await createCleanupDashboard(manager, created).removeLeftoverContainer();

            expect(manager.removed).to.deep.equal([]);
            expect(logs.states['_ESPHomeDashboard.dockerContainer']).to.equal('');
        });

        it('keeps the container name when the Docker API cannot be reached', async () => {
            const created = { count: 0 };
            const manager: TestManager = { containers: [], removed: [], removeError: '', listThrows: true };
            logs.states['_ESPHomeDashboard.dockerContainer'] = 'iob_esphome_0_esphome';

            await createCleanupDashboard(manager, created).removeLeftoverContainer();

            expect(logs.states['_ESPHomeDashboard.dockerContainer']).to.equal('iob_esphome_0_esphome');
            // no error (Sentry) for a stopped Docker
            expect(logs.error).to.deep.equal([]);
            expect(manager.destroyed).to.equal(1);
        });

        it('keeps the container name when the docker CLI lists nothing because Docker does not run', async () => {
            const created = { count: 0 };
            const manager: TestManager = {
                containers: [],
                removed: [],
                removeError: '',
                daemon: { driver: 'cli', daemonRunning: false },
            };
            logs.states['_ESPHomeDashboard.dockerContainer'] = 'iob_esphome_0_esphome';

            await createCleanupDashboard(manager, created).removeLeftoverContainer();

            expect(logs.states['_ESPHomeDashboard.dockerContainer']).to.equal('iob_esphome_0_esphome');
            expect(logs.error).to.deep.equal([]);
        });

        it('forgets the container when the running Docker of the CLI lists no containers', async () => {
            const created = { count: 0 };
            const manager: TestManager = {
                containers: [],
                removed: [],
                removeError: '',
                daemon: { driver: 'cli', daemonRunning: true },
            };
            logs.states['_ESPHomeDashboard.dockerContainer'] = 'iob_esphome_0_esphome';

            await createCleanupDashboard(manager, created).removeLeftoverContainer();

            expect(logs.states['_ESPHomeDashboard.dockerContainer']).to.equal('');
        });

        it('tries again on the next start when the container could not be removed', async () => {
            const created = { count: 0 };
            const manager: TestManager = {
                containers: [{ names: 'iob_esphome_0_esphome', status: 'running' }],
                removed: [],
                removeError: 'permission denied',
            };
            logs.states['_ESPHomeDashboard.dockerContainer'] = 'iob_esphome_0_esphome';

            await createCleanupDashboard(manager, created).removeLeftoverContainer();

            expect(logs.warn).to.have.length(1);
            expect(logs.states['_ESPHomeDashboard.dockerContainer']).to.equal('iob_esphome_0_esphome');
            expect(manager.destroyed).to.equal(1);
        });

        it('only warns when the Docker API refuses to remove the container', async () => {
            const created = { count: 0 };
            const manager: TestManager = {
                containers: [{ names: 'iob_esphome_0_esphome', status: 'running' }],
                removed: [],
                removeError: 'permission denied',
                removeThrows: true,
            };
            logs.states['_ESPHomeDashboard.dockerContainer'] = 'iob_esphome_0_esphome';

            await createCleanupDashboard(manager, created).removeLeftoverContainer();

            // not reported as error (Sentry), tried again on the next start
            expect(logs.error).to.deep.equal([]);
            expect(logs.warn).to.have.length(1);
            expect(logs.warn[0]).to.include('permission denied');
            expect(logs.states['_ESPHomeDashboard.dockerContainer']).to.equal('iob_esphome_0_esphome');
            expect(manager.destroyed).to.equal(1);
        });
    });

    describe('port of the dashboard', () => {
        it('does nothing with js-controller < 8', async () => {
            await createDashboard({ ...native, ESPHomeDashboardEnabled: true }, null).registerDashboardPort();
            expect(logs.warn).to.deep.equal([]);
        });

        it('registers the port and warns when another instance holds it (js-controller >= 8)', async () => {
            const dashboard = createDashboard(
                { ...native, ESPHomeDashboardEnabled: true, ESPHomeDashboardPort: 6060 },
                null,
            );
            const registered: unknown[] = [];
            const adapter = (dashboard as unknown as { adapter: Record<string, unknown> }).adapter;
            adapter.checkUsedResource = (_type: string, data: unknown) => {
                expect(data).to.deep.equal({ port: 6060 });
                return Promise.resolve([{ instance: 'system.adapter.other.0' }]);
            };
            adapter.registerUsedResource = (type: string, data: unknown) => {
                registered.push({ type, data });
                return Promise.resolve();
            };

            await dashboard.registerDashboardPort();

            expect(registered).to.deep.equal([{ type: 'tcpPort', data: { port: 6060 } }]);
            expect(logs.warn).to.have.length(1);
            expect(logs.warn[0]).to.include('system.adapter.other.0');
        });

        it('only warns when the host refuses the registration', async () => {
            const dashboard = createDashboard({ ...native, ESPHomeDashboardEnabled: true }, null);
            const adapter = (dashboard as unknown as { adapter: Record<string, unknown> }).adapter;
            adapter.registerUsedResource = () => Promise.reject(new Error('refused'));

            await dashboard.registerDashboardPort();

            expect(logs.error).to.deep.equal([]);
            expect(logs.warn).to.have.length(1);
        });
    });
});
