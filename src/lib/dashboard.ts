/**
 * ESPHome Dashboard Module
 * Handles everything around the ESPHome Dashboard integrated in the adapter: migration of the
 * dashboard configuration, lookup of the available ESPHome, Pillow and ESPHome Device Builder
 * versions, the version dropDowns of the adapter configuration and the dashboard process started
 * through autopy, or the dashboard container started through the docker plugin of ioBroker.
 */

import type DockerPlugin from '@iobroker/plugin-docker';
import type * as DockerPluginModule from '@iobroker/plugin-docker';
import type { getVenv } from 'autopy' with { 'resolution-mode': 'import' };
import * as fs from 'node:fs';
import { buildDashboardUrl } from './dashboardApi';
import {
    autoDetect,
    buildRequirements,
    compareVersions,
    normalizeVersion,
    usesDeviceBuilder,
} from './dashboardRequirements';
import YamlFileManager from './yamlFileManager';

/** Name of the autopy virtual environment the dashboard is installed in */
const VENV_NAME = 'esphome';

/** The ESPHome dashboard process started through autopy */
type DashboardProcess = ReturnType<Awaited<ReturnType<typeof getVenv>>>;

/** Official ESPHome image, the tag is the ESPHome version */
const dockerImage = 'ghcr.io/esphome/esphome';
/** Directory of the container the YAML configuration files are mounted to, see docker-compose.yaml */
const dockerConfigDir = '/config';
/** State with the name of the container of this instance, while one may exist, see removeLeftoverContainer() */
const dockerContainerState = '_ESPHomeDashboard.dockerContainer';
/**
 * How long the unload waits for a container that is being started (stopTimeout in io-package.json is 10 s,
 * the docker plugin stops the container afterwards)
 */
const dockerUnloadWaitMs = 4000;

/**
 * Name the docker plugin gives a container of this instance (DockerManagerOfOwnContainers prefixes the
 * name of the service with iob_<adapter>_<instance>), known before the plugin renamed it
 *
 * @param namespace - namespace of the instance, e.g. esphome.0
 * @param name - container name of docker-compose.yaml (service name)
 * @returns the name of the container in Docker
 */
export function ownContainerName(namespace: string, name: string | undefined): string {
    const prefix = `iob_${namespace.replace(/[-.]/g, '_')}`;
    if (!name || name === prefix || name.startsWith(`${prefix}_`)) {
        return name || prefix;
    }
    return `${prefix}_${name}`;
}

/** TCP port in the used resources registry of js-controller */
type TcpPortResource = { port: number; bind?: string };
/** Used resources registry of js-controller >= 8, not part of the adapter types of js-controller 7 */
interface ResourceRegistry {
    registerUsedResource(type: 'tcpPort', data: TcpPortResource): Promise<void>;
    checkUsedResource?(type: 'tcpPort', data?: Partial<TcpPortResource>): Promise<{ instance: string }[]>;
}

/** One entry of a version dropDown in the adapter configuration */
type VersionDropDownEntry = string | { label: string; value: string };

/** Adapter functions used by the dashboard, implemented by the Esphome adapter class in main.ts */
export interface DashboardAdapter extends ioBroker.Adapter {
    /** Create or update a state, see Esphome.stateSetCreate() */
    stateSetCreate(
        objName: string,
        name: string,
        value?: boolean | string | number | null,
        unit?: string,
        writable?: boolean,
        initialStateCommon?: Partial<ioBroker.StateCommon>,
    ): Promise<void>;
    /** Log an error and send it to Sentry, see Esphome.errorHandler() */
    errorHandler(codepart: string, error: unknown): void;
    /** Write info.connection again, it depends on isReady(), see Esphome.updateConnectionState() */
    updateConnectionState(): Promise<void>;
}

// ESPHome version installations are pinned to. ESPHome 2026.7.x failed to install for a part of our
// users (#463): the Pillow version selected here conflicted with the one ESPHome pins, and 2026.7.0
// removed the built-in dashboard, both handled since (#479, see dashboardRequirements.ts). Both the
// default for new installations and the one-time migration in migratePinnedVersions() point at the
// last version known to work instead of "Always last available". Keep in sync with the "native"
// defaults in io-package.json.
const defaultDashboardVersion = '2026.6.5';

// States holding whether the one-time migrations already ran: away from "Always last available" for
// the ESPHome version, and to "Auto Detect" for the Pillow version.
const versionMigrationState = '_ESPHomeDashboard.versionPinMigrationDone';
const pillowMigrationState = '_ESPHomeDashboard.pillowAutoDetectMigrationDone';

/**
 * Environment variables with the login of the dashboard ("Username" / "Password" in the advanced dashboard
 * settings). Without both, the dashboard is not protected, as before.
 *
 * Passed as environment variables, not as arguments, so they do not show up in the process list. ESPHome
 * Device Builder (ESPHome >= 2026.7.0 and the Docker image since 2026.6.0) reads ESPHOME_USERNAME /
 * ESPHOME_PASSWORD, the dashboard of older ESPHome versions USERNAME / PASSWORD. The variables are always
 * set, so values inherited from the environment of ioBroker never protect the dashboard by accident.
 * USERNAME is only set with a login: it is the name of the OS user otherwise, which both ignore
 * without PASSWORD.
 *
 * @param config - instance configuration, the password already decrypted by adapter-core
 * @returns environment variables for the dashboard process or container
 */
export function dashboardCredentials(
    config: Pick<ioBroker.AdapterConfig, 'ESPHomeDashboardUsername' | 'ESPHomeDashboardPassword'>,
): Record<string, string> {
    const username = (config.ESPHomeDashboardUsername ?? '').trim();
    const password = config.ESPHomeDashboardPassword ?? '';
    if (!username || !password) {
        return { ESPHOME_USERNAME: '', ESPHOME_PASSWORD: '', PASSWORD: '' };
    }
    return { ESPHOME_USERNAME: username, ESPHOME_PASSWORD: password, USERNAME: username, PASSWORD: password };
}

/** Python version of the dashboard environment while none is configured (the version used before it was selectable) */
export const DEFAULT_PYTHON_VERSION = '3.13.2';

/**
 * Python version autopy installs the dashboard environment with (advanced settings, "PythonVersion").
 *
 * A semver version or range, matched against the releases of python-build-standalone: "3.12" or "~3.12.0" takes the
 * newest 3.12.x. Anything else falls back to {@link DEFAULT_PYTHON_VERSION}. When the environment was created with a
 * Python version not matching it, autopy creates the environment again.
 *
 * @param config - instance configuration
 * @returns version or range passed to autopy's getVenv()
 */
export function pythonVersion(config: Pick<ioBroker.AdapterConfig, 'PythonVersion'>): string {
    const configured = String(config.PythonVersion ?? '').trim();
    return /^[~^]?\d+(\.(\d+|x|\*)){0,2}$/.test(configured) ? configured : DEFAULT_PYTHON_VERSION;
}

