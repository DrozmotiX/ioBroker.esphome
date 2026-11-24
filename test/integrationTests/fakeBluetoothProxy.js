/**
 * A minimal ESPHome device with the bluetooth_proxy component, for the integration tests
 *
 * The ESPHome "host" platform the E2E suite uses has no Bluetooth, so a real firmware cannot deliver
 * advertisements on a CI runner. This server speaks the part of the native API (plaintext frames) the adapter
 * needs to connect: hello, device info, an empty entity list and ping. It records whether the adapter asked for
 * advertisements and sends raw advertisements like a proxy does. The messages are built with the protobuf
 * classes of the client library, so they are encoded exactly as ESPHome encodes them.
 */

const net = require('node:net');
const { pb } = require('@2colors/esphome-native-api/lib/utils/messages');
const { varuint_to_bytes, recv_varuint } = require('@2colors/esphome-native-api/lib/utils');
const { BinaryWriter } = require('google-protobuf');

/** bluetoothProxyFeatureFlags of a current proxy: passive scan, active connections, ..., raw advertisements */
const PROXY_FEATURE_FLAGS = 0b1111111;

/** The services of every BLE device behind the proxy: 0x1f10 with 0x1f1f (read, write, notify), like a pvvx thermometer */
const SERVICES = [
    {
        uuid: '00001f10-0000-1000-8000-00805f9b34fb',
        handle: 30,
        characteristics: [
            {
                uuid: '00001f1f-0000-1000-8000-00805f9b34fb',
                handle: 32,
                properties: 0x1a,
                descriptors: [{ uuid: '00002902-0000-1000-8000-00805f9b34fb', handle: 33 }],
            },
        ],
    },
];

/**
 * Writes a UUID as ESPHome does: two uint64 (high and low half), one field each, not packed. setUuidList() of the
 * protobuf classes writes them packed, which the client library with google-protobuf 4 cannot read.
 *
 * @param {object} writer - BinaryWriter of google-protobuf
 * @param {number} field - Field number
 * @param {string} uuid - 128 bit UUID with dashes
 */
function writeUuid(writer, field, uuid) {
    const hex = uuid.replace(/-/g, '');
    writer.writeUint64String(field, BigInt(`0x${hex.slice(0, 16)}`).toString());
    writer.writeUint64String(field, BigInt(`0x${hex.slice(16)}`).toString());
}

/**
 * @param {number} address - Address of the BLE device as number
 * @param {object[]} services - Services in the form of GattServiceInfo
 * @returns {Uint8Array} An encoded BluetoothGATTGetServicesResponse
 */
function encodeServicesResponse(address, services) {
    const response = new BinaryWriter();
    response.writeUint64(1, address);
    for (const service of services) {
        const s = new BinaryWriter();
        writeUuid(s, 1, service.uuid);
        s.writeUint32(2, service.handle);
        for (const characteristic of service.characteristics) {
            const c = new BinaryWriter();
            writeUuid(c, 1, characteristic.uuid);
            c.writeUint32(2, characteristic.handle);
            c.writeUint32(3, characteristic.properties);
            for (const descriptor of characteristic.descriptors) {
                const d = new BinaryWriter();
                writeUuid(d, 1, descriptor.uuid);
                d.writeUint32(2, descriptor.handle);
                c.writeBytes(4, d.getResultBuffer());
            }
            s.writeBytes(3, c.getResultBuffer());
        }
        response.writeBytes(2, s.getResultBuffer());
    }
    return response.getResultBuffer();
}

class FakeBluetoothProxy {
    /**
     * @param {object} options - Properties of the device
     * @param {string} options.name - ESPHome node name
     * @param {string} options.mac - MAC address of the device, upper case with colons
     * @param {number} [options.featureFlags] - bluetoothProxyFeatureFlags, 0 = no bluetooth_proxy component
     * @param {string} [options.host] - Address to listen on
     * @param {number} [options.port] - Port of the native API
     */
    constructor({ name, mac, featureFlags = PROXY_FEATURE_FLAGS, host = '127.0.0.1', port = 6053 }) {
        this.name = name;
        this.mac = mac;
        this.featureFlags = featureFlags;
        this.host = host;
        this.port = port;
        this.server = null;
        /** Open API connections with their receive buffer and whether they asked for advertisements */
        this.connections = new Set();
        /** Flags of every SubscribeBluetoothLEAdvertisementsRequest received, 1 = raw advertisements */
        this.subscriptions = [];
        /** Number of UnsubscribeBluetoothLEAdvertisementsRequest received */
        this.unsubscriptions = 0;
        /** Free connection slots and their maximum, as BluetoothConnectionsFreeResponse reports them */
        this.freeSlots = 3;
        this.slotLimit = 3;
        /** Addresses (48 bit numbers) of the BLE devices the proxy is connected to */
        this.bleConnections = new Set();
        /** Value of every handle of the BLE devices, as hex */
        this.values = new Map();
        /** Every GATT request in order, e.g. "connect 180725...", "read 32", "disconnect 180725..." */
        this.gattLog = [];
        /** Descriptor writes as { address, handle, hex } */
        this.descriptorWrites = [];
        /** Error code the next connect fails with, 0 = it works */
        this.nextConnectError = 0;
    }

