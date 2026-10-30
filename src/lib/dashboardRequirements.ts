/**
 * Python packages installed next to ESPHome for the integrated ESPHome Dashboard
 *
 * ESPHome pins Pillow exactly, so pip cannot install any other Pillow version next to it. ESPHome
 * 2026.7.0 removed the built-in dashboard, from this version on it is served by the separate package
 * ESPHome Device Builder, whose releases each support ESPHome from a minimum version on (#479).
 * The versions are looked up on PyPI. Kept apart from dashboard.ts so it can be unit tested without
 * adapter-core.
 */

import type { DashboardAdapter } from './dashboard';

// ESPHome 2026.7.0 removed the built-in dashboard (`esphome dashboard` only exits with an error),
// from this version on the dashboard is served by ESPHome Device Builder
const deviceBuilderSinceVersion = '2026.7.0';

/** State caching the Python packages resolved for each ESPHome version, see resolveRequirements() */
export const requirementsCacheState = '_ESPHomeDashboard.requirementsCache';

/** Python packages installed next to one ESPHome version */
export interface DashboardRequirements {
    /** Pillow version ESPHome pins */
    pillow?: string;
    /** Newest ESPHome Device Builder version supporting this ESPHome version */
    deviceBuilder?: string;
}

/** The parts of the PyPI JSON API (https://pypi.org/pypi/<project>[/<version>]/json) used here */
interface PypiProject {
    info: { version: string; requires_dist: string[] | null };
    releases?: Record<string, { yanked?: boolean }[]>;
}

/** Adapter functions used to cache the resolved versions and to log */
type RequirementsAdapter = Pick<DashboardAdapter, 'log' | 'getStateAsync' | 'stateSetCreate'>;

/**
 * Compare two numeric versions like 2026.7.0 or 12.2.0
 *
 * @param a - first version
 * @param b - second version
 * @returns negative when a is older than b, 0 when equal, positive when a is newer
 */
export function compareVersions(a: string, b: string): number {
    const aParts = a.split('.').map(Number);
    const bParts = b.split('.').map(Number);
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
        const aVal = aParts[i] || 0;
        const bVal = bParts[i] || 0;
        if (aVal !== bVal) {
            return aVal - bVal;
        }
    }
    return 0;
}

/**
 * Whether an ESPHome version needs ESPHome Device Builder for the dashboard
 *
 * @param esphomeVersion - ESPHome version, empty when the newest release is installed
 * @returns true from ESPHome 2026.7.0 on and for an unknown (newest) version
 */
export function usesDeviceBuilder(esphomeVersion: string): boolean {
    return !esphomeVersion || compareVersions(esphomeVersion, deviceBuilderSinceVersion) >= 0;
}

/**
 * Version a requirement of a Python package is pinned to with "==", e.g. "pillow==12.3.0"
 *
 * @param requiresDist - requires_dist of the package metadata on PyPI
 * @param name - name of the required package
 * @returns the pinned version, undefined when the requirement is missing or not pinned exactly
 */
export function findPinnedVersion(requiresDist: string[], name: string): string | undefined {
    for (const requirement of requiresDist) {
        const match = /^([A-Za-z0-9._-]+)\s*==\s*([0-9][0-9.]*)\s*$/.exec(requirement);
        if (match && match[1].toLowerCase() === name.toLowerCase()) {
            return match[2];
        }
    }
    return undefined;
}

/**
 * Minimum ESPHome version an ESPHome Device Builder release supports, taken from its "esphome" extra,
 * e.g. `esphome>=2026.10.0; extra == "esphome"`
 *
 * @param requiresDist - requires_dist of the ESPHome Device Builder release on PyPI
 * @returns the minimum version, undefined when the release states none
 */
