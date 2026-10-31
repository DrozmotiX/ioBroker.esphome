import { expect } from 'chai';
import { connectedDeviceNames, type DeviceConnection, isDeviceOnline } from './connectionState';

/**
 * Connection details of a connected device, with the given changes
 *
 * @param changes - fields to override
 */
function device(changes: Partial<DeviceConnection> = {}): DeviceConnection {
    return {
        connected: true,
        connecting: false,
        connectionError: false,
        connectStatus: 'initialized',
        deviceFriendlyName: 'kitchen-light',
        ...changes,
    };
}

describe('connection state', () => {
    describe('isDeviceOnline()', () => {
        it('is only true for a connected device without error that is not (re)connecting', () => {
            expect(isDeviceOnline(device())).to.be.true;
            expect(isDeviceOnline(device({ connected: false }))).to.be.false;
            expect(isDeviceOnline(device({ connecting: true }))).to.be.false;
            expect(isDeviceOnline(device({ connectionError: true }))).to.be.false;
        });
    });

    describe('connectedDeviceNames()', () => {
        it('lists the connected devices by name, sorted', () => {
            expect(
                connectedDeviceNames([
                    ['192.0.2.1', device({ deviceFriendlyName: 'living-room' })],
                    ['192.0.2.2', device({ deviceFriendlyName: 'garage-door' })],
                    ['192.0.2.3', device({ deviceFriendlyName: 'kitchen-light' })],
                ]),
            ).to.deep.equal(['garage-door', 'kitchen-light', 'living-room']);
        });

        it('leaves out devices that are not connected', () => {
            expect(
                connectedDeviceNames([
                    ['192.0.2.1', device({ deviceFriendlyName: 'living-room' })],
                    ['192.0.2.2', device({ deviceFriendlyName: 'garage-door', connected: false })],
                    ['192.0.2.3', device({ deviceFriendlyName: 'unreachable', connectionError: true })],
                    ['192.0.2.4', device({ deviceFriendlyName: 'starting', connecting: true })],
                    ['192.0.2.5', device({ deviceFriendlyName: 'new', connectStatus: 'Initialisation needed' })],
                ]),
            ).to.deep.equal(['living-room']);
        });

        it('uses the IP address while the name is not known yet', () => {
            expect(
                connectedDeviceNames([
                    ['192.0.2.1', device({ deviceFriendlyName: 'Initialisation needed' })],
                    ['192.0.2.2', device({ deviceFriendlyName: null })],
                ]),
            ).to.deep.equal(['192.0.2.1', '192.0.2.2']);
        });

        it('is empty without connected devices', () => {
            expect(connectedDeviceNames([])).to.deep.equal([]);
            expect(connectedDeviceNames([['192.0.2.1', device({ connected: false })]])).to.deep.equal([]);
        });
    });
});