// Interval and per-request timeout of the check whether the started dashboard answers. Checked more often
// until it answers: the dashboard tab of admin waits for it.
const readyCheckIntervalMs = 60000;
const startingCheckIntervalMs = 5000;
const readyCheckTimeoutMs = 5000;

/**
 * States the dashboard tab of admin (admin/jsonTab.json5) shows: while the dashboard is not ready a hint and
 * the start log, the dashboard itself once it answers
 */
const statusState = '_ESPHomeDashboard.status';
const startLogState = '_ESPHomeDashboard.startLog';
/** Number of lines of the start log shown in the dashboard tab */
const startLogLines = 60;

/**
 * Status of the dashboard for the dashboard tab of admin:
 * - disabled: the dashboard is not enabled in the instance settings
 * - starting: the Python environment / the container is prepared or the dashboard does not answer yet
 * - running: the dashboard answers
 * - failed: the dashboard could not be started or stopped
 * - stopped: the instance was stopped
 */
export type DashboardStatus = 'disabled' | 'starting' | 'running' | 'failed' | 'stopped';

/**
 * ESPHome Dashboard class, one instance per adapter instance
 */
class Dashboard {
    private readonly adapter: DashboardAdapter;
    /** The running dashboard process, if started */
    private dashboardProcess: DashboardProcess | undefined;
    /** Timer of the next check whether the started dashboard answers */
    private readyCheckTimer: ioBroker.Timeout | undefined;
    /** Whether the started dashboard answers requests */
    private ready = false;
    /** Set by stop(), no checks or state changes after that */
    private stopping = false;
    /** Whether the dashboard container was handed to Docker, see startDockerContainer() */
    private containerStarted = false;
    /** Docker manager of the docker plugin and name of the container, to check that it runs */
    private dockerContainer: { manager: ReturnType<DockerPlugin['getDockerManager']>; name: string } | undefined;
    /** startDockerContainer() while it runs, the unload waits for it */
    private dockerStart: Promise<void> | undefined;
    /**
     * Log of the dashboard: info, warn and error go to the log of the instance and to the start log shown in the
     * dashboard tab of admin (appendStartLog()), debug only to the log of the instance. Use it instead of
     * adapter.log, so no message about the start is missing in the tab.
     */
    private readonly log: Pick<ioBroker.Logger, 'debug' | 'info' | 'warn' | 'error'>;
    /** Status shown in the dashboard tab, see setStatus() */
    private status: DashboardStatus | undefined;
    /** Last lines of the start log, see appendStartLog() */
    private readonly startLog: string[] = [];
    /** Write of the start log state while it runs, see writeStartLog() */
    private startLogWrite: Promise<void> | undefined;
    /** The start log changed while it was written */
    private startLogChanged = false;
    /** Memory cache of all available ESPHome Dashboard versions */
    private readonly dashboardVersions: string[] = [];
    /** Memory cache for available Pillow versions */
    private readonly pillowVersions: string[] = [];
    /** Memory cache for available ESPHome Device Builder versions */
    private readonly deviceBuilderVersions: string[] = [];

    /**
     * Constructor for Dashboard
     *
     * @param adapter - The ioBroker adapter instance
     */
    constructor(adapter: DashboardAdapter) {
        this.adapter = adapter;
        this.log = {
            debug: message => adapter.log.debug(message),
            info: message => {
                adapter.log.info(message);
                this.appendStartLog(message);
            },
            warn: message => {
                adapter.log.warn(message);
                this.appendStartLog(message);
            },
            error: message => {
                adapter.log.error(message);
                this.appendStartLog(message);
            },
        };
    }

    /**
     * Log an error and send it to Sentry (Esphome.errorHandler()), also shown in the start log of the dashboard tab
     *
     * @param codepart - part of the code the error occurred in
     * @param error - the caught error
     */
    private errorHandler(codepart: string, error: unknown): void {
        this.adapter.errorHandler(codepart, error);
        this.appendStartLog(`${codepart} ${String(error)}`);
    }

    /**
     * Migrate configuration from older adapter versions
     * Automatically set ESPHomeDashboardUrl if ESPHomeDashboardIP is set but URL is empty
     */
    async migrateConfig(): Promise<void> {
        try {
            // Check if migration is needed:
            // ESPHomeDashboardIP is not empty AND ESPHomeDashboardUrl is empty
            if (this.adapter.config.ESPHomeDashboardIP && !this.adapter.config.ESPHomeDashboardUrl) {
                const calculatedUrl = buildDashboardUrl(
                    this.adapter.config.ESPHomeDashboardIP,
                    this.adapter.config.ESPHomeDashboardPort,
                );

                this.log.info(`Migrating configuration: Setting ESPHomeDashboardUrl to ${calculatedUrl}`);

                const adapterObj = await this.adapter.getForeignObjectAsync(`system.adapter.${this.adapter.namespace}`);
                if (!adapterObj) {
                    this.log.error(
                        `Configuration migration failed: Could not retrieve adapter configuration object for ${this.adapter.namespace}`,
                    );
                    return;
                }
                if (!adapterObj.native) {
                    this.log.error(
                        `Configuration migration failed: Adapter configuration object has no native property`,
                    );
                    return;
                }
                adapterObj.native.ESPHomeDashboardUrl = calculatedUrl;
                await this.adapter.setForeignObject(adapterObj._id, adapterObj);

                this.log.info(`Configuration migrated successfully. ESPHomeDashboardUrl set to: ${calculatedUrl}`);

                // adapter will restart
            }
        } catch (error) {
            const reason = error instanceof Error && error.message ? error.message : String(error);
            this.log.error(
                `Error during configuration migration from ESPHomeDashboardIP to ESPHomeDashboardUrl: ${reason}`,
            );
        }
    }

