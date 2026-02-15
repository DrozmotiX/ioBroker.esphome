/**
 * @module class
 */

/**
 * Device Info a device status object to manage connections and relations
 *
 * @returns {object} ip IP-Address of device
//  * @param {string} apiPassword API password of device
//  * @param {boolean} encryptionKeyUsed Indicated if encryption must be used
//  * @param {string} encryptionKey Encryption key of device
//  * @param {string | undefined} [macAddress] MAC-Address of a device
//  * @param {string | undefined} [deviceName] Name of a device (MAC address without ":")
//  * @param {string | undefined} [deviceFriendlyName] Friendly name of a device taken from YAML configuration
 */
class DeviceInfo {
  //ToDO: this object should have deeper typ-definition to ensure code & module events are verified
  adapterObjects = {
    channels: [],
  };
  client = null;
  connected = false;
  connecting = false;
  connectionError = false;
  connectStatus = "Initialisation needed";
  deletionRequested = false;
  deviceFriendlyName = null;
  deviceInfo = null;
  deviceName = null;
  initialized = false;
  ip = null;
  mac = null;
}

/**
 * Client detail object to handle all relevant information for connection status
 *
 * @param {string | undefined} ip IP-Address of device
 * @param {string} apiPassword API password of device
 * @param {boolean} encryptionKeyUsed Indicated if encryption must be used
 * @param {string} encryptionKey Encryption key of device
 * @param {string | undefined} [macAddress] MAC-Address of a device
 * @param {string | undefined} [deviceName] Name of a device (MAC address without ":")
 * @param {string | undefined} [deviceFriendlyName] Friendly name of a device taken from YAML configuration
 */
class ClientDetails extends DeviceInfo {
  /**
   * Store mandatory connection details
   *
   * @param {string} ip IP-Address of device
   * @param {boolean} encryptionKeyUsed Indicated if encryption must be used
   * @param {string} [apiPassword] API password of device
   * @param {string} [encryptionKey] Encryption key of device
   * @param {string | undefined} [macAddress] MAC-Address of a device
   * @param {string | undefined} [deviceName] Name of a device (MAC address without ":")
   * @param {string | undefined} [deviceFriendlyName] Friendly name of a device taken from YAML configuration
   */
  storeConnectDetails(
    ip,
    encryptionKeyUsed,
    apiPassword,
    encryptionKey,
    macAddress,
    deviceName,
    deviceFriendlyName,
  ) {
    this.apiPassword = apiPassword;
    this.deviceFriendlyName = deviceFriendlyName
      ? deviceFriendlyName
      : "Initialisation needed";
    this.deviceName = deviceName ? deviceName : "Initialisation needed";
    this.ip = ip;
    this.mac = macAddress = macAddress ? macAddress : "Initialisation needed";
    this.encryptionKey = encryptionKey;
    this.encryptionKeyUsed = encryptionKeyUsed ? encryptionKeyUsed : false;
  }

  /**
   * Store mandatory connection details of already known device
   *
   * @param {string} ip IP-Address of device
   * @param {string} macAddress MAC-Address of a device
   * @param {string} deviceName Name of a device (MAC address without ":")
   * @param {string} deviceFriendlyName Friendly name of a device taken from YAML configuration
   */
  storeDiscoveredDevice(ip, macAddress, deviceName, deviceFriendlyName) {
    this.connectStatus = "newly discovered";
    this.deviceFriendlyName = deviceFriendlyName;
    this.deviceName = deviceName;
    this.ip = ip;
    this.mac = macAddress;
  }
  /**
   * Store mandatory connection details of already known device
   *
   * @param {string} ip IP-Address of device
   * @param {boolean} encryptionKeyUsed Indicated if encryption must be used
   * @param {string | undefined} macAddress MAC-Address of a device
   * @param {string | undefined} deviceName Name of a device (MAC address without ":")
   * @param {string | undefined} deviceFriendlyName Friendly name of a device taken from YAML configuration
   * @param {string} [apiPassword] API password of device
   * @param {string} [encryptionKey] Encryption key of device
   */
  storeExistingDetails(
    ip,
    encryptionKeyUsed,
    macAddress,
    deviceName,
    deviceFriendlyName,
    apiPassword,
    encryptionKey,
  ) {
    this.apiPassword = !encryptionKeyUsed ? apiPassword : null;
    this.deviceFriendlyName = deviceFriendlyName
      ? deviceFriendlyName
      : "Initialisation needed";
    this.deviceName = deviceName ? deviceName : "Initialisation needed";
    this.ip = ip;
    this.mac = macAddress = macAddress ? macAddress : "Initialisation needed";
    this.encryptionKey = encryptionKeyUsed ? encryptionKey : null;
    this.encryptionKeyUsed = encryptionKeyUsed ? encryptionKeyUsed : false;
  }
}

module.exports = ClientDetails;
//# sourceMappingURL=helpers.js.map
