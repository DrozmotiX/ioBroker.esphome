/**
 * YAML File Manager Module
 * Handles upload, download, list, and delete operations for YAML configuration files
 * in the ESPHome directory.
 */

import type * as AdapterCore from '@iobroker/adapter-core';
import * as I18n from '@iobroker/adapter-core/i18n';
import { constants } from 'node:fs';
import { access, mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

/** One entry of the YAML file list shown in the adapter configuration */
interface YamlFileInfo {
    filename: string;
    /** Human-readable size, e.g. "1.5 KB" */
    size: string;
    /** Last modification time, formatted with toLocaleString() */
    modified: string;
}

/** Result of upload, download and delete, sent back to the admin UI as is */
interface YamlFileResult {
    success: boolean;
    message?: string;
    content?: string;
    filename?: string;
    error?: string;
}

/**
 * Answer to a message of the "YAML Files" tab of admin/jsonConfig.json5.
 * - `text` is shown by a "textSendTo" control
 * - a list of options fills a "selectSendTo" control
 * - `native` changes the given (not saved, "_" prefixed) fields of the form, the buttons have "useNative"
 * - `error` is shown in an error dialog
 */
type AdminResponse =
    { text: string } | { label: string; value: string }[] | { native: Record<string, unknown> } | { error: string };

/** sendTo commands of the "YAML Files" tab, answered by handleAdminMessage() */
const ADMIN_COMMANDS = [
    'getYamlFileList',
    'getYamlFileOptions',
    'refreshYamlFiles',
    'uploadYamlFile',
    'loadYamlFile',
    'deleteYamlFile',
] as const;

type AdminCommand = (typeof ADMIN_COMMANDS)[number];

/**
 * Turns a caught error into the reason text of an error result
 *
 * @param error - The caught error
 */
function errorReason(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error);
}

/**
 * Escapes a text for the HTML of the file list
 *
 * @param text - Text to escape
 */
function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
}

/**
 * Reads a string property of the message admin sent, undefined if it is missing or not a string
 *
 * @param message - The message of the sendTo control
 * @param key - Name of the property
 */
function messageString(message: unknown, key: string): string | undefined {
    if (message && typeof message === 'object') {
        const value = (message as Record<string, unknown>)[key];
        return typeof value === 'string' ? value : undefined;
    }
    return undefined;
}

/**
 * YAML File Manager class for handling ESPHome YAML configuration files
 */
class YamlFileManager {
    private readonly adapter: ioBroker.Adapter;

    /**
     * Constructor for YamlFileManager
     *
     * @param adapter - The ioBroker adapter instance
     */
    constructor(adapter: ioBroker.Adapter) {
        this.adapter = adapter;
    }

    /**
     * Get the ESPHome directory path
     *
     * @returns The absolute path to the ESPHome directory
     */
    getESPHomeDirectory(): string {
        // Loaded on demand like before: loading adapter-core throws "Cannot find js-controller" where none
        // is installed, e.g. in the unit tests of this module
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const utils = require('@iobroker/adapter-core') as typeof AdapterCore;
        const dataDir = utils.getAbsoluteDefaultDataDir();
        return `${dataDir}esphome.${this.adapter.instance}`;
    }

    /**
     * Validate filename for security (prevent path traversal attacks)
     *
     * @param filename - Name of the file to validate
     * @returns True if filename is valid
     */
    validateFilename(filename: unknown): filename is string {
        if (!filename || typeof filename !== 'string') {
            return false;
        }

        // Check for path traversal attempts
        if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
            return false;
        }

        // Ensure it's a basename (no path separators)
        if (path.basename(filename) !== filename) {
            return false;
        }

        // Check for valid YAML extension
        if (!filename.endsWith('.yaml') && !filename.endsWith('.yml')) {
            return false;
        }