    /**
     * One-time migrations of the version settings:
     * - an ESPHome version still on "Always last available" is pinned to the last version known to
     *   work. The pinned default in io-package.json only applies to new installations, so without this
     *   every existing installation would stay on a release line that could not be installed (#463).
     * - the Pillow version is set to "Auto Detect". Every ESPHome release since 2024.12 pins the Pillow
     *   version it needs, any other selected version makes the installation fail (#479). Until now a
     *   Pillow version had to be selected, so a selected version tells nothing about the user's intent.
     *
     * Whether a migration already ran is stored in a state, not in "native": a new installation
     * already ships the defaults, and a "native" marker would be seeded into every existing instance
     * on upgrade, so neither could tell "not migrated yet" from "nothing to migrate". Once a marker is
     * set, a deliberate change of the setting is never touched again.
     */
    async migratePinnedVersions(): Promise<void> {
        try {
            await this.adapter.extendObjectAsync('_ESPHomeDashboard', {
                type: 'channel',
                common: {
                    name: 'ESPHome Dashboard details',
                },
                native: {},
            });

            const versionMigrationDone = (await this.adapter.getStateAsync(versionMigrationState))?.val === true;
            const pillowMigrationDone = (await this.adapter.getStateAsync(pillowMigrationState))?.val === true;
            if (versionMigrationDone && pillowMigrationDone) {
                return;
            }

            const migrated: Record<string, string> = {};
            if (!versionMigrationDone && this.adapter.config.ESPHomeDashboardVersion === 'Always last available') {
                migrated.ESPHomeDashboardVersion = defaultDashboardVersion;
            }
            if (!pillowMigrationDone && this.adapter.config.PillowVersion !== autoDetect) {
                migrated.PillowVersion = autoDetect;
            }

            if (Object.keys(migrated).length) {
                const adapterObj = await this.adapter.getForeignObjectAsync(`system.adapter.${this.adapter.namespace}`);
                if (!adapterObj || !adapterObj.native) {
                    this.log.error(
                        `Migration of the dashboard versions failed: could not read the configuration object of ${this.adapter.namespace}. Please select a fixed ESPHome Dashboard version and "${autoDetect}" as Pillow version in the adapter configuration.`,
                    );
                    return;
                }

                if (migrated.ESPHomeDashboardVersion) {
                    this.log.info(
                        `Not every ESPHome release can be installed on every system, so your configuration has been migrated once from "Always last available" to the last version known to work: ESPHomeDashboardVersion = ${migrated.ESPHomeDashboardVersion}. Select "Always last available" again in the adapter configuration if you prefer to follow the newest release, this migration only runs once.`,
                    );
                }
                if (migrated.PillowVersion) {
                    this.log.info(
                        `ESPHome installs the Pillow version it needs itself, so the Pillow version has been changed once from ${this.adapter.config.PillowVersion || 'none'} to "${autoDetect}". A different version makes the installation fail. You can still select one in the advanced dashboard settings, this migration only runs once.`,
                    );
                }

                Object.assign(adapterObj.native, migrated);
                // Keep this run consistent until the restart caused by the write below kicks in
                Object.assign(this.adapter.config, migrated);

                await this.adapter.setForeignObject(adapterObj._id, adapterObj);
                // adapter will restart
            }

            // Written after the configuration: should the write above fail, the migration is retried
            // on the next start instead of being silently skipped forever. Without changes (new
            // installation, versions already pinned) only the markers are written, so a later
            // deliberate change of the settings is respected.
            await this.adapter.stateSetCreate(versionMigrationState, 'versionPinMigrationDone', true);
            await this.adapter.stateSetCreate(pillowMigrationState, 'pillowAutoDetectMigrationDone', true);
        } catch (error) {
            this.errorHandler(`[migratePinnedVersions]`, error);
        }
    }

    /**
     * Warn when a version is left at "Always last available". Such a setup can break without any
     * change on the user side as soon as an ESPHome release cannot be installed (#463). Reached only
     * when the user selected it deliberately, migratePinnedVersions() moves existing installations
     * off that setting once.
     *
     * @param useDashBoardVersion - ESPHome Dashboard version which will be installed
     */
    warnUnpinnedVersions(useDashBoardVersion: string): void {
        if (this.adapter.config.ESPHomeDashboardVersion === 'Always last available') {
            this.log.warn(
                `ESPHome Dashboard version is set to "Always last available" and resolves to ${useDashBoardVersion || 'the newest release'}. Not every ESPHome release can be installed on every system. If the dashboard does not start, select a fixed version in the adapter configuration, ${defaultDashboardVersion} is known to work.`,
            );
        }
    }

