'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeCharger, install, until } = require('./fake');
const R = require('../lib/registers');
const { ModbusClient } = require('../lib/modbus');

install();

test('register helpers', () => {
    assert.deepEqual(
        ['A1', 'B1', 'B2', 'C1', 'C2', ' E', ' F'].map(c => {
            const s = R.evseState(c);
            return [s.plugged, s.charging, s.fault];
        }),
        [
            [false, false, false],
            [true, false, false],
            [true, false, false],
            [true, false, false],
            [true, true, false],
            [false, false, true],
            [false, false, true],
        ],
    );
    assert.equal(R.currentToReg(6), 6);
    assert.equal(R.currentToReg(16), 16);
    assert.equal(R.currentToReg(8.5), 850);
    assert.equal(R.currentToReg(5), 0);
    assert.equal(R.regToCurrent(850), 8.5);
    assert.equal(R.regToCurrent(31), 31);
    assert.equal(R.uint32(18, 54919), 1234567);
});

test('Modbus client: exceptions, only one connection, timeout', async () => {
    const c = fakeCharger();
    const port = await c.listen();
    const mb = new ModbusClient({ host: '127.0.0.1', port, unitId: 2, timeout: 500 });
    try {
        assert.equal(R.ascii(await mb.read(0, 5)), 'Siemens AG');
        await assert.rejects(mb.read(1600, 40), /Modbus-Fehler 2/);
        await assert.rejects(mb.read(0, 31), /Modbus-Fehler 2/, '40024 is not in the table');
        // a second client gets no connection while the first holds it
        const other = new ModbusClient({ host: '127.0.0.1', port, unitId: 2, timeout: 300 });
        await assert.rejects(other.read(0, 5));
        other.close();
        c.silent = true;
        await assert.rejects(mb.read(0, 5), /Zeitüberschreitung/);
        c.silent = false;
        assert.equal((await mb.read(1633, 1))[0], 16); // reconnects
    } finally {
        mb.close();
        await c.close();
    }
});

async function start(t, config = {}, chargerOpts = {}) {
    const c = fakeCharger(chargerOpts);
    const port = await c.listen();
    const adapter = require('../main.js')({ config: { host: '127.0.0.1', port, unitId: 2, interval: 5, pollMs: 60, fallbackTime: 300, fallbackMode: 'max', ...config } });
    adapter.emit('ready');
    t.after(async () => {
        await new Promise(r => adapter.emit('unload', r));
        await c.close();
    });
    await until(() => adapter.val('info.connection') === true && adapter.val('power.total') !== undefined);
    return { c, adapter };
}

test('reads device info, status and values; fallback is sent', async t => {
    const { c, adapter } = await start(t);
    assert.equal(adapter.val('device.manufacturer'), 'Siemens AG');
    assert.equal(adapter.val('device.serial'), 'VC12345678');
    assert.equal(adapter.val('device.firmware'), '2.500');
    assert.equal(adapter.val('device.phases'), 3);
    assert.equal(adapter.val('device.meter'), 'MID');
    assert.equal(adapter.val('control.maxCurrent'), 16);
    assert.equal(adapter.val('status.plugged'), false);
    assert.equal(adapter.val('status.text'), 'Kein Auto angesteckt');
    assert.equal(adapter.val('energy.total'), 1234.567);
    // fallback: highest current after 300 s
    assert.deepEqual(
        c.writes.filter(w => w.addr === 1660 || w.addr === 1661).map(w => [w.addr, w.values[0]]),
        [
            [1660, 16],
            [1661, 300],
        ],
    );

    c.car('C2');
    await until(() => adapter.val('status.charging') === true);
    await until(() => adapter.val('power.total') === 16 * 230 * 3);
    assert.equal(adapter.val('status.plugged'), true);
    assert.equal(adapter.val('status.text'), 'Lädt');
    assert.equal(adapter.val('power.current1'), 16);
    assert.equal(adapter.val('energy.sessionStart'), 1234.567);
    c.meter(1240067);
    await until(() => adapter.val('energy.session') === 5.5);
    c.car('A1');
    await until(() => adapter.val('status.plugged') === false);
    assert.equal(adapter.val('energy.session'), 5.5, 'last session stays visible');
});

