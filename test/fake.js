'use strict';

/* Fake VersiCharge (Modbus TCP server with the register layout of the Siemens map) and a fake adapter-core. */

const net = require('node:net');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

/** registers of the Siemens table (external numbers, from-to); a read touching anything else -> exception 2 like the real one */
const TABLE = '40001-40005 40006-40007 40008-40012 40013-40022 40023 40025 40026 40027 40028 40029 40030 40031 40032-40036 40037-40041 40042 40043-40048 40049-40051 41600-41606 41634 41641-41642 41643 41648-41657 41661-41678 41693-41694 41826 41827';
const MAPPED = new Set();
for (const r of TABLE.split(' ')) {
    const [from, to = from] = r.split('-').map(Number);
    for (let n = from; n <= to; n++) {
        MAPPED.add(n - 40001);
    }
}

function text(regs, at, str, len) {
    const b = Buffer.alloc(len * 2, 0x20);
    b.write(str, 'latin1');
    for (let i = 0; i < len; i++) {
        regs[at + i] = b.readUInt16BE(i * 2);
    }
}

function fakeCharger({ unitId = 2, phases = 3, install = 16, missing = [] } = {}) {
    const regs = new Array(2000).fill(0);
    text(regs, 0, 'Siemens AG', 5);
    regs[5] = 2024;
    regs[6] = (3 << 8) | 15;
    text(regs, 7, 'VC12345678', 5);
    text(regs, 12, '8EM1310-3EJ04-0GA0', 10);
    regs[22] = 1;
    regs[24] = 1;
    regs[25] = 5;
    regs[27] = 3;
    regs[28] = 32;
    regs[29] = install;
    regs[30] = 3;
    text(regs, 31, '2.500', 5);
    text(regs, 36, '5.1.1', 5);
    regs[41] = 3;
    text(regs, 42, 'Standard', 6);
    text(regs, 48, '25-32', 3);
    regs[1642] = phases === 3 ? 1 : 0;
    regs[1633] = install;
    const c = {
        regs,
        unitId,
        writes: [],
        reads: [],
        connections: 0,
        maxConnections: 1,
        open: new Set(),
        silent: false,
        /** car plugged in / charging: sets state, currents and powers from the current limit */
        car(state) {
            regs[1599] = Buffer.from(state.padStart(2, ' ').slice(0, 2), 'latin1').readUInt16BE(0);
            c.update();
        },
        update() {
            const st = Buffer.alloc(2);
            st.writeUInt16BE(regs[1599]);
            const charging = st.toString('latin1') === 'C2';
            const limit = regs[1633] > 100 ? regs[1633] / 100 : regs[1633];
            const a = charging && limit >= 6 ? Math.floor(limit) : 0;
            for (let i = 0; i < 3; i++) {
                const on = i < phases ? a : 0;
                regs[1647 + i] = on;
                regs[1651 + i] = i < phases ? 230 : 0;
                regs[1662 + i] = on * 230;
            }
            regs[1650] = a;
            regs[1665] = a * 230 * phases;
        },
        /** meter in Wh */
        meter(wh) {
            regs[1692] = Math.floor(wh / 0x10000);
            regs[1693] = wh & 0xffff;
        },
    };
    c.car('A1');
    c.meter(1234567);
    const gone = new Set(missing.map(n => n - 40001)); // registers an older/newer firmware does not have
    const valid = (addr, count) => {
        for (let a = addr; a < addr + count; a++) {
            if (!MAPPED.has(a) || gone.has(a)) {
                return false;
            }
        }
        c.reads.push([addr, count]);
        return true;
    };
    c.server = net.createServer(sock => {
        c.connections++;
        if (c.open.size >= c.maxConnections) {
            sock.destroy(); // only one Modbus connection
            return;
        }
        c.open.add(sock);
        sock.on('close', () => c.open.delete(sock));
        sock.on('error', () => {});
        let buf = Buffer.alloc(0);
        sock.on('data', d => {
            buf = Buffer.concat([buf, d]);
            while (buf.length >= 7 && buf.length >= 6 + buf.readUInt16BE(4)) {
                const len = buf.readUInt16BE(4);
                const frame = buf.subarray(0, 6 + len);
                buf = buf.subarray(6 + len);
                if (c.silent) {
                    continue;
                }
                const pdu = frame.subarray(7);
                const answer = body => {
                    const head = Buffer.alloc(7);
                    frame.copy(head, 0, 0, 4);
                    head.writeUInt16BE(body.length + 1, 4);
                    head.writeUInt8(frame[6], 6);
                    sock.write(Buffer.concat([head, body]));
                };
                const exc = code => answer(Buffer.from([pdu[0] | 0x80, code]));
                if (frame[6] !== c.unitId) {
                    continue; // wrong unit: no answer
                }
                const fc = pdu[0];
                const addr = pdu.readUInt16BE(1);
                if (fc === 3) {
                    const count = pdu.readUInt16BE(3);
                    if (!valid(addr, count)) {
                        exc(2);
                        continue;
                    }
                    const out = Buffer.alloc(2 + count * 2);
                    out[0] = 3;
                    out[1] = count * 2;
                    for (let i = 0; i < count; i++) {
                        out.writeUInt16BE(regs[addr + i], 2 + i * 2);
                    }
                    answer(out);
                } else if (fc === 6) {
                    const v = pdu.readUInt16BE(3);
                    if (addr === 1633 && v > 8000) {
                        exc(3);
                        continue;
                    }
                    if (![1633, 1660, 1661, 1825, 1826].includes(addr)) {
                        exc(2);
                        continue;
                    }
                    // the charger returns the limit in the 0-80 A range
                    regs[addr] = addr === 1633 && v > 100 ? Math.floor(v / 100) : v;
                    c.writes.push({ addr, values: [v] });
                    c.update();
                    answer(pdu.subarray(0, 5));
                } else if (fc === 16) {
                    const count = pdu.readUInt16BE(3);
                    const values = [];
                    for (let i = 0; i < count; i++) {
                        values.push(pdu.readUInt16BE(6 + i * 2));
                        regs[addr + i] = values[i];
                    }
                    c.writes.push({ addr, values });
                    answer(pdu.subarray(0, 5));
                } else {
                    exc(1);
                }
            }
        });
    });
    c.listen = () => new Promise(r => c.server.listen(0, '127.0.0.1', () => r(c.server.address().port)));
    c.close = () =>
        new Promise(r => {
            for (const s of c.open) {
                s.destroy();
            }
            c.server.close(() => r());
        });
    return c;
}