export function findEsphomeMinimum(requiresDist: string[]): string | undefined {
    for (const requirement of requiresDist) {
        const match = /^esphome\s*>=\s*([0-9][0-9.]*)\s*;\s*extra\s*==\s*["']esphome["']/i.exec(requirement);
        if (match) {
            return match[1];
        }
    }
    return undefined;
}

/**
 * Fetch the metadata of a Python package from PyPI
 *
 * @param project - package name, optionally followed by "/<version>" for one release
 * @returns the package metadata
 */
async function fetchPypiProject(project: string): Promise<PypiProject> {
    const response = await fetch(`https://pypi.org/pypi/${project}/json`);
    if (!response.ok) {
        throw new Error(`PyPI request for ${project} failed with status ${response.status}: ${response.statusText}`);
    }
    return (await response.json()) as PypiProject;
}

/**
 * Newest ESPHome Device Builder release supporting an ESPHome version. Every Device Builder release
 * states the minimum ESPHome version it supports, which only ever increases with newer releases.
 *
 * @param esphomeVersion - ESPHome version which will be installed
 * @returns the Device Builder version, undefined when no release supports this ESPHome version
 */
async function findDeviceBuilderVersion(esphomeVersion: string): Promise<string | undefined> {
    const project = await fetchPypiProject('esphome-device-builder');
    // Newest first, without pre-releases and releases which were removed or yanked
    const versions = Object.entries(project.releases ?? {})
        .filter(([version, files]) => /^\d+(\.\d+)*$/.test(version) && files.some(file => !file.yanked))
        .map(([version]) => version)
        .sort((a, b) => compareVersions(b, a));

    const supports = (requiresDist: string[] | null): boolean => {
        const minimum = findEsphomeMinimum(requiresDist ?? []);
        return !minimum || compareVersions(minimum, esphomeVersion) <= 0;
    };

    // The project metadata is the one of the newest release, which is all that is needed for
    // the newest ESPHome version
    if (versions[0] === project.info.version && supports(project.info.requires_dist)) {
        return versions[0];
    }

    // Binary search for the first (newest) release supporting this ESPHome version
    let low = 0;
    let high = versions.length;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const release = await fetchPypiProject(`esphome-device-builder/${versions[middle]}`);
        if (supports(release.info.requires_dist)) {
            high = middle;
        } else {
            low = middle + 1;
        }
    }
    return versions[low];
}

/**
 * Python packages to install next to an ESPHome version: the Pillow version ESPHome pins and,
 * from ESPHome 2026.7.0 on, the matching ESPHome Device Builder.
 *
 * Resolved once per ESPHome version and cached, so a restart installs the same versions and also
 * works without a connection to PyPI. Selecting another ESPHome version resolves again,
 * Dashboard.clearAutopyCache() clears the cache.
 *
 * @param adapter - the adapter, used for the cache state and to log
 * @param esphomeVersion - ESPHome version which will be installed
 * @returns the resolved versions, empty when PyPI could not be reached and nothing is cached
 */
export async function resolveRequirements(
    adapter: RequirementsAdapter,
    esphomeVersion: string,
): Promise<DashboardRequirements> {
    let cache: Record<string, DashboardRequirements> = {};
    try {
        const cachedState = await adapter.getStateAsync(requirementsCacheState);
        if (cachedState && cachedState.val) {
            cache = JSON.parse(String(cachedState.val)) as Record<string, DashboardRequirements>;
        }
    } catch {
        // No or unreadable cache, resolve again
    }
    const cached = cache[esphomeVersion];
    if (cached && (cached.deviceBuilder || !usesDeviceBuilder(esphomeVersion))) {
        return cached;
    }

    try {
        const esphome = await fetchPypiProject(`esphome/${esphomeVersion}`);
        const resolved: DashboardRequirements = {
            pillow: findPinnedVersion(esphome.info.requires_dist ?? [], 'pillow'),
        };
        if (usesDeviceBuilder(esphomeVersion)) {
            resolved.deviceBuilder = await findDeviceBuilderVersion(esphomeVersion);
        }
        adapter.log.debug(
            `Resolved requirements of ESPHome ${esphomeVersion}: Pillow ${resolved.pillow}, ESPHome Device Builder ${resolved.deviceBuilder}`,
        );

        cache[esphomeVersion] = resolved;
        await adapter.stateSetCreate(requirementsCacheState, 'requirementsCache', JSON.stringify(cache));
        return resolved;
    } catch (error) {
        const reason = error instanceof Error && error.message ? error.message : String(error);
        adapter.log.warn(`Unable to resolve the Python packages needed by ESPHome ${esphomeVersion}: ${reason}`);
        return cached ?? {};
    }
}
