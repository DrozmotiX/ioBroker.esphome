import type { Client, DeviceInfoResponse } from '@2colors/esphome-native-api';

/**
 * Device Info a device status object to manage connections and relations
 */
class DeviceInfo {
    /** Channels this adapter already created for the device */
    adapterObjects: { channels: string[] } = {
        channels: [],
    };
    client: Client | null = null;
    connected = false;
    connecting = false;
    connectionError = false;
    connectionDestroyedLogged = false;
    connectStatus = 'Initialisation needed';
    deletionRequested = false;
    deviceFriendlyName: string | null = null;
    /** Device information as reported by the device after connecting */
    deviceInfo?: DeviceInfoResponse | null = null;
    /** MAC address of the device without ":" */
    deviceName: string | null = null;
    initialized = false;
    ip: string | null = null;
    mac: string | null = null;
}

/**
 * Client detail object to handle all relevant information for connection status
 */
class ClientDetails extends DeviceInfo {
    // Only set by the store* methods below, "declare" keeps them out of the emitted class fields
    declare apiPassword?: string | null;
    declare encryptionKey?: string | null;
    declare encryptionKeyUsed?: boolean;

    /**
     * Store mandatory connection details
     *
     * @param ip IP-Address of device
     * @param encryptionKeyUsed Indicated if encryption must be used
     * @param [apiPassword] API password of device
     * @param [encryptionKey] Encryption key of device
     * @param [macAddress] MAC-Address of a device
     * @param [deviceName] Name of a device (MAC address without ":")
     * @param [deviceFriendlyName] Friendly name of a device taken from YAML configuration
     */
    storeConnectDetails(
        ip: string,
        encryptionKeyUsed: boolean,
        apiPassword?: string | null,
        encryptionKey?: string | null,
        macAddress?: string,
        deviceName?: string,
        deviceFriendlyName?: string,
    ): void {
        this.apiPassword = apiPassword;
        this.deviceFriendlyName = deviceFriendlyName ? deviceFriendlyName : 'Initialisation needed';
        this.deviceName = deviceName ? deviceName : 'Initialisation needed';
        this.ip = ip;
        this.mac = macAddress ? macAddress : 'Initialisation needed';
        this.encryptionKey = encryptionKey;
        this.encryptionKeyUsed = encryptionKeyUsed ? encryptionKeyUsed : false;
    }

    /**
     * Store mandatory connection details of already known device
     *
     * @param ip IP-Address of device
     * @param macAddress MAC-Address of a device
     * @param deviceName Name of a device (MAC address without ":")
     * @param deviceFriendlyName Friendly name of a device taken from YAML configuration
     */
    storeDiscoveredDevice(ip: string, macAddress: string, deviceName: string, deviceFriendlyName: string): void {
        this.connectStatus = 'newly discovered';
        this.deviceFriendlyName = deviceFriendlyName;
        this.deviceName = deviceName;
        this.ip = ip;
        this.mac = macAddress;
    }

    /**
     * Store mandatory connection details of already known device
     *
     * @param ip IP-Address of device
     * @param encryptionKeyUsed Indicated if encryption must be used
     * @param macAddress MAC-Address of a device
     * @param deviceName Name of a device (MAC address without ":")
     * @param deviceFriendlyName Friendly name of a device taken from YAML configuration
     * @param [apiPassword] API password of device
     * @param [encryptionKey] Encryption key of device
     */
    storeExistingDetails(
        ip: string,
        encryptionKeyUsed: boolean,
        macAddress: string | undefined,
        deviceName: string | undefined,
        deviceFriendlyName: string | undefined,
        apiPassword?: string,
        encryptionKey?: string,
    ): void {
        this.apiPassword = !encryptionKeyUsed ? apiPassword : null;
        this.deviceFriendlyName = deviceFriendlyName ? deviceFriendlyName : 'Initialisation needed';
        this.deviceName = deviceName ? deviceName : 'Initialisation needed';
        this.ip = ip;
        this.mac = macAddress ? macAddress : 'Initialisation needed';
        this.encryptionKey = encryptionKeyUsed ? encryptionKey : null;
        this.encryptionKeyUsed = encryptionKeyUsed ? encryptionKeyUsed : false;
    }
}

// export = keeps the CommonJS export (module.exports = ClientDetails) that main.ts loads with require()
export = ClientDetails;
