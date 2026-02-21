/**
 * YAML File Manager Module
 * Handles upload, download, list, and delete operations for YAML configuration files
 * in the ESPHome directory.
 *
 * @module yamlFileManager
 */

const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);
const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const unlink = promisify(fs.unlink);
const mkdir = promisify(fs.mkdir);
const access = promisify(fs.access);

/**
 * YAML File Manager class for handling ESPHome YAML configuration files
 */
class YamlFileManager {
    /**
     * Constructor for YamlFileManager
     *
     * @param {object} adapter - The ioBroker adapter instance
     */
    constructor(adapter) {
        this.adapter = adapter;
    }

    /**
     * Get the ESPHome directory path
     *
     * @returns {string} - The absolute path to the ESPHome directory
     */
    getESPHomeDirectory() {
        const utils = require('@iobroker/adapter-core');
        const dataDir = utils.getAbsoluteDefaultDataDir();
        return `${dataDir}esphome.${this.adapter.instance}`;
    }

    /**
     * Validate filename for security (prevent path traversal attacks)
     *
     * @param {string} filename - Name of the file to validate
     * @returns {boolean} - True if filename is valid
     */
    validateFilename(filename) {
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
     * @param {number} bytes - File size in bytes
     * @returns {string} - Formatted file size
     */
    formatFileSize(bytes) {
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
     * @returns {Promise<Array<{filename: string, size: string, modified: string}>>} - Array of file information objects
     */
    async listYamlFiles() {
        try {
            const espHomeDir = this.getESPHomeDirectory();

            // Check if directory exists using async access
            try {
                await access(espHomeDir, fs.constants.F_OK);
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
            this.adapter.log.error(`[yamlFileManager.listYamlFiles] ${error}`);
            return [];
        }
    }

    /**
     * Upload a YAML file to the ESPHome directory
     *
     * @param {string} filename - Name of the file
     * @param {string} content - Content of the file
     * @returns {Promise<{success: boolean, message?: string, error?: string}>} - Result of the operation
     */
    async uploadYamlFile(filename, content) {
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
                await access(espHomeDir, fs.constants.F_OK);
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
            this.adapter.log.error(`[yamlFileManager.uploadYamlFile] ${error}`);
            return {
                success: false,
                error: `Failed to upload file: ${error.message || error}`,
            };
        }
    }

    /**
     * Download a YAML file from the ESPHome directory
     *
     * @param {string} filename - Name of the file
     * @returns {Promise<{success: boolean, content?: string, filename?: string, error?: string}>} - Result of the operation
     */
    async downloadYamlFile(filename) {
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
                await access(filePath, fs.constants.F_OK);
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
            this.adapter.log.error(`[yamlFileManager.downloadYamlFile] ${error}`);
            return {
                success: false,
                error: `Failed to download file: ${error.message || error}`,
            };
        }
    }

    /**
     * Delete a YAML file from the ESPHome directory
     *
     * @param {string} filename - Name of the file
     * @returns {Promise<{success: boolean, message?: string, error?: string}>} - Result of the operation
     */
    async deleteYamlFile(filename) {
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
                await access(filePath, fs.constants.F_OK);
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
            this.adapter.log.error(`[yamlFileManager.deleteYamlFile] ${error}`);
            return {
                success: false,
                error: `Failed to delete file: ${error.message || error}`,
            };
        }
    }
}

module.exports = YamlFileManager;