    /**
     * Get the available versions and start the ESPHome Dashboard process (if enabled)
     */
    async start(): Promise<void> {
        try {
            // YAML files the native dashboard of version 1.0.0 kept next to the data directory (IOBROKER_DATA_DIR
            // without trailing slash), before anything uses the directory
            YamlFileManager.migrateDirectory(this.adapter.log, this.adapter.instance ?? 0);

            // Create Channel to store ESPHomeDashboard related Data
            await this.adapter.extendObjectAsync('_ESPHomeDashboard', {
                type: 'channel',
                common: {
                    name: 'ESPHome Dashboard details',
                },
                native: {},
            });

            // The dashboard tab of admin shows a hint and the start log until the dashboard answers
            this.startLog.length = 0;
            if (this.adapter.config.ESPHomeDashboardEnabled) {
                await this.setStatus('starting');
            } else {
                this.writeStartLog();
                await this.setStatus('disabled');
            }

            // Get all current available ESPHome Dashboard versions
            /** GitHub releases by index, only the name is used */
            let content: Record<string, { name: string }> | undefined;
            let lastUsed: string | undefined;
            let useDashBoardVersion = '';

            // Get data from state which version was used previous Time
            try {
                const lastUsedState = await this.adapter.getStateAsync(`_ESPHomeDashboard.selectedVersion`);
                if (lastUsedState && lastUsedState.val) {
                    // string or number depending on adapter version
                    lastUsed = String(lastUsedState.val);
                }
            } catch {
                // State does not exist
            }

            try {
                const response = await fetch('https://api.github.com/repos/esphome/esphome/releases');
                if (!response.ok) {
                    throw new Error(
                        `GitHub releases request failed with status ${response.status}: ${response.statusText}`,
                    );
                }
                content = (await response.json()) as Record<string, { name: string }>;
            } catch (error) {
                this.errorHandler(`[espHomeDashboard-VersionCall]`, error);
            }

            // If the response was successful, write versions names to a memory array
            if (content) {
                await this.adapter.stateSetCreate(
                    `_ESPHomeDashboard.versionCache`,
                    'versionCache',
                    JSON.stringify(content),
                );
                for (const version in content) {
                    this.dashboardVersions.push(content[version].name);
                }
                await this.adapter.stateSetCreate(`_ESPHomeDashboard.newestVersion`, 'newestVersion', content[0].name);
            } else {
                // Not possible to load latest versions, use fallback
                this.log.warn(
                    `Unable to retrieve current Dashboard release versions, using cached values. Check your internet connection`,
                );
                const cachedState = await this.adapter.getStateAsync(`_ESPHomeDashboard.versionCache`);
                if (cachedState && cachedState.val) {
                    const cachedVersions = JSON.parse(String(cachedState.val)) as Record<string, { name: string }>;
                    for (const version in cachedVersions) {
                        this.dashboardVersions.push(cachedVersions[version].name);
                    }
                }
            }

            // The version can also be typed in the adapter configuration (e.g. a beta release)
            const configuredVersion = normalizeVersion(this.adapter.config.ESPHomeDashboardVersion);
            if (configuredVersion !== '' && configuredVersion !== 'Always last available') {
                useDashBoardVersion = configuredVersion;
            } else if (configuredVersion === 'Always last available') {
                if (content) {
                    useDashBoardVersion = content[0].name;
                } else if (this.dashboardVersions.length > 0) {
                    // Use first cached version if available
                    useDashBoardVersion = this.dashboardVersions[0];
                }
            }

            if (useDashBoardVersion !== '') {
                await this.adapter.stateSetCreate(
                    `_ESPHomeDashboard.selectedVersion`,
                    'selectedVersion',
                    useDashBoardVersion,
                );
            } else if (lastUsed != null) {
                useDashBoardVersion = lastUsed;
            }

            // Versions for the dropDowns of the adapter configuration
            this.pillowVersions.length = 0;
            this.pillowVersions.push(...(await this.fetchAndCachePillowVersions()));
            this.deviceBuilderVersions.length = 0;
            this.deviceBuilderVersions.push(...(await this.fetchAndCacheDeviceBuilderVersions()));

            if (this.adapter.config.ESPHomeDashboardEnabled) {
                // Not awaited: only a hint, an older host answers only after a timeout
                void this.registerDashboardPort();
            }

            // Start Dashboard Process
            if (this.adapter.config.ESPHomeDashboardEnabled && this.adapter.config.ESPHomeDashboardDocker) {
                this.dockerStart = this.startDockerContainer(useDashBoardVersion).finally(() => {
                    this.dockerStart = undefined;
                });
                return;
            }
            // Before the process starts: a container left running would keep its port
            await this.removeLeftoverContainer();
            if (this.adapter.config.ESPHomeDashboardEnabled) {
                this.log.info(`Native Integration of ESPHome Dashboard enabled, making environment ready`);

                this.warnUnpinnedVersions(useDashBoardVersion);

                const useDeviceBuilder = usesDeviceBuilder(useDashBoardVersion);

                try {
                    // This environment is adapter-managed; suppress pip's manual upgrade notices.
                    // Autopy's setup commands and later Python processes inherit this setting.
                    process.env.PIP_DISABLE_PIP_VERSION_CHECK = '1';
                    const { getVenv } = await import('autopy');
                    let python;
                    try {
                        if (!useDashBoardVersion) {
                            this.log.warn(
                                `Unable to determine a specific ESPHome dashboard version. Falling back to latest available version from PyPI`,
                            );
                        }
                        // Pillow comes with ESPHome, the matching Device Builder is chosen by pip, unless
                        // a version is selected in the advanced settings (#479)
                        const requirements = buildRequirements(
                            useDashBoardVersion,
                            this.adapter.config.PillowVersion,
                            this.adapter.config.DeviceBuilderVersion,
                        );
                        this.log.debug(`Python requirements: ${JSON.stringify(requirements)}`);
                        const usePythonVersion = pythonVersion(this.adapter.config);
                        const configuredPythonVersion = String(this.adapter.config.PythonVersion ?? '').trim();
                        if (configuredPythonVersion && usePythonVersion !== configuredPythonVersion) {
                            this.log.warn(
                                `Invalid Python version "${this.adapter.config.PythonVersion}" in the advanced dashboard settings, using ${usePythonVersion}`,
                            );
                        }
                        this.log.info(
                            `Preparing the Python environment of the dashboard (Python ${usePythonVersion}): ${requirements.map(requirement => `${requirement.name}${requirement.version}`).join(', ')}. Installing them takes several minutes on the first start or after a version change.`,
                        );
                        // Create a virtual environment with esphome installed. upgrade: as soon as something
                        // has to be installed (e.g. another ESPHome version), pip may also upgrade the
                        // installed packages, otherwise it keeps the Device Builder installed for the
                        // previous ESPHome version.
                        python = await getVenv({
                            name: VENV_NAME,
                            // An environment with another Python version is created again by autopy
                            pythonVersion: usePythonVersion,
                            requirements,
                            upgrade: true,
                        });
                    } catch (error) {
                        const stack = error instanceof Error ? error.stack : undefined;
                        this.log.error(`Fatal error starting ESPHomeDashboard | ${String(error)} | ${stack}`);
                        await this.setStatus('failed');
                        return;
                    }

                    // Define directory to store configuration files
                    const configDir = this.getConfigDirectory();

                    try {
                        fs.mkdir(configDir, err => {
                            if (err) {
                                return console.log(`ESPHome directory exists`);
                            }
                            console.log(`ESPHome directory created`);
                        });
                        // );
                    } catch (error) {
                        // Directory has issues reading/writing data, iob fix should be executed
                        this.log.warn(
                            `ESPHome DDashboard is unable to access directory to store YAML configuration data, please run ioBroker fix: ${String(error)}`,
                        );
                    }

                    const port = String(this.adapter.config.ESPHomeDashboardPort);
                    // From ESPHome 2026.7.0 on `esphome dashboard` only exits with an error, ESPHome Device
                    // Builder takes the same port and configuration directory
                    const command = useDeviceBuilder ? 'esphome-device-builder' : 'esphome';
                    const args = useDeviceBuilder
                        ? ['--port', port, configDir]
                        : ['dashboard', '--port', port, configDir];

                    // The versions pip installed, Pillow and the Device Builder are not configured by default
                    const installed = await this.getInstalledVersions(python);
                    const deviceBuilderInfo = useDeviceBuilder
                        ? `, ESPHome Device Builder version: ${installed['esphome-device-builder'] || 'unknown'}`
                        : '';
                    this.log.info(
                        `Starting ESPHome Dashboard. ESPHome version: ${installed.esphome || useDashBoardVersion || 'latest'}, Pillow version: ${installed.pillow || 'unknown'}${deviceBuilderInfo}`,
                    );
                    // buffer: false, the output is only logged below and would otherwise be kept in memory
                    // for as long as the dashboard runs. NO_COLOR keeps color codes out of the log.
                    this.logLogin();
                    this.dashboardProcess = python(command, args, {
                        buffer: false,
                        env: { NO_COLOR: '1', ...dashboardCredentials(this.adapter.config) },
                    });

                    this.log.debug(`espHomeDashboard_Process ${JSON.stringify(this.dashboardProcess)}`);

                    // Output of the dashboard: shown in the tab as it is, in the log of the instance by its level
                    this.dashboardProcess.stdout?.on('data', data => {
                        this.appendStartLog(String(data));
                        this.adapter.log.info(`[this.dashboardProcess - Data] ${data}`);
                    });

                    this.dashboardProcess.stderr?.on('data', data => {
                        this.appendStartLog(String(data));
                        if (data.includes('ERROR')) {
                            // e.g. the reason why the dashboard stops right after the start
                            this.adapter.log.error(`[ESPHome - Console] ${data}`);
                        } else if (data.includes('INFO')) {
                            if (data.includes('Starting') || data.includes('Device Builder ready')) {
                                this.adapter.log.info(`[ESPHome - Console] ${data}`);
                            } else {
                                this.adapter.log.debug(`[ESPHome - Console] ${data}`);
                            }
                        }
                    });

                    void this.dashboardProcess.on('exit', (code, signal) => {
                        this.log.warn(`ESPHome Dashboard stopped (exit code ${code}, signal ${signal})`);
                        this.onDashboardStopped();
                    });

                    // The process is also a promise, which rejects when it cannot be started, exits with an
                    // error or is stopped. Unhandled, that rejection terminates the whole adapter (#479).
                    this.dashboardProcess.catch((error: unknown) => {
                        const { code, exitCode, signal } = error as {
                            code?: string;
                            exitCode?: number;
                            signal?: string;
                        };
                        if (exitCode != null || signal != null) {
                            // Exited or stopped, already logged by the exit handler
                            return;
                        }
                        this.onDashboardStopped();
                        const reason = error instanceof Error && error.message ? error.message : String(error);
                        if (code === 'ENOENT') {
                            this.log.error(
                                `ESPHome Dashboard could not be started, "${command}" is missing in the Python environment. Reset the Python environment in the adapter configuration and restart the adapter to install it again: ${reason}`,
                            );
                        } else {
                            this.log.error(`ESPHome Dashboard could not be started: ${reason}`);
                        }
                    });

                    // info.connection (green instance) only lists devices once the dashboard answers
                    this.scheduleReadyCheck(port);
                } catch (error) {
                    this.errorHandler(`[espHomeDashboard-Process]`, error);
                    await this.setStatus('failed');
                }
            } else {
                this.log.info(`Native Integration of ESPHome Dashboard disabled `);
            }
        } catch (error) {
            this.errorHandler(`[espHomeDashboard-Function]`, error);
            if (this.adapter.config.ESPHomeDashboardEnabled) {
                await this.setStatus('failed');
            }
        }
    }

