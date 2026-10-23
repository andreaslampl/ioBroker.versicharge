'use strict';

const utils = require('@iobroker/adapter-core');
const { ModbusClient } = require('./lib/modbus');
const R = require('./lib/registers');

const ro = (name, type, role, unit, extra = {}) => ({ type: 'state', common: { name, type, role, unit, read: true, write: false, ...extra }, native: {} });
const rw = (name, type, role, unit, extra = {}) => ({ type: 'state', common: { name, type, role, unit, read: true, write: true, ...extra }, native: {} });

const OBJECTS = {
    device: { type: 'channel', common: { name: 'Gerät' }, native: {} },
    'device.manufacturer': ro('Hersteller', 'string', 'info.manufacturer'),
    'device.serial': ro('Seriennummer', 'string', 'info.serial'),
    'device.mlfb': ro('Bestellnummer (MLFB)', 'string', 'info.model'),
    'device.productionDate': ro('Herstelldatum', 'string', 'text'),
    'device.firmware': ro('Firmware', 'string', 'info.firmware'),
    'device.firmwareM0': ro('Firmware M0', 'string', 'info.firmware'),
    'device.variant': ro('Firmware-Variante', 'string', 'text'),
    'device.meter': ro('Zähler', 'string', 'text'),
    'device.commissioned': ro('In Betrieb genommen über', 'string', 'text'),
    'device.delay': ro('Verzögerungstaste', 'string', 'text'),
    'device.ratedCurrent': ro('Nennstrom', 'number', 'value.current', 'A'),
    'device.installCurrent': ro('Installationsstrom (Drehschalter)', 'number', 'value.current', 'A'),
    'device.phases': ro('Phasen', 'number', 'value', '', { states: { 1: '1-phasig', 3: '3-phasig' } }),
    status: { type: 'channel', common: { name: 'Status' }, native: {} },
    'status.code': ro('Zustand (J1772)', 'string', 'text'),
    'status.text': ro('Zustand', 'string', 'text'),
    'status.plugged': ro('Auto angesteckt', 'boolean', 'indicator'),
    'status.charging': ro('Lädt', 'boolean', 'indicator.working'),
    'status.fault': ro('Fehler', 'boolean', 'indicator.alarm'),
    'status.error': ro('Fehlernummer', 'number', 'value'),
    'status.errorText': ro('Fehler', 'string', 'text'),
    'status.ocpp': ro('OCPP-Zustand', 'string', 'text'),
    'status.tempBoard': ro('Temperatur im Gerät', 'number', 'value.temperature', '°C'),
    'status.tempCable': ro('Kabeltemperatur', 'number', 'value.temperature', '°C'),
    power: { type: 'channel', common: { name: 'Leistung' }, native: {} },
    'power.total': ro('Ladeleistung', 'number', 'value.power', 'W'),
    'power.l1': ro('Leistung L1', 'number', 'value.power', 'W'),
    'power.l2': ro('Leistung L2', 'number', 'value.power', 'W'),
    'power.l3': ro('Leistung L3', 'number', 'value.power', 'W'),
    'power.current1': ro('Strom L1', 'number', 'value.current', 'A'),
    'power.current2': ro('Strom L2', 'number', 'value.current', 'A'),
    'power.current3': ro('Strom L3', 'number', 'value.current', 'A'),
    'power.voltage1': ro('Spannung L1', 'number', 'value.voltage', 'V'),
    'power.voltage2': ro('Spannung L2', 'number', 'value.voltage', 'V'),
    'power.voltage3': ro('Spannung L3', 'number', 'value.voltage', 'V'),
    energy: { type: 'channel', common: { name: 'Energie' }, native: {} },
    'energy.total': ro('Zählerstand', 'number', 'value.energy.consumed', 'kWh'),
    'energy.session': ro('Geladen (dieser Ladevorgang)', 'number', 'value.energy', 'kWh'),
    'energy.sessionStart': ro('Zählerstand beim Anstecken', 'number', 'value.energy', 'kWh'),
    'energy.sessionSince': ro('Angesteckt seit', 'number', 'date'),
    control: { type: 'channel', common: { name: 'Steuerung' }, native: {} },
    'control.current': rw('Ladestrom (unter 6 A = Pause)', 'number', 'level.current', 'A', { min: 0, max: 80, step: 0.5 }),
    'control.enabled': rw('Laden freigegeben', 'boolean', 'switch.enable'),
    'control.maxCurrent': ro('Höchster Ladestrom', 'number', 'value.current', 'A'),
    'control.energyLimit': rw('Nach x kWh aufhören (0 = aus)', 'number', 'level', 'kWh', { min: 0, max: 8191 }),
};

