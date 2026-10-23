'use strict';

/*
 * Siemens VersiCharge AC (GEN3) Modbus map, from the official Siemens document
 * "VersiCharge AC Series ModBus Map" A5E52200882-AL 02/2025 (FW >= V2.136.14).
 * Addresses are internal (0-based): external 4xxxx - 40001.
 * Blocks follow the table exactly; reading across gaps is refused by the charger (exception 2).
 */

const INFO_BLOCKS = [
    [0, 31], // 40001..40031 manufacturer .. meter type
    [31, 20], // 40032..40051 firmware texts (A8, M0, Modbus app, variant, date)
];

const POLL_BLOCKS = [
    [1599, 7], // 41600..41606 EVSE state, error, OCPP state, temperatures
    [1633, 1], // 41634 charging current limit (Modbus)
    [1640, 3], // 41641..41643 energy target (uint32), charger phases
    [1647, 10], // 41648..41657 currents, voltages
    [1660, 6], // 41661..41666 fallback current/time, active power
    [1692, 2], // 41693..41694 total real energy (uint32)
];

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

/** device info from the two info blocks (external register numbers as keys) */
function parseInfo(a, b) {
    const r = n => (n < 40032 ? a[n - 40001] : b[n - 40032]);
    const range = (from, to) => {
        const out = [];
        for (let n = from; n <= to; n++) {
            out.push(r(n));
        }
        return out;
    };
    const prod = r(40006);
    const prod2 = r(40007);
    return {
        manufacturer: ascii(range(40001, 40005)),
        productionDate: prod ? `${prod}-${String(prod2 >> 8).padStart(2, '0')}-${String(prod2 & 0xff).padStart(2, '0')}` : '',
        serial: ascii(range(40008, 40012)),
        mlfb: ascii(range(40013, 40022)),
        platform: r(40023),
        outlets: r(40025),
        outletType: r(40026),
        delay: DELAY[r(40027)] || String(r(40027)),
        commissioned: COMMISSIONED[r(40028)] || String(r(40028)),
        ratedCurrent: r(40029),
        installCurrent: r(40030),
        meter: METERS[r(40031)] || String(r(40031)),
        firmware: ascii(range(40032, 40036)),
        firmwareM0: ascii(range(40037, 40041)),
        modbusApp: r(40042),
        variant: ascii(range(40043, 40048)),
        firmwareDate: ascii(range(40049, 40051)),
    };
}

/** live values from the poll blocks (in POLL_BLOCKS order) */
function parsePoll([st, cur, tgt, iv, pw, en]) {
    const evse = evseState(ascii([st[0]]));
    const err = int16(st[1]);
    const phases = tgt[2] === 1 ? 3 : 1;
    return {
        evse,
        error: err,
        errorText: ERRORS[err] || (err ? `Fehler ${err}` : 'kein Fehler'),
        ocpp: OCPP[st[2]] || String(st[2]),
        tempBoard: int16(st[3]),
        tempCableA: int16(st[4]),
        tempBoardA: int16(st[5]),
        tempCableB: int16(st[6]),
        currentLimit: regToCurrent(cur[0]),
        energyTarget: uint32(tgt[0], tgt[1]),
        phases,
        current: [iv[0], iv[1], iv[2]],
        currentAvg: iv[3],
        voltage: [iv[4], iv[5], iv[6]],
        voltageLL: [iv[7], iv[8], iv[9]],
        fallbackCurrent: pw[0],
        fallbackTime: pw[1],
        power: [pw[2], pw[3], pw[4]],
        powerTotal: pw[5],
        energyTotal: uint32(en[0], en[1]),
    };
}

module.exports = { INFO_BLOCKS, POLL_BLOCKS, REG, ERRORS, OCPP, PLATFORMS, OUTLETS, evseState, ascii, int16, uint32, currentToReg, regToCurrent, parseInfo, parsePoll };
