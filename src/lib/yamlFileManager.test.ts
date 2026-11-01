import { expect } from 'chai';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
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

    describe('resolveDirectory()', () => {
        it('joins the data directory and the instance folder when the data directory has no trailing slash', () => {
            expect(YamlFileManager.resolveDirectory('/opt/iobroker/iobroker-data', 0)).to.equal(
                path.join('/opt/iobroker/iobroker-data', 'esphome.0'),
            );
            expect(YamlFileManager.resolveDirectory('/opt/iobroker/iobroker-data', 0)).to.not.equal(
                '/opt/iobroker/iobroker-dataesphome.0',
            );
        });

        it('does not duplicate the separator when the data directory already ends with one', () => {
            expect(YamlFileManager.resolveDirectory(`/opt/iobroker/iobroker-data${path.sep}`, '0')).to.equal(
                path.join('/opt/iobroker/iobroker-data', 'esphome.0'),
            );
        });
    });

    describe('migrateLegacyDirectory()', () => {
        let root: string;

        beforeEach(async () => {
            root = await mkdtemp(path.join(tmpdir(), 'esphome-migrate-'));
        });

        afterEach(async () => {
            await rm(root, { recursive: true, force: true });
        });

        it('does nothing in a default installation, where the data directory ends with a slash', async () => {
            const dataDir = `${path.join(root, 'iobroker-data')}${path.sep}`;
            await mkdir(path.join(dataDir, 'esphome.0'), { recursive: true });
            await writeFile(path.join(dataDir, 'esphome.0', 'a.yaml'), 'a');

            expect(YamlFileManager.migrateLegacyDirectory(dataDir, 0).result).to.equal('none');
            expect(await readFile(path.join(dataDir, 'esphome.0', 'a.yaml'), 'utf8')).to.equal('a');
        });

        it('does nothing when no legacy directory exists', () => {
            expect(YamlFileManager.migrateLegacyDirectory(path.join(root, 'iob-data'), 0).result).to.equal('none');
        });

        it('moves the directory version 1.0.0 created next to a data directory without trailing slash', async () => {
            // IOBROKER_DATA_DIR=<root>/iob-data: the dashboard of 1.0.0 used <root>/iob-dataesphome.0
            const dataDir = path.join(root, 'iob-data');
            const legacy = `${dataDir}esphome.0`;
            await mkdir(path.join(legacy, '.esphome'), { recursive: true });
            await writeFile(path.join(legacy, 'a.yaml'), 'a');
            await writeFile(path.join(legacy, 'secrets.yaml'), 'secret');

            const { result, to } = YamlFileManager.migrateLegacyDirectory(dataDir, 0);

            expect(result).to.equal('moved');
            expect(to).to.equal(path.join(dataDir, 'esphome.0'));
            expect(await readFile(path.join(to, 'a.yaml'), 'utf8')).to.equal('a');
            expect(await readFile(path.join(to, 'secrets.yaml'), 'utf8')).to.equal('secret');
            expect(existsSync(legacy)).to.equal(false);
            // runs on every start, nothing to do the second time
            expect(YamlFileManager.migrateLegacyDirectory(dataDir, 0).result).to.equal('none');
        });

        it('copies into an existing directory without overwriting its files and keeps the legacy directory', async () => {
            const dataDir = path.join(root, 'iob-data');
            const legacy = `${dataDir}esphome.0`;
            const target = path.join(dataDir, 'esphome.0');
            await mkdir(legacy, { recursive: true });
            await mkdir(target, { recursive: true });
            await writeFile(path.join(legacy, 'a.yaml'), 'legacy a');
            await writeFile(path.join(legacy, 'b.yaml'), 'legacy b');
            // uploaded with the YAML file management, which already used the new directory
            await writeFile(path.join(target, 'a.yaml'), 'uploaded a');

            expect(YamlFileManager.migrateLegacyDirectory(dataDir, 0).result).to.equal('merged');

            expect(await readFile(path.join(target, 'a.yaml'), 'utf8')).to.equal('uploaded a');
            expect(await readFile(path.join(target, 'b.yaml'), 'utf8')).to.equal('legacy b');
            expect(existsSync(legacy)).to.equal(false);
            expect(await readFile(path.join(`${legacy}.migrated`, 'a.yaml'), 'utf8')).to.equal('legacy a');
            expect(YamlFileManager.migrateLegacyDirectory(dataDir, 0).result).to.equal('none');
        });

        it('keeps relative symlinks pointing into the merged directory', async function () {
            const dataDir = path.join(root, 'iob-data');
            const legacy = `${dataDir}esphome.0`;
            const target = path.join(dataDir, 'esphome.0');
            await mkdir(path.join(legacy, 'common'), { recursive: true });
            await mkdir(target, { recursive: true });
            await writeFile(path.join(legacy, 'common', 'secrets.yaml'), 'secret');
            try {
                await symlink(path.join('common', 'secrets.yaml'), path.join(legacy, 'secrets.yaml'));
            } catch {
                // creating symlinks needs extra rights on Windows
                this.skip();
            }

            expect(YamlFileManager.migrateLegacyDirectory(dataDir, 0).result).to.equal('merged');

            // the legacy directory is renamed, the link still works
            expect(await readlink(path.join(target, 'secrets.yaml'))).to.equal(path.join('common', 'secrets.yaml'));
            expect(await readFile(path.join(target, 'secrets.yaml'), 'utf8')).to.equal('secret');
        });
    });

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

        it('lists the files sorted by name', async () => {
            await writeFile(path.join(dir, 'b.yaml'), '');
            await writeFile(path.join(dir, 'a.yaml'), '');

            expect((await fileManager.listYamlFiles()).map(file => file.filename)).to.deep.equal(['a.yaml', 'b.yaml']);
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
    describe('handleAdminMessage()', () => {
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

        it('handles every sendTo command of the YAML Files tab', () => {
            const jsonConfig = readFileSync(path.join(__dirname, '../../admin/jsonConfig.json5'), 'utf8');
            const yamlTab = jsonConfig.slice(jsonConfig.indexOf('"yamlFiles": {'));
            const commands = [...yamlTab.matchAll(/"command":\s*"(\w+)"/g)].map(match => match[1]);

            expect(commands).to.have.length.greaterThan(0);
            for (const command of commands) {
                expect(fileManager.isAdminCommand(command), command).to.be.true;
            }
            expect(fileManager.isAdminCommand('getHostIp')).to.be.false;
        });

        it('shows the files as HTML table and as options', async () => {
            await writeFile(path.join(dir, 'b.yaml'), 'x');
            // "<" and ">" are not allowed in file names on Windows
            await writeFile(path.join(dir, "a&'b.yml"), '');

            const list = await fileManager.handleAdminMessage('getYamlFileList', null);
            expect(list).to.have.property('text').that.includes('<table');
            const text = (list as { text: string }).text;
            expect(text).to.include('a&#38;&#39;b.yml').and.include('b.yaml').and.include('1 Bytes');
            expect(text).to.not.include("a&'b");

            expect(await fileManager.handleAdminMessage('getYamlFileOptions', null)).to.deep.equal([
                { label: "a&'b.yml", value: "a&'b.yml", noTranslation: true },
                { label: 'b.yaml', value: 'b.yaml', noTranslation: true },
            ]);
        });

        it('shows a hint if there are no files', async () => {
            const list = await fileManager.handleAdminMessage('getYamlFileList', null);
            expect((list as { text: string }).text).to.include('No YAML files found');
            expect(await fileManager.handleAdminMessage('getYamlFileOptions', null)).to.deep.equal([]);
        });

        it('still lists files when I18n.translate throws because init() has not finished', async () => {
            await writeFile(path.join(dir, 'kitchen.yaml'), 'x');
            YamlFileManager.setTranslationLookupForTests(() => {
                throw new Error("i18n not initialized. Please call 'init(__dirname, adapter)' before");
            });
            try {
                const list = await fileManager.handleAdminMessage('getYamlFileList', null);
                expect(list).to.have.property('text').that.includes('kitchen.yaml');
                expect(list).to.not.have.property('error');
            } finally {
                YamlFileManager.setTranslationLookupForTests();
            }
        });

        it('reloads list and selection after upload, refresh and delete', async () => {
            const content = 'esphome:\n  name: "kitchen"\n';

            const upload = await fileManager.handleAdminMessage('uploadYamlFile', {
                filename: 'kitchen.yaml',
                content,
            });
            expect(upload).to.have.nested.property('native._selectedFilename', 'kitchen.yaml');
            expect(upload).to.have.nested.property('native._yamlFilesRefresh').that.is.a('number');
            expect(await readFile(path.join(dir, 'kitchen.yaml'), 'utf8')).to.equal(content);

            const refresh = await fileManager.handleAdminMessage('refreshYamlFiles', null);
            expect(refresh).to.have.nested.property('native._yamlFilesRefresh').that.is.a('number');

            expect(await fileManager.handleAdminMessage('loadYamlFile', { filename: 'kitchen.yaml' })).to.deep.equal({
                native: { _uploadFilename: 'kitchen.yaml', _uploadContent: content },
            });

            const deletion = await fileManager.handleAdminMessage('deleteYamlFile', { filename: 'kitchen.yaml' });
            expect(deletion).to.have.nested.property('native._selectedFilename', '');
            expect(await fileManager.listYamlFiles()).to.deep.equal([]);
        });

        it('answers invalid requests with an error', async () => {
            expect(await fileManager.handleAdminMessage('uploadYamlFile', { filename: 'a.yaml' })).to.deep.equal({
                error: 'Filename and content are required',
            });
            // jsonData admin could not parse arrives as string
            expect(await fileManager.handleAdminMessage('uploadYamlFile', '{"filename": "a.yaml"')).to.deep.equal({
                error: 'Filename and content are required',
            });
            expect(await fileManager.handleAdminMessage('uploadYamlFile', { filename: '../a.yaml', content: 'x' }))
                .to.have.property('error')
                .that.includes('Invalid filename');
            expect(await fileManager.handleAdminMessage('loadYamlFile', { filename: '' })).to.deep.equal({
                error: 'Filename is required',
            });
            expect(await fileManager.handleAdminMessage('loadYamlFile', { filename: 'missing.yaml' })).to.deep.equal({
                error: 'File not found: missing.yaml',
            });
            expect(await fileManager.handleAdminMessage('deleteYamlFile', null)).to.deep.equal({
                error: 'Filename is required',
            });
        });
    });
});
