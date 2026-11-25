import { expect } from 'chai';
import { id_to_type, pb } from '@2colors/esphome-native-api/lib/utils/messages';
import {
    protoMessageIds,
    registerMissingMessages,
    registerNativeApiMessages,
    unsupportedEntityType,
} from './nativeApiMessages';

const proto = `
message HelloRequest {
  option (id) = 1;
  string client_info = 1;
}
// ==================== DATETIME TIME ====================
message ListEntitiesTimeResponse {
  option (id) = 103;
  option (base_class) = "InfoResponseProtoMessage";
  string object_id = 1;
}
message NoClassResponse {
  option (id) = 200;
}
message NoIdMessage {
  string value = 1;
}
`;

/**
 * Plaintext frame of the native API: 0, length, message id, payload
 *
 * @param messageId - Message id from api.proto (below 128)
 * @param payload - Serialized message (below 128 bytes)
 */
function plaintextFrame(messageId: number, payload: Uint8Array): Buffer {
    return Buffer.from([0, payload.length, messageId, ...payload]);
}

describe('nativeApiMessages', () => {
    describe('protoMessageIds()', () => {
        it('lists the id of every message with an id option', () => {
            expect([...protoMessageIds(proto)]).to.deep.equal([
                ['1', 'HelloRequest'],
                ['103', 'ListEntitiesTimeResponse'],
                ['200', 'NoClassResponse'],
            ]);
        });
    });

    describe('registerMissingMessages()', () => {
        it('adds messages missing in the id table that have a protobuf class', () => {
            const idToType: Record<string, string> = { 1: 'HelloRequest' };
            const typeToId: Record<string, string> = { HelloRequest: '1' };
            const hello = { type: 'HelloRequest', id: '1' };
            const time: { type?: string; id?: string } = {};

            const added = registerMissingMessages(proto, idToType, typeToId, {
                HelloRequest: hello,
                ListEntitiesTimeResponse: time,
            });

            expect(added).to.deep.equal(['ListEntitiesTimeResponse']);
            expect(idToType).to.deep.equal({ 1: 'HelloRequest', 103: 'ListEntitiesTimeResponse' });
            expect(typeToId).to.deep.equal({ HelloRequest: '1', ListEntitiesTimeResponse: '103' });
            expect(time).to.deep.equal({ type: 'ListEntitiesTimeResponse', id: '103' });
            expect(hello).to.deep.equal({ type: 'HelloRequest', id: '1' });
        });
    });

    describe('registerNativeApiMessages()', () => {
        it('lets the library decode a datetime entity of type time (id 103) instead of dropping the connection', () => {
            registerNativeApiMessages();
            expect(id_to_type[103]).to.equal('ListEntitiesTimeResponse');

            // eslint-disable-next-line @typescript-eslint/no-require-imports -- internal module of the library without types
            const PlaintextFrameHelper = require('@2colors/esphome-native-api/lib/utils/plaintextFrameHelper') as new (
                host: string,
                port: number,
            ) => NodeJS.EventEmitter & { onData(data: Buffer): void; end(): void; destroy(): void };
            const TimeClass = pb.ListEntitiesTimeResponse as unknown as new () => {
                setObjectId(value: string): void;
                setName(value: string): void;
                serializeBinary(): Uint8Array;
            };
            const config = new TimeClass();
            config.setObjectId('schedule_start');
            config.setName('Schedule start');

            const helper = new PlaintextFrameHelper('127.0.0.1', 6053);
            const messages: string[] = [];
            const errors: unknown[] = [];
            helper.on('message', (message: { constructor: { type: string } }) =>
                messages.push(message.constructor.type),
            );
            helper.on('error', (e: unknown) => errors.push(e));
            try {
                helper.onData(plaintextFrame(103, config.serializeBinary()));
            } finally {
                helper.destroy();
            }

            expect(errors).to.deep.equal([]);
            expect(messages).to.deep.equal(['ListEntitiesTimeResponse']);
        });
    });

    describe('unsupportedEntityType()', () => {
        const supported = new Set(['Sensor', 'Switch']);

        it('returns the entity type of a ListEntities message without entity class', () => {
            expect(unsupportedEntityType('ListEntitiesTimeResponse', supported)).to.equal('Time');
            expect(unsupportedEntityType('ListEntitiesValveResponse', supported)).to.equal('Valve');
        });

        it('returns undefined for supported entity types and other messages', () => {
            expect(unsupportedEntityType('ListEntitiesSensorResponse', supported)).to.equal(undefined);
            expect(unsupportedEntityType('ListEntitiesDoneResponse', supported)).to.equal(undefined);
            expect(unsupportedEntityType('ListEntitiesServicesResponse', supported)).to.equal(undefined);
            expect(unsupportedEntityType('TimeStateResponse', supported)).to.equal(undefined);
        });

        it('knows the entity classes of the library', () => {
            expect(unsupportedEntityType('ListEntitiesLightResponse')).to.equal(undefined);
            expect(unsupportedEntityType('ListEntitiesTimeResponse')).to.equal('Time');
        });
    });
});
