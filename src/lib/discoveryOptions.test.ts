import { expect } from 'chai';
import type { networkInterfaces } from 'node:os';
import { discoveryOptions } from './discoveryOptions';

/** Host with one interface having an IPv4, a global and a link-local IPv6 address */
const interfaces: ReturnType<typeof networkInterfaces> = {
    lo: [
        {
            address: '127.0.0.1',
            netmask: '255.0.0.0',
            family: 'IPv4',
            mac: '00:00:00:00:00:00',
            internal: true,
            cidr: '127.0.0.1/8',
        },
    ],
    eth0: [
        {
            address: '192.168.0.2',
            netmask: '255.255.255.0',
            family: 'IPv4',
            mac: '02:00:00:00:00:01',
            internal: false,
            cidr: '192.168.0.2/24',
        },
        {
            address: 'fd00::2',
            netmask: 'ffff:ffff:ffff:ffff::',
            family: 'IPv6',
            mac: '02:00:00:00:00:01',
            internal: false,
            cidr: 'fd00::2/64',
            scopeid: 0,
        },
        {
            address: 'fe80::2',
            netmask: 'ffff:ffff:ffff:ffff::',
            family: 'IPv6',
            mac: '02:00:00:00:00:01',
            internal: false,
            cidr: 'fe80::2/64',
            scopeid: 2,
        },
    ],
};

describe('discoveryOptions()', () => {
    it('listens on all IPv4 interfaces by default', () => {
        expect(discoveryOptions(undefined, interfaces)).to.deep.equal({ interface: '0.0.0.0' });
        expect(discoveryOptions('', interfaces)).to.deep.equal({ interface: '0.0.0.0' });
        expect(discoveryOptions('0.0.0.0', interfaces)).to.deep.equal({ interface: '0.0.0.0' });
        // multicast-dns cannot listen on all IPv6 interfaces at once
        expect(discoveryOptions('::', interfaces)).to.deep.equal({ interface: '0.0.0.0' });
    });

    it('listens on the selected IPv4 address', () => {
        expect(discoveryOptions('192.168.0.2', interfaces)).to.deep.equal({ interface: '192.168.0.2' });
    });

    it('joins the IPv6 mDNS group on the interface of the selected IPv6 address', () => {
        const expected = { type: 'udp6', ip: 'ff02::fb', interface: '::%eth0', bind: '::' };
        expect(discoveryOptions('fd00::2', interfaces, 'linux')).to.deep.equal(expected);
        expect(discoveryOptions('fe80::2', interfaces, 'darwin')).to.deep.equal(expected);
    });

    it('uses the interface index on Windows', () => {
        expect(discoveryOptions('fe80::2', interfaces, 'win32')).to.deep.include({ interface: '::%2' });
    });

    it('returns undefined for an IPv6 address the host does not have', () => {
        expect(discoveryOptions('fd00::99', interfaces)).to.equal(undefined);
    });
});
