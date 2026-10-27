import { expect } from 'chai';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import YamlFileManager from './yamlFileManager';

/** Minimal adapter: the manager only uses instance and log */
function createAdapter(): ioBroker.Adapter {
    const noop = (): void => {};
    return { instance: 0, log: { info: noop, warn: noop, error: noop, debug: noop } } as unknown as ioBroker.Adapter;
}

describe('YAML File Management', () => {
    const manager = new YamlFileManager(createAdapter());

    describe('validateFilename()', () => {
        it('accepts .yaml and .yml file names', () => {
            for (const name of ['test.yaml', 'device.yml', 'my-config.yaml']) {
                expect(manager.validateFilename(name), name).to.be.true;
            }
        });

        it('rejects other extensions, empty values and non-strings', () => {
            for (const name of ['test.txt', 'config', 'file.json', '', undefined, null, 42]) {
                expect(manager.validateFilename(name), String(name)).to.be.false;
            }
        });

        it('rejects path traversal and path separators', () => {
            for (const name of ['../secrets.yaml', 'sub/device.yaml', 'sub\\device.yaml', '..yaml']) {
                expect(manager.validateFilename(name), name).to.be.false;
            }
        });
    });

    describe('formatFileSize()', () => {
        it('formats bytes, KB and MB', () => {
            expect(manager.formatFileSize(0)).to.equal('0 Bytes');
            expect(manager.formatFileSize(500)).to.equal('500 Bytes');
            expect(manager.formatFileSize(1024)).to.equal('1 KB');
            expect(manager.formatFileSize(1536)).to.equal('1.5 KB');
            expect(manager.formatFileSize(1024 * 1024)).to.equal('1 MB');
        });
    });

    describe('file operations', () => {
        let dir: string;
        let fileManager: YamlFileManager;

        beforeEach(async () => {
            dir = await mkdtemp(path.join(tmpdir(), 'esphome-yaml-'));
            fileManager = new YamlFileManager(createAdapter());
            fileManager.getESPHomeDirectory = (): string => dir;
        });

        afterEach(async () => {
            await rm(dir, { recursive: true, force: true });
        });

        it('uploads, lists, downloads and deletes a file', async () => {
            const content = 'esphome:\n  name: test\n';

            const upload = await fileManager.uploadYamlFile('test.yaml', content);
            expect(upload).to.deep.equal({ success: true, message: 'File test.yaml uploaded successfully' });
            expect(await readFile(path.join(dir, 'test.yaml'), 'utf8')).to.equal(content);

            const files = await fileManager.listYamlFiles();
            expect(files.map(file => file.filename)).to.deep.equal(['test.yaml']);
            expect(files[0].size).to.equal(`${Buffer.byteLength(content)} Bytes`);

            const download = await fileManager.downloadYamlFile('test.yaml');
            expect(download).to.deep.equal({ success: true, content, filename: 'test.yaml' });

            const deletion = await fileManager.deleteYamlFile('test.yaml');
            expect(deletion).to.deep.equal({ success: true, message: 'File test.yaml deleted successfully' });
            expect(await fileManager.listYamlFiles()).to.deep.equal([]);
        });

        it('lists only YAML files', async () => {
            await writeFile(path.join(dir, 'a.yaml'), '');
            await writeFile(path.join(dir, 'b.yml'), '');
            await writeFile(path.join(dir, 'notes.txt'), '');

            const names = (await fileManager.listYamlFiles()).map(file => file.filename).sort();
            expect(names).to.deep.equal(['a.yaml', 'b.yml']);
        });

        it('creates the directory on upload and returns an empty list if it does not exist', async () => {
            await rm(dir, { recursive: true, force: true });
            expect(await fileManager.listYamlFiles()).to.deep.equal([]);

            expect((await fileManager.uploadYamlFile('new.yaml', 'x')).success).to.be.true;
            expect(await readFile(path.join(dir, 'new.yaml'), 'utf8')).to.equal('x');
        });

        it('refuses invalid file names without touching the file system', async () => {
            expect((await fileManager.uploadYamlFile('../evil.yaml', 'x')).success).to.be.false;
            expect(await fileManager.downloadYamlFile('../evil.yaml')).to.deep.equal({
                success: false,
                error: 'Invalid filename',
            });
            expect(await fileManager.deleteYamlFile('evil.txt')).to.deep.equal({
                success: false,
                error: 'Invalid filename',
            });
        });

        it('reports missing files on download and delete', async () => {
            expect(await fileManager.downloadYamlFile('missing.yaml')).to.deep.equal({
                success: false,
                error: 'File not found: missing.yaml',
            });
            expect(await fileManager.deleteYamlFile('missing.yaml')).to.deep.equal({
                success: false,
                error: 'File not found: missing.yaml',
            });
        });
    });
});
