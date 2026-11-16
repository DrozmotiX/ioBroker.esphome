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

/** bluetoothProxyFeatureFlags of a current proxy: passive scan, active connections, ..., raw advertisements */
const PROXY_FEATURE_FLAGS = 0b1111111;

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
        }
        // Everything else (state subscription, time, ...) needs no answer
    }

    /**
     * @param {net.Socket} socket - Connection to write to
     * @param {object} message - Protobuf message
     */
    send(socket, message) {
        const encoded = message.serializeBinary();
        socket.write(
            Buffer.from([
                0,
                ...varuint_to_bytes(encoded.length),
                ...varuint_to_bytes(Number(message.constructor.id)),
                ...encoded,
            ]),
        );
    }
}

module.exports = { FakeBluetoothProxy, PROXY_FEATURE_FLAGS };
