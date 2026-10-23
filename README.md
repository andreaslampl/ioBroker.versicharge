# ioBroker.versicharge

Siemens **VersiCharge AC** (GEN3) Wallbox in ioBroker – lokal über **Modbus TCP**, ohne Cloud.
Liefert Status, Leistung, Ströme, Zählerstand und die pro Ladevorgang geladene Energie und stellt den
**Ladestrom** ein. Damit kann der Adapter **energie** mit PV-Überschuss laden, und **SmartView** zeigt
die Wallbox als Kachel.

Gebaut nach der offiziellen Siemens-Unterlage „VersiCharge AC Series ModBus Map“ (A5E52200882-AL,
02/2025, gültig ab Firmware V2.136.14).

## Vorher

1. **Modbus in der Wallbox einschalten** – ab Werk ist Modbus aus. Einschalten in der App
   **Sifinity Go** (oder über den Siemens-Support).
2. **Nur EINE Modbus-Verbindung:** Die Wallbox nimmt nur einen Modbus-Teilnehmer an. Läuft z. B. **evcc**
   mit der Wallbox, bekommt dieser Adapter keine Verbindung → die Wallbox in evcc entfernen bzw. evcc stoppen.
3. Wird die Wallbox über **OCPP** (Backend) gesteuert, ist Modbus laut Siemens nur noch zum Ablesen da –
   der Ladestrom lässt sich dann evtl. nicht ändern.

## Installation

```
iobroker url https://github.com/andreaslampl/ioBroker.versicharge
```

Dann eine Instanz anlegen und die **Adresse der Wallbox** eintragen (IP, z. B. 192.168.1.x).
Port 502 und Unit-ID 2 passen normalerweise.

## Einstellungen

| Feld | Bedeutung |
|---|---|
| Adresse, Port, Unit-ID | Modbus TCP der Wallbox (Port 502 fest, Unit-ID ab Werk 2) |
| Abfrage alle (s) | Siemens verlangt mindestens 2 s, Standard 5 s |
| Höchster Ladestrom | 0 = wie am Drehschalter der Wallbox eingestellt, sonst eigene Grenze |
| Rückfall nach (s) | Erreicht ioBroker die Wallbox so lange nicht (60–600 s), stellt die Wallbox **selbst** um: normal laden, pausieren oder eigener Strom. 0 = aus |

Der Rückfall wird bei jeder Verbindung neu an die Wallbox geschickt (sie vergisst ihn nach einem Neustart).
Standard: nach 300 s normal laden – wenn ioBroker einmal steht, lädt das Auto trotzdem.

## Datenpunkte

| Datenpunkt | Inhalt |
|---|---|
| `status.text` | Kein Auto angesteckt / Auto angesteckt, wartet / Lädt / Fehler … |
| `status.plugged`, `status.charging`, `status.fault` | angesteckt / lädt / Fehler (true/false) |
| `status.code` | Zustand nach J1772 (A1, B2, C2, E, F) |
| `status.error`, `status.errorText` | Fehlernummer und Text |
| `power.total` | Ladeleistung in W, dazu je Phase Leistung, Strom und Spannung |
| `energy.total` | Zählerstand in kWh |
| `energy.session` | in diesem Ladevorgang geladen (kWh, ab dem Anstecken; bleibt nach dem Abstecken stehen) |
| `control.current` | **Ladestrom in A** (schreibbar). Unter 6 A = Pause, Kommazahlen erlaubt (z. B. 8,5) |
| `control.enabled` | Laden ein/aus (schreibbar); ein = letzter Strom ab 6 A |
| `control.energyLimit` | ab jetzt nach x kWh aufhören (schreibbar), 0 = aus |
| `control.maxCurrent` | höchster einstellbarer Strom |
| `device.*` | Hersteller, Seriennummer, Bestellnummer, Firmware, Phasen, Zähler, Nennstrom |

## PV-Überschussladen

Das Regeln übernimmt der Adapter **energie** (Bereich „Wallbox“): Er kennt Netz, PV und Hausakku und
schreibt den passenden Strom in `versicharge.0.control.current`.

Gut zu wissen:

- Die VersiCharge kann über Modbus **nicht zwischen 1 und 3 Phasen umschalten**. Bei 3-phasigem Anschluss
  beginnt das Laden mit mindestens 6 A × 3 × 230 V ≈ **4,1 kW**, 1-phasig ab ≈ 1,4 kW.
- Laut Norm pausiert die Wallbox unter 6 A.

## Lizenz

MIT
