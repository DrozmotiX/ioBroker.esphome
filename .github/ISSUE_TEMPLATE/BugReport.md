---
name: Bug report
about: Something is not working as it should
title: ''
labels: 'bug'
assignees: 'DutchmanNL'
---

**!!! Before you start !!!**  
- [ ] I have verified that there is not already an issue with the same problem 
- [ ] This is really a bug of current code, not an enhancement request (f.e. adding support for a new device type). There is a dedicated template for feature-requests. 

**Describe the bug**  
A clear and concise description of what the bug is.

**To Reproduce**  
Steps to reproduce the behavior:
1. Create a new device with given yaml.
2. ... (compile, flash, trigger some action on device / try to control state in iobroker, ...)
3. 

Minimal! Yaml config to reproduce.  
Keep all that is required to copy-paste, compile, flash and reproduce the issue - but try to remove as much as possible that is not relevant to this issue!  
Just an example, insert you own yaml!:
```yaml
esphome:
  name: esp-01

esp8266:
  board: esp01_1m

# Enable logging
logger:

# Enable Home Assistant API
api:

ota:
  password: "verysecretotapassword"

wifi:
  ssid: !secret wifi_ssid
  password: !secret wifi_password

light:
  - platform: binary
    name: "Fancy Light"
    output: light_output

output:
  - id: light_output
    platform: gpio
    pin:
      number: GPIO16
      mode:
        output: true
```

**Expected behavior**  
A clear and concise description of what you expected to happen.

**Logs (as screenshot and in text-form)** 

ALL ioBroker logs of the esphome adapter (in a reasonable timeframe around when the issue happened). Not just the latest as this is often not helpful.:

(insert screenshot here)
```txt
esphome.0 2024-03-18 04:20:31.141	info	Try to connect to 1.2.3.4
...
```

If applicable, other logs (like compile logs in dashboard):

(insert screenshot here)
```txt
...
```

**Versions:**  
 - Adapter version: <adapter-version>
 - ESPHome Dashboard version: <dashboard-version>
 - JS-Controller version: <js-controller-version> <!-- determine this with `iobroker -v` on the console -->
 - Node version: <node-version> <!-- determine this with `node -v` on the console -->
 - Operating system: <os-name>
 - Installation Method: installation script / Docker / ...

**Additional context**  
Add any other context about the problem here.