    /**
     * Sets the value of a handle of the BLE devices
     *
     * @param {number} handle - Handle of the characteristic
     * @param {string} hex - The value
     */
    setValue(handle, hex) {
        this.values.set(handle, hex);
    }

    /**
     * Lets the next connection attempt fail with this error code
     *
     * @param {number} error - Error code, e.g. 133
     */
    failNextConnect(error) {
        this.nextConnectError = error;
    }

    /**
     * A BLE device sends a notification
     *
     * @param {number} address - Address of the BLE device
     * @param {number} handle - Handle of the characteristic
     * @param {string} hex - The value
     */
    notify(address, handle, hex) {
        const message = new pb.BluetoothGATTNotifyDataResponse();
        message.setAddress(address);
        message.setHandle(handle);
        message.setData(Buffer.from(hex, 'hex'));
        this.broadcast(message);
    }

    /**
     * The BLE device ends the connection, e.g. because it is out of range
     *
     * @param {number} address - Address of the BLE device
     */
    dropBleConnection(address) {
        this.bleConnections.delete(address);
        this.freeSlots++;
        this.broadcast(this.connectionResponse(address, false, 0, 19));
        this.broadcast(this.connectionsFree());
    }

    /**
     * @param {object} message - Protobuf message for every API connection
     */
    broadcast(message) {
        for (const connection of this.connections) {
            this.send(connection.socket, message);
        }
    }

    /**
     * @param {number} address - Address of the BLE device
     * @param {boolean} connected - Whether it is connected now
     * @param {number} mtu - Negotiated MTU
     * @param {number} error - Error code
     */
    connectionResponse(address, connected, mtu, error) {
        const message = new pb.BluetoothDeviceConnectionResponse();
        message.setAddress(address);
        message.setConnected(connected);
        message.setMtu(mtu);
        message.setError(error);
        return message;
    }

    /** The current free connection slots */
    connectionsFree() {
        const message = new pb.BluetoothConnectionsFreeResponse();
        message.setFree(this.freeSlots);
        message.setLimit(this.slotLimit);
        return message;
    }

