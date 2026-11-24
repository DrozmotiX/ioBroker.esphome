// Types for lib/utils/messages.js of @2colors/esphome-native-api, which ships no types for it. A file of its own:
// in esphome-native-api.d.ts (a module because of its imports) this would be an augmentation of an untyped module.

/**
 * The protobuf classes of the native API (lib/utils/messages.js). Only the ones this adapter builds are declared.
 * The GATT methods of the Connection cannot be used: they match answers by their type only, not by the device.
 */
declare module '@2colors/esphome-native-api/lib/utils/messages' {
    /** A protobuf message */
    interface PbMessage {
        toObject(): Record<string, unknown>;
        serializeBinary(): Uint8Array;
    }

    /** A protobuf message class. The constructor takes the fields in the order of api.proto. */
    interface PbMessageClass<T extends PbMessage = PbMessage> {
        new (fields?: unknown[]): T;
        /** Name of the message, e.g. "BluetoothGATTReadRequest" */
        type: string;
        /** ID of the message in the native API, as string */
        id: string;
        deserializeBinary(bytes: Uint8Array): T;
    }

    /** Request to connect to or disconnect from a BLE device */
    interface BluetoothDeviceRequest extends PbMessage {
        /** Whether address_type is set */
        setHasAddressType(value: boolean): void;
        /** 0 = public, 1 = random */
        setAddressType(value: number): void;
    }

    /** The message classes and enums this adapter uses */
    export const pb: {
        /** Connect to or disconnect from a BLE device */
        BluetoothDeviceRequest: PbMessageClass<BluetoothDeviceRequest>;
        /** Values of BluetoothDeviceRequest.request_type */
        BluetoothDeviceRequestType: {
            /** Disconnect */
            BLUETOOTH_DEVICE_REQUEST_TYPE_DISCONNECT: number;
            /** Connect, the proxy may use the services it cached */
            BLUETOOTH_DEVICE_REQUEST_TYPE_CONNECT_V3_WITH_CACHE: number;
            /** Connect, the proxy reads the services from the device */
            BLUETOOTH_DEVICE_REQUEST_TYPE_CONNECT_V3_WITHOUT_CACHE: number;
        };
        /** Lists the services of a connected device */
        BluetoothGATTGetServicesRequest: PbMessageClass;
        /** Reads a characteristic */
        BluetoothGATTReadRequest: PbMessageClass;
        /** Writes a characteristic */
        BluetoothGATTWriteRequest: PbMessageClass;
        /** Switches notifications of a characteristic on or off */
        BluetoothGATTNotifyRequest: PbMessageClass;
        /** Writes a descriptor */
        BluetoothGATTWriteDescriptorRequest: PbMessageClass;
        /** Asks the proxy to report its free connection slots */
        SubscribeBluetoothConnectionsFreeRequest: PbMessageClass;
    };
}
