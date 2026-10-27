/**
 * YAML File Manager Module
 * Handles upload, download, list, and delete operations for YAML configuration files
 * in the ESPHome directory.
 */

import type * as AdapterCore from '@iobroker/adapter-core';
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
 * Turns a caught error into the reason text of an error result
 *
 * @param error - The caught error
 */
function errorReason(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error);
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

            return await Promise.all(fileInfoPromises);
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
}

// export = keeps the CommonJS export (module.exports = YamlFileManager) that main.ts loads with require()
export = YamlFileManager;
