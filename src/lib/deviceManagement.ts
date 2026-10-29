import type { AdapterInstance } from '@iobroker/adapter-core';
import {
    type ActionContext,
    type DeviceDetails,
    type DeviceInfo,
    type DeviceLoadContext,
    DeviceManagement,
    type DeviceStatus,
    type InstanceDetails,
    type JsonFormSchema,
} from '@iobroker/dm-utils';
import type ClientDetails from './helpers';

/** Device found by the MDNS discovery that is not adopted yet */
export interface DiscoveredDevice {
    /** IP address of the device */
    ip: string;
    /** MAC address, upper case with ":" */
    mac: string;
    /** Friendly name announced by the device, or its host name */
    deviceFriendlyName: string;
}

/** Outcome of adding, updating or deleting a device, as also answered to the admin page */
export interface DeviceActionResult {
    /** Success message */
    result?: string;
    /** Error message */
    error?: string;
}

/** Credentials entered in the add / edit form */
interface CredentialsForm {
    ip?: string;
    encryptionKey?: string;
    apiPassword?: string;
}

/** What the device manager needs from the adapter */
export interface EsphomeDeviceSource {
    /** Adopted devices by IP */
    knownDevices(): Record<string, ClientDetails>;
    /** Devices found by the MDNS discovery that are not adopted yet, by IP */
    discoveredDevices(): Record<string, DiscoveredDevice>;
    /**
     * Add a new device or reconnect a known one with new credentials.
     * respond is called once the connection succeeded or failed.
     */
    addOrUpdateDevice(
        ip: string,
        apiPassword: string | undefined,
        encryptionKey: string | undefined,
        respond: (response: DeviceActionResult) => void,
    ): Promise<void>;
    /** Disconnect a device and delete all its objects */
    removeDevice(ip: string): Promise<DeviceActionResult>;
}

type EsphomeAdapter = AdapterInstance & EsphomeDeviceSource;

/** Placeholder ClientDetails uses until the device reported its information */
const NOT_INITIALIZED = 'Initialisation needed';

/** State the device manager watches for updates pushed by the adapter */
const COMMUNICATION_STATE = 'info.deviceManager';

/** Card header color of discovered devices, added devices use the default (secondary) color */
const DISCOVERED_COLOR = '#9e9e9e';

/** How long the add / edit dialog waits for the first connection result */
const CONNECT_TIMEOUT = 30_000;

/** Texts shown in the device manager, the GUI falls back to English for missing languages */
const texts = {
    addDevice: { en: 'Add device', de: 'Gerät hinzufügen' },
    adoptDevice: { en: 'Add discovered device', de: 'Gefundenes Gerät hinzufügen' },
    editDevice: { en: 'Change connection settings', de: 'Verbindungseinstellungen ändern' },
    deleteDevice: { en: 'Delete device', de: 'Gerät löschen' },
    deleteConfirm: {
        en: 'Delete this device? All its states will be removed.',
        de: 'Dieses Gerät löschen? Alle zugehörigen Datenpunkte werden entfernt.',
    },
    openWebServer: { en: 'Open web server of the device', de: 'Webserver des Geräts öffnen' },
    connecting: { en: 'Connecting to device...', de: 'Verbinde mit Gerät...' },
    connectTimeout: {
        en: 'The device did not answer yet, the adapter keeps trying to connect in the background.',
        de: 'Das Gerät hat noch nicht geantwortet, der Adapter versucht weiterhin, sich im Hintergrund zu verbinden.',
    },
    ip: { en: 'IP address', de: 'IP-Adresse' },
    encryptionKey: { en: 'Encryption key', de: 'Verschlüsselungsschlüssel' },
    apiPassword: { en: 'API password (legacy)', de: 'API-Passwort (veraltet)' },
    credentialsHint: {
        en: 'Enter the API encryption key of the device (recommended) or the API password of older firmware. Leave both fields empty if the API of the device is not protected.',
        de: 'Den API-Verschlüsselungsschlüssel des Geräts (empfohlen) oder das API-Passwort älterer Firmware eingeben. Beide Felder leer lassen, wenn die API des Geräts nicht geschützt ist.',
    },
    keepCredentialsHint: {
        en: 'Leave both fields empty to keep the current credentials.',
        de: 'Beide Felder leer lassen, um die aktuellen Zugangsdaten zu behalten.',
    },
    groupKnown: { en: 'Devices', de: 'Geräte' },
    groupDiscovered: { en: 'Discovered, not added yet', de: 'Gefunden, noch nicht hinzugefügt' },
    notAdded: { en: 'Not added', de: 'Nicht hinzugefügt' },
    add: { en: 'Add', de: 'Hinzufügen' },
    name: { en: 'Name', de: 'Name' },
    mac: { en: 'MAC address', de: 'MAC-Adresse' },
    connectionStatus: { en: 'Connection status', de: 'Verbindungsstatus' },
    esphomeVersion: { en: 'ESPHome version', de: 'ESPHome-Version' },
    compilationTime: { en: 'Compiled', de: 'Kompiliert' },
    model: { en: 'Model', de: 'Modell' },
    manufacturer: { en: 'Manufacturer', de: 'Hersteller' },
    project: { en: 'Project', de: 'Projekt' },
} satisfies Record<string, ioBroker.Translated>;

