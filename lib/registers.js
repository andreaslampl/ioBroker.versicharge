'use strict';

/*
 * Siemens VersiCharge AC (GEN3) Modbus map, from the official Siemens document
 * "VersiCharge AC Series ModBus Map" A5E52200882-AL 02/2025 (FW >= V2.136.14).
 * Addresses are internal (0-based): external 4xxxx - 40001.
 * Blocks follow the table exactly; reading across gaps is refused by the charger (exception 2).
 */

// [internal address, number of registers] - each entry is one row of the Siemens table
const INFO = [
    [0, 5], // 40001 manufacturer
    [5, 2], // 40006 production date
    [7, 5], // 40008 serial
    [12, 10], // 40013 MLFB
    [22, 1], // 40023 platform (40024 is not in the table)
    [24, 1], // 40025 number of outlets
    [25, 1], // 40026 type of outlet
    [26, 1], // 40027 delay button
    [27, 1], // 40028 commissioned via
    [28, 1], // 40029 rated current
    [29, 1], // 40030 installation current
    [30, 1], // 40031 meter type
    [31, 5], // 40032 A8 firmware
    [36, 5], // 40037 M0 firmware
    [41, 1], // 40042 Modbus app
    [42, 6], // 40043 firmware variant
    [48, 3], // 40049 firmware date
];

const POLL = [
    [1599, 1], // 41600 EVSE state (ASCII)
    [1600, 1], // 41601 error
    [1601, 1], // 41602 OCPP state
    [1602, 1], // 41603..41606 temperatures
    [1603, 1],
    [1604, 1],
    [1605, 1],
    [1633, 1], // 41634 charging current limit
    [1640, 2], // 41641 energy target (uint32)
    [1642, 1], // 41643 charger phases
    ...[1647, 1648, 1649, 1650, 1651, 1652, 1653, 1654, 1655, 1656].map(a => [a, 1]), // 41648.. currents, voltages
    ...[1660, 1661, 1662, 1663, 1664, 1665].map(a => [a, 1]), // 41661.. fallback, active power
    [1692, 2], // 41693 total real energy (uint32)
];

/** entries -> blocks of directly following entries (one read each): [{addr, count, entries}] */
function blocks(entries) {
    const out = [];
    for (const [addr, count] of [...entries].sort((x, y) => x[0] - y[0])) {
        const last = out[out.length - 1];
        if (last && last.addr + last.count === addr && last.count + count <= 60) {
            last.count += count;
            last.entries.push([addr, count]);
        } else {
            out.push({ addr, count, entries: [[addr, count]] });
        }
    }
    return out;
}

const REG = {
    current: 1633, // 41634 RW: <= 100 = A, > 100 = 0.01 A; < 6 A pauses
    energyTarget: 1640, // 41641-41642 RW uint32 Wh, 0 = off
    fallbackCurrent: 1660, // 41661 RW A (0 or 6..max), not persistent
    fallbackTime: 1661, // 41662 RW s (0 or 60..600), not persistent
    reboot: 1826, // 41827 WO 1 soft, 2 hard
};

const PLATFORMS = {};
const OUTLETS = {};
const METERS = { 0: 'keine Messung', 1: 'Basis', 2: 'ANSI', 3: 'MID', 4: 'integrierter Zähler MID', 5: 'eichrechtskonform (ERK)', 7: 'CMC-Zähler', 9: 'CMC on board', 25: 'gesperrt' };
const DELAY = { 0: 'keine Verzögerung', 1: '2 Stunden', 2: '4 Stunden', 3: '6 Stunden', 4: '8 Stunden' };
const COMMISSIONED = { 0: 'nicht in Betrieb genommen', 1: 'WLAN', 2: 'Mobilfunk', 3: 'Ethernet' };
const OCPP = { 1: 'Verfügbar', 2: 'Vorbereitung', 3: 'Lädt', 4: 'Pausiert vom Auto', 5: 'Pausiert von der Wallbox', 6: 'Störung', 7: 'Beendet', 8: 'Nicht verfügbar' };

const ERRORS = {
    0: 'kein Fehler',
    2: 'Unterspannung L1',
    3: 'Unterspannung L2',
    4: 'Unterspannung L3',
    6: 'Überspannung L1',
    7: 'Überspannung L2',
    8: 'Überspannung L3',
    10: 'keine Spannung L1',
    11: 'keine Spannung L2',
    12: 'keine Spannung L3',
    22: 'keine Spannung am Ausgang L1',
    23: 'keine Spannung am Ausgang L2',
    24: 'keine Spannung am Ausgang L3',
    25: 'Fehler Pilotsignal (CP)',
    26: 'Stromwahlschalter falsch',
    27: 'ADC-Fehler',
    28: 'Speicherfehler',
    29: 'Fehlerstromschutz (CCID) ausgelöst',
    30: 'Selbsttest Fehlerstromschutz fehlgeschlagen',
    35: 'EEPROM-Fehler',
    36: 'FRAM-Fehler',
    37: 'Messchip-Fehler',
    38: 'Fehlerstromschutz schließt nicht',
    40: 'Steckerverriegelung',
    41: 'Kabel zu heiß',
    42: 'Schütz verschweißt L1',
    46: 'Erdungsüberwachung',
    47: 'Temperatur im Gerät',
    49: 'Temperatur im Gerät (Fühler A)',
    50: 'Temperatur im Gerät (Fühler A und B)',
    51: 'Temperatur im Gerät (Fühler B)',
    52: 'Kabeltemperatur (Fühler A)',
    53: 'Kabeltemperatur (Fühler A und B)',
    54: 'Kabeltemperatur (Fühler B)',
};