class Versicharge extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'versicharge' });
        this.last = new Map(); // state id -> last value written
        this.info = null;
        this.live = null;
        this.failures = 0;
        this.lastError = '';
        this.lastOn = 0; // last current >= 6 A (for control.enabled = true)
        this.missing = new Set(); // registers this charger refuses (exception 2)
        this.split = new Set(); // blocks that have to be read entry by entry
        this.session = { start: null, since: 0, wh: 0, ts: 0 };
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    get interval() {
        return Number(this.config.pollMs) || Math.max(2, Number(this.config.interval) || 5) * 1000; // pollMs: tests only
    }

    async onReady() {
        await this.setState('info.connection', false, true);
        const host = String(this.config.host || '').trim();
        if (!host) {
            this.log.error('Adresse der Wallbox fehlt (Instanz-Einstellungen)');
            return;
        }
        for (const [id, obj] of Object.entries(OBJECTS)) {
            await this.extendObject(id, obj);
        }
        const start = await this.getStateAsync('energy.sessionStart');
        const since = await this.getStateAsync('energy.sessionSince');
        const on = await this.getStateAsync('control.current');
        if (start && typeof start.val === 'number' && start.val > 0) {
            this.session.start = start.val;
            this.session.since = Number(since && since.val) || 0;
        }
        this.lastOn = on && on.val >= 6 ? on.val : 0;
        this.mb = new ModbusClient({ host, port: Number(this.config.port) || 502, unitId: Number(this.config.unitId) || 2, timeout: Math.max(5, Number(this.config.timeout) || 5) * 1000 });
        this.mb.on('connect', () => {
            this.log.info(`Verbunden mit ${host}`);
            this.info = null; // re-read device info and send fallback again
        });
        this.mb.on('disconnect', err => this.log.debug(`Verbindung getrennt: ${err.message}`));
        this.subscribeStates('control.*');
        this.poll();
    }

    async poll() {
        clearTimeout(this.timer);
        if (this.stopped) {
            return;
        }
        const t0 = Date.now();
        try {
            await this.mb.connect(); // a new connection resets info (device info + fallback again)
            if (!this.info) {
                await this.readInfo();
            }
            const values = await this.readEntries(R.POLL);
            if (!values.has(1599)) {
                throw new Error('Zustand der Wallbox (Register 41600) nicht lesbar');
            }
            this.live = R.parsePoll(values);
            await this.writeLive(this.live);
            if (this.failures || !this.connectedOnce) {
                await this.setState('info.connection', true, true);
            }
            this.connectedOnce = true;
            this.failures = 0;
            this.lastError = '';
        } catch (err) {
            this.failures++;
            if (err.message !== this.lastError) {
                this.log.warn(`Wallbox: ${err.message}`);
                this.lastError = err.message;
            }
            if (this.failures === 1) {
                await this.setState('info.connection', false, true);
            }
            this.connectedOnce = false;
        }
        if (this.stopped) {
            return;
        }
        // back off while unreachable: interval, then up to 60 s
        const wait = this.failures ? Math.min(60000, this.interval * Math.min(this.failures, 12)) : Math.max(500, this.interval - (Date.now() - t0));
        this.timer = setTimeout(() => this.poll(), wait);
    }

    /**
     * Reads table entries in as few requests as possible. A block the charger refuses (exception 2, e.g. a
     * register this firmware does not have) is read entry by entry from then on; refused entries are skipped.
     * Returns Map internal address -> uint16.
     */
    async readEntries(entries) {
        const out = new Map();
        for (const blk of R.blocks(entries.filter(([a]) => !this.missing.has(a)))) {
            const key = `${blk.addr}+${blk.count}`;
            if (blk.entries.length === 1 || !this.split.has(key)) {
                try {
                    (await this.mb.read(blk.addr, blk.count)).forEach((v, i) => out.set(blk.addr + i, v));
                    continue;
                } catch (err) {
                    if (err.code !== 2) {
                        throw err;
                    }
                    if (blk.entries.length === 1) {
                        this.skip(blk.addr);
                        continue;
                    }
                    this.split.add(key);
                }
            }
            for (const [addr, count] of blk.entries) {
                try {
                    (await this.mb.read(addr, count)).forEach((v, i) => out.set(addr + i, v));
                } catch (err) {
                    if (err.code !== 2) {
                        throw err;
                    }
                    this.skip(addr);
                }
            }
        }
        return out;
    }

    skip(addr) {
        this.missing.add(addr);
        this.log.info(`Register ${40001 + addr} gibt die Wallbox nicht her (Firmware) – wird übersprungen`);
    }

    async readInfo() {
        const info = R.parseInfo(await this.readEntries(R.INFO));
        const p = await this.readEntries([[1642, 1]]);
        const phases = p.has(1642) ? (p.get(1642) === 1 ? 3 : 1) : undefined;
        this.info = { ...info, phases };
        for (const k of ['manufacturer', 'serial', 'mlfb', 'productionDate', 'firmware', 'firmwareM0', 'variant', 'meter', 'commissioned', 'delay', 'ratedCurrent', 'installCurrent', 'phases']) {
            await this.put(`device.${k}`, this.info[k]);
        }
        await this.put('control.maxCurrent', this.maxCurrent());
        this.log.info(`${info.manufacturer || 'Wallbox'} ${info.mlfb || ''} (Seriennr. ${info.serial || '?'}), Firmware ${info.firmware || '?'}, ${phases || '?'}-phasig, max. ${this.maxCurrent()} A, Zähler: ${info.meter}`);
        await this.writeFallback();
    }

    maxCurrent() {
        const i = this.info || {};
        const own = Number(this.config.maxCurrent) || 0;
        const dev = i.installCurrent || i.ratedCurrent || 32;
        return own >= 6 ? Math.min(own, dev) : dev;
    }

    /** fallback when the Modbus connection is lost: the charger forgets it after a restart, so it is sent on every connect */
    async writeFallback() {
        const time = Number(this.config.fallbackTime) || 0;
        if (!time) {
            return;
        }
        const t = Math.max(60, Math.min(600, time));
        const mode = this.config.fallbackMode || 'max';
        const a = mode === 'stop' ? 0 : mode === 'custom' ? Math.max(6, Math.min(this.maxCurrent(), Number(this.config.fallbackCurrent) || 6)) : this.maxCurrent();
        try {
            await this.mb.writeSingle(R.REG.fallbackCurrent, a);
            await this.mb.writeSingle(R.REG.fallbackTime, t);
            this.log.info(`Rückfall bei Verbindungsverlust: nach ${t} s ${a ? `${a} A` : 'Laden pausieren'}`);
        } catch (err) {
            this.log.warn(`Rückfall-Einstellung nicht übernommen: ${err.message}`);
        }
    }

    async writeLive(v) {
        const e = v.evse;
        await this.put('status.code', e.code);
        await this.put('status.text', e.fault && v.error ? `${e.text}: ${v.errorText}` : e.text);
        await this.put('status.plugged', e.plugged);
        await this.put('status.charging', e.charging);
        await this.put('status.fault', e.fault || Boolean(v.error));
        await this.put('status.error', v.error);
        await this.put('status.errorText', v.errorText);
        await this.put('status.ocpp', v.ocpp);
        await this.put('status.tempBoard', v.tempBoard);
        const cable = [v.tempCableA, v.tempCableB].filter(x => x !== undefined);
        await this.put('status.tempCable', cable.length ? Math.max(...cable) : undefined);
        await this.put('power.total', v.powerTotal);
        for (let i = 0; i < 3; i++) {
            await this.put(`power.l${i + 1}`, v.power[i]);
            await this.put(`power.current${i + 1}`, v.current[i]);
            await this.put(`power.voltage${i + 1}`, v.voltage[i]);
        }
        if (this.info && v.phases !== undefined && this.info.phases !== v.phases) {
            this.info.phases = v.phases;
            await this.put('device.phases', v.phases);
        }
        if (v.currentLimit !== undefined) {
            await this.put('control.current', v.currentLimit);
            if (v.currentLimit >= 6) {
                this.lastOn = v.currentLimit;
            }
            await this.put('control.enabled', v.currentLimit >= 6);
        }
        await this.updateSession(v);
    }

    /** energy of the current charging session: meter at plug-in (or integrated power when the meter reads 0, e.g. ERK variant) */
    async updateSession(v) {
        const now = Date.now();
        const s = this.session;
        const meter = v.energyTotal || 0;
        const kwh = meter / 1000;
        if (meter > 0) {
            await this.put('energy.total', Math.round(kwh * 1000) / 1000);
        } else if (s.ts && v.evse.plugged) {
            s.wh += ((v.powerTotal || 0) * Math.min(now - s.ts, 60000)) / 3600000;
        }
        s.ts = now;
        if (v.evse.plugged && s.start === null) {
            s.start = kwh;
            s.since = now;
            s.wh = 0;
            await this.put('energy.sessionStart', s.start);
            await this.put('energy.sessionSince', s.since);
        } else if (!v.evse.plugged && s.start !== null) {
            s.start = null; // the last session value stays visible until the next plug-in
            await this.put('energy.sessionStart', 0);
        }
        if (s.start !== null) {
            const val = meter > 0 ? kwh - s.start : s.wh / 1000;
            await this.put('energy.session', Math.max(0, Math.round(val * 1000) / 1000));
        }
    }

    /** write an own state only when it changed */
    async put(id, val) {
        if (val === undefined || (typeof val === 'number' && !Number.isFinite(val))) {
            return;
        }
        if (this.last.get(id) === val) {
            return;
        }
        this.last.set(id, val);
        await this.setState(id, val, true);
    }

    async onStateChange(id, state) {
        if (!state || state.ack || !this.mb) {
            return;
        }
        const key = id.slice(this.namespace.length + 1);
        try {
            if (key === 'control.current') {
                await this.setCurrent(state.val);
            } else if (key === 'control.enabled') {
                const on = state.val === true || state.val === 1 || state.val === 'true';
                await this.setCurrent(on ? this.lastOn || this.maxCurrent() : 0);
            } else if (key === 'control.energyLimit') {
                const kwh = Math.max(0, Number(state.val) || 0);
                const wh = kwh ? Math.max(50, Math.min(8191000, Math.round(kwh * 1000))) : 0;
                await this.mb.writeMultiple(R.REG.energyTarget, [Math.floor(wh / 0x10000), wh & 0xffff]);
                this.log.info(wh ? `Laden endet nach weiteren ${wh / 1000} kWh` : 'Energie-Grenze aus');
                await this.setState(key, wh / 1000, true);
            }
        } catch (err) {
            this.log.warn(`${key} = ${state.val}: ${err.message}`);
            this.last.delete(key); // the next poll shows the real value again
        }
    }

    /** A -> charger; below 6 A pauses (per charging standard), above the maximum is limited */
    async setCurrent(val) {
        let a = Number(String(val).replace(',', '.'));
        if (!Number.isFinite(a) || a < 6) {
            a = 0;
        } else {
            a = Math.min(Math.round(a * 100) / 100, this.maxCurrent());
        }
        await this.mb.writeSingle(R.REG.current, R.currentToReg(a));
        const back = R.regToCurrent((await this.mb.read(R.REG.current, 1))[0]);
        this.log.debug(`Ladestrom ${a} A geschrieben, Wallbox meldet ${back} A`);
        if (back >= 6) {
            this.lastOn = back;
        }
        this.last.set('control.current', back);
        this.last.set('control.enabled', back >= 6);
        await this.setState('control.current', back, true);
        await this.setState('control.enabled', back >= 6, true);
    }

    onUnload(callback) {
        this.stopped = true;
        clearTimeout(this.timer);
        try {
            if (this.mb) {
                this.mb.close();
            }
            this.setState('info.connection', false, true);
        } finally {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = options => new Versicharge(options);
} else {
    new Versicharge();
}
