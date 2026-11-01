/**
 * Metadata of a state, looked up by the state name in stateSetCreate() of main.ts.
 * Only name, role and states are used there, the type is derived from the value itself.
 */
interface StateAttribute {
    /** Readable name / description of the state */
    name: string;
    type: ioBroker.CommonType;
    read: boolean;
    write: boolean;
    /** State role, see https://www.iobroker.net/#en/documentation/dev/stateroles.md */
    role: string;
    /** Possible values of an enum-like state with their labels (common.states) */
    states?: Record<string, string>;
}

const stateAttrb: Record<string, StateAttribute> = {
    Position: {
        name: 'Position of cover',
        type: 'number',
        read: true,
        write: false,
        role: 'level.blind',
    },
    Tilt: {
        name: 'Tilt of cover',
        type: 'number',
        read: true,
        write: false,
        role: 'level.tilt',
        // unit: 's|°|%...',
        // modify: ['multiply(3.6)', 'round(2)']
    },
    Stop: {
        name: 'STOP cover',
        type: 'boolean',
        read: true,
        write: false,
        role: 'button',
        // unit: 's|°|%...',
        // modify: ['multiply(3.6)', 'round(2)']
    },
    Button: {
        name: 'Button',
        type: 'boolean',
        read: true,
        write: true,
        role: 'button',
        // unit: 's|°|%...',
        // modify: ['multiply(3.6)', 'round(2)']
    },
    LockState: {
        name: 'Lock State',
        type: 'number',
        read: true,
        write: false,
        role: 'sensor.lock',
        // 0 = NONE, 1 = LOCKED, 2 = UNLOCKED, 3 = JAMMED, 4 = LOCKING, 5 = UNLOCKING
    },
    LockCommand: {
        name: 'Lock Command',
        type: 'number',
        read: true,
        write: true,
        role: 'level.lock',
        // 0 = UNLOCK, 1 = LOCK, 2 = OPEN
    },
    FanSpeed: {
        name: 'Fan Speed (deprecated)',
        type: 'number',
        read: true,
        write: false,
        role: 'level',
        // Deprecated: 0 = LOW, 1 = MEDIUM, 2 = HIGH
    },
    FanSpeedLevel: {
        name: 'Fan Speed Level',
        type: 'number',
        read: true,
        write: true,
        role: 'level',
        // Speed level from 0 to supported_speed_levels
    },
    FanDirection: {
        name: 'Fan Direction',
        type: 'number',
        read: true,
        write: true,
        role: 'value',
        // 0 = FORWARD, 1 = REVERSE
    },
    FanOscillating: {
        name: 'Fan Oscillating',
        type: 'boolean',
        read: true,
        write: true,
        role: 'switch',
    },
    rgbAutoWhite: {
        name: 'Auto white channel',
        type: 'boolean',
        read: true,
        write: true,
        role: 'switch',
    },
    dockerContainer: {
        name: 'ESPHome Dashboard container, removed when Docker Integration is disabled',
        type: 'string',
        read: true,
        write: false,
        role: 'text',
    },
    dashboardStatus: {
        name: 'ESPHome Dashboard status, shown in the dashboard tab',
        type: 'string',
        read: true,
        write: false,
        role: 'text',
        // Values of DashboardStatus in dashboard.ts
        states: {
            disabled: 'Disabled',
            starting: 'Starting',
            running: 'Running',
            failed: 'Failed',
            stopped: 'Stopped',
        },
    },
    dashboardStartLog: {
        name: 'Last lines of the ESPHome Dashboard start, shown in the dashboard tab until it answers',
        type: 'string',
        read: true,
        write: false,
        role: 'text',
    },
    versionPinMigrationDone: {
        name: 'Migration to pinned dashboard versions applied',
        type: 'boolean',
        read: true,
        write: false,
        role: 'indicator',
    },
};

// export = keeps the CommonJS export (module.exports = stateAttrb) that main.ts loads with require()
export = stateAttrb;