    /**
     * Answers the GATT requests of the adapter
     *
     * @param {net.Socket} socket - The connection the request arrived on
     * @param {number} type - Message type ID of api.proto
     * @param {Buffer} payload - Encoded message
     * @returns {boolean} Whether the message was a GATT request
     */
    onGattMessage(socket, type, payload) {
        const is = name => type === Number(pb[name].id);
        if (is('SubscribeBluetoothConnectionsFreeRequest')) {
            this.send(socket, this.connectionsFree());
        } else if (is('BluetoothDeviceRequest')) {
            const request = pb.BluetoothDeviceRequest.deserializeBinary(payload).toObject();
            const address = Number(request.address);
            const requestType = request.requestType;
            if (requestType === pb.BluetoothDeviceRequestType.BLUETOOTH_DEVICE_REQUEST_TYPE_DISCONNECT) {
                this.gattLog.push(`disconnect ${address}`);
                if (this.bleConnections.delete(address)) {
                    this.freeSlots++;
                    this.send(socket, this.connectionsFree());
                }
                this.send(socket, this.connectionResponse(address, false, 0, 0));
            } else {
                this.gattLog.push(`connect ${address}`);
                if (this.nextConnectError) {
                    const error = this.nextConnectError;
                    this.nextConnectError = 0;
                    this.send(socket, this.connectionResponse(address, false, 0, error));
                } else {
                    this.bleConnections.add(address);
                    this.freeSlots--;
                    this.send(socket, this.connectionResponse(address, true, 247, 0));
                    this.send(socket, this.connectionsFree());
                }
            }
        } else if (is('BluetoothGATTGetServicesRequest')) {
            const { address } = pb.BluetoothGATTGetServicesRequest.deserializeBinary(payload).toObject();
            this.gattLog.push('getServices');
            this.sendRaw(
                socket,
                Number(pb.BluetoothGATTGetServicesResponse.id),
                encodeServicesResponse(address, SERVICES),
            );
            const done = new pb.BluetoothGATTGetServicesDoneResponse();
            done.setAddress(address);
            this.send(socket, done);
        } else if (is('BluetoothGATTReadRequest')) {
            const { address, handle } = pb.BluetoothGATTReadRequest.deserializeBinary(payload).toObject();
            this.gattLog.push(`read ${handle}`);
            const response = new pb.BluetoothGATTReadResponse();
            response.setAddress(address);
            response.setHandle(handle);
            response.setData(Buffer.from(this.values.get(handle) ?? '', 'hex'));
            this.send(socket, response);
        } else if (is('BluetoothGATTWriteRequest')) {
            const request = pb.BluetoothGATTWriteRequest.deserializeBinary(payload);
            const { address, handle, response: withResponse } = request.toObject();
            const hex = Buffer.from(request.getData_asU8()).toString('hex');
            this.gattLog.push(`write ${handle} ${hex} ${withResponse}`);
            this.values.set(handle, hex);
            if (withResponse) {
                const response = new pb.BluetoothGATTWriteResponse();
                response.setAddress(address);
                response.setHandle(handle);
                this.send(socket, response);
            }
        } else if (is('BluetoothGATTNotifyRequest')) {
            const { address, handle, enable } = pb.BluetoothGATTNotifyRequest.deserializeBinary(payload).toObject();
            this.gattLog.push(`notify ${handle} ${enable}`);
            const response = new pb.BluetoothGATTNotifyResponse();
            response.setAddress(address);
            response.setHandle(handle);
            this.send(socket, response);
        } else if (is('BluetoothGATTWriteDescriptorRequest')) {
            const request = pb.BluetoothGATTWriteDescriptorRequest.deserializeBinary(payload);
            const { address, handle } = request.toObject();
            const hex = Buffer.from(request.getData_asU8()).toString('hex');
            this.gattLog.push(`writeDescriptor ${handle} ${hex}`);
            this.descriptorWrites.push({ address, handle, hex });
        } else {
            return false;
        }
        return true;
    }

    /** Starts listening for API connections */
    async start() {
        this.server = net.createServer(socket => this.onConnection(socket));
        await new Promise((resolve, reject) => {
            this.server.once('error', error =>
                reject(new Error(`Fake Bluetooth proxy cannot listen on ${this.host}:${this.port}: ${error.message}`)),
            );
            this.server.listen(this.port, this.host, resolve);
        });
    }

    /** Closes all connections and stops listening */
    async stop() {
        this.dropConnections();
        const server = this.server;
        this.server = null;
        if (server) {
            await new Promise(resolve => server.close(resolve));
        }
    }

    /** Whether an API connection currently wants advertisements */
    get subscribed() {
        return [...this.connections].some(connection => connection.subscribed);
    }

    /** Cuts all API connections, like a device that loses its Wi-Fi */
    dropConnections() {
        for (const connection of this.connections) {
            connection.socket.destroy();
        }
        this.connections.clear();
    }

    /**
     * Sends a batch of raw advertisements to every connection that asked for them
     *
     * @param {{address: number, rssi: number, addressType?: number, hex: string}[]} advertisements - The
     *     advertisements: address of the BLE device as 48 bit number, payload as hex string
     */
    sendAdvertisements(advertisements) {
        const message = new pb.BluetoothLERawAdvertisementsResponse();
        for (const { address, rssi, addressType = 0, hex } of advertisements) {
            const advertisement = new pb.BluetoothLERawAdvertisement();
            advertisement.setAddress(address);
            advertisement.setRssi(rssi);
            advertisement.setAddressType(addressType);
            advertisement.setData(Buffer.from(hex, 'hex'));
            message.addAdvertisements(advertisement);
        }
        for (const connection of this.connections) {
            if (connection.subscribed) {
                this.send(connection.socket, message);
            }
        }
    }

