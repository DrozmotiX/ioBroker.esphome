"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
const utils = require("@iobroker/adapter-core");
const clientDevice = require("./lib/helpers.js");
const YamlFileManager = require("./lib/yamlFileManager.js");
const { Client, Discovery } = require("@2colors/esphome-native-api");
const stateAttr = require(`${__dirname}/lib/stateAttr.js`);
const disableSentry = false;
const warnMessages = {};
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const resetTimers = {};
let autodiscovery, dashboardProcess, createConfigStates, discovery;
const clientDetails = {};
const newlyDiscoveredClient = {};
const dashboardVersions = [];
const pillowVersions = [];
const defaultDashboardVersion = "2026.6.5";
const defaultPillowVersion = "12.2.0";
const versionMigrationState = "_ESPHomeDashboard.versionPinMigrationDone";
const COLOR_CAPABILITY = {
  ON_OFF: 1,
  BRIGHTNESS: 2,
  WHITE: 4,
  COLOR_TEMPERATURE: 8,
  COLD_WARM_WHITE: 16,
  RGB: 32
};
class Esphome extends utils.Adapter {
  /**
   * @param {Partial<utils.AdapterOptions>} [options] - Adapter configuration options
   */
  constructor(options) {
    super({
      ...options,
      name: "esphome"
    });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("message", this.onMessage.bind(this));
    this.on("unload", this.onUnload.bind(this));
    this.deviceStateRelation = {};
    this.createdStatesDetails = {};
    this.messageResponse = {};
    this.yamlFileManager = new YamlFileManager(this);
  }
  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    await this.setStateAsync("info.connection", { val: true, ack: true });
    try {
      await this.migrateConfig();
      await this.migratePinnedVersions();
      autodiscovery = this.config.autodiscovery;
      createConfigStates = this.config.configStates;
      await this.resetOnlineStates();
      await this.tryKnownDevices();
      await this.espHomeDashboard();
      if (autodiscovery) {
        if (resetTimers["autodiscovery"]) {
          resetTimers["autodiscovery"] = this.clearTimeout(resetTimers["autodiscovery"]);
        }
        resetTimers["autodiscovery"] = this.setTimeout(async () => {
          this.deviceDiscovery();
        }, 5e3);
      } else {
        this.log.warn(
          `Auto Discovery disabled, new devices (or IP changes) will NOT be detected automatically!`
        );
      }
      this.extendObject("info.deviceCleanup", {
        type: "state",
        common: {
          role: "button",
          name: "Device or service connected",
          type: "boolean",
          read: false,
          write: true,
          def: false
        }
      });
      this.subscribeStates("info.deviceCleanup");
      this.extendObject("info.clearAutopyCache", {
        type: "state",
        common: {
          role: "button",
          name: "Clear Autopy Cache",
          type: "boolean",
          read: false,
          write: true,
          def: false
        }
      });
      this.subscribeStates("info.clearAutopyCache");
    } catch (e) {
      this.log.error(`[Adapter start] Fatal error occurred ${e}`);
    }
  }
  /**
   * Migrate configuration from older adapter versions
   * Automatically set ESPHomeDashboardUrl if ESPHomeDashboardIP is set but URL is empty
   */
  async migrateConfig() {
    try {
      if (this.config.ESPHomeDashboardIP && !this.config.ESPHomeDashboardUrl) {
        const calculatedUrl = `http://${this.config.ESPHomeDashboardIP}:${this.config.ESPHomeDashboardPort}`;
        this.log.info(`Migrating configuration: Setting ESPHomeDashboardUrl to ${calculatedUrl}`);
        const adapterObj = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
        if (!adapterObj) {
          this.log.error(
            `Configuration migration failed: Could not retrieve adapter configuration object for ${this.namespace}`
          );
          return;
        }
        if (!adapterObj.native) {
          this.log.error(
            `Configuration migration failed: Adapter configuration object has no native property`
          );
          return;
        }
        adapterObj.native.ESPHomeDashboardUrl = calculatedUrl;
        await this.setForeignObject(adapterObj._id, adapterObj);
        this.log.info(`Configuration migrated successfully. ESPHomeDashboardUrl set to: ${calculatedUrl}`);
      }
    } catch (error) {
      const reason = error instanceof Error && error.message ? error.message : String(error);
      this.log.error(
        `Error during configuration migration from ESPHomeDashboardIP to ESPHomeDashboardUrl: ${reason}`
      );
    }
  }
  /**
   * Migrate installations which are still on "Always last available" to the pinned versions, once.
   *
   * The pinned defaults in io-package.json only apply to new installations, so without this every
   * existing installation would stay on a release line that currently cannot be installed (#463)
   * and would have to be corrected by hand.
   *
   * Whether the migration already ran is stored in a state, not in "native": a new installation
   * already ships the pinned defaults, and a "native" marker would be seeded into every existing
   * instance on upgrade, so neither could tell "not migrated yet" from "nothing to migrate".
   * Once the marker is set, a deliberate switch back to "Always last available" is never touched.
   */
  async migratePinnedVersions() {
    try {
      await this.extendObjectAsync("_ESPHomeDashboard", {
        type: "channel",
        common: {
          name: "ESPHome Dashboard details"
        },
        native: {}
      });
      const migrationDone = await this.getStateAsync(versionMigrationState);
      if (migrationDone && migrationDone.val === true) {
        return;
      }
      const migrated = {};
      if (this.config.ESPHomeDashboardVersion === "Always last available") {
        migrated.ESPHomeDashboardVersion = defaultDashboardVersion;
      }
      if (this.config.PillowVersion === "Always last available") {
        migrated.PillowVersion = defaultPillowVersion;
      }
      if (!Object.keys(migrated).length) {
        await this.stateSetCreate(versionMigrationState, "versionPinMigrationDone", true);
        return;
      }
      const adapterObj = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
      if (!adapterObj || !adapterObj.native) {
        this.log.error(
          `Migration to pinned versions failed: could not read the configuration object of ${this.namespace}. Please select a fixed ESPHome Dashboard version in the adapter configuration.`
        );
        return;
      }
      const changes = Object.entries(migrated).map(([key, value2]) => `${key} = ${value2}`).join(", ");
      this.log.info(
        `Not every ESPHome release can be installed on every system, so your configuration has been migrated once from "Always last available" to the last combination known to work: ${changes}. Select "Always last available" again in the adapter configuration if you prefer to follow the newest release, this migration only runs once.`
      );
      Object.assign(adapterObj.native, migrated);
      Object.assign(this.config, migrated);
      await this.setForeignObject(adapterObj._id, adapterObj);
      await this.stateSetCreate(versionMigrationState, "versionPinMigrationDone", true);
    } catch (error) {
      this.errorHandler(`[migratePinnedVersions]`, error);
    }
  }
  /**
   * Warn when a version is left at "Always last available". Such a setup can break without any
   * change on the user side as soon as an ESPHome release cannot be installed (#463). Reached only
   * when the user selected it deliberately, migratePinnedVersions() moves existing installations
   * off that setting once.
   *
   * @param {string} useDashBoardVersion - ESPHome Dashboard version which will be installed
   * @param {string} usePillowVersion - Pillow version which will be installed
   */
  warnUnpinnedVersions(useDashBoardVersion, usePillowVersion) {
    if (this.config.ESPHomeDashboardVersion === "Always last available") {
      this.log.warn(
        `ESPHome Dashboard version is set to "Always last available" and resolves to ${useDashBoardVersion || "the newest release"}. Not every ESPHome release can be installed on every system. If the dashboard does not start, select a fixed version in the adapter configuration, ${defaultDashboardVersion} is known to work.`
      );
    }
    if (this.config.PillowVersion === "Always last available") {
      this.log.warn(
        `Pillow version is set to "Always last available" and resolves to ${usePillowVersion || "the newest release"}. If the dashboard does not start, select a fixed version in the adapter configuration, ${defaultPillowVersion} is known to work.`
      );
    }
  }
  // ToDo: move to separate module
  async espHomeDashboard() {
    var _a, _b;
    try {
      await this.extendObjectAsync("_ESPHomeDashboard", {
        type: "channel",
        common: {
          name: "ESPHome Dashboard details"
        },
        native: {}
      });
      let content;
      let lastUsed;
      let useDashBoardVersion = "";
      try {
        lastUsed = await this.getStateAsync(`_ESPHomeDashboard.selectedVersion`);
        if (lastUsed && lastUsed.val) {
          lastUsed = lastUsed.val;
        }
      } catch {
      }
      try {
        const response = await fetch("https://api.github.com/repos/esphome/esphome/releases");
        if (!response.ok) {
          throw new Error(
            `GitHub releases request failed with status ${response.status}: ${response.statusText}`
          );
        }
        content = await response.json();
      } catch (error) {
        this.errorHandler(`[espHomeDashboard-VersionCall]`, error);
      }
      if (content) {
        await this.stateSetCreate(`_ESPHomeDashboard.versionCache`, "versionCache", JSON.stringify(content));
        for (const version in content) {
          dashboardVersions.push(content[version].name);
        }
        await this.stateSetCreate(`_ESPHomeDashboard.newestVersion`, "newestVersion", content[0].name);
      } else {
        this.log.warn(
          `Unable to retrieve current Dashboard release versions, using cached values. Check your internet connection`
        );
        let cachedVersions = await this.getStateAsync(`_ESPHomeDashboard.versionCache`);
        if (cachedVersions && cachedVersions.val) {
          cachedVersions = JSON.parse(String(cachedVersions.val));
          for (const version in cachedVersions) {
            dashboardVersions.push(cachedVersions[version].name);
          }
        }
      }
      if (this.config.ESPHomeDashboardVersion && this.config.ESPHomeDashboardVersion !== "" && this.config.ESPHomeDashboardVersion !== "Always last available") {
        useDashBoardVersion = this.config.ESPHomeDashboardVersion;
      } else if (this.config.ESPHomeDashboardVersion === "Always last available") {
        if (content) {
          useDashBoardVersion = content[0].name;
        } else if (dashboardVersions.length > 0) {
          useDashBoardVersion = dashboardVersions[0];
        }
      }
      if (useDashBoardVersion !== "") {
        await this.stateSetCreate(`_ESPHomeDashboard.selectedVersion`, "selectedVersion", useDashBoardVersion);
      } else if (lastUsed != null) {
        useDashBoardVersion = lastUsed;
      }
      const versions = await this.fetchAndCachePillowVersions();
      pillowVersions.length = 0;
      pillowVersions.push(...versions);
      let usePillowVersion = "";
      if (this.config.PillowVersion && this.config.PillowVersion !== "" && this.config.PillowVersion !== "Always last available") {
        usePillowVersion = this.config.PillowVersion;
      } else if (this.config.PillowVersion === "Always last available" && versions.length > 0) {
        usePillowVersion = versions[0];
      }
      this.log.debug(`Using Pillow version: ${usePillowVersion}`);
      if (this.config.ESPHomeDashboardEnabled) {
        this.log.info(`Native Integration of ESPHome Dashboard enabled, making environment ready`);
        this.warnUnpinnedVersions(useDashBoardVersion, usePillowVersion);
        try {
          const { getVenv } = await Promise.resolve().then(() => __toESM(require("autopy")));
          let python;
          try {
            const requirements = [];
            if (useDashBoardVersion) {
              requirements.push({ name: "esphome", version: `==${useDashBoardVersion}` });
            } else {
              this.log.warn(
                `Unable to determine a specific ESPHome dashboard version. Falling back to latest available version from PyPI`
              );
              requirements.push({ name: "esphome", version: "" });
            }
            if (usePillowVersion) {
              requirements.push({ name: "pillow", version: `==${usePillowVersion}` });
            } else {
              this.log.warn(
                `Unable to determine a specific Pillow version. Falling back to latest available version from PyPI`
              );
              requirements.push({ name: "pillow", version: "" });
            }
            python = await getVenv({
              name: "esphome",
              pythonVersion: "3.13.2",
              // Use any Python 3.13.x version.
              requirements
            });
          } catch (error) {
            const stack = error instanceof Error ? error.stack : void 0;
            this.log.error(`Fatal error starting ESPHomeDashboard | ${error} | ${stack}`);
            return;
          }
          const dataDir = utils.getAbsoluteDefaultDataDir();
          try {
            fs.mkdir(`${dataDir}esphome.${this.instance}`, (err) => {
              if (err) {
                return console.log(`ESPHome directory exists`);
              }
              console.log(`ESPHome directory created`);
            });
          } catch (error) {
            this.log.warn(
              `ESPHome DDashboard is unable to access directory to store YAML configuration data, please run ioBroker fix: ${error}`
            );
          }
          this.log.info(`Starting ESPHome Dashboard`);
          dashboardProcess = python("esphome", [
            "dashboard",
            "--port",
            String(this.config.ESPHomeDashboardPort),
            `${dataDir}esphome.${this.instance}`
          ]);
          this.log.debug(`espHomeDashboard_Process ${JSON.stringify(dashboardProcess)}`);
          (_a = dashboardProcess.stdout) == null ? void 0 : _a.on("data", (data) => {
            this.log.info(`[dashboardProcess - Data] ${data}`);
          });
          (_b = dashboardProcess.stderr) == null ? void 0 : _b.on("data", (data) => {
            if (data.includes("INFO")) {
              if (data.includes("Starting")) {
                this.log.info(`[ESPHome - Console] ${data}`);
              } else {
                this.log.debug(`[ESPHome - Console] ${data}`);
              }
            } else {
            }
          });
          dashboardProcess.on("message", (code, signal) => {
            this.log.info(`[dashboardProcess MESSAGE] Exit code is: ${code} | ${signal}`);
          });
          dashboardProcess.on("exit", (_code, _signal) => {
            this.log.warn(`ESPHome Dashboard stopped`);
          });
          dashboardProcess.on("error", (data) => {
            if (data.message.includes("INFO")) {
              this.log.info(`[dashboardProcess Info] ${data}`);
            } else if (data.message.includes("ERROR")) {
              this.log.error(`[dashboardProcess Warn] ${data}`);
            } else {
              this.log.error(`[dashboardProcess Error] ${data}`);
            }
          });
        } catch (error) {
          this.errorHandler(`[espHomeDashboard-Process]`, error);
        }
      } else {
        this.log.info(`Native Integration of ESPHome Dashboard disabled `);
      }
    } catch (error) {
      this.errorHandler(`[espHomeDashboard-Function]`, error);
    }
  }
  // Try to contact and read data of already known devices
  async tryKnownDevices() {
    try {
      const knownDevices = await this.getDevicesAsync();
      if (!knownDevices) {
        return;
      }
      for (const i in knownDevices) {
        const deviceDetails = knownDevices[i].native;
        clientDetails[deviceDetails.ip] = new clientDevice();
        clientDetails[deviceDetails.ip].storeExistingDetails(
          deviceDetails.ip,
          deviceDetails.encryptionKeyUsed ? deviceDetails.encryptionKeyUsed : false,
          `${deviceDetails.mac}`,
          `${deviceDetails.deviceName}`,
          `${deviceDetails.name}`,
          !deviceDetails.encryptionKeyUsed ? deviceDetails.apiPassword ? deviceDetails.apiPassword : deviceDetails.passWord : null,
          deviceDetails.encryptionKeyUsed ? deviceDetails.encryptionKey : null
        );
        this.connectDevices(deviceDetails.ip);
      }
    } catch (error) {
      this.errorHandler(`[tryKnownDevices]`, error);
    }
  }
  // MDNS discovery handler for ESPHome devices
  deviceDiscovery() {
    try {
      const excludedIP = [];
      for (const entry in this.config.ignoredDevices) {
        if (this.config.ignoredDevices[entry] && this.config.ignoredDevices[entry]["IP-Address"] && !excludedIP.includes(this.config.ignoredDevices[entry]["IP-Address"])) {
          excludedIP.push(this.config.ignoredDevices[entry]["IP-Address"]);
        }
      }
      discovery = new Discovery({
        interface: this.config.discoveryListeningAddress ? this.config.discoveryListeningAddress : "0.0.0.0"
      });
      discovery.run();
      discovery.on("info", (message) => {
        this.log.debug(`ESPHome Device found on ${message.address} | ${JSON.stringify(message)}`);
        if (!excludedIP.includes(message.address) && !newlyDiscoveredClient[message.address] && !clientDetails[message.address]) {
          this.log.info(
            `New ESPHome Device discovered: ${message.friendly_name ? message.friendly_name : message.host} on ${message.address}`
          );
          if (message.mac == null) {
            this.log.warn(`Discovered device with undefined mac. ignoring: ${JSON.stringify(message)}`);
            return;
          }
          newlyDiscoveredClient[message.address] = {
            ip: message.address,
            mac: message.mac.toUpperCase(),
            deviceFriendlyName: message.friendly_name ? message.friendly_name : message.host
          };
        }
      });
    } catch (error) {
      this.errorHandler(`[deviceDiscovery]`, error);
    }
  }
  /**
   * Handle Socket connections
   *
   * @param {string} host IP address of a device
   */
  connectDevices(host) {
    try {
      this.log.info(`Try to connect to ${host}`);
      if (clientDetails[host] && (clientDetails[host].connecting || clientDetails[host].deletionRequested)) {
        return;
      }
      this.updateConnectionStatus(host, false, true, "connecting");
      const reconnectInterval = Math.max(1, Number(this.config.reconnectInterval) || 5) * 1e3;
      const pingInterval = Math.max(1, Number(this.config.pingInterval) || 5) * 1e3;
      const pingAttempts = Math.max(1, Number(this.config.pingAttempts) || 1);
      const clientSettings = {
        host,
        clientInfo: `${this.host}`,
        clearSession: true,
        initializeDeviceInfo: true,
        initializeListEntities: true,
        initializeSubscribeStates: false,
        // initializeSubscribeLogs: false, //ToDo: Make configurable by adapter settings
        reconnect: true,
        reconnectInterval,
        pingInterval,
        pingAttempts
        // port: espDevices[device].port //ToDo: Make configurable by adapter settings
      };
      if (!clientDetails[host].encryptionKeyUsed) {
        clientSettings.password = clientDetails[host].apiPassword ? this.decrypt(clientDetails[host].apiPassword) : "";
      } else {
        clientSettings.encryptionKey = this.decrypt(clientDetails[host].encryptionKey);
      }
      clientDetails[host].client = new Client(clientSettings);
      clientDetails[host].client.on("connected", async () => {
        try {
          await this.updateConnectionStatus(host, true, false, "Connected", false);
          this.log.info(`ESPHome client ${host} connected`);
          delete warnMessages[host];
          clientDetails[host].connectionDestroyedLogged = false;
          if (this.messageResponse[host]) {
            this.sendTo(
              this.messageResponse[host].from,
              this.messageResponse[host].command,
              {
                result: "OK - Device successfully connected, initializing configuration. Refresh table to show all known devices"
              },
              this.messageResponse[host].callback
            );
            delete this.messageResponse[host];
          }
        } catch (e) {
          this.log.error(`connection error ${e}`);
        }
      });
      clientDetails[host].client.on("disconnected", async () => {
        try {
          if (clientDetails[host].deviceName != null) {
            await this.updateConnectionStatus(host, false, false, "disconnected", false);
            delete clientDetails[host].deviceInfo;
            for (const state in this.createdStatesDetails) {
              if (state.split(".")[0] === clientDetails[host].deviceName) {
                delete this.createdStatesDetails[state];
              }
            }
            for (const [key, value2] of Object.entries(clientDetails[host])) {
              if (value2 && typeof value2 === "object" && !Array.isArray(value2) && value2.config && value2.type && value2.name) {
                delete clientDetails[host][key];
              }
            }
            delete this.deviceStateRelation[clientDetails[host].deviceName];
            this.log.warn(
              `ESPHome client ${clientDetails[host].deviceFriendlyName} | ${clientDetails[host].deviceName} | on ${host} disconnected`
            );
          } else {
            this.log.warn(`ESPHome client ${host} disconnected`);
          }
        } catch (e) {
          this.log.debug(`ESPHome disconnect error : ${e}`);
        }
      });
      clientDetails[host].client.on("reconnect", async () => {
        this.log.debug(`Trying to reconnect to ESPHome client ${host}`);
      });
      clientDetails[host].client.on("initialized", async () => {
        this.log.info(`ESPHome  client ${clientDetails[host].deviceFriendlyName} on ip ${host} initialized`);
        clientDetails[host].initialized = true;
        clientDetails[host].connectStatus = "initialized";
        await this.updateConnectionStatus(host, true, false, "initialized", false);
        if (resetTimers[host]) {
          resetTimers[host] = this.clearTimeout(resetTimers[host]);
        }
        resetTimers[host] = this.setTimeout(async () => {
          await this.objectCleanup(host);
        }, 1e4);
      });
      clientDetails[host].client.connection.on("message", (message) => {
        this.log.debug(`[ESPHome Device Message] ${host} client log ${message}`);
      });
      clientDetails[host].client.connection.on("data", (data) => {
        this.log.debug(`[ESPHome Device Data] ${host} client data ${data}`);
      });
      clientDetails[host].client.on("deviceInfo", async (deviceInfo) => {
        try {
          this.log.info(`ESPHome Device info received for ${deviceInfo.name}`);
          this.log.debug(`DeviceData: ${JSON.stringify(deviceInfo)}`);
          const deviceName = this.replaceAll(deviceInfo.macAddress, `:`, ``);
          clientDetails[host].mac = deviceInfo.macAddress;
          clientDetails[host].deviceName = deviceName;
          clientDetails[host].deviceFriendlyName = deviceInfo.name;
          clientDetails[host].deviceInfo = deviceInfo;
          this.deviceStateRelation[deviceName] = { ip: host };
          this.log.debug(
            `DeviceInfo ${clientDetails[host].deviceFriendlyName}: ${JSON.stringify(clientDetails[host].deviceInfo)}`
          );
          await this.extendObjectAsync(deviceName, {
            type: "device",
            common: {
              name: deviceInfo.name,
              statusStates: {
                onlineId: `${this.namespace}.${deviceName}.info._online`
              },
              desc: deviceInfo.friendlyName
            },
            native: {
              ip: host,
              name: clientDetails[host].deviceInfoName,
              mac: deviceInfo.macAddress,
              deviceName,
              deviceFriendlyName: deviceInfo.name,
              apiPassword: clientDetails[host].apiPassword,
              encryptionKey: clientDetails[host].encryptionKey,
              encryptionKeyUsed: clientDetails[host].encryptionKeyUsed
            }
          });
          await this.extendObjectAsync(`${deviceName}.info`, {
            type: "channel",
            common: {
              name: "Device Information"
            },
            native: {}
          });
          if (!clientDetails[host].adapterObjects.channels.includes(
            `${this.namespace}.${clientDetails[host].deviceName}.info`
          )) {
            clientDetails[host].adapterObjects.channels.push(
              `${this.namespace}.${clientDetails[host].deviceName}.info`
            );
          }
          await this.updateConnectionStatus(host, true, false, "Initializing", false);
          await this.traverseJson(deviceInfo, `${deviceName}.info`);
          if (this.messageResponse[host]) {
            const massageObj = {
              type: "info",
              message: "success"
            };
            this.respond(massageObj, this.messageResponse[host]);
            this.messageResponse[host] = null;
          }
        } catch (error) {
          this.errorHandler(`[deviceInfo]`, error);
        }
      });
      clientDetails[host].client.on("newEntity", async (entity) => {
        this.log.debug(`EntityData: ${JSON.stringify(entity.config)}`);
        try {
          clientDetails[host][entity.id] = {
            config: entity.config,
            name: entity.name,
            type: entity.type,
            unit: entity.config.unitOfMeasurement !== void 0 ? entity.config.unitOfMeasurement || "" : ""
          };
          if (clientDetails[host][entity.id].config.deviceClass) {
            this.log.info(
              `${clientDetails[host].deviceFriendlyName} announced ${clientDetails[host][entity.id].config.deviceClass} "${clientDetails[host][entity.id].config.name}"`
            );
          } else {
            this.log.info(
              `${clientDetails[host].deviceFriendlyName} announced ${clientDetails[host][entity.id].type} "${clientDetails[host][entity.id].config.name}"`
            );
          }
          await this.extendObjectAsync(`${clientDetails[host].deviceName}.${entity.type}`, {
            type: "channel",
            common: {
              name: entity.type
            },
            native: {}
          });
          if (!clientDetails[host].adapterObjects.channels.includes(
            `${this.namespace}.${clientDetails[host].deviceName}.${entity.type}`
          )) {
            clientDetails[host].adapterObjects.channels.push(
              `${this.namespace}.${clientDetails[host].deviceName}.${entity.type}`
            );
          }
          await this.extendObjectAsync(`${clientDetails[host].deviceName}.${entity.type}.${entity.id}`, {
            type: "channel",
            common: {
              name: entity.config.name
            },
            native: {}
          });
          if (!clientDetails[host].adapterObjects.channels.includes(
            `${this.namespace}.${clientDetails[host].deviceName}.${entity.type}.${entity.id}`
          )) {
            clientDetails[host].adapterObjects.channels.push(
              `${this.namespace}.${clientDetails[host].deviceName}.${entity.type}.${entity.id}`
            );
          }
          if (!createConfigStates) {
            try {
              const obj = await this.getObjectAsync(
                `${clientDetails[host].deviceName}.${entity.type}.${entity.id}.config`
              );
              if (obj) {
                await this.delObjectAsync(
                  `${clientDetails[host].deviceName}.${entity.type}.${entity.id}.config`,
                  { recursive: true }
                );
              }
            } catch {
            }
          } else {
            await this.extendObjectAsync(
              `${clientDetails[host].deviceName}.${entity.type}.${entity.id}.config`,
              {
                type: "channel",
                common: {
                  name: "Configuration data"
                },
                native: {}
              }
            );
            if (!clientDetails[host].adapterObjects.channels.includes(
              `${this.namespace}.${clientDetails[host].deviceName}.${entity.type}.${entity.id}.config`
            )) {
              clientDetails[host].adapterObjects.channels.push(
                `${this.namespace}.${clientDetails[host].deviceName}.${entity.type}.${entity.id}.config`
              );
            }
            await this.traverseJson(
              entity.config,
              `${clientDetails[host].deviceName}.${entity.type}.${entity.id}.config`
            );
          }
          await this.createNonStateDevices(host, entity);
          if (clientDetails[host].client.connection.connected) {
            try {
              await clientDetails[host].client.connection.subscribeStatesService();
            } catch (e) {
              this.log.debug(
                `[subscribeStates] ${clientDetails[host].deviceFriendlyName}: ${e instanceof Error ? e.message : e}`
              );
            }
          }
          this.log.debug(
            `[DeviceInfoData] ${clientDetails[host].deviceFriendlyName} ${JSON.stringify(clientDetails[host].deviceInfo)}`
          );
          entity.on(`state`, async (state) => {
            clientDetails[host].connectStatus = "connected";
            await this.updateConnectionStatus(host, true, false, "connected", false);
            this.log.debug(`StateData: ${JSON.stringify(state)}`);
            try {
              this.log.debug(`[entityStateConfig] ${JSON.stringify(clientDetails[host][entity.id])}`);
              this.log.debug(`[entityStateData] ${JSON.stringify(state)}`);
              const deviceDetails = `DeviceType ${clientDetails[host][entity.id].type} | State-Keys ${JSON.stringify(state)} | [entityStateConfig] ${JSON.stringify(clientDetails[host][entity.id])}`;
              switch (clientDetails[host][entity.id].type) {
                case "BinarySensor":
                  await this.handleRegularState(`${host}`, entity, state, false);
                  break;
                case "Climate":
                  await this.handleStateArrays(`${host}`, entity, state);
                  break;
                case "Cover":
                  await this.stateSetCreate(
                    `${clientDetails[host].deviceName}.${entity.type}.${entity.id}.position`,
                    `Position`,
                    state.position * 100,
                    `%`,
                    true
                  );
                  await this.stateSetCreate(
                    `${clientDetails[host].deviceName}.${entity.type}.${entity.id}.tilt`,
                    `Tilt`,
                    state.tilt * 100,
                    `%`,
                    true
                  );
                  await this.stateSetCreate(
                    `${clientDetails[host].deviceName}.${entity.type}.${entity.id}.stop`,
                    `Stop`,
                    false,
                    ``,
                    true
                  );
                  break;
                case "Fan":
                  await this.handleStateArrays(`${host}`, entity, state);
                  break;
                case "Light":
                  await this.handleStateArrays(`${host}`, entity, state);
                  break;
                case "Sensor":
                  await this.handleRegularState(`${host}`, entity, state, false);
                  break;
                case "TextSensor":
                  await this.handleRegularState(`${host}`, entity, state, true);
                  break;
                case "Switch":
                  await this.handleRegularState(`${host}`, entity, state, true);
                  break;
                case "Number":
                  await this.handleRegularState(`${host}`, entity, state, true);
                  break;
                case "Text": {
                  await this.handleRegularState(`${host}`, entity, state, true);
                  break;
                }
                case "Select": {
                  await this.handleRegularState(`${host}`, entity, state, true);
                  break;
                }
                case "Lock": {
                  const deviceName = clientDetails[host].deviceName;
                  await this.stateSetCreate(
                    `${deviceName}.${entity.type}.${entity.id}.state`,
                    `LockState`,
                    state.state,
                    ``,
                    false
                  );
                  await this.stateSetCreate(
                    `${deviceName}.${entity.type}.${entity.id}.command`,
                    `LockCommand`,
                    null,
                    // No default to prevent accidental triggers
                    ``,
                    true
                  );
                  break;
                }
                default:
                  if (!warnMessages[clientDetails[host][entity.id].type]) {
                    this.log.warn(
                      `DeviceType ${clientDetails[host][entity.id].type} not yet supported`
                    );
                    this.log.warn(`Please submit git issue with all information from next line`);
                    this.log.warn(
                      `DeviceType ${clientDetails[host][entity.id].type} | State-Keys ${JSON.stringify(state)} | [entityStateConfig] ${JSON.stringify(clientDetails[host][entity.id])}`
                    );
                    warnMessages[clientDetails[host][entity.id].type] = deviceDetails;
                  }
              }
            } catch (error) {
              this.errorHandler(`[connectHandler NewEntity]`, error);
            }
          });
          entity.on(`destroyed`, async (state) => {
            try {
              if (clientDetails[host].connectionDestroyedLogged) {
                return;
              }
              clientDetails[host].connectionDestroyedLogged = true;
              const entityIdentity = (entity == null ? void 0 : entity.name) || (entity == null ? void 0 : entity.id) || host || "unknown";
              if (state !== void 0) {
                this.log.warn(`Connection destroyed for ${state} (${entityIdentity})`);
              } else {
                this.log.warn(`Connection destroyed for ${entityIdentity}`);
              }
            } catch (e) {
              this.log.error(`State handle error ${e}`);
            }
          });
          entity.on(`error`, async (name) => {
            this.log.error(`Entity error: ${name}`);
          });
        } catch (e) {
          const stack = e instanceof Error ? e.stack : void 0;
          this.log.error(`Connection issue for ${entity.name} ${e} | ${stack}`);
        }
      });
      clientDetails[host].client.on("error", async (error) => {
        try {
          let optimisedError = error.message;
          if (error.message && (error.message.includes("EHOSTUNREACH") || error.message.includes("EHOSTDOWN")) || error.code && error.code.includes("ETIMEDOUT")) {
            optimisedError = `Client ${host} unreachable !`;
            if (!clientDetails[host].connectionError) {
              this.log.error(optimisedError);
              await this.updateConnectionStatus(host, false, false, "unreachable", true);
            }
          } else if (error.message.includes("Invalid password")) {
            optimisedError = `Client ${host} incorrect password !`;
            if (!clientDetails.connectionError) {
              this.log.error(optimisedError);
              await this.updateConnectionStatus(host, false, false, "API password incorrect", true);
            }
          } else if (error.message.includes("Encryption expected")) {
            optimisedError = `Client ${host} requires encryption key which has not been provided, please enter encryption key in adapter settings for this device !`;
            if (!clientDetails[host].connectionError) {
              this.log.error(optimisedError);
              await this.updateConnectionStatus(host, false, false, "Encryption Key Missing", true);
            }
          } else if (error.message.includes("ECONNRESET")) {
            optimisedError = `Client ${host} Connection Lost, will reconnect automatically when device is available!`;
            if (!clientDetails[host].connectionError) {
              this.log.warn(optimisedError);
              await this.updateConnectionStatus(host, false, false, "connection lost", true);
            }
          } else if (error.message.includes("timeout")) {
            optimisedError = `Client ${host} Timeout, will reconnect automatically when device is available!`;
            if (!clientDetails[host].connectionError) {
              this.log.warn(optimisedError);
              await this.updateConnectionStatus(host, false, false, "unreachable", true);
            }
          } else if (error.message.includes("ECONNREFUSED")) {
            optimisedError = `Client ${host} not yet ready to connect, will try again!`;
            await this.updateConnectionStatus(host, false, true, "initializing", true);
            this.log.warn(optimisedError);
          } else if (error.message.includes("ENETUNREACH")) {
            optimisedError = `Network not ready to connect to client ${host}`;
            if (!clientDetails[host].connectionError) {
              await this.updateConnectionStatus(host, false, true, "No Network", true);
              this.log.warn(optimisedError);
            }
          } else if (error.message.includes("write after end")) {
          } else {
            this.log.error(`ESPHome client ${host} ${error}`);
          }
          if (this.messageResponse[host]) {
            this.sendTo(
              this.messageResponse[host].from,
              this.messageResponse[host].command,
              { error: `${optimisedError}` },
              this.messageResponse[host].callback
            );
            delete this.messageResponse[host];
          }
        } catch (error2) {
          this.errorHandler(`[connectedDevice onError]`, error2);
        }
      });
      try {
        this.log.debug(`trying to connect to ${host}`);
        clientDetails[host].client.connect();
      } catch (e) {
        this.log.error(`Client ${host} connect error ${e}`);
        this.updateConnectionStatus(host, false, false, "error", true).catch(
          (error) => this.errorHandler(`[connectDevices connect]`, error)
        );
      }
    } catch (e) {
      const stack = e instanceof Error ? e.stack : void 0;
      this.log.error(`ESP device error for ${host} | ${e} | ${stack}`);
    }
  }
  /**
   * Handle regular state values
   *
   * @param {string} host IP-Address of client
   * @param {object} entity Entity-Object of value
   * @param {object} state State-Object
   * @param {boolean} writable Indicate if state should be writable
   */
  async handleRegularState(host, entity, state, writable) {
    try {
      let stateVal = state.state;
      if (clientDetails[host][entity.id].config.accuracyDecimals != null) {
        const rounding = `round(${clientDetails[host][entity.id].config.accuracyDecimals})`;
        this.log.debug(
          `Value "${stateVal}" for name "${entity}" before function modify with method "round(${clientDetails[host][entity.id].config.accuracyDecimals})"`
        );
        stateVal = this.modify(rounding, stateVal);
        this.log.debug(
          `Value "${stateVal}" for name "${entity}" after function modify with method "${rounding}"`
        );
      }
      const stateCommon = {};
      if (entity.config.optionsList != null) {
        stateCommon.states = entity.config.optionsList;
      }
      await this.stateSetCreate(
        `${clientDetails[host].deviceName}.${entity.type}.${entity.id}.state`,
        `State of ${entity.config.name}`,
        stateVal,
        clientDetails[host][entity.id].unit,
        writable,
        stateCommon
      );
    } catch (error) {
      this.errorHandler(`[espHomeDashboard]`, error);
    }
  }
  /**
   * Handle state values
   *
   * @param {string} host IP-Address of client
   * @param {object} entity Entity-Object of value
   * @param {object} state State-Object
   */
  async handleStateArrays(host, entity, state) {
    try {
      clientDetails[host][entity.id].states = state;
      for (const stateName in clientDetails[host][entity.id].states) {
        let unit = "";
        let writable = true;
        let writeValue = state[stateName];
        switch (stateName) {
          case "currentTemperature":
            unit = `\xB0C`;
            writable = false;
            clientDetails[host][entity.id].states.currentTemperature = this.modify(
              "round(2)",
              state[stateName]
            );
            break;
          case "oscillating":
            if (!clientDetails[host][entity.id].config.supportsOscillation) {
              writable = false;
            }
            break;
          case "speed":
            writable = false;
            break;
          case "speedLevel": {
            const supportedSpeedLevels = clientDetails[host][entity.id].config.supportedSpeedLevels;
            if (supportedSpeedLevels === null || supportedSpeedLevels === void 0 || supportedSpeedLevels === 0) {
              writable = false;
            }
            break;
          }
          case "direction":
            if (!clientDetails[host][entity.id].config.supportsDirection) {
              writable = false;
            }
            break;
        }
        if (stateName === `targetTemperature` || stateName === `targetTemperatureLow` || stateName === `targetTemperatureHigh`) {
          unit = `\xB0C`;
        }
        if (stateName === `brightness` || stateName === `blue` || stateName === `green` || stateName === `red` || stateName === `white` || stateName === `colorTemperature` || stateName === `colorBrightness` || stateName === `coldWhite` || stateName === `warmWhite`) {
          writeValue = Math.round(state[stateName] * 100 * 2.55);
          if (clientDetails[host][entity.id].states.transitionLength == null) {
            let transitionLength;
            try {
              transitionLength = await this.getStateAsync(
                `${clientDetails[host].deviceName}.${entity.type}.${entity.id}.transitionLength`
              );
              if (transitionLength) {
                clientDetails[host][entity.id].states.transitionLength = transitionLength.val;
                await this.stateSetCreate(
                  `${clientDetails[host].deviceName}.${entity.type}.${entity.id}.transitionLength`,
                  `${stateName} of ${entity.config.name}`,
                  transitionLength.val,
                  `ms`,
                  writable
                );
              } else {
                await this.stateSetCreate(
                  `${clientDetails[host].deviceName}.${entity.type}.${entity.id}.transitionLength`,
                  `${stateName} of ${entity.config.name}`,
                  0,
                  `ms`,
                  writable
                );
                clientDetails[host][entity.id].states.transitionLength = 0;
              }
            } catch {
              await this.stateSetCreate(
                `${clientDetails[host].deviceName}.${entity.type}.${entity.id}.transitionLength`,
                `${stateName} of ${entity.config.name}`,
                0,
                `ms`,
                writable
              );
              clientDetails[host][entity.id].states.transitionLength = 0;
            }
          }
          if (stateName === "white" && clientDetails[host][entity.id].rgbAutoWhite === void 0) {
            let rgbAutoWhiteVal = false;
            try {
              const existing = await this.getStateAsync(
                `${clientDetails[host].deviceName}.${entity.type}.${entity.id}.config.rgbAutoWhite`
              );
              if (existing != null) {
                rgbAutoWhiteVal = !!existing.val;
              }
            } catch (e) {
              this.log.debug(`[handleStateArrays] Could not read rgbAutoWhite state: ${e}`);
            }
            clientDetails[host][entity.id].rgbAutoWhite = rgbAutoWhiteVal;
            await this.extendObjectAsync(
              `${clientDetails[host].deviceName}.${entity.type}.${entity.id}.config`,
              {
                type: "channel",
                common: { name: "Configuration data" },
                native: {}
              }
            );
            await this.stateSetCreate(
              `${clientDetails[host].deviceName}.${entity.type}.${entity.id}.config.rgbAutoWhite`,
              "rgbAutoWhite",
              rgbAutoWhiteVal,
              "",
              true
            );
          }
        }
        if (stateName !== "key") {
          await this.stateSetCreate(
            `${clientDetails[host].deviceName}.${entity.type}.${entity.id}.${stateName}`,
            `${stateName} of ${entity.config.name}`,
            writeValue,
            unit,
            writable
          );
        }
      }
      if (clientDetails[host][entity.id].states.red != null && clientDetails[host][entity.id].states.blue != null && clientDetails[host][entity.id].states.green != null) {
        const hexValue = this.rgbToHex(
          Math.round(clientDetails[host][entity.id].states.red * 100 * 2.55),
          Math.round(clientDetails[host][entity.id].states.green * 100 * 2.55),
          Math.round(clientDetails[host][entity.id].states.blue * 100 * 2.55)
        );
        await this.stateSetCreate(
          `${clientDetails[host].deviceName}.${entity.type}.${entity.id}.colorHEX`,
          `ColorHEX of ${entity.config.name}`,
          hexValue,
          "",
          true
        );
      }
    } catch (error) {
      this.errorHandler(`[espHomeDashboard]`, error);
    }
  }
  /**
   * Traverses the json-object and provides all information for creating/updating states
   *
   * @param {object} jObject Json-object to be added as states
   * @param {string | null} parent Defines the parent object in the state tree; default=root
   * @param {boolean} replaceName Steers if name from child should be used as name for structure element (channel); default=false
   * @param {boolean} replaceID Steers if ID from child should be used as ID for structure element (channel); default=false;
   * @param {number} state_expire expire time for the current setState in seconds; default is no expire
   */
  async traverseJson(jObject, parent = null, replaceName = false, replaceID = false, state_expire = 0) {
    let id = null;
    let value2 = null;
    let name = null;
    try {
      for (const i in jObject) {
        name = i;
        if (!!jObject[i] && typeof jObject[i] === "object" && jObject[i] === "[object Object]") {
          if (parent == null) {
            id = i;
            if (replaceName) {
              if (jObject[i].name) {
                name = jObject[i].name;
              }
            }
            if (replaceID) {
              if (jObject[i].id) {
                id = jObject[i].id;
              }
            }
          } else {
            id = `${parent}.${i}`;
            if (replaceName) {
              if (jObject[i].name) {
                name = jObject[i].name;
              }
            }
            if (replaceID) {
              if (jObject[i].id) {
                id = `${parent}.${jObject[i].id}`;
              }
            }
          }
          if (Object.keys(jObject[i]).length !== 0) {
            await this.setObjectAsync(id, {
              type: "channel",
              common: {
                name
              },
              native: {}
            });
            await this.traverseJson(jObject[i], id, replaceName, replaceID, state_expire);
          } else {
            this.log.debug(`State ${id} received with empty array, ignore channel creation`);
          }
        } else {
          value2 = jObject[i];
          if (parent == null) {
            id = i;
          } else {
            id = `${parent}.${i}`;
          }
          if (typeof jObject[i] == "object") {
            value2 = JSON.stringify(value2);
          }
          if (value2 !== "[]") {
            this.log.debug(`create id ${id} with value ${value2} and name ${name}`);
            await this.stateSetCreate(id, name, value2);
          }
        }
      }
    } catch (error) {
      this.errorHandler(`[traverseJson]`, error);
    }
  }
  /**
   * Function to handle state creation
   * proper object definitions
   * rounding of values
   *
   * @param {string} objName ID of the object
   * @param {string} name Name of state (also used for stattAttrlib!)
   * @param {boolean | string | number | null} [value] Value of the state
   * @param {string} [unit] Unit to be set
   * @param {boolean} [writable] state writable ?
   * @param {object} initialStateCommon Additional attributes for state.common
   */
  async stateSetCreate(objName, name, value2, unit, writable, initialStateCommon = {}) {
    this.log.debug(`Create_state called for : ${objName} with value : ${value2}`);
    try {
      const common = initialStateCommon;
      if (!stateAttr[name]) {
        const warnMessage = `State attribute definition missing for '${name}'`;
        if (warnMessages[name] !== warnMessage) {
          warnMessages[name] = warnMessage;
        }
      }
      common.name = stateAttr[name] !== void 0 ? stateAttr[name].name || name : name;
      common.type = value2 == null ? "string" : typeof value2;
      common.role = stateAttr[name] !== void 0 ? stateAttr[name].role || "state" : "state";
      common.read = true;
      common.unit = unit !== void 0 ? unit || "" : "";
      common.write = writable !== void 0 ? writable || false : false;
      if (!this.createdStatesDetails[objName] || this.createdStatesDetails[objName] && (common.name !== this.createdStatesDetails[objName].name || common.name !== this.createdStatesDetails[objName].name || common.type !== this.createdStatesDetails[objName].type || common.role !== this.createdStatesDetails[objName].role || common.read !== this.createdStatesDetails[objName].read || common.unit !== this.createdStatesDetails[objName].unit || common.write !== this.createdStatesDetails[objName].write)) {
        await this.extendObjectAsync(objName, {
          type: "state",
          common,
          native: {}
        });
      } else {
      }
      this.createdStatesDetails[objName] = common;
      if (value2 != null) {
        await this.setStateAsync(objName, {
          val: value2,
          ack: true
        });
      }
      common.write && this.subscribeStates(objName);
    } catch (error) {
      this.errorHandler(`[stateSetCreate]`, error);
    }
  }
  /**
   * Handles error messages for log and Sentry
   *
   * @param {string} codepart Function were exception occurred
   * @param {unknown} error Caught value, anything can be thrown in JavaScript
   */
  errorHandler(codepart, error) {
    let errorMsg = error;
    if (error instanceof Error && error.stack != null) {
      errorMsg = error.stack;
    }
    try {
      if (!disableSentry) {
        this.log.info(`[Error caught and send to Sentry, thank you collaborating!] error: ${errorMsg}`);
        if (this.supportsFeature && this.supportsFeature("PLUGINS")) {
          const sentryInstance = this.getPluginInstance("sentry");
          if (sentryInstance && typeof sentryInstance.getSentryObject === "function") {
            const sentryObject = sentryInstance.getSentryObject();
            if (sentryObject) {
              sentryObject.captureException(errorMsg);
            }
          }
        }
      } else {
        this.log.error(`Sentry disabled, error caught : ${errorMsg}`);
      }
    } catch (error2) {
      this.log.error(`Error in function sendSentry: ${error2}`);
    }
  }
  /**
   * Helper replace function
   *
   * @param {string} string String to replace invalid chars
   */
  escapeRegExp(string) {
    return string.replace(/[.*+\-?^${}()|[\]\\]/g, "\\$&");
  }
  /**
   * Helper replace function
   *
   * @param {string} str String to replace invalid chars
   * @param {string} find String to find for replace function
   * @param {string} replace String to replace
   */
  replaceAll(str, find, replace) {
    return str.replace(new RegExp(this.escapeRegExp(find), "g"), replace);
  }
  /**
   * Extract the argument of a modify method, so "multiply(2.5)" yields "2.5"
   *
   * @param {string} method defines the method to be executed (e.g. round())
   * @returns {string} text between the brackets, empty when the method has no argument
   */
  modifyArgument(method2) {
    const inBracket = method2.match(/(?<=\()(.*?)(?=\))/);
    return inBracket ? inBracket[0] : "";
  }
  /**
   * Analysis modify an element in stateAttr.js and execute command
   *
   * @param {string} method defines the method to be executed (e.g. round())
   * @param {string | number | boolean} value value to be executed
   */
  modify(method, value) {
    this.log.debug(`Function modify with method "${method}" and value "${value}"`);
    let result = null;
    try {
      if (method.match(/^custom:/gi) != null) {
        value = eval(method.replace(/^custom:/gi, ""));
      } else if (method.match(/^multiply\(/gi) != null) {
        const inBracket = parseFloat(this.modifyArgument(method));
        value = Number(value) * inBracket;
      } else if (method.match(/^divide\(/gi) != null) {
        const inBracket = parseFloat(this.modifyArgument(method));
        value = Number(value) / inBracket;
      } else if (method.match(/^round\(/gi) != null) {
        const inBracket = parseInt(this.modifyArgument(method));
        value = Math.round(Number(value) * Math.pow(10, inBracket)) / Math.pow(10, inBracket);
      } else if (method.match(/^add\(/gi) != null) {
        const inBracket = parseFloat(this.modifyArgument(method));
        value = parseFloat(String(value)) + inBracket;
      } else if (method.match(/^substract\(/gi) != null) {
        const inBracket = parseFloat(this.modifyArgument(method));
        value = parseFloat(String(value)) - inBracket;
      } else {
        const methodUC = method.toUpperCase();
        switch (methodUC) {
          case "UPPERCASE":
            if (typeof value == "string") {
              result = value.toUpperCase();
            }
            break;
          case "LOWERCASE":
            if (typeof value == "string") {
              result = value.toLowerCase();
            }
            break;
          case "UCFIRST":
            if (typeof value == "string") {
              result = value.substring(0, 1).toUpperCase() + value.substring(1).toLowerCase();
            }
            break;
          default:
            result = value;
        }
      }
      if (!result) {
        return value;
      }
      return result;
    } catch (error) {
      this.errorHandler(`[modify]`, error);
      return value;
    }
  }
  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   *
   * @param {() => void} callback - Callback function to call when unload is complete
   */
  onUnload(callback) {
    try {
      for (const device in clientDetails) {
        if (clientDetails[device].mac != null) {
          const deviceName = this.replaceAll(clientDetails[device].mac, `:`, ``);
          if (clientDetails[device].connectStatus !== "newly discovered") {
            this.setState(`${deviceName}.info._online`, {
              val: false,
              ack: true
            });
          }
        }
        if (discovery) {
          discovery.destroy();
        }
        try {
          clientDetails[device].client.disconnect();
        } catch (e) {
          this.log.debug(`[onUnload] ${JSON.stringify(e)}`);
        }
      }
      for (const timer in resetTimers) {
        if (resetTimers[timer]) {
          resetTimers[timer] = this.clearTimeout(resetTimers[timer]);
        }
      }
      try {
        if (dashboardProcess) {
          dashboardProcess.kill("SIGTERM", {
            forceKillAfterTimeout: 2e3
          });
        }
      } catch (e) {
        this.log.error(`[onUnload - dashboardProcess] ${JSON.stringify(e)}`);
      }
      callback();
    } catch (error) {
      this.errorHandler(`[onUnload]`, error);
      callback();
    }
  }
  /**
   * Validate a proper format of IP-Address
   *
   * @param {string} ipAddress
   */
  validateIPAddress(ipAddress) {
    return /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(
      ipAddress
    );
  }
  /**
   * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
   * Using this method requires "common.message" property to be set to true in io-package.json
   *
   * @param {ioBroker.Message} obj - The message object
   */
  async onMessage(obj) {
    this.log.debug(`Data from configuration received : ${JSON.stringify(obj)}`);
    try {
      switch (obj.command) {
        //ToDo previous add function to be removed
        case "addDevice":
          const ipValid = this.validateIPAddress(obj.message["device-ip"]);
          if (!ipValid) {
            this.log.warn(
              `You entered an incorrect IP-Address ${obj.message["device-ip"]}, cannot add device !`
            );
            const massageObj = {
              type: "error",
              message: "connection failed"
            };
            this.respond(massageObj, obj);
          } else {
            this.log.info(`Valid IP address received`);
            this.connectDevices(obj.message["device-ip"]);
          }
          break;
        case "loadDevices":
          {
            let data = {};
            const knownDeviceTable = [];
            const discoveredDeviceTable = [];
            for (const device in clientDetails) {
              knownDeviceTable.push({
                MACAddress: clientDetails[device].mac,
                deviceName: clientDetails[device].deviceFriendlyName,
                ip: clientDetails[device].ip,
                connectState: clientDetails[device].connectStatus
              });
            }
            for (const device in newlyDiscoveredClient) {
              discoveredDeviceTable.push({
                MACAddress: newlyDiscoveredClient[device].mac,
                deviceName: newlyDiscoveredClient[device].deviceFriendlyName,
                ip: newlyDiscoveredClient[device].ip
              });
            }
            data = {
              native: {
                existingDevicesTable: knownDeviceTable,
                newDevicesTable: discoveredDeviceTable
              }
            };
            this.sendTo(obj.from, obj.command, data, obj.callback);
          }
          break;
        // Front End message handler to load IP-Address dropDown with all current known devices
        case "getDeviceIPs":
          {
            const dropDownEntry = [];
            for (const device in clientDetails) {
              dropDownEntry.push({
                label: device,
                value: clientDetails[device].ip
              });
            }
            for (const device in newlyDiscoveredClient) {
              dropDownEntry.push({
                label: device,
                value: newlyDiscoveredClient[device].ip
              });
            }
            this.sendTo(obj.from, obj.command, dropDownEntry, obj.callback);
          }
          break;
        // Front End message handler to load ESPHome Dashboard dropDown with all available versions
        case "getESPHomeDashboardVersion":
          {
            const dropDownEntry = [];
            dropDownEntry.push("Always last available");
            for (const versions in dashboardVersions) {
              dropDownEntry.push({
                label: dashboardVersions[versions],
                value: dashboardVersions[versions]
              });
            }
            this.ensureVersionInDropDown(dropDownEntry, defaultDashboardVersion);
            this.sendTo(obj.from, obj.command, dropDownEntry, obj.callback);
          }
          break;
        // Front End message handler to load Pillow version dropdown with available versions
        case "getPillowVersion":
          {
            const dropDownEntry = [];
            dropDownEntry.push("Always last available");
            if (pillowVersions.length > 0) {
              for (const version of pillowVersions) {
                dropDownEntry.push({
                  label: version,
                  value: version
                });
              }
            } else {
              this.log.info("No cached Pillow versions available, using fallback versions");
              const fallbackVersions = ["12.2.0", "12.1.1", "12.0.0", "11.3.0", "11.2.0", "11.1.0"];
              for (const version of fallbackVersions) {
                dropDownEntry.push({
                  label: version,
                  value: version
                });
              }
            }
            this.ensureVersionInDropDown(dropDownEntry, defaultPillowVersion);
            this.sendTo(obj.from, obj.command, dropDownEntry, obj.callback);
          }
          break;
        // Front End message handler to host IP-Address(es)
        case "getHostIp":
          {
            const hostIP = await this.getForeignObjectAsync(`system.host.${this.host}`);
            const ip4List = [];
            if (hostIP) {
              for (const ip in hostIP.common.address) {
                console.log(hostIP.common.address[ip]);
                if (this.validateIPAddress(hostIP.common.address[ip])) {
                  ip4List.push({
                    label: hostIP.common.address[ip],
                    value: hostIP.common.address[ip]
                  });
                }
              }
            }
            this.sendTo(obj.from, obj.command, ip4List, obj.callback);
          }
          break;
        // Handle front-end messages to ADD / Modify a devices
        case "_addUpdateDevice":
          if (obj.message.ip === "undefined") {
            this.sendTo(
              obj.from,
              obj.command,
              {
                error: "To add/modify a device, please enter the IP-Address accordingly"
              },
              obj.callback
            );
            return;
          } else if (!this.validateIPAddress(obj.message.ip)) {
            this.sendTo(
              obj.from,
              obj.command,
              {
                error: "Format of IP-Address is incorrect, please provide an valid IPV4 IP-Address"
              },
              obj.callback
            );
            return;
          }
          const initiateNDevice = async () => {
            const encryptionKeyUsed = !!(obj.message.encryptionKey && obj.message.encryptionKey !== "undefined");
            clientDetails[obj.message.ip] = new clientDevice();
            clientDetails[obj.message.ip].storeConnectDetails(
              obj.message.ip,
              encryptionKeyUsed,
              this.encrypt(obj.message.apiPassword),
              encryptionKeyUsed ? this.encrypt(obj.message.encryptionKey) : null
            );
            this.messageResponse[obj.message.ip] = obj;
            delete newlyDiscoveredClient[obj.message.ip];
            this.connectDevices(obj.message.ip);
          };
          if (!clientDetails[obj.message.ip]) {
            await initiateNDevice();
          } else {
            try {
              clientDetails[obj.message.ip].client.disconnect();
            } catch {
            }
            if (resetTimers[obj.message.ip]) {
              resetTimers[obj.message.ip] = this.clearTimeout(resetTimers[obj.message.ip]);
            }
            resetTimers[obj.message.ip] = this.setTimeout(async () => {
              delete clientDetails[obj.message.ip];
              await initiateNDevice();
            }, 2e3);
          }
          break;
        // Handle front-end messages to delete devices
        case "deleteDevice":
          this.messageResponse[obj.message.ip] = obj;
          if (clientDetails[obj.message.ip]) {
            clientDetails[obj.message.ip].client.disconnect();
            try {
              await this.delObjectAsync(clientDetails[obj.message.ip].deviceName, { recursive: true });
            } catch {
            }
            delete clientDetails[obj.message.ip];
            this.sendTo(
              this.messageResponse[obj.message.ip].from,
              this.messageResponse[obj.message.ip].command,
              { result: "OK - Device successfully removed" },
              this.messageResponse[obj.message.ip].callback
            );
            delete this.messageResponse[obj.message.ip];
          } else {
            this.sendTo(
              obj.from,
              obj.command,
              {
                error: "Provided IP-Address unknown, please refresh table and enter an valid IP-Address"
              },
              obj.callback
            );
            return;
          }
          break;
        // Handle YAML file upload
        case "uploadYamlFile":
          {
            if (!obj.message || !obj.message.filename || !obj.message.content) {
              this.sendTo(
                obj.from,
                obj.command,
                { error: "Filename and content are required" },
                obj.callback
              );
              return;
            }
            const result2 = await this.yamlFileManager.uploadYamlFile(
              obj.message.filename,
              obj.message.content
            );
            this.sendTo(obj.from, obj.command, result2, obj.callback);
          }
          break;
        // Handle listing YAML files
        case "listYamlFiles":
          {
            const files = await this.yamlFileManager.listYamlFiles();
            this.sendTo(
              obj.from,
              obj.command,
              {
                native: {
                  yamlFilesTable: files
                }
              },
              obj.callback
            );
          }
          break;
        // Handle YAML file download
        case "downloadYamlFile":
          {
            if (!obj.message || !obj.message.filename) {
              this.sendTo(obj.from, obj.command, { error: "Filename is required" }, obj.callback);
              return;
            }
            const result2 = await this.yamlFileManager.downloadYamlFile(obj.message.filename);
            if (result2.success) {
              this.sendTo(
                obj.from,
                obj.command,
                {
                  result: `File content (copy to use):

${result2.content}`
                },
                obj.callback
              );
            } else {
              this.sendTo(obj.from, obj.command, result2, obj.callback);
            }
          }
          break;
        // Handle YAML file deletion
        case "deleteYamlFile":
          {
            if (!obj.message || !obj.message.filename) {
              this.sendTo(obj.from, obj.command, { error: "Filename is required" }, obj.callback);
              return;
            }
            const result2 = await this.yamlFileManager.deleteYamlFile(obj.message.filename);
            this.sendTo(obj.from, obj.command, result2, obj.callback);
          }
          break;
        // Handle clearing autopy cache
        case "clearAutopyCache":
          {
            await this.clearAutopyCache();
            this.sendTo(
              obj.from,
              obj.command,
              { success: true, message: "Cache clearing triggered" },
              obj.callback
            );
          }
          break;
      }
    } catch (error) {
      this.errorHandler(`[onMessage]`, error);
    }
  }
  /**
   * Add a version to a dropDown when it is not part of it yet, so a configured version can never
   * silently disappear from the selection when the release list is unavailable or outdated
   *
   * @param {Array<string | {label: string, value: string}>} dropDownEntry - dropDown entries to extend
   * @param {string} version - version which must be selectable
   */
  ensureVersionInDropDown(dropDownEntry, version) {
    const known = dropDownEntry.some((entry) => (typeof entry === "string" ? entry : entry.value) === version);
    if (!known) {
      dropDownEntry.push({ label: version, value: version });
    }
  }
  /**
   * Fetch Pillow versions from PyPI and cache them
   *
   * @returns {Promise<string[]>} Array of available Pillow versions
   */
  async fetchAndCachePillowVersions() {
    const fallbackVersions = ["12.2.0", "12.1.1", "12.0.0", "11.3.0", "11.2.0", "11.1.0"];
    try {
      const response = await fetch("https://pypi.org/pypi/pillow/json");
      if (response.ok) {
        const data = (
          /** @type {{ releases: Record<string, unknown> }} */
          await response.json()
        );
        const versions = Object.keys(data.releases).filter((v) => !v.includes("a") && !v.includes("b") && !v.includes("rc")).sort((a, b) => {
          const aParts = a.split(".").map(Number);
          const bParts = b.split(".").map(Number);
          for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
            const aVal = aParts[i] || 0;
            const bVal = bParts[i] || 0;
            if (aVal !== bVal) {
              return bVal - aVal;
            }
          }
          return 0;
        }).slice(0, 20);
        if (versions.length > 0) {
          await this.stateSetCreate(
            `_ESPHomeDashboard.pillowVersionCache`,
            "pillowVersionCache",
            JSON.stringify(versions)
          );
          await this.stateSetCreate(
            `_ESPHomeDashboard.newestPillowVersion`,
            "newestPillowVersion",
            versions[0]
          );
          this.log.debug(`Fetched ${versions.length} Pillow versions from PyPI, newest: ${versions[0]}`);
          return versions;
        }
        this.log.warn("No stable Pillow versions found on PyPI, using cached or fallback versions");
      } else {
        this.log.warn(`Unable to fetch Pillow versions from PyPI: ${response.status}, using cached values`);
      }
    } catch (error) {
      const reason = error instanceof Error && error.message ? error.message : String(error);
      this.log.warn(`Error fetching Pillow versions from PyPI: ${reason}, using cached or fallback versions`);
    }
    try {
      const cachedPillowVersions = await this.getStateAsync(`_ESPHomeDashboard.pillowVersionCache`);
      if (cachedPillowVersions && cachedPillowVersions.val) {
        const versions = JSON.parse(String(cachedPillowVersions.val));
        this.log.info(`Loaded ${versions.length} Pillow versions from cache`);
        return versions;
      }
    } catch {
    }
    this.log.info(`Using ${fallbackVersions.length} fallback Pillow versions`);
    return fallbackVersions;
  }
  /**
   * Clear the autopy cache directory
   */
  async clearAutopyCache() {
    try {
      const homeDir = os.homedir();
      const autopyCache = path.join(homeDir, ".cache", "autopy");
      this.log.info(`Attempting to clear autopy cache at: ${autopyCache}`);
      if (fs.existsSync(autopyCache)) {
        fs.rmSync(autopyCache, { recursive: true, force: true });
        this.log.info("Autopy cache cleared successfully");
      } else {
        this.log.info("Autopy cache directory does not exist");
      }
    } catch (error) {
      const reason = error instanceof Error && error.message ? error.message : String(error);
      this.log.error(`Error clearing autopy cache: ${reason}`);
      throw error;
    }
  }
  /**
   * responds to the adapter that sent the original message
   *
   * @param {string} response - The response message
   * @param {object} obj - The original message object
   */
  respond(response, obj) {
    if (obj.callback) {
      this.sendTo(obj.from, obj.command, response, obj.callback);
    }
  }
  hexToRgb(hex) {
    const shorthandRegex = /^#?([a-f\d])([a-f\d])([a-f\d])$/i;
    hex = hex.replace(shorthandRegex, function(m, r, g, b) {
      return r + r + g + g + b + b;
    });
    const result2 = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result2 ? {
      red: parseInt(result2[1], 16),
      green: parseInt(result2[2], 16),
      blue: parseInt(result2[3], 16)
    } : null;
  }
  rgbToHex(r, g, b) {
    function componentToHex(color) {
      const hex = color.toString(16);
      return hex.length === 1 ? `0${hex}` : hex;
    }
    return `#${componentToHex(r)}${componentToHex(g)}${componentToHex(b)}`;
  }
  /**
   * Is called if a subscribed state changes
   *
   * @param {string} id - The state ID that changed
   * @param {ioBroker.State | null | undefined} state - The new state value
   */
  async onStateChange(id, state) {
    try {
      if (state && state.ack === false) {
        const device = id.split(".");
        try {
          if (id.split(".")[3] === "deviceCleanup") {
            await this.offlineDeviceCleanup();
            return;
          }
          if (id.split(".")[3] === "clearAutopyCache") {
            await this.clearAutopyCache();
            this.setState(id, { val: false, ack: true });
            return;
          }
        } catch {
        }
        const deviceName = device[2];
        if (!this.deviceStateRelation[deviceName]) {
          this.log.debug(`[onStateChange] Device ${deviceName} not connected, acknowledging state change`);
          await this.setStateAsync(id, { val: state.val, ack: true });
          return;
        }
        const deviceIP = this.deviceStateRelation[deviceName].ip;
        if (clientDetails[deviceIP][device[4]].type === `Switch`) {
          await clientDetails[deviceIP].client.connection.switchCommandService({
            key: device[4],
            state: state.val
          });
        } else if (clientDetails[deviceIP][device[4]].type === `Fan`) {
          const validFanStates = ["state", "speed", "speedLevel", "direction", "oscillating"];
          if (validFanStates.includes(device[5])) {
            clientDetails[deviceIP][device[4]].states[device[5]] = state.val;
            await clientDetails[deviceIP].client.connection.fanCommandService(
              clientDetails[deviceIP][device[4]].states
            );
          } else {
            this.log.warn(`Invalid fan state key "${device[5]}" for device ${device[2]}`);
          }
        } else if (clientDetails[deviceIP][device[4]].type === `Climate`) {
          clientDetails[deviceIP][device[4]].states[device[5]] = state.val;
          await clientDetails[deviceIP].client.connection.climateCommandService(
            clientDetails[deviceIP][device[4]].states
          );
        } else if (clientDetails[deviceIP][device[4]].type === `Number`) {
          await clientDetails[deviceIP].client.connection.numberCommandService({
            key: device[4],
            state: state.val
          });
        } else if (clientDetails[deviceIP][device[4]].type === `Text`) {
          await clientDetails[deviceIP].client.connection.textCommandService({
            key: device[4],
            state: state.val
          });
        } else if (clientDetails[deviceIP][device[4]].type === `Button`) {
          await clientDetails[deviceIP].client.connection.buttonCommandService({
            key: device[4]
          });
        } else if (clientDetails[deviceIP][device[4]].type === `Select`) {
          await clientDetails[deviceIP].client.connection.selectCommandService({
            key: device[4],
            state: state.val
          });
        } else if (clientDetails[deviceIP][device[4]].type === `Lock` && device[5] === `command`) {
          await clientDetails[deviceIP].client.connection.lockCommandService({
            key: device[4],
            command: state.val
          });
        } else if (device[5] === `position`) {
          await clientDetails[deviceIP].client.connection.coverCommandService({
            key: device[4],
            position: state.val
          });
        } else if (device[5] === `tilt`) {
          await clientDetails[deviceIP].client.connection.coverCommandService({
            key: device[4],
            tilt: state.val
          });
        } else if (device[5] === `stop`) {
          await clientDetails[deviceIP].client.connection.coverCommandService({
            key: device[4],
            stop: true
          });
        } else if (clientDetails[deviceIP][device[4]].type === `Light`) {
          let writeValue = state.val;
          if (device[5] === `brightness` || device[5] === `blue` || device[5] === `green` || device[5] === `red` || device[5] === `white` || device[5] === `colorTemperature` || device[5] === `colorBrightness` || device[5] === `coldWhite` || device[5] === `warmWhite`) {
            writeValue = Number(writeValue) / 100 / 2.55;
            clientDetails[deviceIP][device[4]].states[device[5]] = writeValue;
          } else if (device[5] === `colorMode`) {
            clientDetails[deviceIP][device[4]].states.colorMode = writeValue;
          } else if (device[5] === `colorHEX`) {
            const rgbConversion = this.hexToRgb(writeValue);
            if (!rgbConversion) {
              return;
            }
            clientDetails[deviceIP][device[4]].states.red = rgbConversion.red / 100 / 2.55;
            clientDetails[deviceIP][device[4]].states.blue = rgbConversion.blue / 100 / 2.55;
            clientDetails[deviceIP][device[4]].states.green = rgbConversion.green / 100 / 2.55;
          } else if (device[5] === `transitionLength`) {
            clientDetails[deviceIP][device[4]].states[device[5]] = writeValue;
          } else if (device[5] === "effect") {
            clientDetails[deviceIP][device[4]].states.effect = writeValue;
          } else if (device[5] === "state") {
            clientDetails[deviceIP][device[4]].states.state = writeValue;
          } else if (device[5] === "config" && device[6] === "rgbAutoWhite") {
            clientDetails[deviceIP][device[4]].rgbAutoWhite = writeValue;
            this.setState(id, !!writeValue, true);
            return;
          }
          const data = {
            key: clientDetails[deviceIP][device[4]].states.key,
            state: clientDetails[deviceIP][device[4]].states.state,
            transitionLength: clientDetails[deviceIP][device[4]].states.transitionLength
          };
          const lightConfig = clientDetails[deviceIP][device[4]].config;
          const colorModesList = lightConfig.supportedColorModesList || [];
          const supportsRgb = lightConfig.legacySupportsRgb === true || colorModesList.some((m) => (m & COLOR_CAPABILITY.RGB) !== 0);
          const supportsBrightness = lightConfig.legacySupportsBrightness === true || colorModesList.some((m) => (m & COLOR_CAPABILITY.BRIGHTNESS) !== 0);
          const supportsWhite = lightConfig.legacySupportsWhiteValue === true || colorModesList.some((m) => (m & COLOR_CAPABILITY.WHITE) !== 0);
          const supportsColorTemp = lightConfig.legacySupportsColorTemperature === true || colorModesList.some((m) => (m & COLOR_CAPABILITY.COLOR_TEMPERATURE) !== 0);
          const supportsColdWarmWhite = colorModesList.some(
            (m) => (m & COLOR_CAPABILITY.COLD_WARM_WHITE) !== 0
          );
          if (clientDetails[deviceIP][device[4]].rgbAutoWhite && supportsWhite && device[5] === "colorHEX") {
            if (String(writeValue).replace(/^#/, "").toLowerCase() === "ffffff") {
              clientDetails[deviceIP][device[4]].states.red = 0;
              clientDetails[deviceIP][device[4]].states.green = 0;
              clientDetails[deviceIP][device[4]].states.blue = 0;
              clientDetails[deviceIP][device[4]].states.white = 1;
            } else {
              clientDetails[deviceIP][device[4]].states.white = 0;
            }
          }
          if (supportsBrightness) {
            data.brightness = clientDetails[deviceIP][device[4]].states.brightness;
          }
          if (supportsRgb) {
            data.red = clientDetails[deviceIP][device[4]].states.red;
            data.green = clientDetails[deviceIP][device[4]].states.green;
            data.blue = clientDetails[deviceIP][device[4]].states.blue;
          }
          if (supportsWhite) {
            data.white = clientDetails[deviceIP][device[4]].states.white;
          }
          if (supportsColorTemp) {
            data.colorTemperature = clientDetails[deviceIP][device[4]].states.colorTemperature;
          }
          if (colorModesList.length > 0) {
            if (clientDetails[deviceIP][device[4]].states.colorMode !== void 0) {
              data.colorMode = clientDetails[deviceIP][device[4]].states.colorMode;
            }
            if (supportsRgb && clientDetails[deviceIP][device[4]].states.colorBrightness !== void 0) {
              data.colorBrightness = clientDetails[deviceIP][device[4]].states.colorBrightness;
            }
            if (supportsColdWarmWhite) {
              if (clientDetails[deviceIP][device[4]].states.coldWhite !== void 0) {
                data.coldWhite = clientDetails[deviceIP][device[4]].states.coldWhite;
              }
              if (clientDetails[deviceIP][device[4]].states.warmWhite !== void 0) {
                data.warmWhite = clientDetails[deviceIP][device[4]].states.warmWhite;
              }
            }
          }
          const effect = clientDetails[deviceIP][device[4]].states.effect;
          if (effect !== "" && effect !== null && effect !== void 0) {
            data.effect = effect;
          }
          this.log.debug(`Send Light values ${JSON.stringify(data)}`);
          await clientDetails[deviceIP].client.connection.lightCommandService(data);
        }
      }
    } catch (e) {
      this.log.error(`[onStateChange] ${e}`);
    }
  }
  /**
   * Some types (like Button) don't have a state. So standard method of creating iobroker objects when receiving state event via api doesn't work here
   *
   * @param {string} host - The ESPHome device hostname or IP
   * @param {object} entity - The entity object from ESPHome API
   * @returns {Promise<void>}
   */
  async createNonStateDevices(host, entity) {
    switch (clientDetails[host][entity.id].type) {
      case "Button": {
        await this.stateSetCreate(
          `${clientDetails[host].deviceName}.${entity.type}.${entity.id}.SET`,
          `Button`,
          false,
          "",
          true
        );
        break;
      }
    }
  }
  async resetOnlineStates() {
    try {
      const params = {
        startkey: `${this.namespace}.`,
        endkey: `${this.namespace}.\u9999`
      };
      const _devices = await this.getObjectViewAsync("system", "device", params);
      for (const currDevice in _devices.rows) {
        await this.extendObjectAsync(_devices.rows[currDevice].id, {
          common: {
            statusStates: {
              onlineId: `${_devices.rows[currDevice].id}.info._online`
            }
          }
        });
        await this.stateSetCreate(`${_devices.rows[currDevice].id}.info._online`, `Online state`, false);
      }
    } catch (error) {
      this.errorHandler(`[resetOnlineStates]`, error);
    }
  }
  async objectCleanup(ip) {
    try {
      this.log.debug(
        `[objectCleanup] Starting channel and state cleanup for ${clientDetails[ip].deviceFriendlyName} | ${ip}`
      );
      if (clientDetails[ip] && (clientDetails[ip].connectionError || !clientDetails[ip].connected)) {
        return;
      }
      const params = {
        startkey: `${this.namespace}.${clientDetails[ip].deviceName}.`,
        endkey: `${this.namespace}.\u9999`
      };
      const _channels = await this.getObjectViewAsync("system", "channel", params);
      for (const currDevice in _channels.rows) {
        if (!clientDetails[ip].adapterObjects.channels.includes(_channels.rows[currDevice].id) && _channels.rows[currDevice].id.split(".")[2] === clientDetails[ip].deviceName) {
          this.log.debug(`[objectCleanup] Unknown Channel found, delete ${_channels.rows[currDevice].id}`);
          await this.delObjectAsync(_channels.rows[currDevice].id, {
            recursive: true
          });
        }
      }
      const _states = await this.getObjectViewAsync("system", "state", params);
      for (const currDevice in _states.rows) {
        if (!this.createdStatesDetails[_states.rows[currDevice].id.replace(`esphome.0.`, ``)] && _states.rows[currDevice].id.split(".")[2] === clientDetails[ip].deviceName) {
          this.log.debug(`[objectCleanup] Unknown State found, delete ${_states.rows[currDevice].id}`);
        }
      }
    } catch (error) {
      this.errorHandler(`[objectCleanup]`, error);
    }
  }
  async offlineDeviceCleanup() {
    this.log.info(`Offline Device cleanup started`);
    try {
      const knownDevices = await this.getDevicesAsync();
      for (const device in knownDevices) {
        const online = await this.getStateAsync(`${knownDevices[device]._id}.info._online`);
        if (!online || !online.val) {
          this.log.info(
            `Offline device ${knownDevices[device]._id.split(".")[2]} expected on ip ${knownDevices[device].native.ip} removed`
          );
          await this.delObjectAsync(knownDevices[device]._id, {
            recursive: true
          });
        }
      }
      if (!knownDevices) {
        return;
      }
      if (knownDevices.length > 0) {
        this.log.info(`Try to contact ${knownDevices.length} known devices`);
      }
    } catch (error) {
      this.errorHandler(`[offlineDeviceCleanup]`, error);
    }
  }
  /**
   * Generic function to properly update memory connection details of a device in all scenarios
   *
   * @param {string} host IP-Address of device
   * @param {boolean} connected Indicator if a device is connected
   * @param {boolean} connecting Indicator if a device is initializing
   * @param {string} [connectionStatus] Connection status shown in Adapter instance / Device Manager
   * @param {boolean} [connectionError] Indicator if a connection error (like incorrect password or timeout) is present
   * @returns void
   */
  async updateConnectionStatus(host, connected, connecting, connectionStatus, connectionError) {
    try {
      if (!clientDetails[host]) {
        return;
      }
      clientDetails[host].connected = connected;
      clientDetails[host].connecting = connecting;
      clientDetails[host].connectionError = connectionError != null ? connectionError : clientDetails[host].connectionError;
      clientDetails[host].connectStatus = connectionStatus != null ? connectionStatus : clientDetails[host].connectStatus;
      if (clientDetails[host].connectStatus === "Initialisation needed") {
        return;
      }
      if (!connected || connectionError || connecting) {
        await this.stateSetCreate(`${clientDetails[host].deviceName}.info._online`, `Online state`, false);
      } else {
        await this.stateSetCreate(`${clientDetails[host].deviceName}.info._online`, `Online state`, true);
      }
      await this.stateSetCreate(
        `${clientDetails[host].deviceName}.info._connectionStatus`,
        `Connection status`,
        connectionStatus
      );
    } catch (error) {
      this.errorHandler(`[updateConnectionStatus]`, error);
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new Esphome(options);
} else {
  new Esphome();
}
//# sourceMappingURL=main.js.map
