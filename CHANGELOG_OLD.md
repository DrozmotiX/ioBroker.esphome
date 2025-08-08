# Older changes
## 0.5.0-beta.0 (2023-11-12) - Rebuild Admin Interface & Connection handler
* (DutchmanNL) Admin interface redesigned to JSON-Config relates #171
* (DutchmanNL) Backend massages implemented to Add/Modify/Delete devices
* (DutchmanNL) Device connection handling and visibility of devices improved
* (DutchmanNL) Auto device discovery temporary disabled due to external bug, relates #175
* (DutchmanNL) Possibility added to exclude IP-Addresses from device discovery, relates #175
* (DutchmanNL) Allow Selection to listen on specific interface or all for device discovery resolves #67
* (DutchmanNL) State implemented to show current connection status (unreachable/disconnected/connected) to improve management of devices
* (DutchmanNL) Several bugfixes, resolves #181 resolves #

## 0.4.1 (2023-11-05)
* (DutchmanNL) Bugfix: Password / connection issues in previous beta resolves #179
* (DutchmanNL) Bugfix: Allow individual API password or encryption keys for devices, resolves #174
* (DutchmanNL) Support ESPHome device Encryption Key (you should migrate from API password to Encryption Key ! resolves #152)

## 0.4.0 (2023-11-03)
* (DutchmanNL) Added cleanup capability for unused channels & states after initialization of a device, resolves #39
* (DutchmanNL) Added button to an info channel which allows to delete all offline devices from an adapter tree. resolves #39
* (DutchmanNL) [Breaking] Backup strategy changed, requires [BackitUp v2.9.1](https://github.com/simatec/ioBroker.backitup) and activate option for ESPHome, fixes #129

## 0.3.2 (2023-11-01)
* (DutchmanNL) Improved error handling if devices are not reachable/disconnected
* (DutchmanNL) Bugfix: Allow control of brightness and color for a light component, resolves #173

## 0.3.1 (2023-10-31)
* (DutchmanNL) Bugfix: Show online state of ESP Device correctly, resolves #106

## 0.3.0 (2023-10-31) - Bugfixes & Improvements
* (Dutchman & SimonFischer04) Several Bugfixes
* (SimonFischer04) Supports type "select device"
* (DutchmanNL) ESPHome dashboard default disabled
* (SimonFischer04) Migrate to @2colors/esphome-native-api
* (DutchmanNL) Automatically create needed directories, resolves #168
* (SimonFischer04) Migrate usage of python to new structure should solve all ESPHome Dashboard-related installation issues

## 0.2.4 (2021-08-24)
* (DutchmanNL) Version of ESPHome Dashboard updated to 2021.8
* (DutchmanNL) Add option if config of ESPHome device should be shown as states (default = FALSE, safes 8 states for each sensor)

## 0.2.3 (2021-06-29)
* (Jey-Cee) Bugfix : Light component state not changed [#74](https://github.com/DrozmotiX/ioBroker.esphome/issues/74)
* (DutchmanNL) Update compatibility to version 1.19.4 of ESPHome Dashboard

## 0.2.2 (2021-06-24)
* (DutchmanNL) [!!! Breaking !!!] Make YAML file persistent, backup your configuration before updating ! solves [#57](https://github.com/DrozmotiX/ioBroker.esphome/issues/57)
* (DutchmanNL) Update ESPHome Dashboard to 1.18.0, requires  Python >=3.7 (and ensure <4.0!)
* (DutchmanNL) Bugfix : Reconnect to devices without autodiscovery / MDNS-Broadcast in network, solves [#66](https://github.com/DrozmotiX/ioBroker.esphome/issues/66)

## 0.2.1-1 (2021-03-30)
* (DutchmanNL) add cover component
* (DutchmanNL) add transitionLength for lights

## 0.2.1-0 (2021-03-30)
* (DutchmanNL) Logging improved, solves [#48](https://github.com/DrozmotiX/ioBroker.esphome/issues/48)
* (DutchmanNL) Name of states changed, solves [#49](https://github.com/DrozmotiX/ioBroker.esphome/issues/49)

## 0.2.0 (2021-03-29)
* (DutchmanNL) Translations updated
* (DutchmanNL) Configuration page updated
* (DutchmanNL) Added to sentry error reporting
* (DutchmanNL) Native integration of ESPHome Dashboard added

## 0.1.5 (2021-03-21)
* (DutchmanNL) Add Translations

## 0.1.4 (2021-03-19)
* (DutchmanNL) Implemented RGBW
* (DutchmanNL) Ensure correct encryption and storage of passwords
* (DutchmanNL) Proper value ranges for type light (255 instead 100)
* (DutchmanNL) Implemented hex color state for type light (if RGB is available)

## 0.1.2 (2021-03-02)
* (DutchmanNL) Type Fan added
* (DutchmanNL) Type Light added
* (DutchmanNL) Error messages optimized
* (DutchmanNL) Device reconnect handling improved
* (DutchmanNL) [Breaking!] Change state name to default "state" for type BinarySensor / Climate / Sensor / TextSensor & Switch  
* (DutchmanNL) Autodiscovery improved, non-ESPHome devices excluded

## 0.1.0 (2021-02-27)
* (DutchmanNL) Autodiscovery implemented
* (DutchmanNL) Type Climat added
* (DutchmanNL) Type TextSensor added
* (DutchmanNL) Solved reconnection issues
* (DutchmanNL) Optimized error messages for unknown types
* (DutchmanNL & @xXBJXx) Adapter configuration page optimized

## 0.0.1
* (DutchmanNL) initial release