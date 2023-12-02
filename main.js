'use strict';

/*
 * Created with @iobroker/create-adapter v1.31.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const clientDevice = require('./lib/helpers.js');
// @ts-ignore Client is just missing in index.d.ts file
const {Client, Discovery} = require('@2colors/esphome-native-api');
const stateAttr = require(__dirname + '/lib/stateAttr.js'); // Load attribute library
const disableSentry = false; // Ensure to set to true during development!
const warnMessages = {}; // Store warn messages to avoid multiple sending to sentry
const fs = require('fs');
const {clearTimeout} = require('timers');
const resetTimers = {}; // Memory allocation for all running timers
let autodiscovery, dashboardProcess, createConfigStates, discovery;
const clientDetails = {}; // Memory cache of all devices and their connection status
const newlyDiscoveredClient = {}; // Memory cache of all newly discovered devices and their connection status

class Esphome extends utils.Adapter {

	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
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
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		await this.setStateAsync('info.connection', {val: true, ack: true});
		try {

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

			// Start MDNS discovery when enabled
			if (autodiscovery) {
				if (resetTimers['autodiscovery']) resetTimers['autodiscovery'] = clearTimeout(resetTimers['autodiscovery']);
				// this.log.info(`Adapter ready, automatic Device Discovery will be activated in 30 seconds.`);
				resetTimers['autodiscovery'] = setTimeout(async () => {
					this.deviceDiscovery(); // Start bonjour service autodiscovery
				}, (5000));
			} else {
				this.log.warn(`Auto Discovery disabled, new devices (or IP changes) will NOT be detected automatically!`);
			}

			// Start ESPHome Dashboard process
			if (this.config.ESPHomeDashboardEnabled) {
				this.log.info(`Native Integration of ESPHome Dashboard enabled `);
				await this.espHomeDashboard();
			} else {
				this.log.info(`Native Integration of ESPHome Dashboard disabled `);
			}

			// Create & Subscribe to button handling offline Device cleanup
			this.extendObject('esphome.0.info.deviceCleanup',
				{
					'type': 'state',
					'common': {
						'role': 'button',
						'name': 'Device or service connected',
						'type': 'boolean',
						'read': false,
						'write': true,
						'def': false
					}
				});
			this.subscribeStates('esphome.0.info.deviceCleanup');

		} catch (e) {
			this.log.error(`[Adapter start] Fatal error occurred ${e}`);
		}
	}

	// ToDo: move to separate module
	async espHomeDashboard() {
		try {
			// @ts-ignore
			const {getVenv} = await import('autopy');

			// Create a virtual environment with mitmproxy installed.
			const python = await getVenv({
				name: 'esphome',
				pythonVersion: '~3.11', // Use any Python 3.11.x version.
				requirements: [{name: 'esphome', version: ''}, {name: 'pillow', version: '==10.0.1'}], // Use latest esphome
			});

			// Define directory to store configuration files
			const dataDir = utils.getAbsoluteDefaultDataDir();

			try {
				fs.mkdir(`${dataDir}esphome.${this.instance}`, (err) => {
					if (err) {
						return console.log(`ESPHome directory exists`);
					}
					console.log(`ESPHome directory created`);
				});
				// );
			} catch (e) {
				// Directory has issues reading/writing data, iob fix should be executed
				this.log.warn(`ESPHome DDashboard is unable to access directory to store YAML configuration data, please run ioBroker fix`);
			}

			const dashboardProcess = python('esphome', ['dashboard', `${dataDir}esphome.${this.instance}`]);

			this.log.debug(`espHomeDashboard_Process ${JSON.stringify(dashboardProcess)}`);

			dashboardProcess.stdout?.on('data', (data) => {
				this.log.info(`[dashboardProcess - Data] ${data}`);
			});

			dashboardProcess.stderr?.on('data', (data) => {
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

			// eslint-disable-next-line no-unused-vars
			dashboardProcess.on('exit', (code, signal) => {
				this.log.warn(`ESPHome Dashboard stopped`);
			});

			dashboardProcess.on('error', (data) => {
				if (data.message.includes('INFO')) {
					this.log.info(`[dashboardProcess Info] ${data}`);
				} else if (data.message.includes('ERROR')) {
					this.log.error(`[dashboardProcess Warn] ${data}`);
				} else {
					this.log.error(`[dashboardProcess Error] ${data}`);
				}
			});
		} catch (error) {
			this.errorHandler(`[espHomeDashboard]`, error);
		}
	}

	// Try to contact and read data of already known devices
	async tryKnownDevices() {
		try {
			// Get all current devices from adapter tree
			const knownDevices = await this.getDevicesAsync();

			// Cancel operation if no devices are found
			if (!knownDevices) return;

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
					!deviceDetails.encryptionKeyUsed ? deviceDetails.apiPassword ? deviceDetails.apiPassword : deviceDetails.passWord : null,
					deviceDetails.encryptionKeyUsed ? deviceDetails.encryptionKey : null
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
				if (this.config.ignoredDevices[entry] && this.config.ignoredDevices[entry]['IP-Address'] && !excludedIP.includes(this.config.ignoredDevices[entry]['IP-Address'])){
					excludedIP.push(this.config.ignoredDevices[entry]['IP-Address']);
				}
			}

			// Start device discovery
			discovery = new Discovery();
			discovery.run();

			discovery.on('info', ( message ) => {
				this.log.debug(`ESPHome Device found on ${message.address} | ${JSON.stringify(message)}`);
				if (!excludedIP.includes(message.address) && !newlyDiscoveredClient[message.address] && !clientDetails[message.address]){
					this.log.info(`New ESPHome Device discovered: ${message.friendly_name ? message.friendly_name : message.host} on ${message.address}`);
					// Store device data into memory to allow adoption by admin interface
					newlyDiscoveredClient[message.address] = {
						ip: message.address,
						mac: message.mac.toUpperCase(),
						deviceFriendlyName: message.friendly_name ? message.friendly_name : message.host
					};
				}
			});

		} catch (error) {
			this.errorHandler(`[deviceDiscovery]`, error);
		}
	}

	/**
	 * Handle Socket connections
	 * @param {string} host IP address of a device
	 */
	connectDevices(host) {
		try {

			this.log.info(`Try to connect to ${host}`);

			// Cancel procedure if connection try or action to delete this device is already in progress or
			if (clientDetails[host] && (clientDetails[host].connecting || clientDetails[host].deletionRequested)) return;
			this.updateConnectionStatus(host,false,true, 'connecting');

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
				clientSettings.password = clientDetails[host].apiPassword ? this.decrypt(clientDetails[host].apiPassword) : '';
			} else {
				clientSettings.encryptionKey =  this.decrypt(clientDetails[host].encryptionKey);
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

					// Check if device connection is caused by adding  device from admin, if yes send OK message
					if (this.messageResponse[host]) {
						this.sendTo(this.messageResponse[host].from, this.messageResponse[host].command,
							{result: 'OK - Device successfully connected, initializing configuration. Refresh table to show all known devices'},
							this.messageResponse[host].callback);
						delete this.messageResponse[host];
					}

				} catch (e) {
					this.log.error(`connection error ${e}`);
				}
			});

			clientDetails[host].client.on('disconnected', async () => 	{
				try {
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

						this.log.warn(`ESPHome client ${clientDetails[host].deviceFriendlyName} | ${clientDetails[host].deviceName} | on ${host} disconnected`);
					} else {
						this.log.warn(`ESPHome client ${host} disconnected`);
					}
				} catch (e) {
					this.log.debug(`ESPHome disconnect error : ${e}`);
				}
			});

			clientDetails[host].client.on('initialized', async () => {
				this.log.info(`ESPHome  client ${clientDetails[host].deviceFriendlyName} on ip ${host} initialized`);
				clientDetails[host].initialized = true;
				clientDetails[host].connectStatus = 'initialized';

				await this.updateConnectionStatus(host, true, false, 'initialized', false);

				// Start timer to clean up unneeded objects
				if (resetTimers[host]) resetTimers[host] = clearTimeout(resetTimers[host]);
				resetTimers[host] = setTimeout(async () => {
					await this.objectCleanup(host);
				}, (10000));
			});

			// Log message listener
			clientDetails[host].client.connection.on('message', (/** @type {object} */ message) => {
				this.log.debug(`[ESPHome Device Message] ${host} client log ${message}`);
			});

			clientDetails[host].client.connection.on('data', (/** @type {object} */ data) => {
				this.log.debug(`[ESPHome Device Data] ${host} client data ${data}`);
			});

			// Handle device information when connected or information updated
			clientDetails[host].client.on('deviceInfo', async (/** @type {object} */ deviceInfo) => {
				try {
					this.log.info(`ESPHome Device info received for ${deviceInfo.name}`);
					this.log.debug(`DeviceData: ${JSON.stringify(deviceInfo)}`);

					// Store device information into memory
					const deviceName = this.replaceAll(deviceInfo.macAddress, `:`, ``);

					clientDetails[host].mac = deviceInfo.macAddress;
					clientDetails[host].deviceName = deviceName;
					clientDetails[host].deviceFriendlyName = deviceInfo.name;

					await this.updateConnectionStatus(host, true, false, 'Initializing', false);

					clientDetails[host].deviceInfo = deviceInfo;

					this.deviceStateRelation[deviceName] = {'ip': host};

					this.log.debug(`DeviceInfo ${clientDetails[host].deviceFriendlyName}: ${JSON.stringify(clientDetails[host].deviceInfo)}`);

					// Create Device main structure
					await this.extendObjectAsync(deviceName, {
						type: 'device',
						common: {
							name: deviceInfo.name,
							statusStates: {
								onlineId: `${this.namespace}.${deviceName}.info._online`
							}
						},
						native: {
							ip: host,
							name: clientDetails[host].deviceInfoName,
							mac: deviceInfo.macAddress,
							deviceName: deviceName,
							deviceFriendlyName : deviceInfo.name,
							apiPassword: clientDetails[host].apiPassword,
							encryptionKey: clientDetails[host].encryptionKey,
							encryptionKeyUsed : clientDetails[host].encryptionKeyUsed
						},
					});

					// Read JSON and handle states
					await this.traverseJson(deviceInfo, `${deviceName}.info`);

					// Check if device connection is caused by adding  device from admin, if yes send OK message
					// ToDo rebuild to new logic
					if (this.messageResponse[host]) {
						const massageObj = {
							'type': 'info',
							'message': 'success'
						};
						// @ts-ignore
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
						unit: entity.config.unitOfMeasurement !== undefined ? entity.config.unitOfMeasurement || '' : ''
					};


					if (clientDetails[host][entity.id].config.deviceClass) {
						this.log.info(`${clientDetails[host].deviceFriendlyName} announced ${clientDetails[host][entity.id].config.deviceClass} "${clientDetails[host][entity.id].config.name}"`);
					} else {
						this.log.info(`${clientDetails[host].deviceFriendlyName} announced ${clientDetails[host][entity.id].type} "${clientDetails[host][entity.id].config.name}"`);
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
					if (!clientDetails[host].adapterObjects.channels.includes(`${this.namespace}.${clientDetails[host].deviceName}.${entity.type}`)) {
						clientDetails[host].adapterObjects.channels.push(`${this.namespace}.${clientDetails[host].deviceName}.${entity.type}`);
					}

					// Create state specific channel by id
					await this.extendObjectAsync(`${clientDetails[host].deviceName}.${entity.type}.${entity.id}`, {
						type: 'channel',
						common: {
							name: entity.config.name
						},
						native: {},
					});

					// Create a channel in device memory
					if (!clientDetails[host].adapterObjects.channels.includes(`${this.namespace}.${clientDetails[host].deviceName}.${entity.type}.${entity.id}`)) {
						clientDetails[host].adapterObjects.channels.push(`${this.namespace}.${clientDetails[host].deviceName}.${entity.type}.${entity.id}`);
					}

					//Check if a config channel should be created
					if (!createConfigStates) {
						// Delete folder structure if already present
						try {
							const obj = await this.getObjectAsync(`${clientDetails[host].deviceName}.${entity.type}.${entity.id}.config`);
							if (obj) {
								await this.delObjectAsync(`${clientDetails[host].deviceName}.${entity.type}.${entity.id}.config`, {recursive: true});
							}
						} catch (error) {
							// do nothing
						}
					} else {
						// Create config channel
						await this.extendObjectAsync(`${clientDetails[host].deviceName}.${entity.type}.${entity.id}.config`, {
							type: 'channel',
							common: {
								name: 'Configuration data'
							},
							native: {},
						});

						// Store channel in device memory
						if (!clientDetails[host].adapterObjects.channels.includes(`${this.namespace}.${clientDetails[host].deviceName}.${entity.type}.${entity.id}.config`)) {
							clientDetails[host].adapterObjects.channels.push(`${this.namespace}.${clientDetails[host].deviceName}.${entity.type}.${entity.id}.config`);
						}

						// Handle Entity JSON structure and write related config channel data
						await this.traverseJson(entity.config, `${clientDetails[host].deviceName}.${entity.type}.${entity.id}.config`);
					}

					await this.createNonStateDevices(host, entity);

					// Request current state values
					await clientDetails[host].client.connection.subscribeStatesService();
					this.log.debug(`[DeviceInfoData] ${clientDetails[host].deviceFriendlyName} ${JSON.stringify(clientDetails[host].deviceInfo)}`);

					// Listen to state changes and write values to states (create state if not yet exists)
					entity.on(`state`, async (/** @type {object} */ state) => {
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
									await this.stateSetCreate(`${clientDetails[host].deviceName}.${entity.type}.${entity.id}.position`, `Position`, 0, `%`, true);
									await this.stateSetCreate(`${clientDetails[host].deviceName}.${entity.type}.${entity.id}.tilt`, `Tilt`, 0, `%`, true);
									await this.stateSetCreate(`${clientDetails[host].deviceName}.${entity.type}.${entity.id}.stop`, `Stop`, false, ``, true);
									break;


								case 'Fan':
									await this.handleRegularState(`${host}`, entity, state, false);
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

								case 'Select': {
									await this.handleRegularState(`${host}`, entity, state, true);
									break;
								}

								default:

									if (!warnMessages[clientDetails[host][entity.id].type]) {
										this.log.warn(`DeviceType ${clientDetails[host][entity.id].type} not yet supported`);
										this.log.warn(`Please submit git issue with all information from next line`);
										this.log.warn(`DeviceType ${clientDetails[host][entity.id].type} | State-Keys ${JSON.stringify(state)} | [entityStateConfig] ${JSON.stringify(clientDetails[host][entity.id])}`);
										warnMessages[clientDetails[host][entity.id].type] = deviceDetails;
									}
							}

						} catch (error) {
							this.errorHandler(`[connectHandler NewEntity]`, error);
						}

					});

					entity.connection.on(`destroyed`, async (/** @type {object} */ state) => {
						try {
							this.log.warn(`Connection destroyed for ${state}`);
						} catch (e) {
							this.log.error(`State handle error ${e}`);
						}

					});

					entity.on(`error`, async (/** @type {object} */ name) => {
						this.log.error(`Entity error: ${name}`);
					});


				} catch (e) {
					this.log.error(`Connection issue for ${entity.name} ${e} | ${e.stack}`);
				}

			});

			// Connection data handler
			clientDetails[host].client.on('error', async (error) => {
				try {

					let optimisedError = error.message;
					// Optimise error messages
					if ((error.message && (error.message.includes('EHOSTUNREACH') || error.message.includes('EHOSTDOWN'))) || (error.code && error.code.includes('ETIMEDOUT'))) {
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
					}  else if (error.message.includes('ECONNREFUSED')) {
						optimisedError = `Client ${host} not yet ready to connect, will try again!`;
						await this.updateConnectionStatus(host, false, true, 'initializing', true);
						this.log.warn(optimisedError);

					} else if (error.message.includes('write after end')) {
						// Ignore error
					} else {
						this.log.error(`ESPHome client ${host} ${error}`);
					}

					// Check if device connection is caused by adding  device from admin, if yes send OK message
					if (this.messageResponse[host]) {

						this.sendTo(this.messageResponse[host].from, this.messageResponse[host].command,
							{error: `${optimisedError}`},
							this.messageResponse[host].callback);
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
				this.log.debug(`Value "${stateVal}" for name "${entity}" before function modify with method "round(${clientDetails[host][entity.id].config.accuracyDecimals})"`);
				stateVal = this.modify(rounding, stateVal);
				this.log.debug(`Value "${stateVal}" for name "${entity}" after function modify with method "${rounding}"`);
			}

			//ToDo review this code section
			/** @type {ioBroker.StateCommon} */
			const stateCommon = {
			};

			if(entity.config.optionsList != null) {
				stateCommon.states = entity.config.optionsList;
			}
			await this.stateSetCreate(`${clientDetails[host].deviceName}.${entity.type}.${entity.id}.state`, `State of ${entity.config.name}`, stateVal, clientDetails[host][entity.id].unit, writable, stateCommon);
		} catch (error) {
			this.errorHandler(`[espHomeDashboard]`, error);
		}
	}

	/**
	 * Handle state values
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
						clientDetails[host][entity.id].states.currentTemperature = this.modify('round(2)', state[stateName]);
						break;

					case 'oscillating': // Sensor type = Fan, write not supported
						writable = false;
						break;

					case 'speed': // Sensor type = Fan, write not supported
						writable = false;
						break;

				}

				// Add unit to temperature states
				if (stateName === `targetTemperature`
					|| stateName === `targetTemperatureLow`
					|| stateName === `targetTemperatureHigh`) {

					unit = `°C`;

				}

				// Add unit to states
				if (stateName === `brightness`
					|| stateName === `blue`
					|| stateName === `green`
					|| stateName === `red`
					|| stateName === `white`
					|| stateName === `colorTemperature`) {

					writeValue = Math.round((state[stateName] * 100) * 2.55);

					// Create transitionLength state only ones
					if (clientDetails[host][entity.id].states.transitionLength == null) {

						// Check if state already exists
						let transitionLength;
						try {

							// Try  to get current state
							transitionLength = await this.getStateAsync(`${clientDetails[host].deviceName}.${entity.type}.${entity.id}.transitionLength`);

							// Check if state contains value
							if (transitionLength) {
								clientDetails[host][entity.id].states.transitionLength = transitionLength.val;
								// Run create state routine to ensure state is cached in memory
								await this.stateSetCreate(`${clientDetails[host].deviceName}.${entity.type}.${entity.id}.transitionLength`, `${stateName} of ${entity.config.name}`, transitionLength.val, `s`, writable);
							} else { // Else create it
								await this.stateSetCreate(`${clientDetails[host].deviceName}.${entity.type}.${entity.id}.transitionLength`, `${stateName} of ${entity.config.name}`, 0, `s`, writable);
								clientDetails[host][entity.id].states.transitionLength = 0;
							}

						} catch (e) { // Else create it
							await this.stateSetCreate(`${clientDetails[host].deviceName}.${entity.type}.${entity.id}.transitionLength`, `${stateName} of ${entity.config.name}`, 0, `s`, writable);
							clientDetails[host][entity.id].states.transitionLength = 0;
						}

					}
				}

				if (stateName !== 'key') {
					await this.stateSetCreate(`${clientDetails[host].deviceName}.${entity.type}.${entity.id}.${stateName}`, `${stateName} of ${entity.config.name}`, writeValue, unit, writable);
				}
			}

			// Convert RGB to HEX and write to state
			if (clientDetails[host][entity.id].states.red != null &&
				clientDetails[host][entity.id].states.blue != null &&
				clientDetails[host][entity.id].states.green != null) {
				const hexValue = this.rgbToHex(
					Math.round((clientDetails[host][entity.id].states.red * 100) * 2.55),
					Math.round((clientDetails[host][entity.id].states.green * 100) * 2.55),
					Math.round((clientDetails[host][entity.id].states.blue * 100) * 2.55),
				);
				await this.stateSetCreate(`${clientDetails[host].deviceName}.${entity.type}.${entity.id}.colorHEX`, `ColorHEX of ${entity.config.name}`, hexValue, '', true);
			}

		} catch (error) {
			this.errorHandler(`[espHomeDashboard]`, error);
		}
	}

	/**
	 * Traverses the json-object and provides all information for creating/updating states
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
				if (!!jObject[i] && typeof (jObject[i]) === 'object' && jObject[i] === '[object Object]') {
					if (parent == null) {
						id = i;
						if (replaceName) {
							if (jObject[i].name) name = jObject[i].name;
						}
						if (replaceID) {
							if (jObject[i].id) id = jObject[i].id;
						}
					} else {
						id = parent + '.' + i;
						if (replaceName) {
							if (jObject[i].name) name = jObject[i].name;
						}
						if (replaceID) {
							if (jObject[i].id) id = parent + '.' + jObject[i].id;
						}
					}
					// Avoid channel creation for empty arrays/objects
					if (Object.keys(jObject[i]).length !== 0) {
						// console.log(`park`);
						await this.setObjectAsync(id, {
							'type': 'channel',
							'common': {
								'name': name,
							},
							'native': {},
						});
						await this.traverseJson(jObject[i], id, replaceName, replaceID, state_expire);
					} else {
						this.log.debug('State ' + id + ' received with empty array, ignore channel creation');
					}
				} else {
					value = jObject[i];
					if (parent == null) {
						id = i;
					} else {
						id = parent + '.' + i;
					}
					if (typeof (jObject[i]) == 'object') value = JSON.stringify(value);
					//avoid state creation if empty
					if (value !== '[]') {
						this.log.debug('create id ' + id + ' with value ' + value + ' and name ' + name);
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
	 * @param {string} objName ID of the object
	 * @param {string} name Name of state (also used for stattAttrlib!)
	 * @param {boolean | string | number | null} [value] Value of the state
	 * @param {string} [unit] Unit to be set
	 * @param {boolean} [writable] state writable ?
	 * @param {object} initialStateCommon Additional attributes for state.common
	 */
	async stateSetCreate(objName, name, value, unit, writable, /** @type Partial<ioBroker.StateCommon> **/ initialStateCommon = {}) {
		this.log.debug('Create_state called for : ' + objName + ' with value : ' + value);
		try {

			// Try to get details from state lib, if not use defaults. Throw warning if states are not known in an attribute list
			/** @type {Partial<ioBroker.StateCommon>} */
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
			common.type = typeof (value);
			common.role = stateAttr[name] !== undefined ? stateAttr[name].role || 'state' : 'state';
			common.read = true;
			common.unit = unit !== undefined ? unit || '' : '';
			// common.write = stateAttr[name] !== undefined ? stateAttr[name].write || false : false;
			common.write = writable !== undefined ? writable || false : false;
			// common.modify = stateAttr[name] !== undefined ? stateAttr[name].modify || '' : '';
			// this.log.debug(`MODIFY to ${name}: ${JSON.stringify(common.modify)}`);

			if ((!this.createdStatesDetails[objName])
				|| (this.createdStatesDetails[objName]
					&& ( common.name !== this.createdStatesDetails[objName].name
						|| common.name !== this.createdStatesDetails[objName].name
						|| common.type !== this.createdStatesDetails[objName].type
						|| common.role !== this.createdStatesDetails[objName].role
						|| common.read !== this.createdStatesDetails[objName].read
						|| common.unit !== this.createdStatesDetails[objName].unit
						|| common.write !== this.createdStatesDetails[objName].write
					)
				)) {

				// console.log(`An attribute has changed : ${state}`);
				// @ts-ignore values are correctly provided by state Attribute definitions, error can be ignored
				await this.extendObjectAsync(objName, {
					type: 'state',
					common,
					native: {}
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
					ack: true
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
	 * @param {string} codepart Function were exception occurred
	 * @param {any} error Error message
	 */
	errorHandler(codepart, error) {
		let errorMsg = error;
		if (error instanceof Error && error.stack != null) errorMsg = error.stack;
		try {
			if (!disableSentry) {
				this.log.info(`[Error caught and send to Sentry, thank you collaborating!] error: ${errorMsg}`);
				if (this.supportsFeature && this.supportsFeature('PLUGINS')) {
					const sentryInstance = this.getPluginInstance('sentry');
					if (sentryInstance) {
						if (sentryInstance && sentryInstance.getSentryObject) sentryInstance.getSentryObject().captureException(errorMsg);
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
	 * @param {string} string String to replace invalid chars
	 */
	escapeRegExp(string) {
		return string.replace(/[.*+\-?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
	}

	/**
	 * Helper replace function
	 * @param {string} str String to replace invalid chars
	 * @param {string} find String to find for replace function
	 * @param {string} replace String to replace
	 */
	replaceAll(str, find, replace) {
		return str.replace(new RegExp(this.escapeRegExp(find), 'g'), replace);
	}

	/**
	 * Analysis modify an element in stateAttr.js and execute command
	 * @param {string} method defines the method to be executed (e.g. round())
	 * @param {string | number | boolean} value value to be executed
	 */
	modify(method, value) {
		this.log.debug(`Function modify with method "${method}" and value "${value}"`);
		let result = null;
		try {
			if (method.match(/^custom:/gi) != null) {                               //check if starts with "custom:"
				value = eval(method.replace(/^custom:/gi, ''));                     //get value without "custom:"
			} else if (method.match(/^multiply\(/gi) != null) {                     //check if starts with "multiply("
				const inBracket = parseFloat(method.match(/(?<=\()(.*?)(?=\))/g));    //get value in brackets
				value = value * inBracket;
			} else if (method.match(/^divide\(/gi) != null) {                       //check if starts with "divide("
				const inBracket = parseFloat(method.match(/(?<=\()(.*?)(?=\))/g));    //get value in brackets
				value = value / inBracket;
			} else if (method.match(/^round\(/gi) != null) {                        //check if starts with "round("
				const inBracket = parseInt(method.match(/(?<=\()(.*?)(?=\))/g));      //get value in brackets
				value = Math.round(value * Math.pow(10, inBracket)) / Math.pow(10, inBracket);
			} else if (method.match(/^add\(/gi) != null) {                          //check if starts with "add("
				const inBracket = parseFloat(method.match(/(?<=\()(.*?)(?=\))/g));    //get value in brackets
				value = parseFloat(value) + inBracket;
			} else if (method.match(/^substract\(/gi) != null) {                    //check if starts with "substract("
				const inBracket = parseFloat(method.match(/(?<=\()(.*?)(?=\))/g));    //get value in brackets
				value = parseFloat(value) - inBracket;
			} else {
				const methodUC = method.toUpperCase();
				switch (methodUC) {
					case 'UPPERCASE':
						if (typeof value == 'string') result = value.toUpperCase();
						break;
					case 'LOWERCASE':
						if (typeof value == 'string') result = value.toLowerCase();
						break;
					case 'UCFIRST':
						if (typeof value == 'string') result = value.substring(0, 1).toUpperCase() + value.substring(1).toLowerCase();
						break;
					default:
						result = value;
				}
			}
			if (!result) return value;
			return result;
		} catch (error) {
			this.errorHandler(`[modify]`, error);
			return value;
		}
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			// this.log.debug(JSON.stringify(clientDetails));

			// Set all online states to false
			for (const device in clientDetails) {

				// Ensure all known online states are set to false
				if (clientDetails[device].mac != null) {
					const deviceName = this.replaceAll(clientDetails[device].mac, `:`, ``);
					if (clientDetails[device].connectStatus !== 'newly discovered') this.setState(`${deviceName}.info._online`, {val: false, ack: true});
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
				if (resetTimers[timer]) resetTimers[timer] = clearTimeout(resetTimers[timer]);
			}

			try {
				if (dashboardProcess) {
					dashboardProcess.kill('SIGTERM', {
						forceKillAfterTimeout: 2000
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
	 * @param {string} ipAddress
	 */
	// eslint-disable-next-line no-case-declarations,no-inner-declarations
	validateIPAddress(ipAddress) {
		return /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(ipAddress);
	}

	/**
	 * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
	 * Using this method requires "common.message" property to be set to true in io-package.json
	 * @param {ioBroker.Message} obj
	 */
	async onMessage(obj) {
		this.log.debug('Data from configuration received : ' + JSON.stringify(obj));
		try {

			switch (obj.command) {

				//ToDo previous add function to be removed
				case 'addDevice':

					// eslint-disable-next-line no-case-declarations
					const ipValid = this.validateIPAddress(obj.message['device-ip']);
					if (!ipValid) {
						this.log.warn(`You entered an incorrect IP-Address ${obj.message['device-ip']}, cannot add device !`);

						const massageObj = {
							'type': 'error',
							'message': 'connection failed'
						};
						// @ts-ignore
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
								'MACAddress' : clientDetails[device].mac,
								'deviceName' : clientDetails[device].deviceFriendlyName,
								'ip' : clientDetails[device].ip,
								'connectState' : clientDetails[device].connectStatus
							});
						}

						//Create table for newlyDiscovered Devices

						for (const device in newlyDiscoveredClient) {
							discoveredDeviceTable.push({
								'MACAddress' : newlyDiscoveredClient[device].mac,
								'deviceName' : newlyDiscoveredClient[device].deviceFriendlyName,
								'ip' : newlyDiscoveredClient[device].ip,
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
							dropDownEntry.push({label: device, value: clientDetails[device].ip});
						}

						for (const device in newlyDiscoveredClient) {
							dropDownEntry.push({label: device, value: newlyDiscoveredClient[device].ip});
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
								if (this.validateIPAddress(hostIP.common.address[ip])) ip4List.push({label: hostIP.common.address[ip], value: hostIP.common.address[ip]});
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
					if (obj.message.ip === 'undefined'){
						this.sendTo(obj.from, obj.command,
							{error: 'To add/modify a device, please enter the IP-Address accordingly'},
							obj.callback);
						return;
					} else if (!this.validateIPAddress(obj.message.ip)){
						this.sendTo(obj.from, obj.command,
							{error: 'Format of IP-Address is incorrect, please provide an valid IPV4 IP-Address'},
							obj.callback);
						return;
					}

					// eslint-disable-next-line no-case-declarations
					const initiateNDevice = async () => {
						const encryptionKeyUsed = !!(obj.message.encryptionKey && obj.message.encryptionKey !== 'undefined');
						clientDetails[obj.message.ip] = new clientDevice();
						clientDetails[obj.message.ip].storeConnectDetails(obj.message.ip, encryptionKeyUsed, this.encrypt(obj.message.apiPassword), encryptionKeyUsed ? this.encrypt(obj.message.encryptionKey) : null);
						this.messageResponse[obj.message.ip] = obj;
						delete newlyDiscoveredClient[obj.message.ip];
						this.connectDevices(obj.message.ip);
					};

					// Store client details in memory and try to connect
					if (!clientDetails[obj.message.ip]){
						// Device is unknown, created memory space
						await initiateNDevice();
					} else {
						// Device is known, update encryptionKey or apiPass
						// Ensure all existing connections are closed, will trigger disconnect event to clean-up memory attributes
						try {
							// if (clientDetails[obj.message.ip].connected) clientDetails[obj.message.ip].client.disconnect();
							clientDetails[obj.message.ip].client.disconnect();
						} catch (e) {
							// There was no connection in memory
						}
						// Clean memory data and init device again with a little delay

						if (resetTimers[obj.message.ip]) resetTimers[obj.message.ip] = clearTimeout(resetTimers[obj.message.ip]);
						resetTimers[obj.message.ip] = setTimeout(async () => {
							delete clientDetails[obj.message.ip];
							await initiateNDevice();
						}, (2000));
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
							await this.delObjectAsync(clientDetails[obj.message.ip].deviceName, {recursive: true});
						} catch (e) {
							// Deleting device channel failed
						}

						// Clean memory data
						delete clientDetails[obj.message.ip];

						// Send confirmation to frontend
						this.sendTo(this.messageResponse[obj.message.ip].from, this.messageResponse[obj.message.ip].command,
							{result: 'OK - Device successfully removed'},
							this.messageResponse[obj.message.ip].callback);
						delete this.messageResponse[obj.message.ip];
					} else {
						this.sendTo(obj.from, obj.command,
							{error: 'Provided IP-Address unknown, please refresh table and enter an valid IP-Address'},
							obj.callback);
						return;
					}

					// this.sendTo(obj.from, obj.command, 1, obj.callback);
					break;
			}
		} catch (error) {
			this.errorHandler(`[onMessage]`, error);
		}
	}

	/**
	 * responds to the adapter that sent the original message
	 * @param {string} response
	 * @param {object} obj
	 */
	respond(response, obj) {
		if (obj.callback)
			this.sendTo(obj.from, obj.command, response, obj.callback);
	}

	hexToRgb(hex) {
		const shorthandRegex = /^#?([a-f\d])([a-f\d])([a-f\d])$/i;
		hex = hex.replace(shorthandRegex, function (m, r, g, b) {
			return r + r + g + g + b + b;
		});

		const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
		return result ? {
			red: parseInt(result[1], 16),
			green: parseInt(result[2], 16),
			blue: parseInt(result[3], 16)
		} : null;
	}

	rgbToHex(r, g, b) {
		function componentToHex(color) {
			const hex = color.toString(16);
			return hex.length === 1 ? '0' + hex : hex;
		}
		return '#' + componentToHex(r) + componentToHex(g) + componentToHex(b);
	}

	/**
	 * Is called if a subscribed state changes
	 * @param {string} id
	 * @param {ioBroker.State | null | undefined} state
	 */
	async onStateChange(id, state) {
		try {
			if (state && state.ack === false) {
				const device = id.split('.');

				try {
					// Verify if trigger is related to device-cleanup
					if (id.split('.')[3] === 'deviceCleanup'){
						await this.offlineDeviceCleanup();
						return;
					}
				} catch (e) {
					// Skip action
				}

				const deviceIP = this.deviceStateRelation[device[2]].ip;

				// Handle Switch State
				if (clientDetails[deviceIP][device[4]].type === `Switch`
					|| clientDetails[deviceIP][device[4]].type === `Fan`) {
					await clientDetails[deviceIP].client.connection.switchCommandService({key: device[4], state: state.val});

					// Handle Climate State
				} else if (clientDetails[deviceIP][device[4]].type === `Climate`) {
					clientDetails[deviceIP][device[4]].states[device[5]] = state.val;
					await clientDetails[deviceIP].client.connection.climateCommandService(clientDetails[deviceIP][device[4]].states);

					// Handle Number State
				} else if (clientDetails[deviceIP][device[4]].type === `Number`) {
					await clientDetails[deviceIP].client.connection.numberCommandService({key: device[4], state: state.val});

					// Handle Button State
				} else if (clientDetails[deviceIP][device[4]].type === `Button`) {
					await clientDetails[deviceIP].client.connection.buttonCommandService({key: device[4]});

					// Handle Select State
				} else if (clientDetails[deviceIP][device[4]].type === `Select`) {
					await clientDetails[deviceIP].client.connection.selectCommandService({key: device[4], state: state.val});

					// Handle Cover Position
				} else if (device[5] === `position`) {
					// clientDetails[deviceIP][device[4]].states[device[5]] = state.val;
					await clientDetails[deviceIP].client.connection.climateCommandService({'key': device[4], 'position': state.val});

					// Handle Cover Tilt
				} else if (device[5] === `tilt`) {
					// clientDetails[deviceIP][device[4]].states[device[5]] = state.val;
					await clientDetails[deviceIP].client.connection.climateCommandService({'key': device[4], 'tilt': state.val});

					// Handle Cover Stop
				} else if (device[5] === `stop`) {
					// clientDetails[deviceIP][device[4]].states[device[5]] = state.val;
					await clientDetails[deviceIP].client.connection.climateCommandService({'key': device[4], 'stop': true});

				} else if (clientDetails[deviceIP][device[4]].type === `Light`) {
					let writeValue = state.val;
					// Add unit to temperature states
					if (device[5] === `brightness`
						|| device[5] === `blue`
						|| device[5] === `green`
						|| device[5] === `red`
						|| device[5] === `white`
						|| device[5] === `colorTemperature`) {

						// Convert value to 255 range
						writeValue = (writeValue / 100) / 2.55;

						// Store value to memory
						clientDetails[deviceIP][device[4]].states[device[5]] = writeValue;

					} else if (device[5] === `colorHEX`) {

						// Convert hex to rgb
						const rgbConversion = this.hexToRgb(writeValue);
						if (!rgbConversion) return;
						clientDetails[deviceIP][device[4]].states.red = (rgbConversion.red / 100) / 2.55;
						clientDetails[deviceIP][device[4]].states.blue = (rgbConversion.blue / 100) / 2.55;
						clientDetails[deviceIP][device[4]].states.green = (rgbConversion.green / 100) / 2.55;

					} else if (device[5] === `transitionLength`) {

						clientDetails[deviceIP][device[4]].states[device[5]] = writeValue;

					} else if (device[5] === 'effect') {

						clientDetails[deviceIP][device[4]].states.effect = writeValue;

					} else if (device[5] === 'state') {

						clientDetails[deviceIP][device[4]].states.state = writeValue;

					}

					const data = {
						key: clientDetails[deviceIP][device[4]].states.key,
						state: clientDetails[deviceIP][device[4]].states.state,
						transitionLength: clientDetails[deviceIP][device[4]].states.transitionLength
					};
					if (clientDetails[deviceIP][device[4]].config.legacySupportsBrightness === true) {
						data.brightness = clientDetails[deviceIP][device[4]].states.brightness;
					}
					if (clientDetails[deviceIP][device[4]].config.legacySupportsRgb === true) {
						data.red = clientDetails[deviceIP][device[4]].states.red;
						data.green = clientDetails[deviceIP][device[4]].states.green;
						data.blue = clientDetails[deviceIP][device[4]].states.blue;
					}
					if (clientDetails[deviceIP][device[4]].config.legacySupportsWhiteValue === true) {
						data.white = clientDetails[deviceIP][device[4]].states.white;
					}
					if (clientDetails[deviceIP][device[4]].config.legacySupportsColorTemperature === true) {
						data.colorTemperature = clientDetails[deviceIP][device[4]].states.colorTemperature;
					}
					const effect = clientDetails[deviceIP][device[4]].states.effect;
					if (effect !== '' && effect !== null && effect !== undefined) {
						data.effect = effect;
					}

					this.log.debug(`Send Light values ${JSON.stringify(data)}`);
					await clientDetails[deviceIP].client.connection.lightCommandService(data);
				}
			}
		} catch (e) {
			this.log.error(`[onStateChange] ${e}`);
		}
	}

	/**
	 * Some types (like Button) don't have a state. So standard method of creating iobroker objects when receiving state event via api doesn't work here
	 * @returns {Promise<void>}
	 */
	async createNonStateDevices(host, entity) {
		switch (clientDetails[host][entity.id].type) {
			case 'Button': {
				await this.stateSetCreate(`${clientDetails[host].deviceName}.${entity.type}.${entity.id}.SET`, `Button`, false, '', true);
				break;
			}
		}
	}

	async resetOnlineStates(){
		try {
			// Set parameters for object view to only include objects within adapter namespace
			const params = {
				startkey : `${this.namespace}.`,
				endkey : `${this.namespace}.\u9999`,
			};

			// Get all current devices in an adapter tree
			const _devices = await this.getObjectViewAsync('system', 'device', params);
			// List all found devices & set online state to false
			for (const currDevice in _devices.rows) {

				// Extend online state to device (to ensure migration of version < 0.3.1
				await this.extendObjectAsync(_devices.rows[currDevice].id, {
					common: {
						statusStates: {
							onlineId: `${_devices.rows[currDevice].id}.info._online`
						}
					},
				});

				// Set online state to false, will be set to true at successfully connected
				await this.stateSetCreate(`${_devices.rows[currDevice].id}.info._online`, `Online state`, false);
			}
		} catch (error) {
			this.errorHandler(`[resetOnlineStates]`, error);
		}
	}

	async objectCleanup(ip){
		try {
			this.log.debug(`[objectCleanup] Starting channel and state cleanup for ${clientDetails[ip].deviceFriendlyName} | ${ip}`);

			// Cancel cleanup operation in case device is not connected anymore or already deleted
			if (clientDetails[ip] && (clientDetails[ip].connectionError || !clientDetails[ip].connected)) return;

			// Set parameters for object view to only include objects within adapter namespace
			const params = {
				startkey : `${this.namespace}.${clientDetails[ip].deviceName}.`,
				endkey : `${this.namespace}.\u9999`,
			};

			// Get all current channels
			const _channels = await this.getObjectViewAsync('system', 'channel', params);
			// List all found channels & compare with memory, delete unneeded channels
			for (const currDevice in _channels.rows) {
				// @ts-ignore
				if (!clientDetails[ip].adapterObjects.channels.includes(_channels.rows[currDevice].id)
					&& _channels.rows[currDevice].id.split('.')[2] === clientDetails[ip].deviceName){
					this.log.debug(`[objectCleanup] Unknown Channel found, delete ${_channels.rows[currDevice].id}`);
					await this.delObjectAsync(_channels.rows[currDevice].id, {recursive: true});
				}
			}

			// Get all current states in adapter tree
			const _states = await this.getObjectViewAsync('system', 'state', params);
			// List all found states & compare with memory, delete unneeded states
			for (const currDevice in _states.rows) {
				if (!this.createdStatesDetails[_states.rows[currDevice].id.replace(`esphome.0.`, ``)]
					&& _states.rows[currDevice].id.split('.')[2] === clientDetails[ip].deviceName){
					this.log.debug(`[objectCleanup] Unknown State found, delete ${_states.rows[currDevice].id}`);
					// await this.delObjectAsync(_states.rows[currDevice].id);
				}
			}
		} catch (error) {
			this.errorHandler(`[objectCleanup]`, error);
		}
	}

	async offlineDeviceCleanup () {

		this.log.info(`Offline Device cleanup started`);

		try {
			// Get an overview of all current devices known by adapter
			const knownDevices = await this.getDevicesAsync();
			// console.log(`KnownDevices: ${knownDevices}`);
			// Loop to all devices, check if online state = TRUE otherwise delete device
			for (const device in knownDevices){
				// Get online value
				const online = await this.getStateAsync(`${knownDevices[device]._id}.info._online`);
				if (!online || !online.val){
					this.log.info(`Offline device ${knownDevices[device]._id.split('.')[2]} expected on ip ${knownDevices[device].native.ip} removed`);
					await this.delObjectAsync(knownDevices[device]._id, {recursive: true});
				}
			}
			if (!knownDevices) return; // exit function if no known device are detected
			if (knownDevices.length > 0) this.log.info(`Try to contact ${knownDevices.length} known devices`);
		} catch (error) {
			this.errorHandler(`[offlineDeviceCleanup]`, error);
		}
	}

	/**
	 * Generic function to properly update memory connection details of a device in all scenarios
	 * @param {string} host IP-Address of device
	 * @param {boolean} connected Indicator if a device is connected
	 * @param {boolean} connecting Indicator if a device is initializing
	 * @param {string} [connectionStatus] Connection status shown in Adapter instance / Device Manager
	 * @param {boolean} [connectionError] Indicator if a connection error (like incorrect password or timeout) is present
	 * @return void
	 */
	async updateConnectionStatus(host, connected, connecting, connectionStatus, connectionError){
		try {
			// Cancel operation if host is unknown
			if (!clientDetails[host]) return;
			clientDetails[host].connected = connected;
			clientDetails[host].connecting = connecting;
			clientDetails[host].connectionError = connectionError != null ? connectionError : clientDetails[host].connectionError;
			clientDetails[host].connectStatus = connectionStatus != null ? connectionStatus : clientDetails[host].connectStatus;

			// Only handle online state if a device was initialized
			if (clientDetails[host].connectStatus === 'Initialisation needed') return;

			// Update device connection indicator
			if (!connected || connectionError || connecting) {
				// Device not connected or initializing, set _online state to false
				await this.stateSetCreate(`${clientDetails[host].deviceName}.info._online`, `Online state`, false);
			} else {
				// Device connected, set _online state to true
				await this.stateSetCreate(`${clientDetails[host].deviceName}.info._online`, `Online state`, true);
			}
			// Write connection status to info channel
			if (clientDetails[host].connected) await this.stateSetCreate(`${clientDetails[host].deviceName}.info._connectionStatus`, `Connection status`, connectionStatus);
		} catch (error) {
			this.errorHandler(`[updateConnectionStatus]`, error);
		}
	}
}

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	module.exports = (options) => new Esphome(options);
} else {
	// otherwise start the instance directly
	new Esphome();
}
//# sourceMappingURL=main.js.map