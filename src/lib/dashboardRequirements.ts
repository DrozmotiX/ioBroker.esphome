/**
 * Python packages installed through autopy for the integrated ESPHome Dashboard
 *
 * ESPHome brings the Pillow version it needs itself (pinned exactly since ESPHome 2024.12), and
 * ESPHome 2026.7.0 removed the built-in dashboard, from this version on it is served by the separate
 * package ESPHome Device Builder (#479). Its "esphome" extra (`esphome-device-builder[esphome]`)
 * states the minimum ESPHome version of each release, so pip picks the newest Device Builder
 * supporting the installed ESPHome. Kept apart from dashboard.ts so it can be unit tested without
 * adapter-core.
 */

/** Value of the Pillow and Device Builder version settings to let pip choose the version */
export const autoDetect = 'Auto Detect';

// ESPHome 2026.7.0 removed the built-in dashboard (`esphome dashboard` only exits with an error),
// from this version on the dashboard is served by ESPHome Device Builder
const deviceBuilderSinceVersion = '2026.7.0';

/** One requirement passed to autopy's getVenv() */
export interface Requirement {
    /** Package name, optionally with extras */
    name: string;
    /** PEP 440 version specifier, empty for any version */
    version: string;
}

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
 * Whether a version setting selects a fixed version. "Always last available" is treated like
 * "Auto Detect": the newest Pillow conflicts with the version ESPHome pins.
 *
 * @param setting - configured version
 * @returns true for a fixed version
 */
function isFixedVersion(setting: string): boolean {
    return !!setting && setting !== autoDetect && setting !== 'Always last available';
}

/**
 * Requirements for autopy's getVenv(). getVenv() has to be called with `upgrade: true`, otherwise pip
 * keeps an installed Device Builder when another ESPHome version is selected.
 *
 * @param esphomeVersion - ESPHome version, empty for the newest release
 * @param pillowVersion - configured Pillow version, "Auto Detect" to leave it to ESPHome
 * @param deviceBuilderVersion - configured Device Builder version, "Auto Detect" to let pip choose
 * @returns the requirements, "version" is set on each: autopy passes `${name}${version}` to pip
 */
export function buildRequirements(
    esphomeVersion: string,
    pillowVersion: string,
    deviceBuilderVersion: string,
): Requirement[] {
    const requirements: Requirement[] = [{ name: 'esphome', version: esphomeVersion ? `==${esphomeVersion}` : '' }];
    // Only for legacy setups, every current ESPHome release installs the Pillow version it pins
    if (isFixedVersion(pillowVersion)) {
        requirements.push({ name: 'pillow', version: `==${pillowVersion}` });
    }
    if (usesDeviceBuilder(esphomeVersion)) {
        requirements.push(
            isFixedVersion(deviceBuilderVersion)
                ? { name: 'esphome-device-builder', version: `==${deviceBuilderVersion}` }
                : { name: 'esphome-device-builder[esphome]', version: '' },
        );
    }
    return requirements;
}
