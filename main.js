'use strict';

/*
 * Created with @iobroker/create-adapter v1.31.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const { Client } = require('esphome-native-api');
const { Discovery } = require('esphome-native-api');
let discovery;
const stateAttr = require(__dirname + '/lib/stateAttr.js'); // Load attribute library
const disableSentry = true; // Ensure to set to true during development!
const warnMessages = {}; // Store warn messages to avoid multiple sending to sentry
const client = {};
let reconnectTimer, reconnectInterval, apiPass, autodiscovery;

// Load your modules here, e.g.:
// const fs = require("fs");

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

		this.deviceInfo  = {}; // Memory array of initiated objects
		this.deviceStateRelation  = {}; // Memory array of initiated device by Device Identifier (name) and IP
		this.createdStatesDetails = {}; // Array to store information of created states
		this.messageResponse = {}; // Array to store messages from admin and provide proper message to add/remove devices
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		await this.setStateAsync('info.connection', {val: true, ack: true});
		try {
			apiPass =  this.config.apiPass;
			autodiscovery =  this.config.autodiscovery;
			reconnectInterval = this.config.reconnectInterval * 1000;

			// Start MDNS discovery when enabled
			if (autodiscovery){
				this.deviceDiscovery(); // Start MDNS autodiscovery
			} else {
				this.log.warn(`Auto Discovery disabled, new devices (or IP changes) will NOT be detected automatically!`);
			}

			await this.tryKnownDevices(); // Try to establish connection to already known devices


		} catch (e) {
			this.log.error(`Connection issue ${e}`);
		}
	}

	// MDNS discovery handler for ESPHome devices
	deviceDiscovery(){
		try {

			this.log.info(`Auto Discovery startet, new devices (or IP changes) will be detected automatically`);
			discovery = new Discovery();

			discovery.on('info', async (message) => {
				try {
					this.log.debug(`Discovery message ${JSON.stringify(message)}`);
					if (this.deviceInfo[message.address] == null){
						this.log.info(`[AutoDiscovery] New ESPHome device found at IP ${message.address}`);
						// Store new Device information to device array in memory
						this.deviceInfo[message.address] = {
							ip: message.address,
							passWord: apiPass
						};
						this.connectDevices(`${message.address}`,`${apiPass}`);
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

	// Try to contact to contact and read data of already known devices
	async tryKnownDevices() {
		try {
			const knownDevices = await this.getDevicesAsync();
			if (!knownDevices) return;

			// Get basic data of known devices and start reading data
			for (const i in knownDevices) {
				this.deviceInfo[knownDevices[i].native.ip] = {
					ip: knownDevices[i].native.ip,
					mac: knownDevices[i].native.mac,
					deviceName: knownDevices[i].native.deviceName,
					deviceInfoName: knownDevices[i].native.name,
					passWord: knownDevices[i].native.passWord,
				};
				this.connectDevices(knownDevices[i].native.ip, knownDevices[i].native.passWord);
			}
		} catch (e) {
			this.sendSentry(`[tryKnownDevices] ${e}`);
		}

	}

	// Handle Socket connections
	connectDevices(host, pass){

		try {
			// const host = espDevices[device].ip;
			this.log.info(`Try to connect to ${host}`);
			// Prepare connection attributes
			client[host] = new Client({
				host: host,
				password : this.decrypt(pass),
				clientInfo : `${this.host}`,
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
					// Clear possible present warn messages for device fromm previous connection
					warnMessages[host] = {
						connectError : false
					};
				} catch (e) {
					this.log.error(`connection error ${e}`);
				}
			});

			client[host].on('disconnected', () => {
				try {
					if (this.deviceInfo[host].deviceName != null) {
						this.setState(`${this.deviceInfo[host].deviceName}.info._online`, {val: false, ack: true});
						this.log.warn(`ESPHome  client  ${host} disconnected`);
					}
				} catch (e) {
					this.log.debug(`ESPHome disconnect error : ${e}`);
				}
			});

			client[host].on('initialized', () => {
				this.log.info(`ESPHome  client ${this.deviceInfo[host].deviceInfoName} on ip ${host} initialized`);
			});

			client[host].on('logs', (messageObj) => {
				this.log.debug(`ESPHome client log : ${JSON.stringify(messageObj)}`);
			});

			// Log message listener
			client[host].connection.on('message', (message) => {
				this.log.debug(`ESPHome ${host} client log ${message}`);
			});

			client[host].connection.on('data', (data) => {
				this.log.debug(`ESPHome ${host} client data ${data}`);
			});

			// Handle device information when connected or information updated
			client[host].on('deviceInfo', async (deviceInfo) => {
				try {
					this.log.info(`ESPHome Device info received for ${deviceInfo.name}`);

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
					this.deviceStateRelation[deviceName] = {'ip' : host};

					this.log.debug(`DeviceInfo : ${JSON.stringify(this.deviceInfo)}`);

					// Create Device main structure
					await this.extendObjectAsync(deviceName, {
						type: 'device',
						common: {
							name: deviceInfo.name,
						},
						native: {
							ip: host,
							name: this.deviceInfo[host].deviceInfoName,
							mac: deviceInfo.macAddress,
							deviceName: deviceName,
							passWord: pass,
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

				try {
					// Store relevant information into memory object
					this.deviceInfo[host][entity.id] = {
						config : entity.config,
						name : entity.name,
						type : entity.type,
						unit: entity.config.unitOfMeasurement !== undefined ? entity.config.unitOfMeasurement || '' : ''
					};

					this.log.info(`${this.deviceInfo[host][entity.id].type} found at ${this.deviceInfo[host].deviceInfoName} on ip ${this.deviceInfo[host].ip}`);

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

					// Request current state values
					await client[host].connection.subscribeStatesService();
					this.log.debug(`[DeviceInfoData] ${JSON.stringify(this.deviceInfo[host])}`);

					// Listen to state changes an write values to states (create state if not yet exists)
					entity.on(`state`, async (state) => {
						try {
							this.log.debug(`[entityStateConfig] ${JSON.stringify(this.deviceInfo[host][entity.id])}`);
							this.log.debug(`[entityStateData] ${JSON.stringify(state)}`);
							const deviceDetails = `DeviceType ${this.deviceInfo[host][entity.id].type} | State-Keys ${JSON.stringify(state)} | [entityStateConfig] ${JSON.stringify(this.deviceInfo[host][entity.id])}`;

							// Ensure proper initialisation of the state
							switch (this.deviceInfo[host][entity.id].type) {
								case 'BinarySensor':
									await this.handleRegularState(`${host}`, entity, state, false );
									break;

								case 'Climate':
									await this.handleClimateState(`${host}`, entity, state);
									break;

								case 'Sensor':
									await this.handleRegularState(`${host}`, entity, state, false );
									break;

								case 'TextSensor':
									await this.handleRegularState(`${host}`, entity, state, false );
									break;

								case 'Switch':
									await this.handleRegularState(`${host}`, entity, state, true );
									break;

								default:

									if (!warnMessages[this.deviceInfo[host][entity.id].type]){
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

					entity.connection.on(`destroyed`, async (state) => {
						try {
							this.log.warn(`Connection destroyed for ${state}`);
						} catch (e) {
							this.log.error(`State handle error ${e}`);
						}

					});

					entity.on(`error`, async (name) => {
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
					if (error.message.includes('EHOSTUNREACH')){
						optimisedError = `Client ${host} not reachable !`;
						if (!warnMessages[host].connectError) {
							this.log.error(optimisedError);
							warnMessages[host].connectError = true;
						}
					} else if (error.message.includes('Invalid password')){
						optimisedError = `Client ${host} incorrect password !`;
						this.log.error(optimisedError);
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

				}  catch (e) {
					this.log.error(`ESPHome error handling issue ${host} ${e}`);
				}
			});

			// connect to socket
			try {
				this.log.debug(`trying to connect to ${host}`);
				// Reserve memory for warn messages
				warnMessages[host] = {
					connectError : false
				};
				client[host].connect();
			} catch (e) {
				this.log.error(`Client ${host} connect error ${e}`);
			}

		}  catch (e) {
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
	async handleRegularState(host, entity, state, writable){
		const stateName = this.deviceInfo[host][entity.id].config.objectId !== undefined ? this.deviceInfo[host][entity.id].config.objectId || 'state' : 'state';
		// Round value to digits as known by configuration
		let stateVal = state.state;

		if (this.deviceInfo[host][entity.id].config.accuracyDecimals != null) {
			const rounding = `round(${this.deviceInfo[host][entity.id].config.accuracyDecimals })`;
			this.log.debug(`Value "${stateVal}" for name "${entity}" before function modify with method "round(${this.deviceInfo[host][entity.id].config.accuracyDecimals})"`);
			stateVal = this.modify(rounding, stateVal);
			this.log.debug(`Value "${stateVal}" for name "${entity}" after function modify with method "${rounding}"`);
		}
		if (this.deviceInfo[host][entity.id].stateName == null) {
			this.deviceInfo[host][entity.id].stateName = `${this.deviceInfo[host].deviceName}.${entity.type}.${entity.id}.${stateName}`;
			await this.stateSetCreate( `${this.deviceInfo[host][entity.id].stateName}`, `value of ${entity.type}`, stateVal, this.deviceInfo[host][entity.id].unit, writable);
		}

		// State is already known, only update values
		await this.setStateAsync(`${this.deviceInfo[host][entity.id].stateName}`, {val: stateVal, ack: true});
	}

	async handleClimateState(host, entity, state) {

		this.deviceInfo[host][entity.id].states = state;

		for (const stateName in this.deviceInfo[host][entity.id].states) {
			let unit = '';
			let writable  = true;
			if (stateName === `targetTemperature` || stateName === `targetTemperatureLow` || stateName === `targetTemperatureHigh`) {
				unit = `°C`;
			} else if (stateName === `currentTemperature`) {
				unit = `°C`;
				writable =  false;
				this.deviceInfo[host][entity.id].states.currentTemperature = this.modify('round(2)', state[stateName]);
			}
			if (stateName !== 'key') {
				await this.stateSetCreate(`${this.deviceInfo[host].deviceName}.${entity.type}.${entity.id}.${stateName}`, `value of ${entity.type}`, state[stateName], unit, writable);
			}
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
				if (!!jObject[i] && typeof (jObject[i]) == 'object' && jObject[i] == '[object Object]') {
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
					if (value != '[]') {
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
	 */
	async stateSetCreate(objName, name, value, unit, writable) {
		this.log.debug('Create_state called for : ' + objName + ' with value : ' + value);
		try {

			// Try to get details from state lib, if not use defaults. throw warning is states is not known in attribute list
			const common = {};
			// const entityID = objName.split('.');
			common.modify = {};
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
			common.modify = stateAttr[name] !== undefined ? stateAttr[name].modify || '' : '';
			this.log.debug(`MODIFY to ${name}: ${JSON.stringify(common.modify)}`);

			if ((!this.createdStatesDetails[objName])
				|| (this.createdStatesDetails[objName]
					&& (
						common.name !== this.createdStatesDetails[objName].name
						|| common.name !== this.createdStatesDetails[objName].name
						|| common.type !== this.createdStatesDetails[objName].type
						|| common.role !== this.createdStatesDetails[objName].role
						|| common.read !== this.createdStatesDetails[objName].read
						|| common.unit !== this.createdStatesDetails[objName].unit
						|| common.write !== this.createdStatesDetails[objName].write
					)
				)) {

				// console.log(`An attribute has changed : ${state}`);
				await this.extendObjectAsync(objName, {
					type: 'state',
					common
				});

			} else {
				console.log(`Nothing changed do not update object`);
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
				this.log.info(`[Error catched and send to Sentry, thank you collaborating!] error: ${msg}`);
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

	// Helper replace functions
	escapeRegExp(string) {
		return string.replace(/[.*+\-?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
	}

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
			}
			else {
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
				try {
					client[device].disconnect();
				} catch (e) {
					this.log.debug(`[onUnload] ${JSON.stringify(e)}`);
				}
			}
			if (reconnectTimer){
				reconnectTimer = clearTimeout();
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
							}
							else {
								// do nothing
							}
						});

					break;

				case 'addDevice':

					// eslint-disable-next-line no-case-declarations,no-inner-declarations
					function validateIPaddress(ipaddress)
					{
						if (/^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(ipaddress))
						{
							return (true);
						}
						return (false);
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
						await this.connectDevices(obj.message['device-ip'],obj.message['device-pass']);
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

	/**
	 * Is called if a subscribed state changes
	 * @param {string} id
	 * @param {ioBroker.State | null | undefined} state
	 */
	async onStateChange(id, state) {
		try {
			if (state && state.ack === false) {
				// The state was changed
				// this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
				const device = id.split('.');
				const deviceIP = this.deviceStateRelation[device[2]].ip;

				// Handle Switch State
				if (this.deviceInfo[deviceIP][device[4]].type === `Switch`) {
					await client[deviceIP].connection.switchCommandService({key: device[4], state: state.val});

					// Handle Climate State
				} else if (this.deviceInfo[deviceIP][device[4]].type === `Climate`) {
					this.deviceInfo[deviceIP][device[4]].states[device[5]] = state.val;
					await client[deviceIP].connection.climateCommandService(this.deviceInfo[deviceIP][device[4]].states);
				}
			}
		} catch (e) {
			this.log.error(`[onStateChange] ${e}`);
		}
	}
}

// @ts-ignore parent is a valid property on module
if (module.parent) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	module.exports = (options) => new Esphome(options);
} else {
	// otherwise start the instance directly
	new Esphome();
}