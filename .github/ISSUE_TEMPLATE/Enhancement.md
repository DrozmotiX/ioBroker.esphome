---
name: Enhancement Request
about: Request new functionality
title: ''
labels: 'enhancement'
assignees: 'DutchmanNL'
---

**!!! Before you start !!!!**
- [ ] I have verified that there is not already an issue requesting the same Enhancement
- [ ] Is it about adding support for a new device-type?

**Describe wanted Enhancement !**  
A clear description of the wanted functionality

**Why should we put effort in it ?**  
Please add some additional information why this Enhancement should be integrated

**Example YAML**  
If applicable, example yaml that demonstrates / can be used to test the new proposed functionality.  
Just an example, insert you own yaml!:
```yaml
esphome:
  name: test
  friendly_name: test

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

select:
  - platform: template
    name: "Template select"
    optimistic: true
    options:
      - one
      - two
      - three
    initial_option: two
```

**Additional context**  
Add any other context about the problem here.