/**
 * Integration with the ioBroker device manager (https://github.com/ioBroker/ioBroker.device-manager).
 *
 * Every device is identified by its IP address, the key all connection handling in main.ts uses.
 * Adopted devices and devices found by the MDNS discovery are listed in their own groups.
 */
export default class EsphomeDeviceManagement extends DeviceManagement<EsphomeAdapter> {
    /**
     * @param adapter - The adapter instance, providing the devices and the add / delete operations
     */
    constructor(adapter: EsphomeAdapter) {
        // Created by the base class, used to push list updates to the GUI
        super(adapter, COMMUNICATION_STATE);
    }

    /** Let an open device manager reload the device list, e.g. after a device was added, discovered or removed */
    async refreshDeviceList(): Promise<void> {
        try {
            await this.sendCommandToGui({ command: 'all' });
        } catch (error) {
            this.log.debug(`[deviceManagement] Cannot notify device manager: ${String(error)}`);
        }
    }

    protected override getInstanceInfo(): InstanceDetails {
        return {
            apiVersion: 'v3',
            communicationStateId: COMMUNICATION_STATE,
            identifierLabel: texts.ip,
            actions: [
                {
                    id: 'add',
                    icon: 'add',
                    title: texts.addDevice,
                    description: texts.addDevice,
                    handler: async context => ({ refresh: await this.addDevice(context) }),
                },
            ],
        };
    }

    protected override loadDevices(context: DeviceLoadContext<string>): void {
        const known = this.adapter.knownDevices();
        const discovered = Object.values(this.adapter.discoveredDevices()).filter(device => !known[device.ip]);
        context.setTotalDevices(Object.keys(known).length + discovered.length);

        for (const [ip, device] of Object.entries(known)) {
            context.addDevice(this.knownDeviceInfo(ip, device));
        }
        for (const device of discovered) {
            context.addDevice(this.discoveredDeviceInfo(device));
        }
    }

    protected override getDeviceDetails(ip: string): DeviceDetails<string> | { error: string } {
        const device = this.adapter.knownDevices()[ip];
        if (!device) {
            const discovered = this.adapter.discoveredDevices()[ip];
            if (!discovered) {
                return { error: `Unknown device ${ip}` };
            }
            return this.details(ip, {
                name: discovered.deviceFriendlyName,
                ip,
                mac: discovered.mac,
            });
        }

        const info = device.deviceInfo;
        return this.details(ip, {
            name: initialized(device.deviceFriendlyName) ?? '',
            ip,
            mac: initialized(device.mac) ?? '',
            connectionStatus: device.connectStatus,
            esphomeVersion: info?.esphomeVersion,
            compilationTime: info?.compilationTime,
            model: info?.model,
            manufacturer: info?.manufacturer,
            project: info?.projectName ? `${info.projectName} ${info.projectVersion ?? ''}`.trim() : undefined,
        });
    }