class FakeAdapter extends EventEmitter {
    constructor(options) {
        super();
        this.namespace = `${options.name}.0`;
        this.connected = true;
        this.config = options.config;
        this.states = {};
        this.objects = {};
        this.logs = [];
        const log = level => m => this.logs.push(`${level}: ${m}`);
        this.log = { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
    }
    _id(id) {
        return id.startsWith(`${this.namespace}.`) ? id : `${this.namespace}.${id}`;
    }
    async setState(id, val, ack) {
        this.states[this._id(id)] = { val, ack: Boolean(ack) };
    }
    async getStateAsync(id) {
        return this.states[this._id(id)] || null;
    }
    async extendObject(id, obj) {
        this.objects[this._id(id)] = obj;
    }
    subscribeStates() {}
    val(id) {
        const s = this.states[this._id(id)];
        return s ? s.val : undefined;
    }
    /** a user or another adapter writes a command */
    command(id, val) {
        const full = this._id(id);
        this.states[full] = { val, ack: false };
        this.emit('stateChange', full, this.states[full]);
    }
}

function install() {
    const orig = Module._load;
    Module._load = function (request, ...rest) {
        if (request === '@iobroker/adapter-core') {
            return { Adapter: FakeAdapter };
        }
        return orig.call(this, request, ...rest);
    };
}

async function until(fn, ms = 5000) {
    const end = Date.now() + ms;
    while (!(await fn())) {
        if (Date.now() > end) {
            throw new Error('timeout');
        }
        await new Promise(r => setTimeout(r, 20));
    }
}

module.exports = { fakeCharger, FakeAdapter, install, until };
