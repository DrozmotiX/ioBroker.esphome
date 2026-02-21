---
name: Verbesserungsvorschlag (Deutsch)
about: Neue Funktionalität anfragen
title: ''
labels: 'enhancement'
assignees: 'DutchmanNL'
---

**!!! Vor dem Erstellen des Vorschlags !!!!**
- [ ] Ich habe überprüft, dass es noch kein Issue gibt, das dieselbe Verbesserung anfordert
- [ ] Geht es darum, Unterstützung für einen neuen Gerätetyp hinzuzufügen?

**Gewünschte Verbesserung beschreiben!**  
Eine klare Beschreibung der gewünschten Funktionalität.

**Warum sollten wir dafür Aufwand investieren?**  
Bitte füge zusätzliche Informationen hinzu, warum diese Verbesserung integriert werden sollte.

**Beispiel-YAML**  
Falls zutreffend, ein Beispiel-YAML, das die neue vorgeschlagene Funktionalität demonstriert bzw. zum Testen verwendet werden kann.  
Nur ein Beispiel, füge deine eigene YAML ein!:
```yaml
esphome:
  name: test
  friendly_name: test

esp8266:
  board: esp01_1m

# Logging aktivieren
logger:

# Home Assistant API aktivieren
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

**Zusätzliche Informationen**  
Füge hier weitere Informationen zum Vorschlag hinzu.