test('charging current: pause below 6 A, 0.01 A steps, limited to the maximum, enabled switch', async t => {
    const { c, adapter } = await start(t);
    c.car('C2');
    adapter.command('control.current', 8.5);
    await until(() => adapter.states['versicharge.0.control.current'].ack && adapter.val('control.current') === 8);
    assert.deepEqual(c.writes.at(-1), { addr: 1633, values: [850] });

    adapter.command('control.current', 4);
    await until(() => adapter.val('control.enabled') === false);
    assert.deepEqual(c.writes.at(-1), { addr: 1633, values: [0] });
    await until(() => adapter.val('status.charging') === true && adapter.val('power.total') === 0);

    adapter.command('control.enabled', true);
    await until(() => adapter.val('control.current') === 8 && adapter.val('control.enabled') === true);
    assert.deepEqual(c.writes.at(-1), { addr: 1633, values: [8] });

    adapter.command('control.current', 40);
    await until(() => adapter.val('control.current') === 16);
    assert.deepEqual(c.writes.at(-1), { addr: 1633, values: [16] });

    adapter.command('control.energyLimit', 20);
    await until(() => c.writes.at(-1).addr === 1640);
    assert.deepEqual(c.writes.at(-1).values, [0, 20000]);
});

test('connection loss: not connected, then reconnects with fallback again', async t => {
    const { c, adapter } = await start(t, { timeout: 5 });
    adapter.mb.timeout = 200;
    c.silent = true;
    await until(() => adapter.val('info.connection') === false);
    c.silent = false;
    const before = c.writes.length;
    await until(() => adapter.val('info.connection') === true, 8000);
    assert.ok(c.writes.slice(before).some(w => w.addr === 1661), 'fallback sent again after reconnect');
    assert.ok(adapter.logs.some(l => /warn: Wallbox: Keine Antwort/.test(l)));
});

test('a register the firmware does not have is skipped, the rest still works', async t => {
    const { c, adapter } = await start(t, {}, { missing: [41604, 40031] });
    assert.equal(adapter.val('device.manufacturer'), 'Siemens AG');
    assert.equal(adapter.val('device.meter'), undefined);
    assert.equal(adapter.val('power.total'), 0);
    assert.ok(adapter.logs.some(l => /Register 41604 gibt die Wallbox nicht her/.test(l)));
    assert.ok(adapter.logs.some(l => /Register 40031 gibt die Wallbox nicht her/.test(l)));
    assert.ok(!adapter.logs.some(l => /warn/.test(l)), adapter.logs.join('\n'));
    // later polls read the block around it in parts, without the missing register
    c.reads.length = 0;
    c.car('C2');
    await until(() => adapter.val('status.charging') === true);
    assert.ok(!c.reads.some(([a, n]) => a <= 1603 && a + n > 1603));
});

test('pause: the wallbox shows 16 A again after 0 (owner FW 2.500) - the pause stays, is sent again if it charges', async t => {
    const { c, adapter } = await start(t);
    c.revertPause = 16;
    c.car('B1');
    adapter.states['versicharge.0.control.current'] = { val: 0, ack: false, from: 'system.adapter.admin.0' };
    adapter.emit('stateChange', 'versicharge.0.control.current', adapter.states['versicharge.0.control.current']);
    await until(() => adapter.logs.some(l => /zeigt nach der Pause wieder 16 A \(Zustand B1\)/.test(l)));
    assert.ok(adapter.logs.includes('info: Befehl control.current = 0 (von admin.0)'));
    assert.ok(adapter.logs.includes('info: Ladestrom 0 A geschrieben, Wallbox meldet 0 A'));
    assert.equal(adapter.val('control.current'), 0);
    assert.equal(adapter.val('control.enabled'), false);
    assert.ok(!adapter.logs.some(l => /ohne Befehl/.test(l)));
    // the car charges anyway -> pause sent again
    const n = c.writes.length;
    c.car('C2');
    await until(() => adapter.logs.some(l => /lädt trotz Pause \(11040 W\) – Pause erneut gesendet \(1\. Mal\)/.test(l)));
    await until(() => c.writes.length > n);
    assert.deepEqual(c.writes.slice(n).map(w => [w.addr, w.values[0]]), [[1633, 0]]);
    assert.equal(adapter.val('control.current'), 0);
    // a new current ends the pause (after the fake's own revert timer of the repeated pause)
    await new Promise(r => setTimeout(r, 300));
    adapter.command('control.current', 10);
    await until(() => adapter.val('control.current') === 10 && adapter.val('control.enabled') === true);
});

test('diagnosis: a current changed by the wallbox itself (e.g. the app) is logged', async t => {
    const { c, adapter } = await start(t);
    adapter.command('control.current', 10);
    await until(() => adapter.logs.includes('info: Ladestrom 10 A geschrieben, Wallbox meldet 10 A'));
    c.regs[1633] = 12;
    await until(() => adapter.logs.some(l => /Wallbox meldet jetzt 12 A statt 10 A, ohne Befehl/.test(l)));
});
