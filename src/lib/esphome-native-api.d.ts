// Completes the type declarations shipped with @2colors/esphome-native-api: they only declare the
// "error" and "ble" events of the Client and miss connect(), disconnect(), the entity events and the
// entities themselves, although the library provides all of them at runtime (lib/client.js and
// lib/entities/Base.js).

import type { EventEmitter } from 'node:events';
import type {
    DeviceInfoResponse,
    ListEntitiesEntityResponse,
    SubscribeLogsResponse,
} from '@2colors/esphome-native-api';

declare module '@2colors/esphome-native-api' {
    /**
     * Entity the Client creates for every entity a device announces (lib/entities/Base.js).
     * Config and state fields differ per entity type, the code reads them depending on entity.type.
     */
    interface Entity extends EventEmitter {
        /** Key of the entity, unique per device */
        id: number;
        /** Entity class name, e.g. "Sensor", "Switch" or "Light" */
        type: string;
        name: string;
        config: ListEntitiesEntityResponse & Record<string, any>;
        state?: Record<string, any>;
        on(event: 'state', listener: (state: Record<string, any>) => void): this;
        /** Emitted without an argument when the connection is gone */
        on(event: 'destroyed', listener: (state?: unknown) => void): this;
        on(event: 'error', listener: (error: unknown) => void): this;
    }

    interface Client {
        /** Entities of the device by key */
        entities: Record<number, Entity>;
        connected: boolean;
        initialized: boolean;
        connect(): void;
        disconnect(): void;
        on(event: 'newEntity', listener: (entity: Entity) => void): this;
        on(event: 'deviceInfo', listener: (deviceInfo: DeviceInfoResponse) => void): this;
        on(event: 'logs', listener: (data: SubscribeLogsResponse) => void): this;
        on(event: 'connected' | 'disconnected' | 'initialized' | 'reconnect', listener: () => void): this;
    }

    interface Connection {
        /** Subscribes to state changes of all entities */
        subscribeStatesService(): void;
    }
}
