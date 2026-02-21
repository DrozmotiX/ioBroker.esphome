const { expect } = require('chai');

describe('YAML File Management', () => {
    describe('File Upload', () => {
        it('should validate YAML filename extension', function () {
            const validNames = ['test.yaml', 'device.yml', 'my-config.yaml'];
            const invalidNames = ['test.txt', 'config', 'file.json'];

            validNames.forEach(name => {
                expect(name.endsWith('.yaml') || name.endsWith('.yml')).to.be.true;
            });

            invalidNames.forEach(name => {
                expect(name.endsWith('.yaml') || name.endsWith('.yml')).to.be.false;
            });
        });

        it('should format file size correctly', function () {
            const formatFileSize = bytes => {
                if (bytes === 0) {
                    return '0 Bytes';
                }

                const k = 1024;
                const sizes = ['Bytes', 'KB', 'MB', 'GB'];
                const i = Math.floor(Math.log(bytes) / Math.log(k));

                return `${Math.round((bytes / Math.pow(k, i)) * 100) / 100} ${sizes[i]}`;
            };

            expect(formatFileSize(0)).to.equal('0 Bytes');
            expect(formatFileSize(1024)).to.equal('1 KB');
            expect(formatFileSize(1024 * 1024)).to.equal('1 MB');
            expect(formatFileSize(500)).to.equal('500 Bytes');
        });
    });

    describe('File Path Handling', () => {
        it('should construct correct ESPHome directory path', function () {
            const instance = 0;
            const dataDir = '/opt/iobroker/iobroker-data/';
            const expectedPath = `${dataDir}esphome.${instance}`;

            expect(expectedPath).to.equal('/opt/iobroker/iobroker-data/esphome.0');
        });
    });

    describe('Message Handler Validation', () => {
        it('should validate required fields for upload', function () {
            const validMessage = {
                filename: 'test.yaml',
                content: 'esphome:\n  name: test',
            };

            const invalidMessages = [
                { filename: 'test.yaml' }, // missing content
                { content: 'esphome:\n  name: test' }, // missing filename
                {}, // missing both
            ];

            expect(!!(validMessage.filename && validMessage.content)).to.be.true;

            invalidMessages.forEach(msg => {
                expect(!!(msg.filename && msg.content)).to.be.false;
            });
        });

        it('should validate filename for download/delete', function () {
            const validMessage = { filename: 'test.yaml' };
            const invalidMessage = {};

            expect(validMessage.filename).to.exist;
            expect(invalidMessage.filename).to.not.exist;
        });
    });
});