    /**
     * Get the directory of the YAML configuration files of this instance, the same directory the YAML
     * file management of the adapter configuration uses
     *
     * @returns absolute path of the directory
     */
    getConfigDirectory(): string {
        return YamlFileManager.getDirectory(this.adapter.instance ?? 0);
    }

    /**
     * Run the ESPHome Dashboard as container of the official ESPHome image instead of the autopy process
     *
     * The container is declared in docker-compose.yaml and managed by the docker plugin of ioBroker
     * (common.plugins.docker in io-package.json). The plugin prepares it when the instance starts, but
     * waits (iobWaitForReady) until instanceIsReady() is called here: only now the image tag and the
     * configuration directory are known, which a compose file cannot express. As this only happens when
     * the dashboard is enabled, the container never runs with a disabled dashboard. iobStopOnUnload
     * stops it together with the instance, like the native dashboard process.
     *
     * Not awaited by start(): on the first start the image is pulled, which takes a while.
     *
     * The command is `dashboard` for every version: the entrypoint of the image runs ESPHome Device Builder
     * for it since ESPHome 2026.6.0, older images still have `esphome dashboard`.
     *
     * @param version - ESPHome version (image tag) to run, the newest stable release if empty
     */
    async startDockerContainer(version: string): Promise<void> {
        try {
            const plugin = this.adapter.getPluginInstance('docker') as DockerPlugin | null;
            if (!plugin) {
                this.log.error(
                    `Docker Integration of the ESPHome Dashboard is enabled, but the docker plugin of ioBroker is not loaded. Disable "Use Docker Integration" to run the dashboard without Docker.`,
                );
                await this.setStatus('failed');
                return;
            }
            const container = plugin.configurations.find(config =>
                config.mounts?.some(mount => mount.target === dockerConfigDir),
            );
            if (!container) {
                this.log.error(
                    `Docker Integration of the ESPHome Dashboard is enabled, but docker-compose.yaml of the adapter declares no ESPHome Dashboard container for the docker plugin. Restart the instance, reinstall the adapter if this persists.`,
                );
                await this.setStatus('failed');
                return;
            }

            // The container writes into the same directory as the native dashboard and the YAML file management
            const configDir = this.getConfigDirectory();
            fs.mkdirSync(configDir, { recursive: true });

            container.image = `${dockerImage}:${version || 'stable'}`;
            // A version tag never changes, "stable" does: pull it again on every start, otherwise the image
            // of the first start would be used for good
            container.iobAutoImageUpdate = !version;
            // Login of the dashboard, see dashboardCredentials()
            container.environment = { ...container.environment, ...dashboardCredentials(this.adapter.config) };
            this.logLogin();
            for (const mount of container.mounts ?? []) {
                if (mount.target === dockerConfigDir) {
                    mount.type = 'bind';
                    mount.source = configDir;
                }
            }

            this.log.info(
                `Docker Integration (beta) of ESPHome Dashboard enabled, starting container. Image: ${container.image}, configuration directory: ${configDir}. Pulling the image takes several minutes on the first start or after a version change.`,
            );
            // Recorded before the container can exist: when the process ends while it is being created,
            // removeLeftoverContainer() still knows it
            await this.adapter.stateSetCreate(
                dockerContainerState,
                'dockerContainer',
                ownContainerName(this.adapter.namespace, container.name),
            );
            const ready = plugin.instanceIsReady();
            // Created by instanceIsReady() right away. Kept here, as the plugin drops it on unload.
            const manager = plugin.getDockerManager();
            // Resolves also when the image could not be pulled or the container not started, the plugin
            // only logs a warning then
            await ready;

            const name = container.name;
            if (this.stopping) {
                // The instance unloaded while the image was pulled: the plugin stopped the container before
                // it existed, so it is stopped here. The unload waits a moment for this (stop()); if the
                // process ended before, the next start reuses it or removeLeftoverContainer() removes it.
                if (manager && name) {
                    await manager.containerStop(name).catch(() => undefined);
                }
                return;
            }

            const state = name ? (await manager?.containerList(true))?.find(info => info.names === name) : undefined;
            if (!name || !state) {
                this.log.error(
                    `ESPHome Dashboard container ${name ?? ''} was not created: Docker is not installed or not running, or the image ${container.image} could not be pulled, see the warnings of the docker plugin in the log. Disable "Use Docker Integration" to run the dashboard without Docker.`,
                );
                await this.setStatus('failed');
                return;
            }
            // Removed by the next start of the instance without Docker Integration, also when the instance
            // ended without stopping it. Normally the name recorded above already.
            await this.adapter.stateSetCreate(dockerContainerState, 'dockerContainer', name);
            if (state.status === 'running' || state.status === 'restarting') {
                this.log.info(`ESPHome Dashboard container ${name} is running, waiting for the dashboard to answer`);
            } else {
                this.log.error(
                    `ESPHome Dashboard container ${name} is not running (${state.status}), see the warnings of the docker plugin above. The docker plugin tries to start it again every minute.`,
                );
            }
            // Host network: the dashboard of the container answers on the configured port of this host.
            // info.connection (green instance) only lists devices once it does, like with the process. Also
            // checked when the container does not run yet, the docker plugin starts it again.
            this.containerStarted = true;
            this.dockerContainer = { manager, name };
            this.scheduleReadyCheck(String(this.adapter.config.ESPHomeDashboardPort));
        } catch (error) {
            this.errorHandler(`[espHomeDashboard-Docker]`, error);
            await this.setStatus('failed');
        }
    }

