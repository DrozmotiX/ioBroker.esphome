---
name: Fehlerbericht (Deutsch)
about: Etwas funktioniert nicht wie erwartet
title: ''
labels: 'bug'
assignees: 'DutchmanNL'
---

**!!! Vor dem Erstellen des Berichts !!!**  
- [ ] Ich habe überprüft, dass es noch kein Issue mit demselben Problem gibt
- [ ] Dies ist wirklich ein Fehler im aktuellen Code und kein Verbesserungsvorschlag (z.B. Unterstützung für einen neuen Gerätetyp hinzufügen). Dafür gibt es eine eigene Vorlage.

**Fehlerbeschreibung**  
Eine klare und präzise Beschreibung des Fehlers.

**Reproduktion**  
Schritte zur Reproduktion des Verhaltens:
1. Neues Gerät mit der angegebenen YAML-Konfiguration erstellen.
2. ... (kompilieren, flashen, eine Aktion auf dem Gerät auslösen / versuchen, den Zustand in ioBroker zu steuern, ...)
3. 

Minimale! YAML-Konfiguration zur Reproduktion.  
Behalte alles, was erforderlich ist, um das Issue zu kopieren, zu kompilieren, zu flashen und nachzustellen – entferne aber so viel wie möglich, was für dieses Issue nicht relevant ist!  
Nur ein Beispiel, füge deine eigene YAML ein!:
```yaml
esphome:
  name: esp-01

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

**Erwartetes Verhalten**  
Eine klare und präzise Beschreibung dessen, was erwartet wurde.

**Protokolle (als Screenshot und in Textform)**

ALLE ioBroker-Protokolle des ESPHome-Adapters (in einem angemessenen Zeitrahmen rund um das Auftreten des Fehlers). Nicht nur die letzte Protokollmeldung, da diese oft nicht aussagekräftig ist.:

(Screenshot hier einfügen)
```txt
esphome.0 2024-03-18 04:20:31.141	info	Try to connect to 1.2.3.4
...
```

Falls zutreffend, weitere Protokolle (z.B. Kompilierprotokolle im Dashboard):

(Screenshot hier einfügen)
```txt
...
```

**Versionen:**  
 - Adapter-Version: <adapter-version>
 - ESPHome-Dashboard-Version: <dashboard-version>
 - JS-Controller-Version: <js-controller-version> <!-- ermittelbar mit `iobroker -v` in der Konsole -->
 - Node-Version: <node-version> <!-- ermittelbar mit `node -v` in der Konsole -->
 - Betriebssystem: <os-name>
 - Installationsmethode: Installationsskript / Docker / ...

**Zusätzliche Informationen**  
Füge hier weitere Informationen zum Problem hinzu.
