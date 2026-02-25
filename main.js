'use strict';

/*
 * Created with @iobroker/create-adapter v1.31.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const clientDevice = require('./lib/helpers.js');
const YamlFileManager = require('./lib/yamlFileManager.js');
// @ts-expect-error Client is just missing in index.d.ts file
const { Client, Discovery } = require('@2colors/esphome-native-api');
const stateAttr = require(`${__dirname}/lib/stateAttr.js`); // Load attribute library
const disableSentry = false; // Ensure to set to true during development!
const warnMessages = {}; // Store warn messages to avoid multiple sending to sentry
const fs = require('fs');
const path = require('path');
const os = require('os');
const { clearTimeout } = require('timers');
const resetTimers = {}; // Memory allocation for all running timers
let autodiscovery, dashboardProcess, createConfigStates, discovery;
const clientDetails = {}; // Memory cache of all devices and their connection status
const newlyDiscoveredClient = {}; // Memory cache of all newly discovered devices and their connection status
const dashboardVersions = [];
const pillowVersions = []; // Memory cache for available Pillow versions
class Esphome extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - Adapter configuration options
     */
    constructor(options) {
        super({
            ...options,
            name: 'esphome',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        // this.on('objectChange', this.onObjectChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));

        this.deviceStateRelation = {}; // Memory array of an initiated device by Device Identifier (name) and IP
        this.createdStatesDetails = {}; // Array to store information of created states
        this.messageResponse = {}; // Array to store messages from admin and provide proper message to add/remove devices

        // Initialize YAML file manager
        this.yamlFileManager = new YamlFileManager(this);
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        await this.setStateAsync('info.connection', { val: true, ack: true });
        try {
            // Migrate from older adapter versions that only had ESPHomeDashboardIP
            await this.migrateConfig();

            //ToDo: store default data into clientDetails object instead of global variable
            // Store settings in global variables
            // defaultApiPass = this.config.apiPass;
            autodiscovery = this.config.autodiscovery;
            // reconnectInterval = this.config.reconnectInterval * 1000;
            createConfigStates = this.config.configStates;

            // Ensure all online states are set to false during adapter start
            await this.resetOnlineStates();

            // Try connecting to already known devices
            await this.tryKnownDevices();

            // Get current available versions and start ESPHome Dashboard process (if enabled)
            await this.espHomeDashboard();

            // Start MDNS discovery when enabled
            if (autodiscovery) {
                if (resetTimers['autodiscovery']) {
                    resetTimers['autodiscovery'] = clearTimeout(resetTimers['autodiscovery']);
                }
                // this.log.info(`Adapter ready, automatic Device Discovery will be activated in 30 seconds.`);
                resetTimers['autodiscovery'] = setTimeout(async () => {
                    this.deviceDiscovery(); // Start bonjour service autodiscovery
                }, 5000);
            } else {
                this.log.warn(
                    `Auto Discovery disabled, new devices (or IP changes) will NOT be detected automatically!`,
                );
            }

            // Create & Subscribe to button handling offline Device cleanup
            this.extendObject('info.deviceCleanup', {
                type: 'state',
                common: {
                    role: 'button',
                    name: 'Device or service connected',
                    type: 'boolean',
                    read: false,
                    write: true,
                    def: false,
                },
            });
            this.subscribeStates('info.deviceCleanup');

            // Create & Subscribe to button for clearing autopy cache
            this.extendObject('info.clearAutopyCache', {
                type: 'state',
                common: {
                    role: 'button',
                    name: 'Clear Autopy Cache',
                    type: 'boolean',
                    read: false,
                    write: true,
                    def: false,
                },
            });
            this.subscribeStates('info.clearAutopyCache');
        } catch (e) {
            this.log.error(`[Adapter start] Fatal error occurred ${e}`);
        }
    }

    /**
     * Migrate configuration from older adapter versions
     * Automatically set ESPHomeDashboardUrl if ESPHomeDashboardIP is set but URL is empty
     */
    async migrateConfig() {
        try {
            // Check if migration is needed:
            // ESPHomeDashboardIP is not empty AND ESPHomeDashboardUrl is empty
            if (this.config.ESPHomeDashboardIP && !this.config.ESPHomeDashboardUrl) {
                const calculatedUrl = `http://${this.config.ESPHomeDashboardIP}:${this.config.ESPHomeDashboardPort}`;

                this.log.info(`Migrating configuration: Setting ESPHomeDashboardUrl to ${calculatedUrl}`);

                const adapterObj = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
                if (!adapterObj) {
                    this.log.error(
                        `Configuration migration failed: Could not retrieve adapter configuration object for ${this.namespace}`,
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
                await this.setForeignObject(adapterObj._id, adapterObj);

                this.log.info(`Configuration migrated successfully. ESPHomeDashboardUrl set to: ${calculatedUrl}`);

                // adapter will restart
            }
        } catch (error) {
            this.log.error(
                `Error during configuration migration from ESPHomeDashboardIP to ESPHomeDashboardUrl: ${error.message || error}`,
            );
        }
    }

    // ToDo: move to separate module
    async espHomeDashboard() {
        try {
            // Create Channel to store ESPHomeDashboard related Data
            await this.extendObjectAsync('_ESPHomeDashboard', {
                type: 'channel',
                common: {
                    name: 'ESPHome Dashboard details',
                },
                native: {},
            });

            // Get all current available ESPHome Dashboard versions
            let content;
            let lastUsed;
            let useDashBoardVersion = '';

            // Get data from state which version was used previous Time
            try {
                lastUsed = await this.getStateAsync(`_ESPHomeDashboard.selectedVersion`);
                if (lastUsed && lastUsed.val) {
                    lastUsed = lastUsed.val;
                }
            } catch {
                // State does not exist
            }

            try {
                const headers = {};
                if (process.env.GITHUB_TOKEN) {
                    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
                }
                const response = await fetch('https://api.github.com/repos/esphome/esphome/releases', { headers });
                if (!response.ok) {
                    throw new Error(
                        `GitHub releases request failed with status ${response.status}: ${response.statusText}`,
                    );
                }
                content = await response.json();
            } catch (error) {
                this.errorHandler(`[espHomeDashboard-VersionCall]`, error);
            }

            // If the response was successful, write versions names to a memory array
            if (content) {
                await this.stateSetCreate(`_ESPHomeDashboard.versionCache`, 'versionCache', JSON.stringify(content));
                for (const version in content) {
                    dashboardVersions.push(content[version].name);
                }
                await this.stateSetCreate(`_ESPHomeDashboard.newestVersion`, 'newestVersion', content[0].name);
            } else {
                // Not possible to load latest versions, use fallback
                this.log.warn(
                    `Unable to retrieve current Dashboard release versions, using cached values. Check your internet connection`,
                );
                let cachedVersions = await this.getStateAsync(`_ESPHomeDashboard.versionCache`);
                if (cachedVersions && cachedVersions.val) {
                    cachedVersions = JSON.parse(cachedVersions.val);
                    for (const version in cachedVersions) {
                        dashboardVersions.push(cachedVersions[version].name);
                    }
                }
            }

            // Use latest available version
            if (
                this.config.ESPHomeDashboardVersion &&
                this.config.ESPHomeDashboardVersion !== '' &&
                this.config.ESPHomeDashboardVersion !== 'Always last available'
            ) {
                useDashBoardVersion = this.config.ESPHomeDashboardVersion;
            } else if (this.config.ESPHomeDashboardVersion === 'Always last available') {
                if (content) {
                    useDashBoardVersion = content[0].name;
                } else if (dashboardVersions.length > 0) {
                    // Use first cached version if available
                    useDashBoardVersion = dashboardVersions[0];
                }
            }

            if (useDashBoardVersion !== '') {
                await this.stateSetCreate(`_ESPHomeDashboard.selectedVersion`, 'selectedVersion', useDashBoardVersion);
            } else if (lastUsed != null) {
                // @ts-expect-error lastUsed may be string or number depending on adapter version
                useDashBoardVersion = lastUsed;
            }

            // Fetch Pillow versions from PyPI and cache them
            const versions = await this.fetchAndCachePillowVersions();
            pillowVersions.length = 0; // Clear array
            pillowVersions.push(...versions);

            // Determine Pillow version to use
            let usePillowVersion = '11.3.0'; // Default version

            // Check if user has configured a specific pillow version
            if (
                this.config.PillowVersion &&
                this.config.PillowVersion !== '' &&
                this.config.PillowVersion !== 'Always last available'
            ) {
                usePillowVersion = this.config.PillowVersion;
            }
            // If "Always last available" is selected, keep the default latest version

            this.log.debug(`Using Pillow version: ${usePillowVersion}`);

            // Start Dashboard Process
            if (this.config.ESPHomeDashboardEnabled) {
                this.log.info(`Native Integration of ESPHome Dashboard enabled, making environment ready`);
                try {
                    // @ts-expect-error autopy types are incomplete
                    const { getVenv } = await import('autopy');
                    let python;
                    try {
                        // Create a virtual environment with esphome installed.
                        python = await getVenv({
                            name: 'esphome',
                            pythonVersion: '3.13.2', // Use any Python 3.13.x version.
                            requirements: [
                                { name: 'esphome', version: `==${useDashBoardVersion}` },
                                { name: 'pillow', version: `==${usePillowVersion}` },
                            ], // Use latest esphome
                        });
                    } catch (error) {
                        this.log.error(`Fatal error starting ESPHomeDashboard | ${error} | ${error.stack}`);
                        return;
                    }

                    // Define directory to store configuration files
                    const dataDir = utils.getAbsoluteDefaultDataDir();

                    try {
                        fs.mkdir(`${dataDir}esphome.${this.instance}`, err => {
                            if (err) {
                                return console.log(`ESPHome directory exists`);
                            }
                            console.log(`ESPHome directory created`);
                        });
                        // );
                    } catch (error) {
                        // Directory has issues reading/writing data, iob fix should be executed
                        this.log.warn(
                            `ESPHome DDashboard is unable to access directory to store YAML configuration data, please run ioBroker fix: ${error}`,
                        );
                    }

                    this.log.info(`Starting ESPHome Dashboard`);
                    const dashboardProcess = python('esphome', [
                        'dashboard',
                        '--port',
                        this.config.ESPHomeDashboardPort,
                        `${dataDir}esphome.${this.instance}`,
                    ]);

                    this.log.debug(`espHomeDashboard_Process ${JSON.stringify(dashboardProcess)}`);

                    dashboardProcess.stdout?.on('data', data => {
                        this.log.info(`[dashboardProcess - Data] ${data}`);
                    });

                    dashboardProcess.stderr?.on('data', data => {
                        // this.log.warn(`[dashboardProcess ERROR] ${data}`);
                        if (data.includes('INFO')) {
                            if (data.includes('Starting')) {
                                this.log.info(`[ESPHome - Console] ${data}`);
                            } else {
                                this.log.debug(`[ESPHome - Console] ${data}`);
                            }
                        } else {
                            // console.debug(`[espHomeDashboard] Unknown logging data : ${JSON.stringify(data)}`);
                        }
                    });

                    dashboardProcess.on('message', (code, signal) => {
                        this.log.info(`[dashboardProcess MESSAGE] Exit code is: ${code} | ${signal}`);
                    });

                    dashboardProcess.on('exit', (_code, _signal) => {
                        this.log.warn(`ESPHome Dashboard stopped`);
                    });

                    dashboardProcess.on('error', data => {
                        if (data.message.includes('INFO')) {
                            this.log.info(`[dashboardProcess Info] ${data}`);
                        } else if (data.message.includes('ERROR')) {
                            this.log.error(`[dashboardProcess Warn] ${data}`);
                        } else {
                            this.log.error(`[dashboardProcess Error] ${data}`);
                        }
                    });
                } catch (error) {
                    this.errorHandler(`[espHomeDashboard-Process]`, error);
                }
            } else {
                this.log.info(`Native Integration of ESPHome Dashboard disabled `);
            }
        } catch (error) {
            this.errorHandler(`[espHomeDashboard-Function]`, error);
        }
    }

    // Try to contact and read data of already known devices
    async tryKnownDevices() {
        try {
            // Get all current devices from adapter tree
            const knownDevices = await this.getDevicesAsync();

            // Cancel operation if no devices are found
            if (!knownDevices) {
                return;
            }

            // Get connection data of known devices and to connect
            for (const i in knownDevices) {
                const deviceDetails = knownDevices[i].native;

                // Create a memory object and store mandatory connection data
                clientDetails[deviceDetails.ip] = new clientDevice();
                clientDetails[deviceDetails.ip].storeExistingDetails(
                    deviceDetails.ip,
                    deviceDetails.encryptionKeyUsed ? deviceDetails.encryptionKeyUsed : false,
                    `${deviceDetails.mac}`,
                    `${deviceDetails.deviceName}`,
                    `${deviceDetails.name}`,
                    !deviceDetails.encryptionKeyUsed
                        ? deviceDetails.apiPassword
                            ? deviceDetails.apiPassword
                            : deviceDetails.passWord
                        : null,
                    deviceDetails.encryptionKeyUsed ? deviceDetails.encryptionKey : null,
                );

                // Start connection to this device
                this.connectDevices(deviceDetails.ip);
            }
        } catch (error) {
            this.errorHandler(`[tryKnownDevices]`, error);
        }
    }

    // MDNS discovery handler for ESPHome devices
    deviceDiscovery() {
        try {
            // Get a list of IP-Addresses from Adapter config to exclude by autodiscovery
            const excludedIP = [];

            // Prepare an array to easy processing containing all IP addresses to be excluded from device discovery
            //ToDo: Check function doesn't look correct
            for (const entry in this.config.ignoredDevices) {
                if (
                    this.config.ignoredDevices[entry] &&
                    this.config.ignoredDevices[entry]['IP-Address'] &&
                    !excludedIP.includes(this.config.ignoredDevices[entry]['IP-Address'])
                ) {
                    excludedIP.push(this.config.ignoredDevices[entry]['IP-Address']);
                }
            }

            // Start device discovery
            discovery = new Discovery({
                interface: this.config.discoveryListeningAddress ? this.config.discoveryListeningAddress : '0.0.0.0',
            });
            discovery.run();

            discovery.on('info', message => {
                this.log.debug(`ESPHome Device found on ${message.address} | ${JSON.stringify(message)}`);
                if (
                    !excludedIP.includes(message.address) &&
                    !newlyDiscoveredClient[message.address] &&
                    !clientDetails[message.address]
                ) {
                    this.log.info(
                        `New ESPHome Device discovered: ${message.friendly_name ? message.friendly_name : message.host} on ${message.address}`,
                    );

                    if (message.mac == null) {
                        this.log.warn(`Discovered device with undefined mac. ignoring: ${JSON.stringify(message)}`);
                        return;
                    }

                    // Store device data into memory to allow adoption by admin interface
                    newlyDiscoveredClient[message.address] = {
                        ip: message.address,
                        mac: message.mac.toUpperCase(),
                        deviceFriendlyName: message.friendly_name ? message.friendly_name : message.host,
                    };
                }
            });
        } catch (error) {
            this.errorHandler(`[deviceDiscovery]`, error);
        }
    }

    /**
     * Handle Socket connections
     *
     * @param {string} host IP address of a device
     */
    connectDevices(host) {
        try {
            this.log.info(`Try to connect to ${host}`);

            // Cancel procedure if connection try or action to delete this device is already in progress or
            if (clientDetails[host] && (clientDetails[host].connecting || clientDetails[host].deletionRequested)) {
                return;
            }
            this.updateConnectionStatus(host, false, true, 'connecting');

            // Generic client settings
            const clientSettings = {
                host: host,
                clientInfo: `${this.host}`,
                clearSession: true,
                initializeDeviceInfo: true,
                initializeListEntities: true,
                initializeSubscribeStates: false,
                // initializeSubscribeLogs: false, //ToDo: Make configurable by adapter settings
                reconnect: true,
                reconnectInterval: 5000,
                pingInterval: 5000, //ToDo: Make configurable by adapter settings
                pingAttempts: 1, //ToDo: Make configurable by adapter settings
                // port: espDevices[device].port //ToDo: Make configurable by adapter settings
            };

            // Add an encryption key or apiPassword to the settings object
            if (!clientDetails[host].encryptionKeyUsed) {
                clientSettings.password = clientDetails[host].apiPassword
                    ? this.decrypt(clientDetails[host].apiPassword)
                    : '';
            } else {
                clientSettings.encryptionKey = this.decrypt(clientDetails[host].encryptionKey);
            }

            // Start connection to a client, if connection fails process wil try to reconnect every "reconnection"
            // interval setting until clientDetails[host].client.disconnect() is called
            clientDetails[host].client = new Client(clientSettings);

            // Connection listener
            clientDetails[host].client.on('connected', async () => {
                try {
                    await this.updateConnectionStatus(host, true, false, 'Connected', false);

                    this.log.info(`ESPHome client ${host} connected`);
                    // Clear possible present warning messages for devices from previous connection
                    delete warnMessages[host];

                    // Remove UserDefinedServices channels from tracking on reconnect so objectCleanup
                    // can delete channels for services no longer present in the ESPHome device config
                    if (clientDetails[host].deviceName) {
                        const prefix = `${this.namespace}.${clientDetails[host].deviceName}.UserDefinedServices`;
                        clientDetails[host].adapterObjects.channels = clientDetails[
                            host
                        ].adapterObjects.channels.filter(ch => !ch.startsWith(prefix));
                    }
                    // Reset the service registry so stale service entries don't persist
                    clientDetails[host].userDefinedServices = {};

                    // Check if device connection is caused by adding  device from admin, if yes send OK message
                    if (this.messageResponse[host]) {
                        this.sendTo(
                            this.messageResponse[host].from,
                            this.messageResponse[host].command,
                            {
                                result: 'OK - Device successfully connected, initializing configuration. Refresh table to show all known devices',
                            },
                            this.messageResponse[host].callback,
                        );
                        delete this.messageResponse[host];
                    }
                } catch (e) {
                    this.log.error(`connection error ${e}`);
                }
            });

            clientDetails[host].client.on('disconnected', async () => {
                try {
                    // Remove the service announcement listener to prevent accumulation on reconnect
                    clientDetails[host].client.connection.off(
                        'message.ListEntitiesServicesResponse',
                        onServiceAnnouncement,
                    );

                    if (clientDetails[host].deviceName != null) {
                        await this.updateConnectionStatus(host, false, false, 'disconnected', false);
                        delete clientDetails[host].deviceInfo;
                        // Cleanup all known states in memory related to this device
                        for (const state in this.createdStatesDetails) {
                            // Remove states from cache
                            if (state.split('.')[0] === clientDetails[host].deviceName) {
                                delete this.createdStatesDetails[state];
                            }
                        }

                        this.log.warn(
                            `ESPHome client ${clientDetails[host].deviceFriendlyName} | ${clientDetails[host].deviceName} | on ${host} disconnected`,
                        );
                    } else {
                        this.log.warn(`ESPHome client ${host} disconnected`);
                    }
                } catch (e) {
                    this.log.debug(`ESPHome disconnect error : ${e}`);
                }
            });

            clientDetails[host].client.on('reconnect', async () => {
                this.log.debug(`Trying to reconnect to ESPHome client ${host}`);
            });

            clientDetails[host].client.on('initialized', async () => {
                this.log.info(`ESPHome  client ${clientDetails[host].deviceFriendlyName} on ip ${host} initialized`);
                clientDetails[host].initialized = true;
                clientDetails[host].connectStatus = 'initialized';

                await this.updateConnectionStatus(host, true, false, 'initialized', false);

                // Start timer to clean up unneeded objects
                if (resetTimers[host]) {
                    resetTimers[host] = clearTimeout(resetTimers[host]);
                }
                resetTimers[host] = setTimeout(async () => {
                    await this.objectCleanup(host);
                }, 10000);
            });

            // Log message listener
            clientDetails[host].client.connection.on('message', message => {
                this.log.debug(`[ESPHome Device Message] ${host} client log ${message}`);
            });

            clientDetails[host].client.connection.on('data', data => {
                this.log.debug(`[ESPHome Device Data] ${host} client data ${data}`);
            });

            // Listen for user-defined service announcements; store reference for cleanup on disconnect
            const onServiceAnnouncement = async serviceConfig => {
                try {
                    this.log.info(
                        `${clientDetails[host].deviceFriendlyName} announced user-defined service "${serviceConfig.name}"`,
                    );
                    await this.handleUserDefinedService(host, serviceConfig);
                } catch (e) {
                    this.errorHandler(`[handleUserDefinedService]`, e);
                }
            };
            clientDetails[host].client.connection.on('message.ListEntitiesServicesResponse', onServiceAnnouncement);

            // Handle device information when connected or information updated
            clientDetails[host].client.on('deviceInfo', async deviceInfo => {
                try {
                    this.log.info(`ESPHome Device info received for ${deviceInfo.name}`);
                    this.log.debug(`DeviceData: ${JSON.stringify(deviceInfo)}`);

                    // Store device information into memory
                    const deviceName = this.replaceAll(deviceInfo.macAddress, `:`, ``);

                    clientDetails[host].mac = deviceInfo.macAddress;
                    clientDetails[host].deviceName = deviceName;
                    clientDetails[host].deviceFriendlyName = deviceInfo.name;
                    clientDetails[host].deviceInfo = deviceInfo;

                    this.deviceStateRelation[deviceName] = { ip: host };

                    this.log.debug(
                        `DeviceInfo ${clientDetails[host].deviceFriendlyName}: ${JSON.stringify(clientDetails[host].deviceInfo)}`,
                    );

                    // Create Device main structure
                    await this.extendObjectAsync(deviceName, {
                        type: 'device',
                        common: {
                            name: deviceInfo.name,
                            statusStates: {
                                onlineId: `${this.namespace}.${deviceName}.info._online`,
                            },
                            // @ts-expect-error js-controller issue - desc should be string but friendlyName may be undefined
                            desc: deviceInfo.friendlyName,
                        },
                        native: {
                            ip: host,
                            name: clientDetails[host].deviceInfoName,
                            mac: deviceInfo.macAddress,
                            deviceName: deviceName,
                            deviceFriendlyName: deviceInfo.name,
                            apiPassword: clientDetails[host].apiPassword,
                            encryptionKey: clientDetails[host].encryptionKey,
                            encryptionKeyUsed: clientDetails[host].encryptionKeyUsed,
                        },
                    });

                    // Create info channel explicitly with proper type
                    await this.extendObjectAsync(`${deviceName}.info`, {
                        type: 'channel',
                        common: {
                            name: 'Device Information',
                        },
                        native: {},
                    });

                    // Store channel in device memory
                    if (
                        !clientDetails[host].adapterObjects.channels.includes(
                            `${this.namespace}.${clientDetails[host].deviceName}.info`,
                        )
                    ) {
                        clientDetails[host].adapterObjects.channels.push(
                            `${this.namespace}.${clientDetails[host].deviceName}.info`,
                        );
                    }

                    await this.updateConnectionStatus(host, true, false, 'Initializing', false);

                    // Read JSON and handle states
                    await this.traverseJson(deviceInfo, `${deviceName}.info`);

                    // Check if device connection is caused by adding  device from admin, if yes send OK message
                    // ToDo rebuild to new logic
                    if (this.messageResponse[host]) {
                        const massageObj = {
                            type: 'info',
                            message: 'success',
                        };
                        // @ts-expect-error massageObj type mismatch with respond method signature
                        this.respond(massageObj, this.messageResponse[host]);
                        this.messageResponse[host] = null;
                    }
                } catch (error) {
                    this.errorHandler(`[deviceInfo]`, error);
                }
            });

            // Initialise data for states
            clientDetails[host].client.on('newEntity', async entity => {
                this.log.debug(`EntityData: ${JSON.stringify(entity.config)}`);
                try {
                    // Store relevant information into memory object
                    clientDetails[host][entity.id] = {
                        config: entity.config,
                        name: entity.name,
                        type: entity.type,
                        unit:
                            entity.config.unitOfMeasurement !== undefined ? entity.config.unitOfMeasurement || '' : '',
                    };

                    if (clientDetails[host][entity.id].config.deviceClass) {
                        this.log.info(
                            `${clientDetails[host].deviceFriendlyName} announced ${clientDetails[host][entity.id].config.deviceClass} "${clientDetails[host][entity.id].config.name}"`,
                        );
                    } else {
                        this.log.info(
                            `${clientDetails[host].deviceFriendlyName} announced ${clientDetails[host][entity.id].type} "${clientDetails[host][entity.id].config.name}"`,
                        );
                    }

                    // Create Device main structure
                    await this.extendObjectAsync(`${clientDetails[host].deviceName}.${entity.type}`, {
                        type: 'channel',
                        common: {
                            name: entity.type,
                        },
                        native: {},
                    });

                    // Cache created channel in device memory
                    if (
                        !clientDetails[host].adapterObjects.channels.includes(
                            `${this.namespace}.${clientDetails[host].deviceName}.${entity.type}`,
                        )
                    ) {
                        clientDetails[host].adapterObjects.channels.push(
                            `${this.namespace}.${clientDetails[host].deviceName}.${entity.type}`,
                        );
                    }

                    // Create state specific channel by id
                    await this.extendObjectAsync(`${clientDetails[host].deviceName}.${entity.type}.${entity.id}`, {
                        type: 'channel',
                        common: {
                            name: entity.config.name,
                        },
                        native: {},
                    });

                    // Create a channel in device memory
                    if (
                        !clientDetails[host].adapterObjects.channels.includes(
                            `${this.namespace}.${clientDetails[host].deviceName}.${entity.type}.${entity.id}`,
                        )
                    ) {
                        clientDetails[host].adapterObjects.channels.push(
                            `${this.namespace}.${clientDetails[host].deviceName}.${entity.type}.${entity.id}`,
                        );
                    }

                    //Check if a config channel should be created
                    if (!createConfigStates) {
                        // Delete folder structure if already present
                        try {
                            const obj = await this.getObjectAsync(
                                `${clientDetails[host].deviceName}.${entity.type}.${entity.id}.config`,
                            );
                            if (obj) {
                                await this.delObjectAsync(
                                    `${clientDetails[host].deviceName}.${entity.type}.${entity.id}.config`,
                                    { recursive: true },
                                );
                            }
                        } catch {
                            // do nothing
                        }
                    } else {
                        // Create config channel
                        await this.extendObjectAsync(
                            `${clientDetails[host].deviceName}.${entity.type}.${entity.id}.config`,
                            {
                                type: 'channel',
                                common: {
                                    name: 'Configuration data',
                                },
                                native: {},
                            },
                        );

                        // Store channel in device memory
                        if (
                            !clientDetails[host].adapterObjects.channels.includes(
                                `${this.namespace}.${clientDetails[host].deviceName}.${entity.type}.${entity.id}.config`,
                            )
                        ) {
                            clientDetails[host].adapterObjects.channels.push(
                                `${this.namespace}.${clientDetails[host].deviceName}.${entity.type}.${entity.id}.config`,
                            );
                        }

                        // Handle Entity JSON structure and write related config channel data
                        await this.traverseJson(
                            entity.config,
                            `${clientDetails[host].deviceName}.${entity.type}.${entity.id}.config`,
                        );
                    }

                    await this.createNonStateDevices(host, entity);

                    // Request current state values
                    await clientDetails[host].client.connection.subscribeStatesService();
                    this.log.debug(
                        `[DeviceInfoData] ${clientDetails[host].deviceFriendlyName} ${JSON.stringify(clientDetails[host].deviceInfo)}`,
                    );

                    // Listen to state changes and write values to states (create state if not yet exists)
                    entity.on(`state`, async state => {
                        clientDetails[host].connectStatus = 'connected';
                        await this.updateConnectionStatus(host, true, false, 'connected', false);
                        this.log.debug(`StateData: ${JSON.stringify(state)}`);
                        try {
                            this.log.debug(`[entityStateConfig] ${JSON.stringify(clientDetails[host][entity.id])}`);
                            this.log.debug(`[entityStateData] ${JSON.stringify(state)}`);
                            const deviceDetails = `DeviceType ${clientDetails[host][entity.id].type} | State-Keys ${JSON.stringify(state)} | [entityStateConfig] ${JSON.stringify(clientDetails[host][entity.id])}`;

                            // Ensure proper initialization of the state
                            switch (clientDetails[host][entity.id].type) {
                                case 'BinarySensor':
                                    await this.handleRegularState(`${host}`, entity, state, false);
                                    break;

                                case 'Climate':
                                    await this.handleStateArrays(`${host}`, entity, state);
                                    break;

                                case 'Cover':
                                    // esphome send position and tilt as 0-1 value
                                    await this.stateSetCreate(
                                        `${clientDetails[host].deviceName}.${entity.type}.${entity.id}.position`,
                                        `Position`,
                                        state.position * 100,
                                        `%`,
                                        true,
                                    );
                                    await this.stateSetCreate(
                                        `${clientDetails[host].deviceName}.${entity.type}.${entity.id}.tilt`,
                                        `Tilt`,
                                        state.tilt * 100,
                                        `%`,
                                        true,
                                    );
                                    await this.stateSetCreate(
                                        `${clientDetails[host].deviceName}.${entity.type}.${entity.id}.stop`,
                                        `Stop`,
                                        false,
                                        ``,
                                        true,
                                    );
                                    break;

                                case 'Fan':
                                    await this.handleStateArrays(`${host}`, entity, state);
                                    break;

                                case 'Light':
                                    await this.handleStateArrays(`${host}`, entity, state);
                                    break;

                                case 'Sensor':
                                    await this.handleRegularState(`${host}`, entity, state, false);
                                    break;

                                case 'TextSensor':
                                    await this.handleRegularState(`${host}`, entity, state, true);
                                    break;

                                case 'Switch':
                                    await this.handleRegularState(`${host}`, entity, state, true);
                                    break;

                                case 'Number':
                                    await this.handleRegularState(`${host}`, entity, state, true);
                                    break;

                                case 'Text': {
                                    await this.handleRegularState(`${host}`, entity, state, true);
                                    break;
                                }

                                case 'Select': {
                                    await this.handleRegularState(`${host}`, entity, state, true);
                                    break;
                                }

                                case 'Lock': {
                                    const deviceName = clientDetails[host].deviceName;
                                    // Lock state: 0=NONE, 1=LOCKED, 2=UNLOCKED, 3=JAMMED, 4=LOCKING, 5=UNLOCKING
                                    await this.stateSetCreate(
                                        `${deviceName}.${entity.type}.${entity.id}.state`,
                                        `LockState`,
                                        state.state,
                                        ``,
                                        false,
                                    );
                                    // Lock command: 0=UNLOCK, 1=LOCK, 2=OPEN
                                    await this.stateSetCreate(
                                        `${deviceName}.${entity.type}.${entity.id}.command`,
                                        `LockCommand`,
                                        null, // No default to prevent accidental triggers
                                        ``,
                                        true,
                                    );
                                    break;
                                }

                                default:
                                    if (!warnMessages[clientDetails[host][entity.id].type]) {
                                        this.log.warn(
                                            `DeviceType ${clientDetails[host][entity.id].type} not yet supported`,
                                        );
                                        this.log.warn(`Please submit git issue with all information from next line`);
                                        this.log.warn(
                                            `DeviceType ${clientDetails[host][entity.id].type} | State-Keys ${JSON.stringify(state)} | [entityStateConfig] ${JSON.stringify(clientDetails[host][entity.id])}`,
                                        );
                                        warnMessages[clientDetails[host][entity.id].type] = deviceDetails;
                                    }
                            }
                        } catch (error) {
                            this.errorHandler(`[connectHandler NewEntity]`, error);
                        }
                    });

                    entity.connection.on(`destroyed`, async state => {
                        try {
                            this.log.warn(`Connection destroyed for ${state}`);
                        } catch (e) {
                            this.log.error(`State handle error ${e}`);
                        }
                    });

                    entity.on(`error`, async name => {
                        this.log.error(`Entity error: ${name}`);
                    });
                } catch (e) {
                    this.log.error(`Connection issue for ${entity.name} ${e} | ${e.stack}`);
                }
            });

            // Connection data handler
            clientDetails[host].client.on('error', async error => {
                try {
                    let optimisedError = error.message;
                    // Optimise error messages
                    if (
                        (error.message &&
                            (error.message.includes('EHOSTUNREACH') || error.message.includes('EHOSTDOWN'))) ||
                        (error.code && error.code.includes('ETIMEDOUT'))
                    ) {
                        optimisedError = `Client ${host} unreachable !`;
                        if (!clientDetails[host].connectionError) {
                            this.log.error(optimisedError);
                            await this.updateConnectionStatus(host, false, false, 'unreachable', true);
                        }
                    } else if (error.message.includes('Invalid password')) {
                        optimisedError = `Client ${host} incorrect password !`;
                        if (!clientDetails.connectionError) {
                            this.log.error(optimisedError);
                            await this.updateConnectionStatus(host, false, false, 'API password incorrect', true);
                        }
                    } else if (error.message.includes('Encryption expected')) {
                        optimisedError = `Client ${host} requires encryption key which has not been provided, please enter encryption key in adapter settings for this device !`;
                        if (!clientDetails[host].connectionError) {
                            this.log.error(optimisedError);
                            await this.updateConnectionStatus(host, false, false, 'Encryption Key Missing', true);
                        }
                    } else if (error.message.includes('ECONNRESET')) {
                        optimisedError = `Client ${host} Connection Lost, will reconnect automatically when device is available!`;
                        if (!clientDetails[host].connectionError) {
                            this.log.warn(optimisedError);
                            await this.updateConnectionStatus(host, false, false, 'connection lost', true);
                        }
                    } else if (error.message.includes('timeout')) {
                        optimisedError = `Client ${host} Timeout, will reconnect automatically when device is available!`;
                        if (!clientDetails[host].connectionError) {
                            this.log.warn(optimisedError);
                            await this.updateConnectionStatus(host, false, false, 'unreachable', true);
                        }
                    } else if (error.message.includes('ECONNREFUSED')) {
                        optimisedError = `Client ${host} not yet ready to connect, will try again!`;
                        await this.updateConnectionStatus(host, false, true, 'initializing', true);
                        this.log.warn(optimisedError);
                    } else if (error.message.includes('ENETUNREACH')) {
                        optimisedError = `Network not ready to connect to client ${host}`;
                        if (!clientDetails[host].connectionError) {
                            await this.updateConnectionStatus(host, false, true, 'No Network', true);
                            this.log.warn(optimisedError);
                        }
                    } else if (error.message.includes('write after end')) {
                        // Ignore error
                    } else {
                        this.log.error(`ESPHome client ${host} ${error}`);
                    }

                    // Check if device connection is caused by adding  device from admin, if yes send OK message
                    if (this.messageResponse[host]) {
                        this.sendTo(
                            this.messageResponse[host].from,
                            this.messageResponse[host].command,
                            { error: `${optimisedError}` },
                            this.messageResponse[host].callback,
                        );
                        delete this.messageResponse[host];
                    }
                } catch (error) {
                    this.errorHandler(`[connectedDevice onError]`, error);
                }
            });

            //ToDo: Review should not be needed as reconnect process already takes care of it
            // connect to socket
            try {
                this.log.debug(`trying to connect to ${host}`);
                clientDetails[host].client.connect();
            } catch (e) {
                this.log.error(`Client ${host} connect error ${e}`);
            }
        } catch (e) {
            this.log.error(`ESP device error for ${host} | ${e} | ${e.stack}`);
        }
    }

    /**
     * Handle regular state values
     *
     * @param {string} host IP-Address of client
     * @param {object} entity Entity-Object of value
     * @param {object} state State-Object
     * @param {boolean} writable Indicate if state should be writable
     */
    async handleRegularState(host, entity, state, writable) {
        try {
            // Round value to digits as known by configuration
            let stateVal = state.state;

            if (clientDetails[host][entity.id].config.accuracyDecimals != null) {
                const rounding = `round(${clientDetails[host][entity.id].config.accuracyDecimals})`;
                this.log.debug(
                    `Value "${stateVal}" for name "${entity}" before function modify with method "round(${clientDetails[host][entity.id].config.accuracyDecimals})"`,
                );
                stateVal = this.modify(rounding, stateVal);
                this.log.debug(
                    `Value "${stateVal}" for name "${entity}" after function modify with method "${rounding}"`,
                );
            }

            //ToDo review this code section
            const stateCommon = {};

            if (entity.config.optionsList != null) {
                stateCommon.states = entity.config.optionsList;
            }
            await this.stateSetCreate(
                `${clientDetails[host].deviceName}.${entity.type}.${entity.id}.state`,
                `State of ${entity.config.name}`,
                stateVal,
                clientDetails[host][entity.id].unit,
                writable,
                stateCommon,
            );
        } catch (error) {
            this.errorHandler(`[espHomeDashboard]`, error);
        }
    }

    /**
     * Handle state values
     *
     * @param {string} host IP-Address of client
     * @param {object} entity Entity-Object of value
     * @param {object} state State-Object
     */
    async handleStateArrays(host, entity, state) {
        try {
            clientDetails[host][entity.id].states = state;

            for (const stateName in clientDetails[host][entity.id].states) {
                let unit = '';
                let writable = true;
                let writeValue = state[stateName];

                // Define if state should be writable
                switch (stateName) {
                    case 'currentTemperature':
                        unit = `°C`;
                        writable = false;
                        clientDetails[host][entity.id].states.currentTemperature = this.modify(
                            'round(2)',
                            state[stateName],
                        );
                        break;

                    case 'oscillating': // Sensor type = Fan
                        // Check if entity supports oscillation
                        if (!clientDetails[host][entity.id].config.supportsOscillation) {
                            writable = false;
                        }
                        break;

                    case 'speed': // Sensor type = Fan, deprecated - read only
                        writable = false;
                        break;

                    case 'speedLevel': {
                        // Sensor type = Fan
                        // Check if entity supports speed levels
                        const supportedSpeedLevels = clientDetails[host][entity.id].config.supportedSpeedLevels;
                        if (
                            supportedSpeedLevels === null ||
                            supportedSpeedLevels === undefined ||
                            supportedSpeedLevels === 0
                        ) {
                            writable = false;
                        }
                        break;
                    }

                    case 'direction': // Sensor type = Fan
                        // Check if entity supports direction
                        if (!clientDetails[host][entity.id].config.supportsDirection) {
                            writable = false;
                        }
                        break;
                }

                // Add unit to temperature states
                if (
                    stateName === `targetTemperature` ||
                    stateName === `targetTemperatureLow` ||
                    stateName === `targetTemperatureHigh`
                ) {
                    unit = `°C`;
                }

                // Add unit to states
                if (
                    stateName === `brightness` ||
                    stateName === `blue` ||
                    stateName === `green` ||
                    stateName === `red` ||
                    stateName === `white` ||
                    stateName === `colorTemperature` ||
                    stateName === `colorBrightness` ||
                    stateName === `coldWhite` ||
                    stateName === `warmWhite`
                ) {
                    writeValue = Math.round(state[stateName] * 100 * 2.55);

                    // Create transitionLength state only ones
                    if (clientDetails[host][entity.id].states.transitionLength == null) {
                        // Check if state already exists
                        let transitionLength;
                        try {
                            // Try  to get current state
                            transitionLength = await this.getStateAsync(
                                `${clientDetails[host].deviceName}.${entity.type}.${entity.id}.transitionLength`,
                            );

                            // Check if state contains value
                            if (transitionLength) {
                                clientDetails[host][entity.id].states.transitionLength = transitionLength.val;
                                // Run create state routine to ensure state is cached in memory
                                await this.stateSetCreate(
                                    `${clientDetails[host].deviceName}.${entity.type}.${entity.id}.transitionLength`,
                                    `${stateName} of ${entity.config.name}`,
                                    transitionLength.val,
                                    `ms`,
                                    writable,
                                );
                            } else {
                                // Else create it
                                await this.stateSetCreate(
                                    `${clientDetails[host].deviceName}.${entity.type}.${entity.id}.transitionLength`,
                                    `${stateName} of ${entity.config.name}`,
                                    0,
                                    `ms`,
                                    writable,
                                );
                                clientDetails[host][entity.id].states.transitionLength = 0;
                            }
                        } catch {
                            // Else create it
                            await this.stateSetCreate(
                                `${clientDetails[host].deviceName}.${entity.type}.${entity.id}.transitionLength`,
                                `${stateName} of ${entity.config.name}`,
                                0,
                                `ms`,
                                writable,
                            );
                            clientDetails[host][entity.id].states.transitionLength = 0;
                        }
                    }

                    // Create rgbAutoWhite state only once for lights with a dedicated white channel
                    if (stateName === 'white' && clientDetails[host][entity.id].rgbAutoWhite === undefined) {
                        let rgbAutoWhiteVal = false;
                        try {
                            const existing = await this.getStateAsync(
                                `${clientDetails[host].deviceName}.${entity.type}.${entity.id}.config.rgbAutoWhite`,
                            );
                            if (existing != null) {
                                rgbAutoWhiteVal = !!existing.val;
                            }
                        } catch (e) {
                            this.log.debug(`[handleStateArrays] Could not read rgbAutoWhite state: ${e}`);
                        }
                        clientDetails[host][entity.id].rgbAutoWhite = rgbAutoWhiteVal;
                        // Ensure config channel exists before creating the state inside it
                        await this.extendObjectAsync(
                            `${clientDetails[host].deviceName}.${entity.type}.${entity.id}.config`,
                            {
                                type: 'channel',
                                common: { name: 'Configuration data' },
                                native: {},
                            },
                        );
                        await this.stateSetCreate(
                            `${clientDetails[host].deviceName}.${entity.type}.${entity.id}.config.rgbAutoWhite`,
                            'rgbAutoWhite',
                            rgbAutoWhiteVal,
                            '',
                            true,
                        );
                    }
                }

                if (stateName !== 'key') {
                    await this.stateSetCreate(
                        `${clientDetails[host].deviceName}.${entity.type}.${entity.id}.${stateName}`,
                        `${stateName} of ${entity.config.name}`,
                        writeValue,
                        unit,
                        writable,
                    );
                }
            }

            // Convert RGB to HEX and write to state
            if (
                clientDetails[host][entity.id].states.red != null &&
                clientDetails[host][entity.id].states.blue != null &&
                clientDetails[host][entity.id].states.green != null
            ) {
                const hexValue = this.rgbToHex(
                    Math.round(clientDetails[host][entity.id].states.red * 100 * 2.55),
                    Math.round(clientDetails[host][entity.id].states.green * 100 * 2.55),
                    Math.round(clientDetails[host][entity.id].states.blue * 100 * 2.55),
                );
                await this.stateSetCreate(
                    `${clientDetails[host].deviceName}.${entity.type}.${entity.id}.colorHEX`,
                    `ColorHEX of ${entity.config.name}`,
                    hexValue,
                    '',
                    true,
                );
            }
        } catch (error) {
            this.errorHandler(`[espHomeDashboard]`, error);
        }
    }

    /**
     * Traverses the json-object and provides all information for creating/updating states
     *
     * @param {object} jObject Json-object to be added as states
     * @param {string | null} parent Defines the parent object in the state tree; default=root
     * @param {boolean} replaceName Steers if name from child should be used as name for structure element (channel); default=false
     * @param {boolean} replaceID Steers if ID from child should be used as ID for structure element (channel); default=false;
     * @param {number} state_expire expire time for the current setState in seconds; default is no expire
     */
    async traverseJson(jObject, parent = null, replaceName = false, replaceID = false, state_expire = 0) {
        let id = null;
        let value = null;
        let name = null;

        try {
            for (const i in jObject) {
                name = i;
                if (!!jObject[i] && typeof jObject[i] === 'object' && jObject[i] === '[object Object]') {
                    if (parent == null) {
                        id = i;
                        if (replaceName) {
                            if (jObject[i].name) {
                                name = jObject[i].name;
                            }
                        }
                        if (replaceID) {
                            if (jObject[i].id) {
                                id = jObject[i].id;
                            }
                        }
                    } else {
                        id = `${parent}.${i}`;
                        if (replaceName) {
                            if (jObject[i].name) {
                                name = jObject[i].name;
                            }
                        }
                        if (replaceID) {
                            if (jObject[i].id) {
                                id = `${parent}.${jObject[i].id}`;
                            }
                        }
                    }
                    // Avoid channel creation for empty arrays/objects
                    if (Object.keys(jObject[i]).length !== 0) {
                        // console.log(`park`);
                        await this.setObjectAsync(id, {
                            type: 'channel',
                            common: {
                                name: name,
                            },
                            native: {},
                        });
                        await this.traverseJson(jObject[i], id, replaceName, replaceID, state_expire);
                    } else {
                        this.log.debug(`State ${id} received with empty array, ignore channel creation`);
                    }
                } else {
                    value = jObject[i];
                    if (parent == null) {
                        id = i;
                    } else {
                        id = `${parent}.${i}`;
                    }
                    if (typeof jObject[i] == 'object') {
                        value = JSON.stringify(value);
                    }
                    //avoid state creation if empty
                    if (value !== '[]') {
                        this.log.debug(`create id ${id} with value ${value} and name ${name}`);
                        await this.stateSetCreate(id, name, value);
                    }
                }
            }
        } catch (error) {
            this.errorHandler(`[traverseJson]`, error);
        }
    }

    /**
     * Function to handle state creation
     * proper object definitions
     * rounding of values
     *
     * @param {string} objName ID of the object
     * @param {string} name Name of state (also used for stattAttrlib!)
     * @param {boolean | string | number | null} [value] Value of the state
     * @param {string} [unit] Unit to be set
     * @param {boolean} [writable] state writable ?
     * @param {object} initialStateCommon Additional attributes for state.common
     */
    async stateSetCreate(
        objName,
        name,
        value,
        unit,
        writable,
        /** Partial<ioBroker.StateCommon> */ initialStateCommon = {},
    ) {
        this.log.debug(`Create_state called for : ${objName} with value : ${value}`);
        try {
            // Try to get details from state lib, if not use defaults. Throw warning if states are not known in an attribute list
            const common = initialStateCommon;
            // const entityID = objName.split('.');
            // common.modify = {};
            if (!stateAttr[name]) {
                const warnMessage = `State attribute definition missing for '${name}'`;
                if (warnMessages[name] !== warnMessage) {
                    warnMessages[name] = warnMessage;
                    // Send information to Sentry
                    // this.sendSentry(warnMessage);
                }
            }
            common.name = stateAttr[name] !== undefined ? stateAttr[name].name || name : name;

            // default to type string if value is null to avoid errors like:
            //   Object 004B1296140C.info.area is invalid: obj.common.type has an invalid value (undefined) but has to be one of number, string, boolean, array, object, mixed, json This will throw an error up from js-controller version 7.0.0!
            common.type = value == null ? 'string' : typeof value;

            common.role = stateAttr[name] !== undefined ? stateAttr[name].role || 'state' : 'state';
            common.read = true;
            common.unit = unit !== undefined ? unit || '' : '';
            // common.write = stateAttr[name] !== undefined ? stateAttr[name].write || false : false;
            common.write = writable !== undefined ? writable || false : false;
            // common.modify = stateAttr[name] !== undefined ? stateAttr[name].modify || '' : '';
            // this.log.debug(`MODIFY to ${name}: ${JSON.stringify(common.modify)}`);

            if (
                !this.createdStatesDetails[objName] ||
                (this.createdStatesDetails[objName] &&
                    (common.name !== this.createdStatesDetails[objName].name ||
                        common.name !== this.createdStatesDetails[objName].name ||
                        common.type !== this.createdStatesDetails[objName].type ||
                        common.role !== this.createdStatesDetails[objName].role ||
                        common.read !== this.createdStatesDetails[objName].read ||
                        common.unit !== this.createdStatesDetails[objName].unit ||
                        common.write !== this.createdStatesDetails[objName].write))
            ) {
                // console.log(`An attribute has changed : ${state}`);
                // @ts-expect-error values are correctly provided by state Attribute definitions, error can be ignored
                await this.extendObjectAsync(objName, {
                    type: 'state',
                    common,
                    native: {},
                });
            } else {
                // console.log(`Nothing changed do not update object`);
            }

            // Store current object definition to memory
            this.createdStatesDetails[objName] = common;

            // // Set value to state
            if (value != null) {
                await this.setStateAsync(objName, {
                    val: value,
                    ack: true,
                });
            }
            // Subscribe on state changes if writable
            common.write && this.subscribeStates(objName);
        } catch (error) {
            this.errorHandler(`[stateSetCreate]`, error);
        }
    }

    /**
     * Handles error messages for log and Sentry
     *
     * @param {string} codepart Function were exception occurred
     * @param {any} error Error message
     */
    errorHandler(codepart, error) {
        let errorMsg = error;
        if (error instanceof Error && error.stack != null) {
            errorMsg = error.stack;
        }
        try {
            if (!disableSentry) {
                this.log.info(`[Error caught and send to Sentry, thank you collaborating!] error: ${errorMsg}`);
                if (this.supportsFeature && this.supportsFeature('PLUGINS')) {
                    const sentryInstance = this.getPluginInstance('sentry');
                    if (sentryInstance && typeof sentryInstance.getSentryObject === 'function') {
                        const sentryObject = sentryInstance.getSentryObject();
                        if (sentryObject) {
                            sentryObject.captureException(errorMsg);
                        }
                    }
                }
            } else {
                this.log.error(`Sentry disabled, error caught : ${errorMsg}`);
            }
        } catch (error) {
            this.log.error(`Error in function sendSentry: ${error}`);
        }
    }

    /**
     * Helper replace function
     *
     * @param {string} string String to replace invalid chars
     */
    escapeRegExp(string) {
        return string.replace(/[.*+\-?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
    }

    /**
     * Helper replace function
     *
     * @param {string} str String to replace invalid chars
     * @param {string} find String to find for replace function
     * @param {string} replace String to replace
     */
    replaceAll(str, find, replace) {
        return str.replace(new RegExp(this.escapeRegExp(find), 'g'), replace);
    }

    /**
     * Analysis modify an element in stateAttr.js and execute command
     *
     * @param {string} method defines the method to be executed (e.g. round())
     * @param {string | number | boolean} value value to be executed
     */
    modify(method, value) {
        this.log.debug(`Function modify with method "${method}" and value "${value}"`);
        let result = null;
        try {
            if (method.match(/^custom:/gi) != null) {
                //check if starts with "custom:"
                value = eval(method.replace(/^custom:/gi, '')); //get value without "custom:"
            } else if (method.match(/^multiply\(/gi) != null) {
                //check if starts with "multiply("
                const inBracket = parseFloat(method.match(/(?<=\()(.*?)(?=\))/g)); //get value in brackets
                value = value * inBracket;
            } else if (method.match(/^divide\(/gi) != null) {
                //check if starts with "divide("
                const inBracket = parseFloat(method.match(/(?<=\()(.*?)(?=\))/g)); //get value in brackets
                value = value / inBracket;
            } else if (method.match(/^round\(/gi) != null) {
                //check if starts with "round("
                const inBracket = parseInt(method.match(/(?<=\()(.*?)(?=\))/g)); //get value in brackets
                value = Math.round(value * Math.pow(10, inBracket)) / Math.pow(10, inBracket);
            } else if (method.match(/^add\(/gi) != null) {
                //check if starts with "add("
                const inBracket = parseFloat(method.match(/(?<=\()(.*?)(?=\))/g)); //get value in brackets
                value = parseFloat(value) + inBracket;
            } else if (method.match(/^substract\(/gi) != null) {
                //check if starts with "substract("
                const inBracket = parseFloat(method.match(/(?<=\()(.*?)(?=\))/g)); //get value in brackets
                value = parseFloat(value) - inBracket;
            } else {
                const methodUC = method.toUpperCase();
                switch (methodUC) {
                    case 'UPPERCASE':
                        if (typeof value == 'string') {
                            result = value.toUpperCase();
                        }
                        break;
                    case 'LOWERCASE':
                        if (typeof value == 'string') {
                            result = value.toLowerCase();
                        }
                        break;
                    case 'UCFIRST':
                        if (typeof value == 'string') {
                            result = value.substring(0, 1).toUpperCase() + value.substring(1).toLowerCase();
                        }
                        break;
                    default:
                        result = value;
                }
            }
            if (!result) {
                return value;
            }
            return result;
        } catch (error) {
            this.errorHandler(`[modify]`, error);
            return value;
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param {() => void} callback - Callback function to call when unload is complete
     */
    onUnload(callback) {
        try {
            // this.log.debug(JSON.stringify(clientDetails));

            // Set all online states to false
            for (const device in clientDetails) {
                // Ensure all known online states are set to false
                if (clientDetails[device].mac != null) {
                    const deviceName = this.replaceAll(clientDetails[device].mac, `:`, ``);
                    if (clientDetails[device].connectStatus !== 'newly discovered') {
                        this.setState(`${deviceName}.info._online`, {
                            val: false,
                            ack: true,
                        });
                    }
                }

                if (discovery) {
                    discovery.destroy();
                }

                try {
                    clientDetails[device].client.disconnect();
                } catch (e) {
                    this.log.debug(`[onUnload] ${JSON.stringify(e)}`);
                }
            }

            // Ensure all possible running timers are cleared
            for (const timer in resetTimers) {
                if (resetTimers[timer]) {
                    resetTimers[timer] = clearTimeout(resetTimers[timer]);
                }
            }

            try {
                if (dashboardProcess) {
                    dashboardProcess.kill('SIGTERM', {
                        forceKillAfterTimeout: 2000,
                    });
                }
            } catch (e) {
                this.log.error(`[onUnload - dashboardProcess] ${JSON.stringify(e)}`);
            }

            callback();
        } catch (error) {
            this.errorHandler(`[onUnload]`, error);
            callback();
        }
    }

    /**
     * Validate a proper format of IP-Address
     *
     * @param {string} ipAddress
     */

    validateIPAddress(ipAddress) {
        return /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(
            ipAddress,
        );
    }

    /**
     * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
     * Using this method requires "common.message" property to be set to true in io-package.json
     *
     * @param {ioBroker.Message} obj - The message object
     */
    async onMessage(obj) {
        this.log.debug(`Data from configuration received : ${JSON.stringify(obj)}`);
        try {
            switch (obj.command) {
                //ToDo previous add function to be removed
                case 'addDevice':
                    // eslint-disable-next-line no-case-declarations
                    const ipValid = this.validateIPAddress(obj.message['device-ip']);
                    if (!ipValid) {
                        this.log.warn(
                            `You entered an incorrect IP-Address ${obj.message['device-ip']}, cannot add device !`,
                        );

                        const massageObj = {
                            type: 'error',
                            message: 'connection failed',
                        };
                        // @ts-expect-error massageObj type mismatch with respond method signature
                        this.respond(massageObj, obj);
                    } else {
                        this.log.info(`Valid IP address received`);
                        this.connectDevices(obj.message['device-ip']);
                    }
                    break;

                case 'loadDevices':
                    {
                        let data = {};

                        const knownDeviceTable = [];
                        const discoveredDeviceTable = [];

                        //Create table for all known devices
                        for (const device in clientDetails) {
                            knownDeviceTable.push({
                                MACAddress: clientDetails[device].mac,
                                deviceName: clientDetails[device].deviceFriendlyName,
                                ip: clientDetails[device].ip,
                                connectState: clientDetails[device].connectStatus,
                            });
                        }

                        //Create table for newlyDiscovered Devices

                        for (const device in newlyDiscoveredClient) {
                            discoveredDeviceTable.push({
                                MACAddress: newlyDiscoveredClient[device].mac,
                                deviceName: newlyDiscoveredClient[device].deviceFriendlyName,
                                ip: newlyDiscoveredClient[device].ip,
                            });
                        }

                        data = {
                            native: {
                                existingDevicesTable: knownDeviceTable,
                                newDevicesTable: discoveredDeviceTable,
                            },
                        };
                        this.sendTo(obj.from, obj.command, data, obj.callback);
                    }
                    break;

                // Front End message handler to load IP-Address dropDown with all current known devices
                case 'getDeviceIPs':
                    {
                        const dropDownEntry = [];
                        for (const device in clientDetails) {
                            dropDownEntry.push({
                                label: device,
                                value: clientDetails[device].ip,
                            });
                        }

                        for (const device in newlyDiscoveredClient) {
                            dropDownEntry.push({
                                label: device,
                                value: newlyDiscoveredClient[device].ip,
                            });
                        }

                        this.sendTo(obj.from, obj.command, dropDownEntry, obj.callback);
                    }
                    break;

                // Front End message handler to load ESPHome Dashboard dropDown with all available versions
                case 'getESPHomeDashboardVersion':
                    {
                        const dropDownEntry = [];
                        dropDownEntry.push('Always last available');
                        for (const versions in dashboardVersions) {
                            dropDownEntry.push({
                                label: dashboardVersions[versions],
                                value: dashboardVersions[versions],
                            });
                        }

                        this.sendTo(obj.from, obj.command, dropDownEntry, obj.callback);
                    }
                    break;

                // Front End message handler to load Pillow version dropdown with available versions
                case 'getPillowVersion':
                    {
                        const dropDownEntry = [];
                        dropDownEntry.push('Always last available');

                        // Use cached versions from memory
                        if (pillowVersions.length > 0) {
                            for (const version of pillowVersions) {
                                dropDownEntry.push({
                                    label: version,
                                    value: version,
                                });
                            }
                        } else {
                            // Fallback versions if cache is empty
                            this.log.info('No cached Pillow versions available, using fallback versions');
                            const fallbackVersions = ['11.3.0', '11.2.0', '11.1.0', '11.0.0', '10.4.0', '10.3.0'];
                            for (const version of fallbackVersions) {
                                dropDownEntry.push({
                                    label: version,
                                    value: version,
                                });
                            }
                        }

                        this.sendTo(obj.from, obj.command, dropDownEntry, obj.callback);
                    }
                    break;

                // Front End message handler to host IP-Address(es)
                case 'getHostIp':
                    {
                        // Get all current known host IP-Addresses from System object
                        const hostIP = await this.getForeignObjectAsync(`system.host.${this.host}`);
                        const ip4List = [];

                        // Only show IP4 in dropdown
                        if (hostIP) {
                            for (const ip in hostIP.common.address) {
                                console.log(hostIP.common.address[ip]);
                                if (this.validateIPAddress(hostIP.common.address[ip])) {
                                    ip4List.push({
                                        label: hostIP.common.address[ip],
                                        value: hostIP.common.address[ip],
                                    });
                                }
                            }
                        }

                        // console.log(`IP4 List ${ip4List}`);

                        this.sendTo(obj.from, obj.command, ip4List, obj.callback);
                    }
                    break;

                // Handle front-end messages to ADD / Modify a devices
                case '_addUpdateDevice':
                    // console.log(JSON.stringify(obj));
                    // IP input validation
                    if (obj.message.ip === 'undefined') {
                        this.sendTo(
                            obj.from,
                            obj.command,
                            {
                                error: 'To add/modify a device, please enter the IP-Address accordingly',
                            },
                            obj.callback,
                        );
                        return;
                    } else if (!this.validateIPAddress(obj.message.ip)) {
                        this.sendTo(
                            obj.from,
                            obj.command,
                            {
                                error: 'Format of IP-Address is incorrect, please provide an valid IPV4 IP-Address',
                            },
                            obj.callback,
                        );
                        return;
                    }

                    // eslint-disable-next-line no-case-declarations
                    const initiateNDevice = async () => {
                        const encryptionKeyUsed = !!(
                            obj.message.encryptionKey && obj.message.encryptionKey !== 'undefined'
                        );
                        clientDetails[obj.message.ip] = new clientDevice();
                        clientDetails[obj.message.ip].storeConnectDetails(
                            obj.message.ip,
                            encryptionKeyUsed,
                            this.encrypt(obj.message.apiPassword),
                            encryptionKeyUsed ? this.encrypt(obj.message.encryptionKey) : null,
                        );
                        this.messageResponse[obj.message.ip] = obj;
                        delete newlyDiscoveredClient[obj.message.ip];
                        this.connectDevices(obj.message.ip);
                    };

                    // Store client details in memory and try to connect
                    if (!clientDetails[obj.message.ip]) {
                        // Device is unknown, created memory space
                        await initiateNDevice();
                    } else {
                        // Device is known, update encryptionKey or apiPass
                        // Ensure all existing connections are closed, will trigger disconnect event to clean-up memory attributes
                        try {
                            // if (clientDetails[obj.message.ip].connected) clientDetails[obj.message.ip].client.disconnect();
                            clientDetails[obj.message.ip].client.disconnect();
                        } catch {
                            // There was no connection in memory
                        }
                        // Clean memory data and init device again with a little delay

                        if (resetTimers[obj.message.ip]) {
                            resetTimers[obj.message.ip] = clearTimeout(resetTimers[obj.message.ip]);
                        }
                        resetTimers[obj.message.ip] = setTimeout(async () => {
                            delete clientDetails[obj.message.ip];
                            await initiateNDevice();
                        }, 2000);
                    }
                    break;

                // Handle front-end messages to delete devices
                case 'deleteDevice':
                    this.messageResponse[obj.message.ip] = obj;
                    if (clientDetails[obj.message.ip]) {
                        // Ensure all existing connections are closed, will trigger disconnect event to clean-up memory attributes
                        clientDetails[obj.message.ip].client.disconnect();
                        // Try to delete Device Object including all underlying states
                        try {
                            await this.delObjectAsync(clientDetails[obj.message.ip].deviceName, { recursive: true });
                        } catch {
                            // Deleting device channel failed
                        }

                        // Clean memory data
                        delete clientDetails[obj.message.ip];

                        // Send confirmation to frontend
                        this.sendTo(
                            this.messageResponse[obj.message.ip].from,
                            this.messageResponse[obj.message.ip].command,
                            { result: 'OK - Device successfully removed' },
                            this.messageResponse[obj.message.ip].callback,
                        );
                        delete this.messageResponse[obj.message.ip];
                    } else {
                        this.sendTo(
                            obj.from,
                            obj.command,
                            {
                                error: 'Provided IP-Address unknown, please refresh table and enter an valid IP-Address',
                            },
                            obj.callback,
                        );
                        return;
                    }

                    // this.sendTo(obj.from, obj.command, 1, obj.callback);
                    break;

                // Handle YAML file upload
                case 'uploadYamlFile':
                    {
                        if (!obj.message || !obj.message.filename || !obj.message.content) {
                            this.sendTo(
                                obj.from,
                                obj.command,
                                { error: 'Filename and content are required' },
                                obj.callback,
                            );
                            return;
                        }

                        const result = await this.yamlFileManager.uploadYamlFile(
                            obj.message.filename,
                            obj.message.content,
                        );
                        this.sendTo(obj.from, obj.command, result, obj.callback);
                    }
                    break;

                // Handle listing YAML files
                case 'listYamlFiles':
                    {
                        const files = await this.yamlFileManager.listYamlFiles();
                        this.sendTo(
                            obj.from,
                            obj.command,
                            {
                                native: {
                                    yamlFilesTable: files,
                                },
                            },
                            obj.callback,
                        );
                    }
                    break;

                // Handle YAML file download
                case 'downloadYamlFile':
                    {
                        if (!obj.message || !obj.message.filename) {
                            this.sendTo(obj.from, obj.command, { error: 'Filename is required' }, obj.callback);
                            return;
                        }

                        const result = await this.yamlFileManager.downloadYamlFile(obj.message.filename);

                        // Format the response to show file content in a user-friendly way
                        if (result.success) {
                            this.sendTo(
                                obj.from,
                                obj.command,
                                {
                                    result: `File content (copy to use):\n\n${result.content}`,
                                },
                                obj.callback,
                            );
                        } else {
                            this.sendTo(obj.from, obj.command, result, obj.callback);
                        }
                    }
                    break;

                // Handle YAML file deletion
                case 'deleteYamlFile':
                    {
                        if (!obj.message || !obj.message.filename) {
                            this.sendTo(obj.from, obj.command, { error: 'Filename is required' }, obj.callback);
                            return;
                        }

                        const result = await this.yamlFileManager.deleteYamlFile(obj.message.filename);
                        this.sendTo(obj.from, obj.command, result, obj.callback);
                    }
                    break;

                // Handle clearing autopy cache
                case 'clearAutopyCache':
                    {
                        await this.clearAutopyCache();
                        this.sendTo(
                            obj.from,
                            obj.command,
                            { success: true, message: 'Cache clearing triggered' },
                            obj.callback,
                        );
                    }
                    break;
            }
        } catch (error) {
            this.errorHandler(`[onMessage]`, error);
        }
    }

    /**
     * Fetch Pillow versions from PyPI and cache them
     *
     * @returns {Promise<string[]>} Array of available Pillow versions
     */
    async fetchAndCachePillowVersions() {
        const fallbackVersions = ['11.3.0', '11.2.0', '11.1.0', '11.0.0', '10.4.0', '10.3.0'];

        try {
            const response = await fetch('https://pypi.org/pypi/pillow/json');
            if (response.ok) {
                const data = await response.json();
                const versions = Object.keys(data.releases)
                    .filter(v => !v.includes('a') && !v.includes('b') && !v.includes('rc')) // Filter out alpha/beta/rc versions
                    .sort((a, b) => {
                        // Sort versions in descending order (newest first)
                        const aParts = a.split('.').map(Number);
                        const bParts = b.split('.').map(Number);
                        for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
                            const aVal = aParts[i] || 0;
                            const bVal = bParts[i] || 0;
                            if (aVal !== bVal) {
                                return bVal - aVal;
                            }
                        }
                        return 0;
                    })
                    .slice(0, 20); // Limit to 20 most recent versions

                if (versions.length > 0) {
                    // Cache the versions
                    await this.stateSetCreate(
                        `_ESPHomeDashboard.pillowVersionCache`,
                        'pillowVersionCache',
                        JSON.stringify(versions),
                    );
                    await this.stateSetCreate(
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
            this.log.warn(
                `Error fetching Pillow versions from PyPI: ${error.message}, using cached or fallback versions`,
            );
        }

        // Try to load from cache
        try {
            const cachedPillowVersions = await this.getStateAsync(`_ESPHomeDashboard.pillowVersionCache`);
            if (cachedPillowVersions && cachedPillowVersions.val) {
                const versions = JSON.parse(cachedPillowVersions.val);
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
     * Clear the autopy cache directory
     */
    async clearAutopyCache() {
        try {
            const homeDir = os.homedir();
            const autopyCache = path.join(homeDir, '.cache', 'autopy');

            this.log.info(`Attempting to clear autopy cache at: ${autopyCache}`);

            // Check if directory exists
            if (fs.existsSync(autopyCache)) {
                // Use recursive removal
                fs.rmSync(autopyCache, { recursive: true, force: true });
                this.log.info('Autopy cache cleared successfully');
            } else {
                this.log.info('Autopy cache directory does not exist');
            }
        } catch (error) {
            this.log.error(`Error clearing autopy cache: ${error.message}`);
            throw error;
        }
    }

    /**
     * responds to the adapter that sent the original message
     *
     * @param {string} response - The response message
     * @param {object} obj - The original message object
     */
    respond(response, obj) {
        if (obj.callback) {
            this.sendTo(obj.from, obj.command, response, obj.callback);
        }
    }

    hexToRgb(hex) {
        const shorthandRegex = /^#?([a-f\d])([a-f\d])([a-f\d])$/i;
        hex = hex.replace(shorthandRegex, function (m, r, g, b) {
            return r + r + g + g + b + b;
        });

        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result
            ? {
                  red: parseInt(result[1], 16),
                  green: parseInt(result[2], 16),
                  blue: parseInt(result[3], 16),
              }
            : null;
    }

    rgbToHex(r, g, b) {
        function componentToHex(color) {
            const hex = color.toString(16);
            return hex.length === 1 ? `0${hex}` : hex;
        }
        return `#${componentToHex(r)}${componentToHex(g)}${componentToHex(b)}`;
    }

    /**
     * Is called if a subscribed state changes
     *
     * @param {string} id - The state ID that changed
     * @param {ioBroker.State | null | undefined} state - The new state value
     */
    async onStateChange(id, state) {
        try {
            if (state && state.ack === false) {
                const device = id.split('.');

                try {
                    // Verify if trigger is related to device-cleanup
                    if (id.split('.')[3] === 'deviceCleanup') {
                        await this.offlineDeviceCleanup();
                        return;
                    }

                    // Verify if trigger is related to clearing autopy cache
                    if (id.split('.')[3] === 'clearAutopyCache') {
                        await this.clearAutopyCache();
                        this.setState(id, { val: false, ack: true });
                        return;
                    }
                } catch {
                    // Skip action
                }

                const deviceIP = this.deviceStateRelation[device[2]].ip;

                // Handle Switch State
                if (clientDetails[deviceIP][device[4]].type === `Switch`) {
                    await clientDetails[deviceIP].client.connection.switchCommandService({
                        key: device[4],
                        state: state.val,
                    });

                    // Handle Fan State
                } else if (clientDetails[deviceIP][device[4]].type === `Fan`) {
                    // Validate that the state key exists before updating
                    const validFanStates = ['state', 'speed', 'speedLevel', 'direction', 'oscillating'];
                    if (validFanStates.includes(device[5])) {
                        // Update the state in memory
                        clientDetails[deviceIP][device[4]].states[device[5]] = state.val;
                        // Call fan command service with all current states
                        await clientDetails[deviceIP].client.connection.fanCommandService(
                            clientDetails[deviceIP][device[4]].states,
                        );
                    } else {
                        this.log.warn(`Invalid fan state key "${device[5]}" for device ${device[2]}`);
                    }

                    // Handle Climate State
                } else if (clientDetails[deviceIP][device[4]].type === `Climate`) {
                    clientDetails[deviceIP][device[4]].states[device[5]] = state.val;
                    await clientDetails[deviceIP].client.connection.climateCommandService(
                        clientDetails[deviceIP][device[4]].states,
                    );

                    // Handle Number State
                } else if (clientDetails[deviceIP][device[4]].type === `Number`) {
                    await clientDetails[deviceIP].client.connection.numberCommandService({
                        key: device[4],
                        state: state.val,
                    });

                    // Handle Text State
                } else if (clientDetails[deviceIP][device[4]].type === `Text`) {
                    await clientDetails[deviceIP].client.connection.textCommandService({
                        key: device[4],
                        state: state.val,
                    });

                    // Handle Button State
                } else if (clientDetails[deviceIP][device[4]].type === `Button`) {
                    await clientDetails[deviceIP].client.connection.buttonCommandService({
                        key: device[4],
                    });

                    // Handle Select State
                } else if (clientDetails[deviceIP][device[4]].type === `Select`) {
                    await clientDetails[deviceIP].client.connection.selectCommandService({
                        key: device[4],
                        state: state.val,
                    });

                    // Handle Lock Command
                } else if (clientDetails[deviceIP][device[4]].type === `Lock` && device[5] === `command`) {
                    await clientDetails[deviceIP].client.connection.lockCommandService({
                        key: device[4],
                        command: state.val,
                    });

                    // Handle Cover Position
                } else if (device[5] === `position`) {
                    // clientDetails[deviceIP][device[4]].states[device[5]] = state.val;
                    await clientDetails[deviceIP].client.connection.coverCommandService({
                        key: device[4],
                        position: state.val,
                    });

                    // Handle Cover Tilt
                } else if (device[5] === `tilt`) {
                    // clientDetails[deviceIP][device[4]].states[device[5]] = state.val;
                    await clientDetails[deviceIP].client.connection.coverCommandService({
                        key: device[4],
                        tilt: state.val,
                    });

                    // Handle Cover Stop
                } else if (device[5] === `stop`) {
                    // clientDetails[deviceIP][device[4]].states[device[5]] = state.val;
                    await clientDetails[deviceIP].client.connection.coverCommandService({
                        key: device[4],
                        stop: true,
                    });
                } else if (clientDetails[deviceIP][device[4]].type === `Light`) {
                    let writeValue = state.val;
                    // Add unit to temperature states
                    if (
                        device[5] === `brightness` ||
                        device[5] === `blue` ||
                        device[5] === `green` ||
                        device[5] === `red` ||
                        device[5] === `white` ||
                        device[5] === `colorTemperature` ||
                        device[5] === `colorBrightness` ||
                        device[5] === `coldWhite` ||
                        device[5] === `warmWhite`
                    ) {
                        // Convert value to 255 range
                        writeValue = writeValue / 100 / 2.55;

                        // Store value to memory
                        clientDetails[deviceIP][device[4]].states[device[5]] = writeValue;
                    } else if (device[5] === `colorMode`) {
                        clientDetails[deviceIP][device[4]].states.colorMode = writeValue;
                    } else if (device[5] === `colorHEX`) {
                        // Convert hex to rgb
                        const rgbConversion = this.hexToRgb(writeValue);
                        if (!rgbConversion) {
                            return;
                        }
                        clientDetails[deviceIP][device[4]].states.red = rgbConversion.red / 100 / 2.55;
                        clientDetails[deviceIP][device[4]].states.blue = rgbConversion.blue / 100 / 2.55;
                        clientDetails[deviceIP][device[4]].states.green = rgbConversion.green / 100 / 2.55;
                    } else if (device[5] === `transitionLength`) {
                        clientDetails[deviceIP][device[4]].states[device[5]] = writeValue;
                    } else if (device[5] === 'effect') {
                        clientDetails[deviceIP][device[4]].states.effect = writeValue;
                    } else if (device[5] === 'state') {
                        clientDetails[deviceIP][device[4]].states.state = writeValue;
                    } else if (device[5] === 'config' && device[6] === 'rgbAutoWhite') {
                        // Store device-specific preference; no light command needed
                        clientDetails[deviceIP][device[4]].rgbAutoWhite = writeValue;
                        // Acknowledge the preference update so the state does not stay with ack=false
                        this.setState(id, !!writeValue, true);
                        return;
                    }

                    const data = {
                        key: clientDetails[deviceIP][device[4]].states.key,
                        state: clientDetails[deviceIP][device[4]].states.state,
                        transitionLength: clientDetails[deviceIP][device[4]].states.transitionLength,
                    };

                    const lightConfig = clientDetails[deviceIP][device[4]].config;
                    const colorModesList = lightConfig.supportedColorModesList || [];
                    // ColorMode constants: Unknown=0, OnOff=1, Brightness=2, White=3, ColorTemperature=4,
                    // ColdWarmWhite=5, RGB=6, RGBWhite=7, RGBColorTemperature=8, RGBColdWarmWhite=9
                    const supportsRgb =
                        lightConfig.legacySupportsRgb === true || colorModesList.some(m => [6, 7, 8, 9].includes(m));
                    const supportsBrightness =
                        lightConfig.legacySupportsBrightness === true || colorModesList.some(m => m >= 2 && m <= 9);
                    const supportsWhite =
                        lightConfig.legacySupportsWhiteValue === true || colorModesList.some(m => [3, 7].includes(m));
                    const supportsColorTemp =
                        lightConfig.legacySupportsColorTemperature === true ||
                        colorModesList.some(m => [4, 8].includes(m));
                    const supportsColdWarmWhite = colorModesList.some(m => [5, 9].includes(m));

                    // Auto white channel: when colorHEX is set to white (#ffffff) on RGBW lights,
                    // automatically switch to white channel; otherwise switch to RGB mode
                    if (clientDetails[deviceIP][device[4]].rgbAutoWhite && supportsWhite && device[5] === 'colorHEX') {
                        if (writeValue.replace(/^#/, '').toLowerCase() === 'ffffff') {
                            // White color detected: redirect to dedicated white channel
                            clientDetails[deviceIP][device[4]].states.red = 0;
                            clientDetails[deviceIP][device[4]].states.green = 0;
                            clientDetails[deviceIP][device[4]].states.blue = 0;
                            clientDetails[deviceIP][device[4]].states.white = 1;
                        } else {
                            // Non-white color: disable white channel
                            clientDetails[deviceIP][device[4]].states.white = 0;
                        }
                    }

                    if (supportsBrightness) {
                        data.brightness = clientDetails[deviceIP][device[4]].states.brightness;
                    }
                    if (supportsRgb) {
                        data.red = clientDetails[deviceIP][device[4]].states.red;
                        data.green = clientDetails[deviceIP][device[4]].states.green;
                        data.blue = clientDetails[deviceIP][device[4]].states.blue;
                    }
                    if (supportsWhite) {
                        data.white = clientDetails[deviceIP][device[4]].states.white;
                    }
                    if (supportsColorTemp) {
                        data.colorTemperature = clientDetails[deviceIP][device[4]].states.colorTemperature;
                    }
                    // Include new color fields for non-legacy devices using supportedColorModesList
                    if (colorModesList.length > 0) {
                        if (clientDetails[deviceIP][device[4]].states.colorMode !== undefined) {
                            data.colorMode = clientDetails[deviceIP][device[4]].states.colorMode;
                        }
                        if (supportsRgb && clientDetails[deviceIP][device[4]].states.colorBrightness !== undefined) {
                            data.colorBrightness = clientDetails[deviceIP][device[4]].states.colorBrightness;
                        }
                        if (supportsColdWarmWhite) {
                            if (clientDetails[deviceIP][device[4]].states.coldWhite !== undefined) {
                                data.coldWhite = clientDetails[deviceIP][device[4]].states.coldWhite;
                            }
                            if (clientDetails[deviceIP][device[4]].states.warmWhite !== undefined) {
                                data.warmWhite = clientDetails[deviceIP][device[4]].states.warmWhite;
                            }
                        }
                    }
                    const effect = clientDetails[deviceIP][device[4]].states.effect;
                    if (effect !== '' && effect !== null && effect !== undefined) {
                        data.effect = effect;
                    }

                    this.log.debug(`Send Light values ${JSON.stringify(data)}`);
                    await clientDetails[deviceIP].client.connection.lightCommandService(data);
                } else if (
                    device.length >= 6 &&
                    clientDetails[deviceIP].userDefinedServices &&
                    clientDetails[deviceIP].userDefinedServices[device[4]]
                ) {
                    if (device[5] === 'run') {
                        // Execute the service and reset the button
                        await this.executeUserDefinedService(deviceIP, device[2], device[4]);
                        await this.setStateAsync(id, { val: false, ack: true });
                    } else {
                        // Argument value updated - validate & convert based on object type before acknowledging
                        const obj = await this.getObjectAsync(id);
                        let newVal = state.val;

                        if (obj && obj.common && obj.common.type) {
                            if (obj.common.type === 'number') {
                                newVal = Number(state.val);
                                if (isNaN(newVal)) {
                                    this.log.warn(`Invalid number value "${state.val}" for service arg "${device[5]}"`);
                                    return;
                                }
                            } else if (obj.common.type === 'boolean') {
                                newVal = state.val === true || state.val === 'true';
                            }
                        }
                        await this.setStateAsync(id, { val: newVal, ack: true });
                    }
                }
            }
        } catch (e) {
            this.log.error(`[onStateChange] ${e}`);
        }
    }

    /**
     * Some types (like Button) don't have a state. So standard method of creating iobroker objects when receiving state event via api doesn't work here
     *
     * @param {string} host - The ESPHome device hostname or IP
     * @param {object} entity - The entity object from ESPHome API
     * @returns {Promise<void>}
     */
    async createNonStateDevices(host, entity) {
        switch (clientDetails[host][entity.id].type) {
            case 'Button': {
                await this.stateSetCreate(
                    `${clientDetails[host].deviceName}.${entity.type}.${entity.id}.SET`,
                    `Button`,
                    false,
                    '',
                    true,
                );
                break;
            }
        }
    }

    /**
     * Handle a user-defined service announcement from an ESPHome device.
     * Creates the ioBroker object tree: DeviceName.UserDefinedServices.<key>.<arg> + a run button.
     *
     * @param {string} host - Device IP/hostname
     * @param {object} serviceConfig - ListEntitiesServicesResponse from the ESPHome API
     * @returns {Promise<void>}
     */
    async handleUserDefinedService(host, serviceConfig) {
        const deviceName = clientDetails[host].deviceName;
        if (!deviceName) {
            this.log.warn(
                `[handleUserDefinedService] deviceName not yet known for ${host}, skipping service "${serviceConfig.name}"`,
            );
            return;
        }

        const serviceKey = String(serviceConfig.key);

        // Store service config in memory for later execution
        clientDetails[host].userDefinedServices[serviceKey] = { config: serviceConfig };

        // Create parent channel: DeviceName.UserDefinedServices
        const parentChannel = `${deviceName}.UserDefinedServices`;
        await this.extendObjectAsync(parentChannel, {
            type: 'channel',
            common: { name: 'User Defined Services' },
            native: {},
        });
        if (!clientDetails[host].adapterObjects.channels.includes(`${this.namespace}.${parentChannel}`)) {
            clientDetails[host].adapterObjects.channels.push(`${this.namespace}.${parentChannel}`);
        }

        // Create per-service channel: DeviceName.UserDefinedServices.<key>
        const serviceChannel = `${parentChannel}.${serviceKey}`;
        await this.extendObjectAsync(serviceChannel, {
            type: 'channel',
            common: { name: serviceConfig.name },
            native: {},
        });
        if (!clientDetails[host].adapterObjects.channels.includes(`${this.namespace}.${serviceChannel}`)) {
            clientDetails[host].adapterObjects.channels.push(`${this.namespace}.${serviceChannel}`);
        }

        // Create a writable state for each argument
        for (const arg of serviceConfig.argsList || []) {
            // ServiceArgType: Bool=0, Int=1, Float=2, String=3, BoolArray=4, IntArray=5, FloatArray=6, StringArray=7
            let iobType, iobDef;
            if (arg.type === 0) {
                iobType = 'boolean';
                iobDef = false;
            } else if (arg.type === 1 || arg.type === 2) {
                iobType = 'number';
                iobDef = 0;
            } else {
                // String, BoolArray, IntArray, FloatArray, StringArray stored as string (JSON for arrays)
                iobType = 'string';
                iobDef = '';
            }

            await this.extendObjectAsync(`${serviceChannel}.${arg.name}`, {
                type: 'state',
                common: {
                    name: arg.name,
                    type: iobType,
                    role: 'value',
                    read: true,
                    write: true,
                    def: iobDef,
                },
                native: {},
            });
            this.subscribeStates(`${serviceChannel}.${arg.name}`);
            await this.stateSetCreate(`${serviceChannel}.${arg.name}`, arg.name, iobDef);
        }

        // Create a run button to trigger the service
        await this.extendObjectAsync(`${serviceChannel}.run`, {
            type: 'state',
            common: {
                name: `Run ${serviceConfig.name}`,
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
                def: false,
            },
            native: {},
        });
        this.subscribeStates(`${serviceChannel}.run`);
    }

    /**
     * Execute a user-defined ESPHome service using the library's executeServiceService method.
     *
     * @param {string} deviceIP - Device IP/hostname
     * @param {string} deviceName - Device name (MAC without colons)
     * @param {string} serviceKey - Service key (numeric, as string)
     * @returns {Promise<void>}
     */
    async executeUserDefinedService(deviceIP, deviceName, serviceKey) {
        const deviceDetails = clientDetails[deviceIP];
        if (!deviceDetails || !deviceDetails.client) {
            this.log.error(
                `Cannot execute user-defined service: no connection for device IP ${deviceIP} (${deviceName})`,
            );
            return;
        }

        const serviceEntry = deviceDetails.userDefinedServices && deviceDetails.userDefinedServices[serviceKey];
        if (!serviceEntry || !serviceEntry.config) {
            this.log.error(
                `Cannot execute user-defined service: no service configuration found for device IP ${deviceIP} (${deviceName}), serviceKey=${serviceKey}`,
            );
            return;
        }
        const serviceConfig = serviceEntry.config;

        const args = [];
        for (const arg of serviceConfig.argsList || []) {
            const argState = await this.getStateAsync(`${deviceName}.UserDefinedServices.${serviceKey}.${arg.name}`);
            const argVal = argState ? argState.val : null;

            // ServiceArgType: Bool=0, Int=1, Float=2, String=3, BoolArray=4, IntArray=5, FloatArray=6, StringArray=7
            switch (arg.type) {
                case 0: // Bool
                    args.push({ type: arg.type, value: argVal === true || argVal === 'true' });
                    break;
                case 1: // Int
                    args.push({ type: arg.type, value: parseInt(argVal) || 0 });
                    break;
                case 2: // Float
                    args.push({ type: arg.type, value: parseFloat(argVal) || 0 });
                    break;
                case 3: // String
                    args.push({ type: arg.type, value: String(argVal !== null && argVal !== undefined ? argVal : '') });
                    break;
                case 4: {
                    // BoolArray
                    const arr = this.parseServiceArrayArg(argVal);
                    args.push({ type: arg.type, value: arr.map(v => v === true || v === 'true') });
                    break;
                }
                case 5: {
                    // IntArray
                    const arr = this.parseServiceArrayArg(argVal);
                    args.push({ type: arg.type, value: arr.map(v => parseInt(v) || 0) });
                    break;
                }
                case 6: {
                    // FloatArray
                    const arr = this.parseServiceArrayArg(argVal);
                    args.push({ type: arg.type, value: arr.map(v => parseFloat(v) || 0) });
                    break;
                }
                case 7: {
                    // StringArray
                    const arr = this.parseServiceArrayArg(argVal);
                    args.push({ type: arg.type, value: arr.map(v => String(v)) });
                    break;
                }
                default:
                    this.log.warn(`Unknown service arg type ${arg.type} for argument "${arg.name}"`);
            }
        }

        clientDetails[deviceIP].client.connection.executeServiceService({ key: Number(serviceKey), args });
        this.log.info(`Executed user-defined service "${serviceConfig.name}" on ${deviceName}`);
    }

    /**
     * Safely parse a JSON string array argument value, falling back to empty array on error.
     *
     * @param {any} argVal State value (JSON string or already an array)
     * @returns {Array<any>} Parsed array or empty array on failure
     */
    parseServiceArrayArg(argVal) {
        if (Array.isArray(argVal)) {
            return argVal;
        }

        if (typeof argVal === 'string') {
            const trimmed = argVal.trim();
            if (!trimmed) {
                return [];
            }

            try {
                const parsed = JSON.parse(trimmed);
                return Array.isArray(parsed) ? parsed : [];
            } catch {
                this.log.warn(`Failed to parse service array argument "${argVal}", using empty array`);
                return [];
            }
        }

        this.log.warn(`Received unsupported service array argument type "${typeof argVal}", using empty array`);
        return [];
    }

    async resetOnlineStates() {
        try {
            // Set parameters for object view to only include objects within adapter namespace
            const params = {
                startkey: `${this.namespace}.`,
                endkey: `${this.namespace}.\u9999`,
            };

            // Get all current devices in an adapter tree
            const _devices = await this.getObjectViewAsync('system', 'device', params);
            // List all found devices & set online state to false
            for (const currDevice in _devices.rows) {
                // Extend online state to device (to ensure migration of version < 0.3.1
                await this.extendObjectAsync(_devices.rows[currDevice].id, {
                    common: {
                        statusStates: {
                            onlineId: `${_devices.rows[currDevice].id}.info._online`,
                        },
                    },
                });

                // Set online state to false, will be set to true at successfully connected
                await this.stateSetCreate(`${_devices.rows[currDevice].id}.info._online`, `Online state`, false);
            }
        } catch (error) {
            this.errorHandler(`[resetOnlineStates]`, error);
        }
    }

    async objectCleanup(ip) {
        try {
            this.log.debug(
                `[objectCleanup] Starting channel and state cleanup for ${clientDetails[ip].deviceFriendlyName} | ${ip}`,
            );

            // Cancel cleanup operation in case device is not connected anymore or already deleted
            if (clientDetails[ip] && (clientDetails[ip].connectionError || !clientDetails[ip].connected)) {
                return;
            }

            // Set parameters for object view to only include objects within adapter namespace
            const params = {
                startkey: `${this.namespace}.${clientDetails[ip].deviceName}.`,
                endkey: `${this.namespace}.\u9999`,
            };

            // Get all current channels
            const _channels = await this.getObjectViewAsync('system', 'channel', params);
            // List all found channels & compare with memory, delete unneeded channels
            for (const currDevice in _channels.rows) {
                // @ts-expect-error _channels.rows is an array but treated as object here
                if (
                    !clientDetails[ip].adapterObjects.channels.includes(_channels.rows[currDevice].id) &&
                    _channels.rows[currDevice].id.split('.')[2] === clientDetails[ip].deviceName
                ) {
                    this.log.debug(`[objectCleanup] Unknown Channel found, delete ${_channels.rows[currDevice].id}`);
                    await this.delObjectAsync(_channels.rows[currDevice].id, {
                        recursive: true,
                    });
                }
            }

            // Get all current states in adapter tree
            const _states = await this.getObjectViewAsync('system', 'state', params);
            // List all found states & compare with memory, delete unneeded states
            for (const currDevice in _states.rows) {
                if (
                    !this.createdStatesDetails[_states.rows[currDevice].id.replace(`esphome.0.`, ``)] &&
                    _states.rows[currDevice].id.split('.')[2] === clientDetails[ip].deviceName
                ) {
                    this.log.debug(`[objectCleanup] Unknown State found, delete ${_states.rows[currDevice].id}`);
                    // await this.delObjectAsync(_states.rows[currDevice].id);
                }
            }
        } catch (error) {
            this.errorHandler(`[objectCleanup]`, error);
        }
    }

    async offlineDeviceCleanup() {
        this.log.info(`Offline Device cleanup started`);

        try {
            // Get an overview of all current devices known by adapter
            const knownDevices = await this.getDevicesAsync();
            // console.log(`KnownDevices: ${knownDevices}`);
            // Loop to all devices, check if online state = TRUE otherwise delete device
            for (const device in knownDevices) {
                // Get online value
                const online = await this.getStateAsync(`${knownDevices[device]._id}.info._online`);
                if (!online || !online.val) {
                    this.log.info(
                        `Offline device ${knownDevices[device]._id.split('.')[2]} expected on ip ${knownDevices[device].native.ip} removed`,
                    );
                    await this.delObjectAsync(knownDevices[device]._id, {
                        recursive: true,
                    });
                }
            }
            if (!knownDevices) {
                return;
            } // exit function if no known device are detected
            if (knownDevices.length > 0) {
                this.log.info(`Try to contact ${knownDevices.length} known devices`);
            }
        } catch (error) {
            this.errorHandler(`[offlineDeviceCleanup]`, error);
        }
    }

    /**
     * Generic function to properly update memory connection details of a device in all scenarios
     *
     * @param {string} host IP-Address of device
     * @param {boolean} connected Indicator if a device is connected
     * @param {boolean} connecting Indicator if a device is initializing
     * @param {string} [connectionStatus] Connection status shown in Adapter instance / Device Manager
     * @param {boolean} [connectionError] Indicator if a connection error (like incorrect password or timeout) is present
     * @returns void
     */
    async updateConnectionStatus(host, connected, connecting, connectionStatus, connectionError) {
        try {
            // Cancel operation if host is unknown
            if (!clientDetails[host]) {
                return;
            }
            clientDetails[host].connected = connected;
            clientDetails[host].connecting = connecting;
            clientDetails[host].connectionError =
                connectionError != null ? connectionError : clientDetails[host].connectionError;
            clientDetails[host].connectStatus =
                connectionStatus != null ? connectionStatus : clientDetails[host].connectStatus;

            // Only handle online state if a device was initialized
            if (clientDetails[host].connectStatus === 'Initialisation needed') {
                return;
            }

            // Update device connection indicator
            if (!connected || connectionError || connecting) {
                // Device not connected or initializing, set _online state to false
                await this.stateSetCreate(`${clientDetails[host].deviceName}.info._online`, `Online state`, false);
            } else {
                // Device connected, set _online state to true
                await this.stateSetCreate(`${clientDetails[host].deviceName}.info._online`, `Online state`, true);
            }
            // Write connection status to info channel
            await this.stateSetCreate(
                `${clientDetails[host].deviceName}.info._connectionStatus`,
                `Connection status`,
                connectionStatus,
            );
        } catch (error) {
            this.errorHandler(`[updateConnectionStatus]`, error);
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - Adapter configuration options
     */
    module.exports = options => new Esphome(options);
} else {
    // otherwise start the instance directly
    new Esphome();
}
//# sourceMappingURL=main.js.map