    /**
     * Log whether the dashboard asks for a login, and warn when only one of username and password is set
     */
    private logLogin(): void {
        const username = (this.adapter.config.ESPHomeDashboardUsername ?? '').trim();
        const password = this.adapter.config.ESPHomeDashboardPassword ?? '';
        if (username && password) {
            this.log.info(`ESPHome Dashboard is protected by a login, username: ${username}`);
        } else if (username || password) {
            this.log.warn(
                `ESPHome Dashboard is NOT protected: only the ${username ? 'username' : 'password'} of the login is set in the advanced dashboard settings, both are needed`,
            );
        }
    }

    /**
     * Report the port of the dashboard (process or container, both on the host network and all interfaces)
     * to js-controller >= 8 as used by this instance (common.declareUsedResources), so it shows up as
     * occupied. Before, warn when another instance holds it: the dashboard would not start then.
     */
    async registerDashboardPort(): Promise<void> {
        const registry = this.adapter as unknown as Partial<ResourceRegistry>;
        if (typeof registry.registerUsedResource !== 'function') {
            // js-controller < 8
            return;
        }
        const port = Number(this.adapter.config.ESPHomeDashboardPort) || 6052;
        if (typeof registry.checkUsedResource === 'function') {
            try {
                const holders = await registry.checkUsedResource('tcpPort', { port });
                if (holders.length) {
                    this.log.warn(
                        `Port ${port} of the ESPHome Dashboard is already used by ${holders.map(holder => holder.instance).join(', ')}. The dashboard will probably not start, select another port in the dashboard settings.`,
                    );
                }
            } catch (error) {
                this.log.debug(`Cannot check whether port ${port} is free: ${String(error)}`);
            }
        }
        try {
            await registry.registerUsedResource('tcpPort', { port });
        } catch (error) {
            // A registration still waiting for the host when the instance unloads is rejected, nothing to report
            if (!this.stopping) {
                this.log.warn(`Cannot register port ${port} of the ESPHome Dashboard as used: ${String(error)}`);
            }
        }
    }

    /**
     * Create a docker manager for this instance, without the docker plugin, which only manages the container
     * while "Use Docker Integration" and the dashboard are enabled
     *
     * @returns the docker manager
     */
    createDockerManager(): DockerPluginModule.DockerManager {
        // Loaded on demand: only needed when a container was left behind
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { DockerManager } = require('@iobroker/plugin-docker') as typeof DockerPluginModule;
        return new DockerManager({
            logger: this.adapter.log,
            namespace: `esphome.${this.adapter.instance ?? 0}`,
            quiet: true,
        });
    }

    /**
     * Remove the dashboard container of this instance when the dashboard runs without Docker or is disabled.
     * Normally the docker plugin stops it on unload, but not when the instance ended without unload (crash,
     * killed after stopTimeout) or while the image was pulled. Then it would keep running, serving the YAML
     * directory and blocking the port of the dashboard process. Docker is only contacted when a container
     * was created before (dockerContainerState).
     */
    async removeLeftoverContainer(): Promise<void> {
        try {
            const state = await this.adapter.getStateAsync(dockerContainerState);
            const name = state?.val ? String(state.val) : '';
            if (!name) {
                return;
            }
            const manager = this.createDockerManager();
            try {
                await manager.isReady();
                // The name is only forgotten when Docker answered: the Docker API throws when the daemon cannot be
                // reached, the docker CLI returns an empty list then
                let containers: Awaited<ReturnType<typeof manager.containerList>>;
                try {
                    containers = await manager.containerList(true);
                } catch (error) {
                    this.log.debug(
                        `Docker cannot be reached, container ${name} is checked again on the next start: ${String(error)}`,
                    );
                    return;
                }
                const container = containers.find(info => info.names === name);
                if (!containers.length) {
                    const info = await manager.getDockerDaemonInfo();
                    if (info.driver === 'cli' && !info.daemonRunning) {
                        this.log.debug(
                            `Docker does not seem to run, container ${name} is checked again on the next start`,
                        );
                        return;
                    }
                }
                if (container) {
                    this.log.info(
                        `Removing ESPHome Dashboard container ${name}, "Use Docker Integration" or the dashboard is disabled`,
                    );
                    // The Docker API reports a failure by throwing, the docker CLI in stderr
                    let failure: string;
                    try {
                        failure = (await manager.containerRemove(name)).stderr;
                    } catch (error) {
                        failure = error instanceof Error ? error.message : String(error);
                    }
                    if (failure) {
                        // Kept in the state, tried again on the next start
                        this.log.warn(`ESPHome Dashboard container ${name} could not be removed: ${failure}`);
                        return;
                    }
                }
                await this.adapter.stateSetCreate(dockerContainerState, 'dockerContainer', '');
            } finally {
                await manager.destroy().catch(() => undefined);
            }
        } catch (error) {
            this.errorHandler(`[espHomeDashboard-DockerCleanup]`, error);
        }
    }

    /**
     * Add a version to a dropDown when it is not part of it yet, so a configured version can never
     * silently disappear from the selection when the release list is unavailable or outdated
     *
     * @param dropDownEntry - dropDown entries to extend
     * @param version - version which must be selectable
     */
    ensureVersionInDropDown(dropDownEntry: (string | { label: string; value: string })[], version: string): void {
        const known = dropDownEntry.some(entry => (typeof entry === 'string' ? entry : entry.value) === version);
        if (!known) {
            dropDownEntry.push({ label: version, value: version });
        }
    }

    /**
     * Fetch Pillow versions from PyPI and cache them
     *
     * @returns Array of available Pillow versions
     */
    async fetchAndCachePillowVersions(): Promise<string[]> {
        const fallbackVersions = ['12.2.0', '12.1.1', '12.0.0', '11.3.0', '11.2.0', '11.1.0'];

        try {
            const response = await fetch('https://pypi.org/pypi/pillow/json');
            if (response.ok) {
                const data = (await response.json()) as { releases: Record<string, unknown> };
                const versions = Object.keys(data.releases)
                    .filter(v => !v.includes('a') && !v.includes('b') && !v.includes('rc')) // Filter out alpha/beta/rc versions
                    .sort((a, b) => compareVersions(b, a)) // Sort versions in descending order (newest first)
                    .slice(0, 20); // Limit to 20 most recent versions

                if (versions.length > 0) {
                    // Cache the versions
                    await this.adapter.stateSetCreate(
                        `_ESPHomeDashboard.pillowVersionCache`,
                        'pillowVersionCache',
                        JSON.stringify(versions),
                    );
                    await this.adapter.stateSetCreate(
                        `_ESPHomeDashboard.newestPillowVersion`,
                        'newestPillowVersion',
                        versions[0],
                    );
                    this.log.debug(`Fetched ${versions.length} Pillow versions from PyPI, newest: ${versions[0]}`);
                    return versions;
                }
                this.log.warn('No stable Pillow versions found on PyPI, using cached or fallback versions');
            } else {
                this.log.warn(`Unable to fetch Pillow versions from PyPI: ${response.status}, using cached values`);
            }
        } catch (error) {
            const reason = error instanceof Error && error.message ? error.message : String(error);
            this.log.warn(`Error fetching Pillow versions from PyPI: ${reason}, using cached or fallback versions`);
        }

        // Try to load from cache
        try {
            const cachedPillowVersions = await this.adapter.getStateAsync(`_ESPHomeDashboard.pillowVersionCache`);
            if (cachedPillowVersions && cachedPillowVersions.val) {
                const versions = JSON.parse(String(cachedPillowVersions.val));
                this.log.info(`Loaded ${versions.length} Pillow versions from cache`);
                return versions;
            }
        } catch {
            // Cache read failed, will use fallback
        }

        // Use fallback versions
        this.log.info(`Using ${fallbackVersions.length} fallback Pillow versions`);
        return fallbackVersions;
    }

