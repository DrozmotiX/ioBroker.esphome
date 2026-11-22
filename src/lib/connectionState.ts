import type ClientDetails from './helpers';

/** Connection details of a device, as kept in memory by the adapter */
export type DeviceConnection = Pick<
    ClientDetails,
    'connected' | 'connecting' | 'connectionError' | 'connectStatus' | 'deviceFriendlyName'
>;

/** Placeholder of ClientDetails for values not known yet */
const NOT_INITIALISED = 'Initialisation needed';

/**
 * Whether a device is connected, the value of its info._online state
 *
 * @param device - connection details of the device
 */
export function isDeviceOnline(device: DeviceConnection): boolean {
    return device.connected && !device.connecting && !device.connectionError;
}

/**
 * Names of the connected devices for info.connection, sorted. A device is listed by its name, or by its
 * IP address as long as the name is not known yet (a newly added device, before its device info arrived).
 *
 * @param devices - connection details of all devices by IP address
 */
export function connectedDeviceNames(devices: [string, DeviceConnection][]): string[] {
    return devices
        .filter(([, device]) => device.connectStatus !== NOT_INITIALISED && isDeviceOnline(device))
        .map(([ip, device]) =>
            device.deviceFriendlyName && device.deviceFriendlyName !== NOT_INITIALISED ? device.deviceFriendlyName : ip,
        )
        .sort((a, b) => a.localeCompare(b));
}

/**
 * Value of info.connection: the connected devices, comma-separated. The admin shows the instance green while it is not
 * empty, so with the ESPHome Dashboard enabled nothing is listed until the dashboard answers.
 *
 * @param devices - connection details of all devices by IP address
 * @param dashboardEnabled - whether the integrated ESPHome Dashboard is enabled
 * @param dashboardReady - whether the dashboard answers requests
 */
export function connectionStateValue(
    devices: [string, DeviceConnection][],
    dashboardEnabled: boolean,
    dashboardReady: boolean,
): string {
    if (dashboardEnabled && !dashboardReady) {
        return '';
    }
    return connectedDeviceNames(devices).join(',');
}