/** J1772 state (A1, B2, C2, " E", " F") -> plugged/charging/text */
function evseState(code) {
    const c = String(code || '').trim().toUpperCase();
    const letter = c[0] || '';
    const map = {
        A: 'Kein Auto angesteckt',
        B: c === 'B1' ? 'Auto angesteckt, Laden pausiert' : 'Auto angesteckt, wartet',
        C: c === 'C1' ? 'Auto angesteckt, Laden pausiert' : 'Lädt',
        D: 'Lädt (mit Belüftung)',
        E: 'Fehler (behebbar)',
        F: 'Störung',
    };
    return {
        code: c,
        plugged: ['B', 'C', 'D'].includes(letter),
        charging: (letter === 'C' || letter === 'D') && c !== 'C1',
        fault: letter === 'E' || letter === 'F',
        text: map[letter] || (c ? `Unbekannt (${c})` : 'Unbekannt'),
    };
}

/** registers -> ASCII text (2 chars per register, high byte first), spaces/nulls trimmed */
function ascii(regs) {
    const b = Buffer.alloc(regs.length * 2);
    regs.forEach((r, i) => b.writeUInt16BE(r, i * 2));
    return b.toString('latin1').replace(/\0/g, ' ').trim();
}

function int16(v) {
    return v > 0x7fff ? v - 0x10000 : v;
}

function uint32(hi, lo) {
    return hi * 0x10000 + lo;
}

/** user value in A -> register value (writes 0.01 A units above 100) */
function currentToReg(a) {
    const n = Number(a);
    if (!Number.isFinite(n) || n < 6) {
        return 0;
    }
    return Number.isInteger(n) ? n : Math.round(n * 100);
}

/** register value -> A ("returns it in the 0-80 A range") */
function regToCurrent(v) {
    return v > 100 ? v / 100 : v;
}

/** values: Map internal address -> uint16 (missing = not readable); external register numbers below */
function getter(m) {
    const r = n => m.get(n - 40001);
    const range = (from, to) => {
        const out = [];
        for (let n = from; n <= to; n++) {
            if (r(n) === undefined) {
                return undefined;
            }
            out.push(r(n));
        }
        return out;
    };
    const text = (from, to) => {
        const regs = range(from, to);
        return regs ? ascii(regs) : undefined;
    };
    const u32 = n => (r(n) === undefined || r(n + 1) === undefined ? undefined : uint32(r(n), r(n + 1)));
    const i16 = n => (r(n) === undefined ? undefined : int16(r(n)));
    const map = (table, n) => (r(n) === undefined ? undefined : table[r(n)] || String(r(n)));
    return { r, text, u32, i16, map };
}

function parseInfo(m) {
    const { r, text, map } = getter(m);
    const prod = r(40006);
    const prod2 = r(40007);
    return {
        manufacturer: text(40001, 40005),
        productionDate: prod && prod2 !== undefined ? `${prod}-${String(prod2 >> 8).padStart(2, '0')}-${String(prod2 & 0xff).padStart(2, '0')}` : undefined,
        serial: text(40008, 40012),
        mlfb: text(40013, 40022),
        platform: r(40023),
        outlets: r(40025),
        outletType: r(40026),
        delay: map(DELAY, 40027),
        commissioned: map(COMMISSIONED, 40028),
        ratedCurrent: r(40029),
        installCurrent: r(40030),
        meter: map(METERS, 40031),
        firmware: text(40032, 40036),
        firmwareM0: text(40037, 40041),
        modbusApp: r(40042),
        variant: text(40043, 40048),
        firmwareDate: text(40049, 40051),
    };
}

function parsePoll(m) {
    const { r, u32, i16, map } = getter(m);
    const err = i16(41601);
    const cur = r(41634);
    return {
        evse: evseState(r(41600) === undefined ? '' : ascii([r(41600)])),
        error: err,
        errorText: err === undefined ? undefined : ERRORS[err] || (err ? `Fehler ${err}` : 'kein Fehler'),
        ocpp: map(OCPP, 41602),
        tempBoard: i16(41603),
        tempCableA: i16(41604),
        tempBoardA: i16(41605),
        tempCableB: i16(41606),
        currentLimit: cur === undefined ? undefined : regToCurrent(cur),
        energyTarget: u32(41641),
        phases: r(41643) === undefined ? undefined : r(41643) === 1 ? 3 : 1,
        current: [r(41648), r(41649), r(41650)],
        currentAvg: r(41651),
        voltage: [r(41652), r(41653), r(41654)],
        voltageLL: [r(41655), r(41656), r(41657)],
        fallbackCurrent: r(41661),
        fallbackTime: r(41662),
        power: [r(41663), r(41664), r(41665)],
        powerTotal: r(41666),
        energyTotal: u32(41693),
    };
}

module.exports = { INFO, POLL, blocks, REG, ERRORS, OCPP, PLATFORMS, OUTLETS, evseState, ascii, int16, uint32, currentToReg, regToCurrent, parseInfo, parsePoll };