    /**
     * Fetch the ESPHome Device Builder versions from PyPI for the version dropDown and cache them
     *
     * @returns the newest 20 releases, newest first, the cached ones when PyPI cannot be reached
     */
    async fetchAndCacheDeviceBuilderVersions(): Promise<string[]> {
        const cacheState = `_ESPHomeDashboard.deviceBuilderVersionCache`;
        try {
            const response = await fetch('https://pypi.org/pypi/esphome-device-builder/json');
            if (!response.ok) {
                throw new Error(`status ${response.status}`);
            }
            const data = (await response.json()) as { releases: Record<string, { yanked?: boolean }[]> };
            const versions = Object.entries(data.releases)
                // Without pre-releases and releases which were removed or yanked
                .filter(([version, files]) => /^\d+(\.\d+)*$/.test(version) && files.some(file => !file.yanked))
                .map(([version]) => version)
                .sort((a, b) => compareVersions(b, a))
                .slice(0, 20);
            await this.adapter.stateSetCreate(cacheState, 'deviceBuilderVersionCache', JSON.stringify(versions));
            return versions;
        } catch (error) {
            const reason = error instanceof Error && error.message ? error.message : String(error);
            this.log.debug(`Unable to fetch ESPHome Device Builder versions from PyPI: ${reason}`);
        }

        try {
            const cached = await this.adapter.getStateAsync(cacheState);
            if (cached && cached.val) {
                return JSON.parse(String(cached.val)) as string[];
            }
        } catch {
            // No usable cache, only "Auto Detect" can be selected
        }
        return [];
    }

    /**
     * Versions of ESPHome, Pillow and ESPHome Device Builder installed in the Python environment
     *
     * @param python - runs a command in the Python environment, returned by autopy's getVenv()
     * @returns installed versions by package name, empty when pip could not be asked
     */
    private async getInstalledVersions(
        python: Awaited<ReturnType<typeof getVenv>>,
    ): Promise<Record<string, string | undefined>> {
        try {
            const { stdout } = await python('python', ['-m', 'pip', 'list', '--format', 'json']);
            const packages = JSON.parse(String(stdout)) as { name: string; version: string }[];
            return Object.fromEntries(packages.map(({ name, version }) => [name.toLowerCase(), version]));
        } catch (error) {
            const reason = error instanceof Error && error.message ? error.message : String(error);
            this.log.debug(`Unable to list the installed Python packages: ${reason}`);
            return {};
        }
    }

    /**
     * Remove the Python virtual environment of the dashboard (ESPHome, ESPHome Device Builder, Pillow and their
     * dependencies). autopy creates it again on the next start of the dashboard. The Python downloaded by autopy is
     * kept. autopy decides where it stores the environment, the location depends on the platform.
     */
    async resetPythonEnvironment(): Promise<void> {
        try {
            this.log.info('Removing the Python environment of the ESPHome Dashboard');
            const { removeVenv } = await import('autopy');
            await removeVenv(VENV_NAME);
            this.log.info(
                'Python environment of the ESPHome Dashboard removed, restart the adapter to install it again',
            );
        } catch (error) {
            const reason = error instanceof Error && error.message ? error.message : String(error);
            this.log.error(`Error removing the Python environment of the ESPHome Dashboard: ${reason}`);
            throw error;
        }
    }

    /**
     * Stop the dashboard process, if running. The container is stopped by the docker plugin; while it is
     * being started, this waits a moment, so a container created meanwhile is stopped by startDockerContainer()
     * before the adapter process ends.
     */
    async stop(): Promise<void> {
        this.stopping = true;
        this.adapter.clearTimeout(this.readyCheckTimer);
        this.readyCheckTimer = undefined;
        if (this.status && this.status !== 'disabled') {
            // Not awaited, the unload must not wait for the database
            void this.setStatus('stopped');
        }
        try {
            if (this.dashboardProcess) {
                this.dashboardProcess.kill('SIGTERM', {
                    forceKillAfterTimeout: 2000,
                });
            }
        } catch (e) {
            this.log.error(`[onUnload - dashboardProcess] ${JSON.stringify(e)}`);
        }
        if (this.dockerStart) {
            // The timers of the adapter cannot be used any more while it unloads
            const timeout = AbortSignal.timeout(dockerUnloadWaitMs);
            await Promise.race([
                this.dockerStart,
                new Promise<void>(resolve => timeout.addEventListener('abort', () => resolve())),
            ]);
        }
    }

    /**
     * Whether the started dashboard answers requests. info.connection (green instance) waits for it while the
     * dashboard is enabled.
     *
     * @returns true once the dashboard answered, false again when it stopped
     */
    isReady(): boolean {
        return this.ready;
    }

    /**
     * Check repeatedly whether the started dashboard answers and update info.connection once it does.
     * For the process this ends when it answers, stops or the adapter unloads. The container is checked
     * until the adapter unloads, info.connection is updated again when it stops answering.
     *
     * @param port - port the dashboard listens on
     */
    private scheduleReadyCheck(port: string): void {
        this.readyCheckTimer = this.adapter.setTimeout(
            async () => {
                this.readyCheckTimer = undefined;
                if (!this.isStarted()) {
                    return;
                }
                // Host network: when the container cannot bind the port because something else holds it, that
                // answers instead, so the container itself has to run as well
                const reachable = (await this.isReachable(port)) && (await this.isContainerRunning());
                if (!this.isStarted()) {
                    return;
                }
                const changed = reachable !== this.ready;
                this.ready = reachable;
                // The process reports its exit, the container does not: it is checked as long as it runs
                if (!reachable || this.containerStarted) {
                    this.scheduleReadyCheck(port);
                }
                if (!changed) {
                    return;
                }
                if (reachable) {
                    this.log.info(`ESPHome Dashboard is reachable on port ${port}`);
                    await this.setStatus('running');
                } else {
                    this.log.warn(`ESPHome Dashboard is not reachable on port ${port} any more`);
                    await this.setStatus('starting');
                }
                await this.adapter.updateConnectionState();
            },
            this.ready ? readyCheckIntervalMs : startingCheckIntervalMs,
        );
    }

