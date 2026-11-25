// Internal modules of @2colors/esphome-native-api the adapter reads directly (see src/lib/nativeApiMessages.ts).
// The package ships no types for them.

declare module '@2colors/esphome-native-api/lib/utils/messages' {
    /** Protobuf message class of the generated api_pb.js; type and id are set for every message in id_to_type */
    interface ProtoMessageClass {
        type?: string;
        id?: string;
    }
    /** Message id (as in api.proto) to message name, used to decode every frame the device sends */
    export const id_to_type: Record<string, string>;
    /** Message name to id */
    export const type_to_id: Record<string, string>;
    /** All generated protobuf message classes by name */
    export const pb: Record<string, ProtoMessageClass | undefined>;
}

declare module '@2colors/esphome-native-api/lib/entities' {
    /** Entity classes the library creates entities for, by class name (e.g. "Sensor") */
    export const Entities: Record<string, unknown>;
}