    /**
     * @param {net.Socket} socket - New API connection
     */
    onConnection(socket) {
        const connection = { socket, buffer: Buffer.alloc(0), subscribed: false };
        this.connections.add(connection);
        socket.on('data', data => {
            connection.buffer = Buffer.concat([connection.buffer, data]);
            let frame;
            while ((frame = this.readFrame(connection))) {
                this.onMessage(connection, frame.type, frame.payload);
            }
        });
        socket.on('close', () => this.connections.delete(connection));
        socket.on('error', () => {
            // The adapter closed the connection, nothing to do
        });
    }

    /**
     * Takes the next complete plaintext frame from the receive buffer: 0x00, payload length and message type as
     * varints, then the payload
     *
     * @param {{buffer: Buffer}} connection - The connection
     * @returns {{type: number, payload: Buffer} | null} null while no complete frame was received
     */
    readFrame(connection) {
        const { buffer } = connection;
        if (buffer.length < 3) {
            return null;
        }
        if (buffer[0] !== 0) {
            throw new Error('Fake Bluetooth proxy only speaks the plaintext protocol, the adapter sent something else');
        }
        let offset = 1;
        const next = () => (offset >= buffer.length ? null : buffer[offset++]);
        const length = recv_varuint(next);
        const type = length === null ? null : recv_varuint(next);
        if (length === null || type === null || offset + length > buffer.length) {
            return null;
        }
        connection.buffer = buffer.subarray(offset + length);
        return { type, payload: buffer.subarray(offset, offset + length) };
    }

    /**
     * Answers a message of the adapter
     *
     * @param {{socket: net.Socket, subscribed: boolean}} connection - The connection it arrived on
     * @param {number} type - Message type ID of api.proto
     * @param {Buffer} payload - Encoded message
     */
    onMessage(connection, type, payload) {
        const { socket } = connection;
        if (type === Number(pb.HelloRequest.id)) {
            const response = new pb.HelloResponse();
            // API version of ESPHome 2025.x: no authentication message without a password
            response.setApiVersionMajor(1);
            response.setApiVersionMinor(13);
            response.setServerInfo('fake Bluetooth proxy (integration test)');
            response.setName(this.name);
            this.send(socket, response);
        } else if (type === Number(pb.AuthenticationRequest.id)) {
            this.send(socket, new pb.AuthenticationResponse());
        } else if (type === Number(pb.DeviceInfoRequest.id)) {
            const response = new pb.DeviceInfoResponse();
            response.setName(this.name);
            response.setFriendlyName(this.name);
            response.setMacAddress(this.mac);
            response.setEsphomeVersion('2026.6.5');
            response.setModel('esp32dev');
            response.setManufacturer('Espressif');
            response.setBluetoothProxyFeatureFlags(this.featureFlags);
            response.setBluetoothMacAddress(this.mac);
            this.send(socket, response);
        } else if (type === Number(pb.ListEntitiesRequest.id)) {
            this.send(socket, new pb.ListEntitiesDoneResponse());
        } else if (type === Number(pb.PingRequest.id)) {
            this.send(socket, new pb.PingResponse());
        } else if (type === Number(pb.DisconnectRequest.id)) {
            this.send(socket, new pb.DisconnectResponse());
            socket.end();
        } else if (type === Number(pb.SubscribeBluetoothLEAdvertisementsRequest.id)) {
            const { flags } = pb.SubscribeBluetoothLEAdvertisementsRequest.deserializeBinary(payload).toObject();
            this.subscriptions.push(flags);
            connection.subscribed = true;
        } else if (type === Number(pb.UnsubscribeBluetoothLEAdvertisementsRequest.id)) {
            this.unsubscriptions++;
            connection.subscribed = false;
        } else {
            this.onGattMessage(socket, type, payload);
        }
        // Everything else (state subscription, time, ...) needs no answer
    }

    /**
     * @param {net.Socket} socket - Connection to write to
     * @param {object} message - Protobuf message
     */
    send(socket, message) {
        this.sendRaw(socket, Number(message.constructor.id), message.serializeBinary());
    }

    /**
     * @param {net.Socket} socket - Connection to write to
     * @param {number} type - Message type ID of api.proto
     * @param {Uint8Array} encoded - The encoded message
     */
    sendRaw(socket, type, encoded) {
        socket.write(Buffer.from([0, ...varuint_to_bytes(encoded.length), ...varuint_to_bytes(type), ...encoded]));
    }
}

module.exports = { FakeBluetoothProxy, PROXY_FEATURE_FLAGS, SERVICES };