    /**
     * Read-only form with the given values, empty values are left out
     *
     * @param ip - IP address of the device
     * @param values - Values to show, keyed like the entries of texts
     */
    private details(ip: string, values: Partial<Record<keyof typeof texts, string>>): DeviceDetails<string> {
        const items: Record<string, { type: 'text'; label: ioBroker.Translated; readOnly: true; sm: 6 }> = {};
        const data: Record<string, string> = {};
        for (const [key, value] of Object.entries(values) as [keyof typeof texts, string | undefined][]) {
            if (value) {
                items[key] = { type: 'text', label: texts[key], readOnly: true, sm: 6 };
                data[key] = value;
            }
        }
        return { id: ip, schema: { type: 'panel', items }, data };
    }

    /**
     * Device manager entry of an adopted device
     *
     * @param ip - IP address of the device
     * @param device - Connection details of the device
     */
    private knownDeviceInfo(ip: string, device: ClientDetails): DeviceInfo<string> {
        const deviceName = initialized(device.deviceName);
        const status: DeviceStatus = deviceName
            ? {
                  connection: {
                      stateId: `${this.adapter.namespace}.${deviceName}.info._online`,
                      mapping: { true: 'connected', false: 'disconnected' },
                  },
                  warning: device.connectionError ? device.connectStatus : false,
              }
            : 'disconnected';

        const actions: DeviceInfo<string>['actions'] = [
            {
                id: 'edit',
                icon: 'settings',
                description: texts.editDevice,
                handler: async (id, context) => ({
                    refresh: (await this.editDevice(id, context)) ? 'devices' : 'none',
                }),
            },
            {
                id: 'delete',
                icon: 'delete',
                description: texts.deleteDevice,
                handler: async (id, context) => ({
                    refresh: (await this.confirmRemoveDevice(id, context)) ? 'devices' : 'none',
                }),
            },
        ];
        if (device.deviceInfo?.webserverPort) {
            actions.push({
                id: 'web',
                icon: 'web',
                description: texts.openWebServer,
                url: `http://${ip}:${device.deviceInfo.webserverPort}`,
            });
        }

        return {
            id: ip,
            identifier: ip,
            name: initialized(device.deviceFriendlyName) ?? ip,
            manufacturer: device.deviceInfo?.manufacturer || undefined,
            model: device.deviceInfo?.model || undefined,
            status,
            group: { key: 'known', name: texts.groupKnown },
            actions,
            hasDetails: true,
        };
    }

    /**
     * Device manager entry of a device found by the MDNS discovery
     *
     * @param device - Discovered device
     */
    private discoveredDeviceInfo(device: DiscoveredDevice): DeviceInfo<string> {
        return {
            id: device.ip,
            identifier: device.ip,
            name: device.deviceFriendlyName,
            // Grey header and no connection status, so it does not look like an added device that is offline
            backgroundColor: DISCOVERED_COLOR,
            indicators: [
                {
                    id: 'discovered',
                    icon: 'search',
                    color: 'info',
                    text: texts.notAdded,
                    tooltip: texts.groupDiscovered,
                },
            ],
            group: { key: 'discovered', name: texts.groupDiscovered },
            actions: [
                {
                    id: 'adopt',
                    icon: 'add',
                    title: texts.add,
                    variant: 'contained',
                    description: texts.adoptDevice,
                    handler: async (id, context) => ({
                        refresh: (await this.addDevice(context, id)) ? 'devices' : 'none',
                    }),
                },
            ],
            hasDetails: true,
        };
    }

    /**
     * Ask for IP address and credentials and add the device
     *
     * @param context - Action context to talk to the user
     * @param [ip] - IP address to prefill, e.g. of a discovered device
     * @returns true if the device was added
     */
    async addDevice(context: ActionContext, ip?: string): Promise<boolean> {
        const form = await context.showForm(this.credentialsSchema(!!ip, texts.credentialsHint), {
            data: { ip: ip ?? '', encryptionKey: '', apiPassword: '' },
            title: ip ? texts.adoptDevice : texts.addDevice,
        });
        if (!form) {
            return false;
        }
        const { ip: enteredIp, encryptionKey, apiPassword } = form as CredentialsForm;
        return this.connect(context, (ip ?? enteredIp ?? '').trim(), apiPassword, encryptionKey);
    }

