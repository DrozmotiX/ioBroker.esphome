import { Entities } from '@2colors/esphome-native-api/lib/entities';
import { id_to_type, pb, type_to_id } from '@2colors/esphome-native-api/lib/utils/messages';
import { readFileSync } from 'node:fs';

/**
 * Message id and name of every message in an api.proto file
 *
 * @param proto - Content of the api.proto file
 * @returns Message name by message id
 */
export function protoMessageIds(proto: string): Map<string, string> {
    const ids = new Map<string, string>();
    const messagePattern = /message\s+(\w+)\s*\{\s*option\s*\(id\)\s*=\s*(\d+)\s*;/g;
    for (const match of proto.matchAll(messagePattern)) {
        ids.set(match[2], match[1]);
    }
    return ids;
}

/**
 * Adds the messages of api.proto the library has a protobuf class for but no id in its id table.
 *
 * The library decodes a frame by looking up the message id in id_to_type. A message missing there
 * (for example ListEntitiesTimeResponse, id 103, of a datetime entity) cannot be decoded, the library
 * then closes the connection and the device reconnects in a loop. Once the id is known, the library
 * decodes the message and ignores it if it has no entity class for it.
 *
 * @param proto - Content of the api.proto file of the library
 * @param idToType - Id table of the library, completed in place
 * @param typeToId - Reverse table of the library, completed in place
 * @param classes - Generated protobuf classes of the library
 * @returns The names of the messages added
 */
export function registerMissingMessages(
    proto: string,
    idToType: Record<string, string>,
    typeToId: Record<string, string>,
    classes: Record<string, { type?: string; id?: string } | undefined>,
): string[] {
    const added: string[] = [];
    for (const [id, type] of protoMessageIds(proto)) {
        const messageClass = classes[type];
        if (idToType[id] !== undefined || messageClass === undefined) {
            continue;
        }
        idToType[id] = type;
        typeToId[type] = id;
        messageClass.type = type;
        messageClass.id = id;
        added.push(type);
    }
    return added;
}

/**
 * Completes the message id table of `@2colors/esphome-native-api` with the messages of its own api.proto,
 * see registerMissingMessages(). Call once before connecting to devices.
 *
 * @returns The names of the messages added
 */
export function registerNativeApiMessages(): string[] {
    const proto = readFileSync(require.resolve('@2colors/esphome-native-api/lib/protoc/api.proto'), 'utf8');
    return registerMissingMessages(proto, id_to_type, type_to_id, pb);
}

/**
 * Entity type announced by a ListEntities message the library has no entity class for.
 *
 * @param messageType - Name of a message received from the device, e.g. "ListEntitiesTimeResponse"
 * @param supportedTypes - Entity class names of the library, e.g. "Sensor"
 * @returns The entity type ("Time"), or undefined for supported types and other messages
 */
export function unsupportedEntityType(
    messageType: string,
    supportedTypes: ReadonlySet<string> = new Set(Object.keys(Entities)),
): string | undefined {
    const match = /^ListEntities(\w+)Response$/.exec(messageType);
    if (!match || match[1] === 'Done' || match[1] === 'Services' || supportedTypes.has(match[1])) {
        return undefined;
    }
    return match[1];
}