    /**
     * Whether the dashboard container runs, always true for the dashboard process
     *
     * @returns false when the container stopped or Docker cannot tell
     */
    private async isContainerRunning(): Promise<boolean> {
        if (!this.dockerContainer) {
            return true;
        }
        const { manager, name } = this.dockerContainer;
        try {
            const state = (await manager?.containerList(true))?.find(info => info.names === name);
            return state?.status === 'running';
        } catch {
            return false;
        }
    }

    /**
     * Whether the dashboard was started, as process or as container, and the adapter does not unload
     *
     * @returns true while the dashboard is expected to answer
     */
    private isStarted(): boolean {
        return !this.stopping && (this.dashboardProcess !== undefined || this.containerStarted);
    }

    /**
     * Whether the dashboard answers HTTP requests on the given port of this host
     *
     * @param port - port the dashboard listens on
     * @returns true for a successful response or a redirect
     */
    private async isReachable(port: string): Promise<boolean> {
        try {
            const response = await fetch(`http://localhost:${port}/`, {
                redirect: 'manual',
                signal: AbortSignal.timeout(readyCheckTimeoutMs),
            });
            return response.status >= 200 && response.status < 400;
        } catch {
            // Not listening (yet)
            return false;
        }
    }

    /**
     * The dashboard process exited or could not be started: no more checks and, unless the adapter
     * unloads, info.connection is updated so the instance no longer shows green
     */
    private onDashboardStopped(): void {
        this.dashboardProcess = undefined;
        this.ready = false;
        this.adapter.clearTimeout(this.readyCheckTimer);
        this.readyCheckTimer = undefined;
        if (this.stopping) {
            return;
        }
        void this.setStatus('failed');
        void this.adapter.updateConnectionState();
    }

    /**
     * Status of the dashboard shown in the dashboard tab of admin
     *
     * @returns undefined before start()
     */
    getStatus(): DashboardStatus | undefined {
        return this.status;
    }

    /**
     * Data of the dashboard tab of admin (command of admin/jsonTab.json5)
     *
     * @returns URL of the dashboard shown in the iframe of the tab
     */
    getTabData(): { data: { dashboardUrl: string } } {
        return { data: { dashboardUrl: this.adapter.config.ESPHomeDashboardUrl || '' } };
    }

    /**
     * Update the status shown in the dashboard tab of admin
     *
     * @param status - new status
     */
    private async setStatus(status: DashboardStatus): Promise<void> {
        if (status === this.status) {
            return;
        }
        this.status = status;
        await this.adapter.stateSetCreate(statusState, 'dashboardStatus', status);
        if (status !== 'running') {
            // Output written while the dashboard answered was not stored, see appendStartLog()
            this.writeStartLog();
        }
    }

    /**
     * Add output of the dashboard start to the log shown in the dashboard tab of admin until the dashboard
     * answers. Only the last lines are kept.
     *
     * @param text - one or more lines
     */
    private appendStartLog(text: string): void {
        const time = new Date().toTimeString().slice(0, 8);
        for (const line of text.split(/\r?\n/)) {
            if (line.trim()) {
                this.startLog.push(`${time} ${line.trimEnd()}`);
            }
        }
        if (this.startLog.length > startLogLines) {
            this.startLog.splice(0, this.startLog.length - startLogLines);
        }
        // Not shown while the dashboard answers, the dashboard logs every request
        if (this.status !== 'running') {
            this.writeStartLog();
        }
    }

    /**
     * Write the start log to its state. A change made while it is written is written right afterwards, so
     * a burst of output only causes a few writes.
     */
    private writeStartLog(): void {
        this.startLogChanged = true;
        if (this.startLogWrite || this.stopping) {
            return;
        }
        this.startLogWrite = (async () => {
            while (this.startLogChanged && !this.stopping) {
                this.startLogChanged = false;
                await this.adapter.stateSetCreate(startLogState, 'dashboardStartLog', this.startLog.join('\n'));
            }
        })().finally(() => {
            this.startLogWrite = undefined;
        });
    }

    /**
     * Entries of the ESPHome Dashboard version dropDown in the adapter configuration
     *
     * @returns dropDown entries, "Always last available" first
     */
    getDashboardVersionDropDown(): VersionDropDownEntry[] {
        const dropDownEntry: VersionDropDownEntry[] = [];
        dropDownEntry.push('Always last available');
        // eslint-disable-next-line @typescript-eslint/no-for-in-array -- for...in kept: it also tolerates a missing (undefined) value
        for (const versions in this.dashboardVersions) {
            dropDownEntry.push({
                label: this.dashboardVersions[versions],
                value: this.dashboardVersions[versions],
            });
        }
        // The version new installations default to must always be selectable, also
        // when the release list could not be retrieved from GitHub
        this.ensureVersionInDropDown(dropDownEntry, defaultDashboardVersion);
        return dropDownEntry;
    }

    /**
     * Entries of the Pillow version dropDown in the adapter configuration
     *
     * @returns dropDown entries, "Auto Detect" first
     */
    getPillowVersionDropDown(): VersionDropDownEntry[] {
        const dropDownEntry: VersionDropDownEntry[] = [];
        // "Always last available" is not offered: the newest Pillow conflicts with the version ESPHome pins
        dropDownEntry.push(autoDetect);

        // Use cached versions from memory
        if (this.pillowVersions.length > 0) {
            for (const version of this.pillowVersions) {
                dropDownEntry.push({
                    label: version,
                    value: version,
                });
            }
        } else {
            // Fallback versions if cache is empty
            this.log.info('No cached Pillow versions available, using fallback versions');
            const fallbackVersions = ['12.2.0', '12.1.1', '12.0.0', '11.3.0', '11.2.0', '11.1.0'];
            for (const version of fallbackVersions) {
                dropDownEntry.push({
                    label: version,
                    value: version,
                });
            }
        }
        return dropDownEntry;
    }

    /**
     * Entries of the ESPHome Device Builder version dropDown in the adapter configuration
     *
     * @returns dropDown entries, "Auto Detect" first
     */
    getDeviceBuilderVersionDropDown(): VersionDropDownEntry[] {
        const dropDownEntry: VersionDropDownEntry[] = [autoDetect];
        for (const version of this.deviceBuilderVersions) {
            dropDownEntry.push({ label: version, value: version });
        }
        // A selected version must stay selectable, also when the release list could not be retrieved
        const configured = this.adapter.config.DeviceBuilderVersion;
        if (configured && configured !== autoDetect) {
            this.ensureVersionInDropDown(dropDownEntry, configured);
        }
        return dropDownEntry;
    }
}

export default Dashboard;
