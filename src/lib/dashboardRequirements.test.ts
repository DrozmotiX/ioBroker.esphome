import { expect } from 'chai';
import {
    autoDetect,
    buildRequirements,
    compareVersions,
    normalizeVersion,
    usesDeviceBuilder,
} from './dashboardRequirements';

describe('ESPHome Dashboard requirements', () => {
    describe('compareVersions()', () => {
        it('compares calendar and semantic versions numerically', () => {
            expect(compareVersions('2026.10.0', '2026.7.0')).to.be.greaterThan(0);
            expect(compareVersions('2026.6.5', '2026.7.0')).to.be.lessThan(0);
            expect(compareVersions('12.2', '12.2.0')).to.equal(0);
        });
    });

    describe('normalizeVersion()', () => {
        it('keeps a version selected from the list unchanged', () => {
            expect(normalizeVersion('2026.6.5')).to.equal('2026.6.5');
            expect(normalizeVersion('Always last available')).to.equal('Always last available');
        });

        it('cleans up a typed version', () => {
            expect(normalizeVersion('  2026.7.0b1 ')).to.equal('2026.7.0b1');
            expect(normalizeVersion('v2026.7.0')).to.equal('2026.7.0');
            expect(normalizeVersion('V2026.7.0')).to.equal('2026.7.0');
        });

        it('returns an empty string when nothing is configured', () => {
            expect(normalizeVersion(undefined)).to.equal('');
            expect(normalizeVersion(null)).to.equal('');
            expect(normalizeVersion('   ')).to.equal('');
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

    describe('buildRequirements()', () => {
        it('leaves Pillow to ESPHome and the Device Builder version to pip by default', () => {
            expect(buildRequirements('2026.10.1', autoDetect, autoDetect)).to.deep.equal([
                { name: 'esphome', version: '==2026.10.1' },
                { name: 'esphome-device-builder[esphome]', version: '' },
            ]);
        });

        it('installs no Device Builder before ESPHome 2026.7.0', () => {
            expect(buildRequirements('2026.6.5', autoDetect, autoDetect)).to.deep.equal([
                { name: 'esphome', version: '==2026.6.5' },
            ]);
        });

        it('installs the selected Pillow and Device Builder versions', () => {
            expect(buildRequirements('2026.10.1', '12.3.0', '1.25.0')).to.deep.equal([
                { name: 'esphome', version: '==2026.10.1' },
                { name: 'pillow', version: '==12.3.0' },
                { name: 'esphome-device-builder', version: '==1.25.0' },
            ]);
        });

        it('treats "Always last available" and an empty setting like "Auto Detect"', () => {
            expect(buildRequirements('', 'Always last available', '')).to.deep.equal([
                { name: 'esphome', version: '' },
                { name: 'esphome-device-builder[esphome]', version: '' },
            ]);
        });
    });
});
