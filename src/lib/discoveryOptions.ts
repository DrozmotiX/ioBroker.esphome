import type { DiscoveryConfig } from '@2colors/esphome-native-api';
import { isIPv6 } from 'node:net';
import { networkInterfaces, platform } from 'node:os';

/** Options of the MDNS discovery, `type` is passed on to multicast-dns but missing in DiscoveryConfig */
export type DiscoveryOptions = DiscoveryConfig & { type?: 'udp4' | 'udp6' };

/** Multicast address of mDNS over IPv6 (link-local scope) */
const MDNS_IPV6_GROUP = 'ff02::fb';

/**
 * Options for the MDNS discovery listening on the given address.
 *
 * An IPv4 address (or 0.0.0.0 for all interfaces) is used as it is. multicast-dns needs a single network
 * interface for IPv6: the socket listens on all addresses (::) and joins the mDNS group on the interface of the
 * selected address, given as scope ("::%eth0", on Windows the interface index "::%12").
 * "::" (all IPv6 interfaces) is not possible that way and listens on all IPv4 interfaces instead.
 *
 * @param address - Selected listening address, empty for all interfaces
 * @param interfaces - Network interfaces of the host, os.networkInterfaces() by default
 * @param os - Platform, decides how the interface is given
 * @returns The options, or undefined if the IPv6 address belongs to none of the interfaces
 */
export function discoveryOptions(
    address: string | undefined,
    interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
    os: NodeJS.Platform = platform(),
): DiscoveryOptions | undefined {
    if (!address || address === '::' || !isIPv6(address)) {
        return { interface: address && address !== '::' ? address : '0.0.0.0' };
    }
    for (const [name, entries] of Object.entries(interfaces)) {
        const entry = entries?.find(candidate => candidate.family === 'IPv6' && candidate.address === address);
        if (entry) {
            return {
                type: 'udp6',
                ip: MDNS_IPV6_GROUP,
                interface: `::%${os === 'win32' ? (entry.scopeid ?? 0) : name}`,
                bind: '::',
            };
        }
    }
    return undefined;
}