    /**
     * Ask for new credentials of a known device and reconnect it
     *
     * @param ip - IP address of the device
     * @param context - Action context to talk to the user
     * @returns true if the device was reconnected
     */
    async editDevice(ip: string, context: ActionContext): Promise<boolean> {
        const device = this.adapter.knownDevices()[ip];
        if (!device) {
            await context.showMessage(`Unknown device ${ip}`);
            return false;
        }
        const form = await context.showForm(this.credentialsSchema(true, texts.keepCredentialsHint), {
            data: { ip, encryptionKey: '', apiPassword: '' },
            title: texts.editDevice,
        });
        if (!form) {
            return false;
        }

        let { encryptionKey, apiPassword } = form as CredentialsForm;
        if (!encryptionKey && !apiPassword) {
            // Keep the current credentials, they are stored encrypted
            encryptionKey = device.encryptionKeyUsed && device.encryptionKey ? this.decrypt(device.encryptionKey) : '';
            apiPassword = !device.encryptionKeyUsed && device.apiPassword ? this.decrypt(device.apiPassword) : '';
        }
        return this.connect(context, ip, apiPassword, encryptionKey);
    }

    /**
     * Ask for confirmation and delete a known device
     *
     * @param ip - IP address of the device
     * @param context - Action context to talk to the user
     * @returns true if the device was deleted
     */
    async confirmRemoveDevice(ip: string, context: ActionContext): Promise<boolean> {
        if (!(await context.showConfirmation(texts.deleteConfirm))) {
            return false;
        }
        const response = await this.adapter.removeDevice(ip);
        if (response.error) {
            await context.showMessage(response.error);
            return false;
        }
        return true;
    }

    /**
     * Connect a device while showing a progress dialog, then show the result
     *
     * @param context - Action context to talk to the user
     * @param ip - IP address of the device
     * @param apiPassword - API password, empty if not used
     * @param encryptionKey - Encryption key, empty if not used
     * @returns true if the device is known to the adapter afterwards
     */
    private async connect(
        context: ActionContext,
        ip: string,
        apiPassword: string | undefined,
        encryptionKey: string | undefined,
    ): Promise<boolean> {
        const progress = await context.openProgress(texts.connecting, { indeterminate: true, label: ip });
        let response: DeviceActionResult;
        try {
            response = await new Promise<DeviceActionResult>(resolve => {
                const timeout = this.adapter.setTimeout(
                    () => resolve({ result: texts.connectTimeout.en }),
                    CONNECT_TIMEOUT,
                );
                this.adapter
                    .addOrUpdateDevice(ip, apiPassword || undefined, encryptionKey || undefined, result => {
                        this.adapter.clearTimeout(timeout);
                        resolve(result);
                    })
                    .catch((error: unknown) => {
                        this.adapter.clearTimeout(timeout);
                        resolve({ error: String(error) });
                    });
            });
        } finally {
            await progress.close();
        }

        await context.showMessage(response.error ?? response.result ?? '');
        return !!this.adapter.knownDevices()[ip];
    }

    /**
     * Form asking for IP address and credentials
     *
     * @param ipReadOnly - true if the IP address is given and must not be changed
     * @param hint - Explanation shown below the fields
     */
    private credentialsSchema(ipReadOnly: boolean, hint: ioBroker.Translated): JsonFormSchema {
        return {
            type: 'panel',
            items: {
                ip: { type: 'text', label: texts.ip, readOnly: ipReadOnly, sm: 12 },
                encryptionKey: { type: 'password', label: texts.encryptionKey, newLine: true, sm: 12 },
                apiPassword: { type: 'password', label: texts.apiPassword, newLine: true, sm: 12 },
                hint: { type: 'staticText', text: hint, newLine: true, sm: 12 },
            },
        };
    }

    /**
     * Decrypt a credential stored by the adapter
     *
     * @param value - Encrypted value
     */
    private decrypt(value: string): string {
        return this.adapter.decrypt(value);
    }
}

/**
 * Value or undefined while the device has not reported its information yet
 *
 * @param value - Value stored in ClientDetails
 */
function initialized(value: string | null | undefined): string | undefined {
    return value && value !== NOT_INITIALIZED && value !== 'undefined' ? value : undefined;
}