        return true;
    }

    /**
     * Format file size in human-readable format
     *
     * @param bytes - File size in bytes
     * @returns Formatted file size
     */
    formatFileSize(bytes: number): string {
        if (bytes === 0) {
            return '0 Bytes';
        }

        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));

        return `${Math.round((bytes / Math.pow(k, i)) * 100) / 100} ${sizes[i]}`;
    }

    /**
     * List all YAML files in the ESPHome directory
     *
     * @returns Array of file information objects
     */
    async listYamlFiles(): Promise<YamlFileInfo[]> {
        try {
            const espHomeDir = this.getESPHomeDirectory();

            // Check if directory exists using async access
            try {
                await access(espHomeDir, constants.F_OK);
            } catch {
                this.adapter.log.warn(`ESPHome directory does not exist: ${espHomeDir}`);
                return [];
            }

            const files = await readdir(espHomeDir);
            const yamlFiles = files.filter(file => file.endsWith('.yaml') || file.endsWith('.yml'));

            const fileInfoPromises = yamlFiles.map(async filename => {
                const filePath = path.join(espHomeDir, filename);
                const stats = await stat(filePath);

                return {
                    filename: filename,
                    size: this.formatFileSize(stats.size),
                    modified: stats.mtime.toLocaleString(),
                };
            });

            const fileInfos = await Promise.all(fileInfoPromises);
            return fileInfos.sort((a, b) => a.filename.localeCompare(b.filename));
        } catch (error) {
            this.adapter.log.error(`[yamlFileManager.listYamlFiles] ${String(error)}`);
            return [];
        }
    }

    /**
     * Upload a YAML file to the ESPHome directory
     *
     * @param filename - Name of the file
     * @param content - Content of the file
     * @returns Result of the operation
     */
    async uploadYamlFile(filename: unknown, content: string): Promise<YamlFileResult> {
        try {
            const espHomeDir = this.getESPHomeDirectory();

            // Validate filename for security
            if (!this.validateFilename(filename)) {
                return {
                    success: false,
                    error: 'Invalid filename. Only .yaml and .yml files are allowed, and filename must not contain path separators or relative path components.',
                };
            }

            // Ensure directory exists using async mkdir
            try {
                await access(espHomeDir, constants.F_OK);
            } catch {
                await mkdir(espHomeDir, { recursive: true });
                this.adapter.log.info(`Created ESPHome directory: ${espHomeDir}`);
            }

            const filePath = path.join(espHomeDir, filename);
            await writeFile(filePath, content, 'utf8');

            this.adapter.log.info(`YAML file uploaded successfully: ${filename}`);
            return {
                success: true,
                message: `File ${filename} uploaded successfully`,
            };
        } catch (error) {
            this.adapter.log.error(`[yamlFileManager.uploadYamlFile] ${String(error)}`);
            return {
                success: false,
                error: `Failed to upload file: ${errorReason(error)}`,
            };
        }
    }

    /**
     * Download a YAML file from the ESPHome directory
     *
     * @param filename - Name of the file
     * @returns Result of the operation
     */
    async downloadYamlFile(filename: unknown): Promise<YamlFileResult> {
        try {
            // Validate filename for security
            if (!this.validateFilename(filename)) {
                return {
                    success: false,
                    error: 'Invalid filename',
                };
            }

            const espHomeDir = this.getESPHomeDirectory();
            const filePath = path.join(espHomeDir, filename);

            // Check if file exists using async access
            try {
                await access(filePath, constants.F_OK);
            } catch {
                return {
                    success: false,
                    error: `File not found: ${filename}`,
                };
            }

            const content = await readFile(filePath, 'utf8');

            return {
                success: true,
                content: content,
                filename: filename,
            };
        } catch (error) {
            this.adapter.log.error(`[yamlFileManager.downloadYamlFile] ${String(error)}`);
            return {
                success: false,
                error: `Failed to download file: ${errorReason(error)}`,
            };
        }
    }

    /**
     * Delete a YAML file from the ESPHome directory
     *
     * @param filename - Name of the file
     * @returns Result of the operation
     */
    async deleteYamlFile(filename: unknown): Promise<YamlFileResult> {
        try {
            // Validate filename for security
            if (!this.validateFilename(filename)) {
                return {
                    success: false,
                    error: 'Invalid filename',
                };
            }

            const espHomeDir = this.getESPHomeDirectory();
            const filePath = path.join(espHomeDir, filename);

            // Check if file exists using async access
            try {
                await access(filePath, constants.F_OK);
            } catch {
                return {
                    success: false,
                    error: `File not found: ${filename}`,
                };
            }

            await unlink(filePath);

            this.adapter.log.info(`YAML file deleted successfully: ${filename}`);
            return {
                success: true,
                message: `File ${filename} deleted successfully`,
            };
        } catch (error) {
            this.adapter.log.error(`[yamlFileManager.deleteYamlFile] ${String(error)}`);
            return {
                success: false,
                error: `Failed to delete file: ${errorReason(error)}`,
            };
        }
    }

    /**
     * Whether a sendTo command belongs to the "YAML Files" tab
     *
     * @param command - Command of the message
     */
    isAdminCommand(command: string): command is AdminCommand {
        return (ADMIN_COMMANDS as readonly string[]).includes(command);
    }

    /**
     * Renders the file list of the "YAML Files" tab as HTML table
     */
    async renderFileList(): Promise<string> {
        const files = await this.listYamlFiles();
        if (!files.length) {
            return `<i>${escapeHtml(I18n.translate('No YAML files found'))}</i>`;
        }
        const cell = 'text-align: left; padding: 4px 16px 4px 0';
        const header = [I18n.translate('File name'), I18n.translate('Size'), I18n.translate('Modified')]
            .map(title => `<th style="${cell}">${escapeHtml(title)}</th>`)
            .join('');
        const rows = files
            .map(
                file =>
                    `<tr>${[file.filename, file.size, file.modified]
                        .map(value => `<td style="${cell}">${escapeHtml(value)}</td>`)
                        .join('')}</tr>`,
            )
            .join('');
        return `<table style="border-collapse: collapse"><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table>`;
    }

    /**
     * Answers a sendTo message of the "YAML Files" tab in admin/jsonConfig.json5
     *
     * @param command - One of ADMIN_COMMANDS
     * @param message - Data of the message, built by the jsonData of the control
     */
    async handleAdminMessage(command: AdminCommand, message: unknown): Promise<AdminResponse> {
        try {
            switch (command) {
                case 'getYamlFileList':
                    return { text: await this.renderFileList() };

                case 'getYamlFileOptions':
                    // noTranslation: file names are no translation keys (the control itself must not set it, its help is one)
                    return (await this.listYamlFiles()).map(file => ({
                        label: file.filename,
                        value: file.filename,
                        noTranslation: true,
                    }));

                case 'refreshYamlFiles':
                    // The file list and the file selection reload when this value changes
                    return { native: { _yamlFilesRefresh: Date.now() } };

                case 'uploadYamlFile': {
                    const filename = messageString(message, 'filename');
                    const content = messageString(message, 'content');
                    if (!filename || !content) {
                        return { error: 'Filename and content are required' };
                    }
                    const result = await this.uploadYamlFile(filename, content);
                    if (!result.success) {
                        return { error: result.error ?? 'Failed to upload file' };
                    }
                    return { native: { _yamlFilesRefresh: Date.now(), _selectedFilename: filename } };
                }

                case 'loadYamlFile': {
                    const filename = messageString(message, 'filename');
                    if (!filename) {
                        return { error: 'Filename is required' };
                    }
                    const result = await this.downloadYamlFile(filename);
                    if (!result.success) {
                        return { error: result.error ?? 'Failed to download file' };
                    }
                    return { native: { _uploadFilename: filename, _uploadContent: result.content ?? '' } };
                }

                case 'deleteYamlFile': {
                    const filename = messageString(message, 'filename');
                    if (!filename) {
                        return { error: 'Filename is required' };
                    }
                    const result = await this.deleteYamlFile(filename);
                    if (!result.success) {
                        return { error: result.error ?? 'Failed to delete file' };
                    }
                    return { native: { _yamlFilesRefresh: Date.now(), _selectedFilename: '' } };
                }
            }
        } catch (error) {
            this.adapter.log.error(`[yamlFileManager.handleAdminMessage] ${command}: ${String(error)}`);
            return { error: errorReason(error) };
        }
    }
}

// export = keeps the CommonJS export (module.exports = YamlFileManager) that main.ts loads with require()
export = YamlFileManager;
