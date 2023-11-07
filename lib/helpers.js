
/**
 * @class
 * @alias DeviceInfo
 */
module.exports = class DeviceInfo {

	/**
     * Initiates a device status object to manage connections and relations
     * @param {string} ip IP-Address of device
	 * @param {string} [macAddress] MAC-Address of a device
	 * @param {string} [deviceName] Name of a device (MAC address without ":")
	 * @param {string} [deviceFriendlyName] Friendly name of a device taken from YAML configuration
     */
	constructor(ip, macAddress, deviceName, deviceFriendlyName) {
		/** @type {boolean} */
		this.deletionRequested = false;
		/** @type {string} */
		this.deviceFriendlyName = deviceFriendlyName ? deviceFriendlyName : 'Initialisation needed';
		/** @type {string} */
		this.deviceName = deviceName ? deviceName : 'Initialisation needed';
		/** @type {boolean} */
		this.initialized = false;
		this.ip = ip;
		/** @type {boolean} */
		this.newlyAdded = true;
		/** @type {boolean} */
		this.connected = false;
		/** @type {boolean} */
		this.connecting = true;
		/** @type {boolean} */
		this.connectionError = false;
		/** @type {string} */
		this.connectStatus = 'Connecting';
		/** @type {string} */
		this.mac = macAddress = macAddress ? macAddress : 'Initialisation needed' ;
	}
};