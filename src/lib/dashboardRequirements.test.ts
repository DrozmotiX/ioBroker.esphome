import { expect } from 'chai';
import type { DashboardAdapter } from './dashboard';
import {
    compareVersions,
    findEsphomeMinimum,
    findPinnedVersion,
    resolveRequirements,
    usesDeviceBuilder,
} from './dashboardRequirements';

/**
 * Minimal adapter: resolveRequirements() only uses states and log
 *
 * @param states - state values by ID, shared between adapters to test the cache
 */
function createAdapter(states: Record<string, string> = {}): DashboardAdapter {
    const noop = (): void => {};
    return {
        log: { info: noop, warn: noop, error: noop, debug: noop },
        getStateAsync: (id: string) => Promise.resolve(id in states ? { val: states[id] } : null),
        stateSetCreate: (id: string, _name: string, value: string) => {
            states[id] = value;
            return Promise.resolve();
        },
    } as unknown as DashboardAdapter;
}

/** Device Builder releases on PyPI with the minimum ESPHome version of their "esphome" extra */
const deviceBuilderReleases: Record<string, { minimum: string; yanked?: boolean }> = {
    '1.0.0': { minimum: '2024.1.0' },
    '1.9.6': { minimum: '2026.7.4' },
    '1.20.0': { minimum: '2026.9.1' },
    '1.25.0': { minimum: '2026.10.0', yanked: true },
    '1.26.0': { minimum: '2026.10.0' },
    '1.27.0b1': { minimum: '2026.11.0' },
};

/**
 * Replace fetch with a fake PyPI
 *
 * @param requested - collects the requested URLs
 * @returns function restoring the real fetch
 */
function fakePypi(requested: string[]): () => void {
    const realFetch = globalThis.fetch;
    const builderInfo = (version: string): { version: string; requires_dist: string[] } => ({
        version,
        requires_dist: ['aiohttp>=3.9.0', `esphome>=${deviceBuilderReleases[version].minimum}; extra == "esphome"`],
    });
    globalThis.fetch = (input: string | URL | Request): Promise<Response> => {
        const url = input instanceof Request ? input.url : input.toString();
        requested.push(url);
        const path = url.replace('https://pypi.org/pypi/', '').replace('/json', '');
        let body: unknown;
        if (path === 'esphome/2026.6.5') {
            body = { info: { version: '2026.6.5', requires_dist: ['platformio==6.1.19', 'pillow==12.2.0'] } };
        } else if (path.startsWith('esphome/')) {
            body = { info: { version: path.split('/')[1], requires_dist: ['pillow==12.3.0'] } };
        } else if (path === 'esphome-device-builder') {
            body = {
                info: builderInfo('1.26.0'),
                releases: Object.fromEntries(
                    Object.entries(deviceBuilderReleases).map(([version, { yanked }]) => [
                        version,
                        [{ yanked: !!yanked }],
                    ]),
                ),
            };
        } else if (path.startsWith('esphome-device-builder/')) {
            body = { info: builderInfo(path.split('/')[1]) };
        } else {
            return Promise.resolve(new Response('not found', { status: 404 }));
        }
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    };
    return () => {
        globalThis.fetch = realFetch;
    };
}

describe('ESPHome Dashboard requirements', () => {
    describe('compareVersions()', () => {
        it('compares calendar and semantic versions numerically', () => {
            expect(compareVersions('2026.10.0', '2026.7.0')).to.be.greaterThan(0);
            expect(compareVersions('2026.6.5', '2026.7.0')).to.be.lessThan(0);
            expect(compareVersions('12.2', '12.2.0')).to.equal(0);
        });
    });

    describe('usesDeviceBuilder()', () => {
        it('is used from ESPHome 2026.7.0 on and for the newest (unknown) version', () => {
            expect(usesDeviceBuilder('2026.6.5')).to.be.false;
            expect(usesDeviceBuilder('2025.12.0')).to.be.false;
            expect(usesDeviceBuilder('2026.7.0')).to.be.true;
            expect(usesDeviceBuilder('2026.10.1')).to.be.true;
            expect(usesDeviceBuilder('')).to.be.true;
        });
    });

    describe('findPinnedVersion()', () => {
        it('finds an exactly pinned requirement', () => {
            expect(findPinnedVersion(['platformio==6.1.19', 'Pillow==12.3.0'], 'pillow')).to.equal('12.3.0');
        });

        it('ignores ranges and missing requirements', () => {
            expect(findPinnedVersion(['pillow>=10.0.0'], 'pillow')).to.be.undefined;
            expect(findPinnedVersion(['platformio==6.1.19'], 'pillow')).to.be.undefined;
        });
    });

    describe('findEsphomeMinimum()', () => {
        it('reads the minimum ESPHome version of the "esphome" extra', () => {
            expect(findEsphomeMinimum(['aiohttp>=3.9.0', 'esphome>=2026.10.0; extra == "esphome"'])).to.equal(
                '2026.10.0',
            );
            expect(findEsphomeMinimum(['aiohttp>=3.9.0'])).to.be.undefined;
        });
    });

    describe('resolveRequirements()', () => {
        let requested: string[];
        let restoreFetch: () => void;

        beforeEach(() => {
            requested = [];
            restoreFetch = fakePypi(requested);
        });

        afterEach(() => restoreFetch());

        it('uses the Pillow version ESPHome pins and no Device Builder before ESPHome 2026.7.0', async () => {
            expect(await resolveRequirements(createAdapter(), '2026.6.5')).to.deep.equal({ pillow: '12.2.0' });
        });

        it('picks the newest Device Builder with the newest ESPHome from the project metadata alone', async () => {
            expect(await resolveRequirements(createAdapter(), '2026.10.1')).to.deep.equal({
                pillow: '12.3.0',
                deviceBuilder: '1.26.0',
            });
            expect(requested).to.have.length(2);
        });

        it('picks the newest Device Builder supporting an older ESPHome, skipping yanked releases', async () => {
            expect((await resolveRequirements(createAdapter(), '2026.7.4')).deviceBuilder).to.equal('1.9.6');
            expect((await resolveRequirements(createAdapter(), '2026.9.1')).deviceBuilder).to.equal('1.20.0');
            expect((await resolveRequirements(createAdapter(), '2026.7.0')).deviceBuilder).to.equal('1.0.0');
            expect(requested.some(url => url.includes('1.25.0') || url.includes('1.27.0b1'))).to.be.false;
        });

        it('resolves each ESPHome version once and uses the cache afterwards', async () => {
            const states: Record<string, string> = {};
            await resolveRequirements(createAdapter(states), '2026.10.1');
            requested.length = 0;

            const resolved = await resolveRequirements(createAdapter(states), '2026.10.1');
            expect(resolved).to.deep.equal({ pillow: '12.3.0', deviceBuilder: '1.26.0' });
            expect(requested).to.be.empty;
        });

        it('returns nothing when PyPI cannot be reached and nothing is cached', async () => {
            globalThis.fetch = () => Promise.reject(new Error('offline'));
            expect(await resolveRequirements(createAdapter(), '2026.10.1')).to.deep.equal({});
        });
    });
});
