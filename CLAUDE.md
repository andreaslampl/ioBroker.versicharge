# ioBroker.versicharge

ioBroker adapter for the Siemens VersiCharge AC (GEN3) wallbox via Modbus TCP (port 502, unit id 2).
Built only from the official Siemens "VersiCharge AC Series ModBus Map" (A5E52200882-AL 02/2025,
FW >= V2.136.14). evcc's versicharge driver is not MIT licensed - do not copy from it.

## Layout

- `lib/modbus.js` – `ModbusClient`: one persistent TCP connection (the charger accepts only ONE Modbus
  client), requests serialized with a small gap, FC 03/06/16, timeout drops the connection (late answers
  would confuse the next request), `connect()` emits 'connect'.
- `lib/registers.js` – `INFO`/`POLL` = one entry per table row, `blocks()` merges directly following entries
  (reads across gaps -> exception 2; main `readEntries()` then reads that block entry by entry and skips
  refused entries for good, logged once as info),
  internal addresses = external - 40001. `evseState()` (J1772 A/B/C/E/F), error texts, current
  encoding (<= 100 = A, > 100 = 0.01 A, < 6 A pauses; read back always in A), `parseInfo`/`parsePoll`.
- `main.js` – poll every `interval` s (min 2 s per Siemens), device info + fallback (41661 current,
  41662 time; not persistent, so sent on every new connection), states written on change,
  session energy from the meter at plug-in (`energy.sessionStart` persisted; integrated power if the
  meter reads 0, ERK variant), `control.current`/`enabled`/`energyLimit` (41641 uint32 Wh).
- `test/` – `node --test`; `fake.js` = fake charger (Modbus server with the same blocks, one connection,
  `silent` for timeouts) + fake adapter-core.

## Status

- 0.1.0: owner's wallbox: VersiCharge 3, firmware 2.500.34+25-32, 3-phase, car VW ID.4. So far it is
  driven by evcc (holds the single Modbus connection). Not yet tested against the real wallbox.
  Surplus charging lives in ioBroker.energie, the tile in ioBroker.smartview.
- 0.1.0 field: connected to the real wallbox (evcc stopped), but "Modbus-Fehler 2": the first info block
  40001-40031 spanned 40024, which is not in the table. 0.1.1: entry-wise table + fallback (see above);
  the fake charger now refuses every read touching a register outside the table, and Modbus errors name the register.
- 0.1.1 field: connects and reads the owner's wallbox: MLFB 8EM1310-3FJ04-3GA2, firmware 2.500.34, 3-phase,
  max 16 A, meter "eichrechtskonform (ERK)" - per Siemens the energy registers read 0 on ERK, so energy.total may
  stay empty and energy.session comes from integrated power. No register skipped. Owner confirmed the values
  arrive in ioBroker. Control (writing the current) and surplus charging not yet tested.
- 0.1.1 field: 6 A works; 0 pauses (enabled false), but control.current goes back to 16 right after. Unknown
  whether another ioBroker writer (energie wallbox control?) or the wallbox itself resets it, and whether the
  car really charges again. 0.1.2 logs every command with `state.from` and changes the wallbox makes by itself.
- No 1p/3p switching register exists in the map (only 41643 = charger type, read-only).

## Conventions

- UI texts and README in German, code and comments in English.
- Bump `version` in both `package.json` and `io-package.json` and add a `news` entry.
- Install on the ioBroker host: `iobroker url https://github.com/andreaslampl/ioBroker.versicharge`.
- Run `npm test` before committing.
- Don't put the owner's IP addresses in the repository (use x.x.x.x / 192.168.1.x examples).
