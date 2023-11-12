'use strict';

/*
 * Created with @iobroker/create-adapter v1.31.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
// @ts-ignore Client is just missing in index.d.ts file
const {Client, Discovery} = require('@2colors/esphome-native-api');
let discovery;
const stateAttr = require(__dirname + '/lib/stateAttr.js'); // Load attribute library
const disableSentry = false; // Ensure to set to true during development!
const warnMessages = {}; // Store warn messages to avoid multiple sending to sentry
const fs = require('fs');
const client = {};
let reconnectTimer, reconnectInterval, apiPass, autodiscovery, dashboardProcess, createConfigStates;

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

		this.deviceInfo = {}; // Memory array of initiated objects
		this.deviceStateRelation = {}; // Memory array of initiated device by Device Identifier (name) and IP
		this.createdStatesDetails = {}; // Array to store information of created states
		this.messageResponse = {}; // Array to store messages from admin and provide proper message to add/remove devices
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		await this.setStateAsync('info.connection', {val: true, ack: true});
		try {
			apiPass = this.config.apiPass;
			autodiscovery = this.config.autodiscovery;
			reconnectInterval = this.config.reconnectInterval * 1000;
			createConfigStates = this.config.configStates;

			// Ensure all online states are set to false during adapter start
			await this.resetOnlineStates();

			// Try connecting to already known devices
			await this.tryKnownDevices();

			// Start MDNS discovery when enabled
			if (autodiscovery) {
				this.deviceDiscovery(); // Start MDNS autodiscovery
			} else {
				this.log.warn(`Auto Discovery disabled, new devices (or IP changes) will NOT be detected automatically!`);
			}

			if (this.config.ESPHomeDashboardEnabled) {
				this.log.info(`Native Integration of ESPHome Dashboard enabled `);
				await this.espHomeDashboard();
			} else {
				this.log.info(`Native Integration of ESPHome Dashboard disabled `);
			}

		} catch (e) {
			this.log.error(`Connection issue ${e}`);
		}
	}

	async espHomeDashboard() {
		try {
			// @ts-ignore
			const {getVenv} = await import('autopy');

			const config = require(__dirname + '/package.json').iobroker_esphome_adapter;

			// Create a virtual environment with mitmproxy installed.
			const python = await getVenv({
				name: 'esphome',
				pythonVersion: `~${config.python_version}`,
				requirements: [{name: 'esphome', version: `==${config.dashboard_version}`}],
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
				// Directory has an issue reading/writing data, iob fix should be executed
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
					console.debug(`[espHomeDashboard] Unknown logging data : ${JSON.stringify(data)}`);
				}
			});

			dashboardProcess.on('message', (code, signal) => {
				this.log.info(`[dashboardProcess MESSAGE] Exit code is: ${code} | ${signal}`);
			});

			// eslint-disable-next-line no-unused-vars
			dashboardProcess.on('exit', (code, signal) => {
				this.log.warn(`ESPHome Dashboard deactivated`);
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
		} catch (e) {
			this.log.error(`[espHomeDashboard] ${e}`);
		}
	}

	// Try to contact and read data of already known devices
	async tryKnownDevices() {
		try {
			const knownDevices = await this.getDevicesAsync();
			if (!knownDevices) return;

			// Get basic data of known devices and start reading data
			for (const i in knownDevices) {
				this.deviceInfo[knownDevices[i].native.ip] = {
					ip: knownDevices[i].native.ip,
					passWord: this.decrypt(knownDevices[i].native.passWord),
				};
				this.connectDevices(knownDevices[i].native.ip, this.deviceInfo[knownDevices[i].native.ip].passWord);
			}
		} catch (e) {
			this.sendSentry(`[tryKnownDevices] ${e}`);
		}
	}

	// MDNS discovery handler for ESPHome devices
	deviceDiscovery() {
		try {

			this.log.info(`Auto Discovery startet, new devices (or IP changes) will be detected automatically`);
			discovery = new Discovery();

			discovery.on('info', async (message) => {
				try {
					this.log.debug(`Discovery message ${JSON.stringify(message)}`);
					if (this.deviceInfo[message.address] == null) {
						this.log.info(`[AutoDiscovery] New ESPHome device found at IP ${message.address}`);
						// Store new Device information to device array in memory
						this.deviceInfo[message.address] = {
							ip: message.address,
							passWord: apiPass
						};
						this.connectDevices(`${message.address}`, `${apiPass}`);
					}
				} catch (e) {
					this.log.error(`[deviceDiscovery handler] ${e}`);
				}
			});
			discovery.run();
		} catch (e) {
			this.sendSentry(`[deviceDiscovery] ${e}`);
		}
	}

	/**
	 * Handle Socket connections
	 * @param {string} host IP adress of device
	 * @param {string | number | boolean} pass Password used for APU
	 */
	connectDevices(host, pass) {
		try {
			// const host = espDevices[device].ip;
			this.log.info(`Try to connect to ${host}`);
			// Prepare connection attributes
			client[host] = new Client({
				host: host,
				password: pass,
				clientInfo: `${this.host}`,
				clearSession: true,
				initializeDeviceInfo: true,
				initializeListEntities: true,
				initializeSubscribeStates: false,
				// initializeSubscribeLogs: false, //ToDo: Make configurable by adapter settings
				reconnect: true,
				reconnectInterval: reconnectInterval,
				pingInterval: 15000, //ToDo: Make configurable by adapter settings
				pingAttempts: 3
				// port: espDevices[device].port //ToDo: Make configurable by adapter settings
			});

			// Connection listener
			client[host].on('connected', async () => {
				try {
					this.log.info(`ESPHome client ${host} connected`);
					// Clear possible present warn messages for device from previous connection
					delete warnMessages[host];
				} catch (e) {
					this.log.error(`connection error ${e}`);
				}
			});

			client[host].on('disconnected', () => {
				try {
					if (this.deviceInfo[host].deviceName != null) {
						this.setState(`${this.deviceInfo[host].deviceName}.info._online`, {val: false, ack: true});
						this.log.warn(`ESPHome  client  ${this.deviceInfo[host].deviceInfo.name} disconnected`);
					} else {
						this.log.warn(`ESPHome  client  ${host} disconnected`);
					}
				} catch (e) {
					this.log.debug(`ESPHome disconnect error : ${e}`);
				}
			});

			client[host].on('initialized', () => {
				this.log.info(`ESPHome  client ${this.deviceInfo[host].deviceInfo.name} on ip ${host} initialized`);
			});

			client[host].on('logs', (/** @type {object} */ messageObj) => {
				this.log.debug(`ESPHome client log : ${JSON.stringify(messageObj)}`);
			});

			// Log message listener
			client[host].connection.on('message', (/** @type {object} */ message) => {
				this.log.debug(`${host} client log ${message}`);
			});

			client[host].connection.on('data', (/** @type {object} */ data) => {
				this.log.debug(`${host} client data ${data}`);
			});

			// Handle device information when connected or information updated
			client[host].on('deviceInfo', async (/** @type {object} */ deviceInfo) => {
				try {
					this.log.info(`ESPHome Device info received for ${deviceInfo.name}`);
					this.log.debug(`DeviceData: ${JSON.stringify(deviceInfo)}`);

					// Store device information into memory
					const deviceName = this.replaceAll(deviceInfo.macAddress, `:`, ``);
					this.deviceInfo[host] = {
						ip: host,
						mac: deviceInfo.macAddress,
						deviceInfo: deviceInfo,
						deviceName: deviceName,
						deviceInfoName: deviceInfo.name,
						passWord: pass,
					};

					// Store MAC & IP relation
					this.deviceStateRelation[deviceName] = {'ip': host};

					this.log.debug(`DeviceInfo ${this.deviceInfo[host].deviceInfo.name}: ${JSON.stringify(this.deviceInfo)}`);

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
							name: this.deviceInfo[host].deviceInfoName,
							mac: deviceInfo.macAddress,
							deviceName: deviceName,
							passWord: this.encrypt(pass),
						},
					});

					// Read JSON and handle states
					await this.TraverseJson(deviceInfo, `${deviceName}.info`);

					// Create connection indicator at device info channel
					await this.stateSetCreate(`${deviceName}.info._online`, `Online state`, true);

					// Check if device connection is caused by adding  device from admin, if yes send OK message
					if (this.messageResponse[host]) {
						const massageObj = {
							'type': 'info',
							'message': 'success'
						};
						// @ts-ignore
						this.respond(massageObj, this.messageResponse[host]);
						this.messageResponse[host] = null;
					}

				} catch (e) {
					this.log.error(`deviceInfo ${host} ${e}`);
				}
			});

			// Initialise data for states
			client[host].on('newEntity', async entity => {
				this.log.debug(`EntityData: ${JSON.stringify(entity.config)}`);
				try {
					// Store relevant information into memory object
					this.deviceInfo[host][entity.id] = {
						config: entity.config,
						name: entity.name,
						type: entity.type,
						unit: entity.config.unitOfMeasurement !== undefined ? entity.config.unitOfMeasurement || '' : ''
					};


					if (this.deviceInfo[host][entity.id].config.deviceClass) {
						this.log.info(`${this.deviceInfo[host].deviceInfo.name} announced ${this.deviceInfo[host][entity.id].config.deviceClass} "${this.deviceInfo[host][entity.id].config.name}"`);
					} else {
						this.log.info(`${this.deviceInfo[host].deviceInfo.name} announced ${this.deviceInfo[host][entity.id].type} "${this.deviceInfo[host][entity.id].config.name}"`);
					}

					// Create Device main structure
					await this.extendObjectAsync(`${this.deviceInfo[host].deviceName}.${entity.type}`, {
						type: 'channel',
						common: {
							name: entity.type,
						},
						native: {},
					});

					// Create state specific channel by id
					await this.extendObjectAsync(`${this.deviceInfo[host].deviceName}.${entity.type}.${entity.id}`, {
						type: 'channel',
						common: {
							name: entity.config.name
						},
						native: {},
					});

					//Check if config channel should be created
					if (!createConfigStates) {
						// Delete folder structure if already present
						try {
							const obj = await this.getObjectAsync(`${this.deviceInfo[host].deviceName}.${entity.type}.${entity.id}.config`);
							if (obj) {
								await this.delObjectAsync(`${this.deviceInfo[host].deviceName}.${entity.type}.${entity.id}.config`, {recursive: true});
							}
						} catch (error) {
							// do nothing
						}
					} else {
						// Create config channel
						await this.extendObjectAsync(`${this.deviceInfo[host].deviceName}.${entity.type}.${entity.id}.config`, {
							type: 'channel',
							common: {
								name: 'Configuration data'
							},
							native: {},
						});
						// Handle Entity JSON structure and write related config channel data
						await this.TraverseJson(entity.config, `${this.deviceInfo[host].deviceName}.${entity.type}.${entity.id}.config`);
					}

					await this.createNonStateDevices(host, entity);

					// Request current state values
					await client[host].connection.subscribeStatesService();
					this.log.debug(`[DeviceInfoData] ${this.deviceInfo[host].deviceInfo.name} ${JSON.stringify(this.deviceInfo[host])}`);

					// Listen to state changes an write values to states (create state if not yet exists)
					entity.on(`state`, async (/** @type {object} */ state) => {
						this.log.debug(`StateData: ${JSON.stringify(state)}`);
						try {
							this.log.debug(`[entityStateConfig] ${JSON.stringify(this.deviceInfo[host][entity.id])}`);
							this.log.debug(`[entityStateData] ${JSON.stringify(state)}`);
							const deviceDetails = `DeviceType ${this.deviceInfo[host][entity.id].type} | State-Keys ${JSON.stringify(state)} | [entityStateConfig] ${JSON.stringify(this.deviceInfo[host][entity.id])}`;

							// Ensure proper initialisation of the state
							switch (this.deviceInfo[host][entity.id].type) {
								case 'BinarySensor':
									await this.handleRegularState(`${host}`, entity, state, false);
									break;

								case 'Climate':
									await this.handleStateArrays(`${host}`, entity, state);
									break;

								case 'Cover':
									await this.stateSetCreate(`${this.deviceInfo[host].deviceName}.${entity.type}.${entity.id}.position`, `Position`, 0, `%`, true);
									await this.stateSetCreate(`${this.deviceInfo[host].deviceName}.${entity.type}.${entity.id}.tilt`, `Tilt`, 0, `%`, true);
									await this.stateSetCreate(`${this.deviceInfo[host].deviceName}.${entity.type}.${entity.id}.stop`, `Stop`, false, ``, true);
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

									if (!warnMessages[this.deviceInfo[host][entity.id].type]) {
										this.log.warn(`DeviceType ${this.deviceInfo[host][entity.id].type} not yet supported`);
										this.log.warn(`Please submit git issue with all information from next line`);
										this.log.warn(`DeviceType ${this.deviceInfo[host][entity.id].type} | State-Keys ${JSON.stringify(state)} | [entityStateConfig] ${JSON.stringify(this.deviceInfo[host][entity.id])}`);
										warnMessages[this.deviceInfo[host][entity.id].type] = deviceDetails;
									}
							}

						} catch (e) {
							this.log.error(`State handle error ${e}`);
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
					this.log.error(`Connection issue for ${entity.name} ${e}`);
				}

			});

			// Connection data handler
			client[host].on('error', (error) => {
				try {
					let optimisedError = error.message;
					// Optimise error messages
					if (error.message.includes('EHOSTUNREACH')) {
						optimisedError = `Client ${this.deviceInfo[host].ip} not reachable !`;
						if (!warnMessages[host].connectError) {
							this.log.error(optimisedError);
							warnMessages[host].connectError = true;
						}
					} else if (error.message.includes('Invalid password')) {
						optimisedError = `Client ${host} incorrect password !`;
						this.log.error(optimisedError);
					} else if (error.message.includes('ECONNRESET')) {
						optimisedError = `Client ${this.deviceInfo[host].ip} Connection Lost, will reconnect automatically when device is available!`;
						this.log.warn(optimisedError);
					} else if (error.message.includes('timeout')) {
						optimisedError = `Client ${host} Timeout, connection Lost, will reconnect automatically when device is available!`;
						this.log.warn(optimisedError);
					} else if (error.message.includes('write after end')) {
						// Ignore error
					} else {
						this.log.error(`ESPHome client ${host} ${error}`);
					}

					// Check if device connection is caused by adding  device from admin, if yes send OK message
					if (this.messageResponse[host]) {

						const massageObj = {
							'type': 'error',
							'message': optimisedError
						};
						// @ts-ignore
						this.respond(massageObj, this.messageResponse[host]);
						this.messageResponse[host] = null;
					}

				} catch (e) {
					this.log.error(`ESPHome error handling issue ${host} ${e}`);
				}
			});

			//ToDo: Review
			// connect to socket
			try {
				this.log.debug(`trying to connect to ${host}`);
				// Reserve memory for warn messages
				warnMessages[host] = {
					connectError: false
				};
				client[host].connect();
			} catch (e) {
				this.log.error(`Client ${host} connect error ${e}`);
			}

		} catch (e) {
			this.log.error(`ESP device error for ${host}`);
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
		// Round value to digits as known by configuration
		let stateVal = state.state;

		if (this.deviceInfo[host][entity.id].config.accuracyDecimals != null) {
			const rounding = `round(${this.deviceInfo[host][entity.id].config.accuracyDecimals})`;
			this.log.debug(`Value "${stateVal}" for name "${entity}" before function modify with method "round(${this.deviceInfo[host][entity.id].config.accuracyDecimals})"`);
			stateVal = this.modify(rounding, stateVal);
			this.log.debug(`Value "${stateVal}" for name "${entity}" after function modify with method "${rounding}"`);
		}


		/** @type {ioBroker.StateCommon} */
		const stateCommon = {
		};

		if(entity.config.optionsList != null) {
			stateCommon.states = entity.config.optionsList;
		}

		await this.stateSetCreate(`${this.deviceInfo[host].deviceName}.${entity.type}.${entity.id}.state`, `State of ${entity.config.name}`, stateVal, this.deviceInfo[host][entity.id].unit, writable, stateCommon);
	}

	/**
	 * Handle state values
	 * @param {string} host IP-Address of client
	 * @param {object} entity Entity-Object of value
	 * @param {object} state State-Object
	 */
	async handleStateArrays(host, entity, state) {

		this.deviceInfo[host][entity.id].states = state;

		for (const stateName in this.deviceInfo[host][entity.id].states) {
			let unit = '';
			let writable = true;
			let writeValue = state[stateName];

			// Define if state should be writable
			switch (stateName) {
				case 'currentTemperature':
					unit = `°C`;
					writable = false;
					this.deviceInfo[host][entity.id].states.currentTemperature = this.modify('round(2)', state[stateName]);
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
				if (this.deviceInfo[host][entity.id].states.transitionLength == null) {

					// Check if state already exists
					let transitionLength;
					try {

						// Try  to get current state
						transitionLength = await this.getStateAsync(`${this.deviceInfo[host].deviceName}.${entity.type}.${entity.id}.transitionLength`);

						// Check if state contains value
						if (transitionLength) {
							this.deviceInfo[host][entity.id].states.transitionLength = transitionLength.val;
						} else { // Else just create it
							await this.stateSetCreate(`${this.deviceInfo[host].deviceName}.${entity.type}.${entity.id}.transitionLength`, `${stateName} of ${entity.config.name}`, 0, `s`, writable);
							this.deviceInfo[host][entity.id].states.transitionLength = 0;
						}

					} catch (e) { // Else just create it
						await this.stateSetCreate(`${this.deviceInfo[host].deviceName}.${entity.type}.${entity.id}.transitionLength`, `${stateName} of ${entity.config.name}`, 0, `s`, writable);
						this.deviceInfo[host][entity.id].states.transitionLength = 0;
					}

				}
			}

			if (stateName !== 'key') {
				await this.stateSetCreate(`${this.deviceInfo[host].deviceName}.${entity.type}.${entity.id}.${stateName}`, `${stateName} of ${entity.config.name}`, writeValue, unit, writable);
			}
		}

		// Convert RGB to HEX an write to state
		if (this.deviceInfo[host][entity.id].states.red != null &&
			this.deviceInfo[host][entity.id].states.blue != null &&
			this.deviceInfo[host][entity.id].states.green != null) {
			const hexValue = this.rgbToHex(
				Math.round((this.deviceInfo[host][entity.id].states.red * 100) * 2.55),
				Math.round((this.deviceInfo[host][entity.id].states.green * 100) * 2.55),
				Math.round((this.deviceInfo[host][entity.id].states.blue * 100) * 2.55),
			);
			await this.stateSetCreate(`${this.deviceInfo[host].deviceName}.${entity.type}.${entity.id}.colorHEX`, `ColorHEX of ${entity.config.name}`, hexValue, '', true);
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
	async TraverseJson(jObject, parent = null, replaceName = false, replaceID = false, state_expire = 0) {
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
						console.log(`park`);
						await this.setObjectAsync(id, {
							'type': 'channel',
							'common': {
								'name': name,
							},
							'native': {},
						});
						await this.TraverseJson(jObject[i], id, replaceName, replaceID, state_expire);
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
		} catch (e) {
			this.sendSentry(`[TraverseJson] ${e}`);
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

			// Try to get details from state lib, if not use defaults. throw warning if states is not known in attribute list
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

		} catch (e) {
			this.sendSentry(`[stateSetCreate] ${e}`);
		}
	}

	/**
	 * Handles error mesages for log and Sentry
	 * @param {string} msg Error message
	 */
	sendSentry(msg) {
		try {
			if (!disableSentry) {
				this.log.info(`[Error caught and send to Sentry, thank you collaborating!] error: ${msg}`);
				if (this.supportsFeature && this.supportsFeature('PLUGINS')) {
					const sentryInstance = this.getPluginInstance('sentry');
					if (sentryInstance) {
						sentryInstance.getSentryObject().captureException(msg);
					}
				}
			} else {
				this.log.error(`Sentry disabled, error caught : ${msg}`);
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
	 * Analysis modify element in stateAttr.js and executes command
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
		} catch (e) {
			this.sendSentry(`[modify] ${e}`);
			return value;
		}
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			this.log.debug(JSON.stringify(this.deviceInfo));
			for (const device in this.deviceInfo) {

				// Ensure all known online states are set to false
				if (this.deviceInfo[device].mac != null) {
					const deviceName = this.replaceAll(this.deviceInfo[device].mac, `:`, ``);
					this.setState(`${deviceName}.info._online`, {val: false, ack: true});
				}

				try {
					client[device].disconnect();
				} catch (e) {
					this.log.debug(`[onUnload] ${JSON.stringify(e)}`);
				}
			}
			if (reconnectTimer) {
				reconnectTimer = clearTimeout();
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
		} catch (e) {
			this.log.error(`[onUnload] ${JSON.stringify(e)}`);
			callback();
		}
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
				case 'removeDevice':
					await this.deleteDeviceAsync(`${obj.message}`)
						.catch(async error => {
							if (error !== 'Not exists') {
								this.log.error(`deleteDeviceAsync has a problem: ${error.message}, stack: ${error.stack}`);
							} else {
								// do nothing
							}
						});

					break;

				case 'addDevice':

					// eslint-disable-next-line no-case-declarations,no-inner-declarations
					function validateIPaddress(ipaddress) {
						if (/^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(ipaddress)) {
							return true;
						}
						return false;
					}

					// eslint-disable-next-line no-case-declarations
					const ipValid = validateIPaddress(obj.message['device-ip']);
					if (!ipValid) {
						this.log.warn(`You entered an incorrect IP-Address, cannot add device !`);

						const massageObj = {
							'type': 'error',
							'message': 'connection failed'
						};
						// @ts-ignore
						this.respond(massageObj, obj);

					} else {
						this.log.info(`Valid IP address received`);
						this.messageResponse[obj.message['device-ip']] = obj;
						const pass = this.decrypt(obj.message['device-pass']);
						await this.connectDevices(obj.message['device-ip'], pass);
					}
					break;
			}
		} catch (e) {
			this.sendSentry(`[onMessage] ${e}`);
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
				const deviceIP = this.deviceStateRelation[device[2]].ip;

				// Handle Switch State
				if (this.deviceInfo[deviceIP][device[4]].type === `Switch`
					|| this.deviceInfo[deviceIP][device[4]].type === `Fan`) {
					await client[deviceIP].connection.switchCommandService({key: device[4], state: state.val});

					// Handle Climate State
				} else if (this.deviceInfo[deviceIP][device[4]].type === `Climate`) {
					this.deviceInfo[deviceIP][device[4]].states[device[5]] = state.val;
					await client[deviceIP].connection.climateCommandService(this.deviceInfo[deviceIP][device[4]].states);

					// Handle Number State
				} else if (this.deviceInfo[deviceIP][device[4]].type === `Number`) {
					await client[deviceIP].connection.numberCommandService({key: device[4], state: state.val});

					// Handle Button State
				} else if (this.deviceInfo[deviceIP][device[4]].type === `Button`) {
					await client[deviceIP].connection.buttonCommandService({key: device[4]});

					// Handle Select State
				} else if (this.deviceInfo[deviceIP][device[4]].type === `Select`) {
					await client[deviceIP].connection.selectCommandService({key: device[4], state: state.val});

					// Handle Cover Position
				} else if (device[5] === `position`) {
					// this.deviceInfo[deviceIP][device[4]].states[device[5]] = state.val;
					await client[deviceIP].connection.climateCommandService({'key': device[4], 'position': state.val});

					// Handle Cover Tilt
				} else if (device[5] === `tilt`) {
					// this.deviceInfo[deviceIP][device[4]].states[device[5]] = state.val;
					await client[deviceIP].connection.climateCommandService({'key': device[4], 'tilt': state.val});

					// Handle Cover Stop
				} else if (device[5] === `stop`) {
					// this.deviceInfo[deviceIP][device[4]].states[device[5]] = state.val;
					await client[deviceIP].connection.climateCommandService({'key': device[4], 'stop': true});

				} else if (this.deviceInfo[deviceIP][device[4]].type === `Light`) {
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
						this.deviceInfo[deviceIP][device[4]].states[device[5]] = writeValue;

					} else if (device[5] === `colorHEX`) {

						// Convert hex to rgb
						const rgbConversion = this.hexToRgb(writeValue);
						if (!rgbConversion) return;
						this.deviceInfo[deviceIP][device[4]].states.red = (rgbConversion.red / 100) / 2.55;
						this.deviceInfo[deviceIP][device[4]].states.blue = (rgbConversion.blue / 100) / 2.55;
						this.deviceInfo[deviceIP][device[4]].states.green = (rgbConversion.green / 100) / 2.55;

					} else if (device[5] === `transitionLength`) {

						this.deviceInfo[deviceIP][device[4]].states[device[5]] = writeValue;

					} else if (device[5] === 'effect') {

						this.deviceInfo[deviceIP][device[4]].states.effect = writeValue;

					} else if (device[5] === 'state') {

						this.deviceInfo[deviceIP][device[4]].states.state = writeValue;

					}

					const data = {
						key: this.deviceInfo[deviceIP][device[4]].states.key,
						state: this.deviceInfo[deviceIP][device[4]].states.state,
						transitionLength: this.deviceInfo[deviceIP][device[4]].states.transitionLength
					};
					if (this.deviceInfo[deviceIP][device[4]].config.supportsBrightness === true) {
						data.brightness = this.deviceInfo[deviceIP][device[4]].states.brightness;
					}
					if (this.deviceInfo[deviceIP][device[4]].config.supportsRgb === true) {
						data.red = this.deviceInfo[deviceIP][device[4]].states.red;
						data.green = this.deviceInfo[deviceIP][device[4]].states.green;
						data.blue = this.deviceInfo[deviceIP][device[4]].states.blue;
					}
					if (this.deviceInfo[deviceIP][device[4]].config.supportsWhiteValue === true) {
						data.white = this.deviceInfo[deviceIP][device[4]].states.white;
					}
					if (this.deviceInfo[deviceIP][device[4]].config.supportsColorTemperature === true) {
						data.colorTemperature = this.deviceInfo[deviceIP][device[4]].states.colorTemperature;
					}
					const effect = this.deviceInfo[deviceIP][device[4]].states.effect;
					if (effect !== '' && effect !== null && effect !== undefined) {
						data.effect = effect;
					}

					this.log.debug(`Send Light values ${JSON.stringify(data)}`);
					await client[deviceIP].connection.lightCommandService(data);
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
		switch (this.deviceInfo[host][entity.id].type) {
			case 'Button': {
				await this.stateSetCreate(`${this.deviceInfo[host].deviceName}.${entity.type}.${entity.id}.SET`, `Button`, false, '', true);
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

			// Get all current devices in adapter tree
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
				this.setState(`${_devices.rows[currDevice].id}.info._online`, {val: false, ack: true});
			}

		} catch (e) {
			this.log.error(`[resetOnlineState] ${e}`);
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
