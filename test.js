// node test.js : checks the packet parsing, the flow maths on a synthetic brew, the smoothing and the CSV output.
// No data files are needed: the weight series is generated here (five pours of 50 g, small pseudo random noise).
const assert = require('assert');
const WL = require('./core.js');

// 1. packet parsing
const buf = new ArrayBuffer(7), dv = new DataView(buf);
dv.setInt32(0, 19680, true); dv.setUint16(4, 65535, true); dv.setUint8(6, 3);
let p = WL.parsePacket(dv);
assert.deepStrictEqual([p.g, p.seq, p.tared, p.calibrated, p.noData], [196.8, 65535, true, true, false]);
dv.setInt32(0, -123, true); dv.setUint8(6, 4);
p = WL.parsePacket(dv);
assert.strictEqual(p.g, null); assert.strictEqual(p.noData, true);
assert.strictEqual(WL.parsePacket(new DataView(new ArrayBuffer(3))), null);

// 2. sequence loss counting incl. wrap and a restart
const sq = new WL.SeqTracker();
[65534, 65535, 0, 1, 3, 4].forEach(s => sq.feed(s));
assert.strictEqual(sq.lost, 1);
sq.feed(2000); assert.strictEqual(sq.lost, 1);  // a restart of the scale is not a loss

// 3. synthetic brew at 10 Hz: five pours of 50 g, 8 to 10 s long, then 60 s of rest; noise sd about 0.1 g
let seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const noise = () => (rnd() + rnd() + rnd() - 1.5) * 0.2;
const pours = [[3, 12], [47, 56], [67, 75], [87, 95], [106, 113]];
const w = []; let level = 0;
for (let i = 0; i < 1800; i++) {
  const t = i / 10; let rate = 0;
  for (const [a, b] of pours) if (t >= a && t < b) rate = 50 / (b - a);
  level += rate / 10; w.push(level + noise());
}
const fc = new WL.FlowCalc(); const flow = [];
w.forEach((g, i) => flow.push(fc.push(i / 10, g)));
const peak = Math.max(...flow.filter(x => x != null));
const segs = []; let on = false, a0 = 0;
flow.forEach((x, i) => { if (!on && x != null && x > 1.5) { on = true; a0 = i; } else if (on && (x == null || x < 0.5)) { on = false; if (i - a0 >= 10) segs.push([a0 / 10, i / 10]); } });
console.log('peak flow', peak.toFixed(1), 'g/s; flow segments (s):', segs.map(s => s.join('-')).join('  '));
assert.ok(peak > 5.5 && peak < 7.5, 'peak flow should be about 6 g/s');
assert.strictEqual(segs.length, 5, 'five pours');
const idle = flow.slice(1400, 1700).filter(x => x != null);
assert.ok(Math.max(...idle.map(Math.abs)) < 1.0, 'no flow while idle');

// 4. moving average and noise
const ma = new WL.MovingAvg(3);
assert.strictEqual(ma.push(3), 3); assert.strictEqual(ma.push(6), 4.5); assert.strictEqual(ma.push(9), 6); assert.strictEqual(ma.push(12), 9);
assert.strictEqual(ma.push(null), null); assert.strictEqual(ma.push(5), 5);   // a hole empties the window
const sd = (n) => { const m = new WL.MovingAvg(n); return WL.noiseSd(w.map(g => m.push(g)).slice(1400, 1700)); };
console.log('idle noise sd (g): off', sd(1).toFixed(3), ' 3', sd(3).toFixed(3), ' 5', sd(5).toFixed(3), ' 10', sd(10).toFixed(3));
assert.ok(sd(3) < sd(1) && sd(5) < sd(3) && sd(10) < sd(5), 'more smoothing = less noise');
assert.ok(Math.abs(WL.noiseSd([0, 1, 2, 3, 4, 5, 6, 7])) < 1e-9, 'a straight ramp has no noise');

// 5. CSV
const out = WL.toCsv([{ t: 0, g: 0, f: null, raw: 1.5, seq: 1, flags: 3 }, { t: 0.1, g: 0.5, f: 0.25, raw: 2, seq: 2, flags: 3 }]);
assert.strictEqual(out, 'time_s,weight_g,flow_gps,raw_g,seq,flags\n0.00,0.00,,1.50,1,3\n0.10,0.50,0.25,2.00,2,3\n');
// 6. timer format
assert.strictEqual(WL.fmtTimer(0), '0:00.0'); assert.strictEqual(WL.fmtTimer(83.4), '1:23.4'); assert.strictEqual(WL.fmtTimer(599.99), '9:59.9'); assert.strictEqual(WL.fmtTimer(-3), '0:00.0');
assert.strictEqual(WL.rowsToCsv([[0, 0, null, 1.5, 1, 3]]), 'time_s,weight_g,flow_gps,raw_g,seq,flags\n0.00,0.00,,1.50,1,3\n');

// 7. brew storage with a fake localStorage (with a size limit)
class Mem { constructor(limit) { this.m = new Map(); this.limit = limit || Infinity; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { const size = [...this.m].filter(([kk]) => kk !== k).reduce((a, [, vv]) => a + vv.length, 0) + v.length; if (size > this.limit) throw new Error('QuotaExceededError'); this.m.set(k, v); }
  removeItem(k) { this.m.delete(k); } }
const mk = (id, n) => ({ id, start: Date.now(), label: 'x', sm: 3, dur: n / 10, rows: Array.from({ length: n }, (_, i) => [i / 10, i, null, i, i, 3]) });
let st = new WL.BrewStore(new Mem(), 3);
assert.ok(st.save(mk('a', 50)) && st.save(mk('b', 50)) && st.save(mk('c', 50)) && st.save(mk('d', 50)));
assert.deepStrictEqual(st.index().map(m => m.id), ['d', 'c', 'b'], 'newest first, max 3 brews, oldest dropped');
assert.strictEqual(st.get('a'), null); assert.strictEqual(st.get('d').rows.length, 50);
st.remove('c'); assert.deepStrictEqual(st.index().map(m => m.id), ['d', 'b']);
assert.strictEqual(st.index()[0].n, 50); assert.strictEqual(st.index()[0].finalG, 49);
st.saveActive(mk('live', 20)); assert.strictEqual(st.loadActive().rows.length, 20); st.clearActive(); assert.strictEqual(st.loadActive(), null);
st.clearAll(); assert.deepStrictEqual(st.index(), []);
// full storage: the oldest brews go first, the new one is kept; a brew that can never fit is refused
const one = JSON.stringify(mk('z', 200)).length;
st = new WL.BrewStore(new Mem(one * 2 + 400), 20);
st.save(mk('a', 200)); st.save(mk('b', 200)); assert.ok(st.save(mk('c', 200)));
assert.ok(st.get('c') && !st.get('a'), 'quota: oldest dropped, new kept');
assert.strictEqual(new WL.BrewStore(new Mem(100), 20).save(mk('big', 200)), false);
// broken storage object: nothing throws
const bad = new WL.BrewStore({ getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } });
assert.strictEqual(bad.save(mk('q', 5)), false); assert.deepStrictEqual(bad.index(), []); assert.strictEqual(bad.loadActive(), null);
console.log('all tests passed');
