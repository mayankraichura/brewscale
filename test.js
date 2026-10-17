// node test.js : checks the packet parsing, the flow maths on a synthetic brew, the smoothing and the CSV output.
// No recorded data is needed: the weight series is generated here (five pours of 50 g, small pseudo random noise). The page file is checked for wiring.
const assert = require('assert'), fs = require('fs'), path = require('path');
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
// 8. cup removal: a synthetic espresso (ramp 1.4 g/s from 3 s), a touch of the cup, the cup lifted at 29.3 s, put back at 33.6 s
const cr = new WL.CupRemoval(20, 2); let hit = null, nHits = 0;
for (let i = 0; i < 400; i++) {
  const t = i / 10; let raw = -218 + Math.max(0, Math.min(t, 28.7) - 3) * 1.4 + (((i * 7919) % 13) - 6) * 0.02;
  if (t >= 28.8) raw -= 1.4;                    // fingers touch the cup
  if (t >= 29.1) raw -= 3;                      // 4.4 g in all: must not trigger
  if (t >= 29.3 && t < 33.6) raw -= 83;         // the cup comes off
  if (t >= 33.6) raw += 0;                      // cup back: weight returns
  const r = cr.push(t, raw, t >= 2);
  if (r) { nHits++; if (!hit) hit = r; }
}
assert.ok(hit, 'cup removal found');
assert.ok(hit.detectT >= 29.3 && hit.detectT < 29.5, 'found when the weight fell: ' + hit.detectT);
assert.ok(hit.endT >= 28.6 && hit.endT <= 28.8, 'the brew is complete where the last stable reading ended: ' + hit.endT);
assert.ok(Math.abs(hit.finalRaw - (-218 + 25.7 * 1.4)) < 0.3, 'final raw ' + hit.finalRaw);
const quiet = new WL.CupRemoval(20, 2);
for (let i = 0; i < 300; i++) assert.strictEqual(quiet.push(i / 10, 100 + i * 0.5, true), null, 'a rising weight never triggers');   // 5 g/s pour
const small = new WL.CupRemoval(20, 2); let none = null;
for (let i = 0; i < 100; i++) { const r = small.push(i / 10, i < 50 ? 50 : 40, true); if (r) none = r; }
assert.strictEqual(none, null, 'a drop of 10 g is below the 20 g limit');
const unarmed = new WL.CupRemoval(20, 2); let early = null;
for (let i = 0; i < 40; i++) { const r = unarmed.push(i / 10, i < 10 ? 100 : 0, false); if (r) early = r; }
assert.strictEqual(early, null, 'not armed: no detection');
assert.strictEqual(new WL.BrewStore(new Mem(), 5).meta({ id: 'm', start: 1, dur: 3, rows: [[0, 1, null, 1, 1, 3]], end: { finalG: 37.4 } }).finalG, 37.4);
// 9. CSV upload: round trip, tolerant parsing, clear errors, file name parsing
const rows0 = Array.from({ length: 60 }, (_, i) => [+(i / 10).toFixed(2), +(i * 0.5).toFixed(2), i < 15 ? null : 5, +(i * 0.5 - 200).toFixed(2), 100 + i, 3]);
let pc = WL.parseCsv(WL.rowsToCsv(rows0));
assert.ok(!pc.error && pc.rows.length === 60 && pc.bad === 0);
assert.deepStrictEqual(pc.rows[20], rows0[20]); assert.strictEqual(pc.rows[3][2], null);
pc = WL.parseCsv('\uFEFF' + WL.rowsToCsv(rows0).replace(/\n/g, '\r\n'));
assert.ok(!pc.error && pc.rows.length === 60, 'CRLF and BOM');
pc = WL.parseCsv('time_s,weight_g\n' + rows0.map(r => r[0] + ',' + r[1]).join('\n'));
assert.ok(!pc.error && pc.rows[40][2] != null && Math.abs(pc.rows[40][2] - 5) < 0.01, 'flow computed when the column is missing: ' + (pc.rows[40] && pc.rows[40][2]));
pc = WL.parseCsv('time_s,raw_g\n' + rows0.map(r => r[0] + ',' + r[3]).join('\n'));
assert.ok(!pc.error && pc.rows[0][1] === 0 && Math.abs(pc.rows[59][1] - 29.5) < 1e-9, 'weight from raw_g minus the first reading');
assert.ok(/does not look like/.test(WL.parseCsv('a,b\n1,2\n3,4').error));
assert.ok(/no data rows/.test(WL.parseCsv('time_s,weight_g\n').error));
assert.ok(/Fewer than 5/.test(WL.parseCsv('time_s,weight_g\n0,1\n1,2\n2,3').error));
assert.ok(/backwards/.test(WL.parseCsv('time_s,weight_g\n0,1\n1,2\n2,3\n3,4\n2,5\n6,7').error));
pc = WL.parseCsv(WL.rowsToCsv(rows0) + 'x,y,z\n'); assert.strictEqual(pc.bad, 1, 'a bad line is counted, not fatal');
let fn = WL.parseFileName('weightlog-Pump-on-empty-cup-ma10-20261015-032139.csv');
assert.deepStrictEqual([fn.label, fn.sm, new Date(fn.start).getFullYear(), new Date(fn.start).getMinutes()], ['Pump-on-empty-cup', 10, 2026, 21]);
fn = WL.parseFileName('weightlog-raw-20261013-092553.csv'); assert.deepStrictEqual([fn.label, fn.sm], ['', 1]);
fn = WL.parseFileName('weightlog-ma3-20261013-131225.csv'); assert.deepStrictEqual([fn.label, fn.sm], ['', 3]);
fn = WL.parseFileName('my brew.csv'); assert.deepStrictEqual([fn.label, fn.sm, fn.start], [null, null, null]);
// 10. comparison numbers
const espresso = Array.from({ length: 300 }, (_, i) => { const t = i / 10, g = Math.max(0, t - 3) * 1.5; return [t, +g.toFixed(2), t < 4.5 ? null : 1.5, 0, i, 3]; });
let mt = WL.brewMetrics({ rows: espresso, dur: 29.9 });
assert.strictEqual(mt.dur, 29.9); assert.ok(mt.firstDrip > 3.6 && mt.firstDrip < 3.8, 'first drip ' + mt.firstDrip);
assert.ok(Math.abs(mt.yieldG - 40.35) < 0.01 && Math.abs(mt.avgFlow - 40.35 / (29.9 - mt.firstDrip)) < 1e-9 && mt.peakFlow === 1.5);
mt = WL.brewMetrics({ rows: espresso, dur: 29.9, end: { finalG: 36.5 } }); assert.strictEqual(mt.yieldG, 36.5, 'the stored yield wins');
mt = WL.brewMetrics({ rows: espresso.map(r => [r[0], 0, null, 0, 0, 0]), dur: 10 }); assert.strictEqual(mt.firstDrip, null); assert.strictEqual(mt.avgFlow, null); assert.strictEqual(mt.peakFlow, null);
assert.strictEqual(WL.firstDripTime([]), null);
// 11. end reason in the saved index, and the upgrade of an older index
{
  const mem = new Mem(); const stx = new WL.BrewStore(mem, 10);
  stx.save({ ...mk('r1', 30), end: { reason: 'cup-removed', t: 3, finalG: 12 } });
  stx.save({ ...mk('r2', 30), end: { reason: 'manual', t: 3, finalG: 13 } });
  stx.save({ ...mk('r3', 30), interrupted: true });
  stx.save({ ...mk('r4', 30), end: { reason: 'imported', t: 3, finalG: 14 } });
  stx.save(mk('r5', 30));
  assert.deepStrictEqual(stx.index().map(m => m.reason), [null, 'imported', 'interrupted', 'manual', 'cup-removed']);
  assert.deepStrictEqual(['cup-removed', 'manual', 'imported', 'interrupted', null, 'x'].map(WL.reasonLabel), ['cup removed', 'stopped', 'file', 'interrupted', '', '']);
  // an index from before this field existed
  const old = JSON.parse(mem.getItem('wl.index')).map(m => { const c = { ...m }; delete c.reason; return c; });
  mem.setItem('wl.index', JSON.stringify(old));
  assert.ok(!('reason' in stx.index()[0]));
  const up = stx.upgradeIndex();
  assert.deepStrictEqual(up.map(m => m.reason), [null, 'imported', 'interrupted', 'manual', 'cup-removed']);
  assert.deepStrictEqual(stx.index().map(m => m.reason), up.map(m => m.reason), 'the upgraded index is stored');
  assert.deepStrictEqual(new WL.BrewStore(new Mem(), 3).upgradeIndex(), [], 'an empty store is fine');
}
// 13. tare over Bluetooth: the command, the reply parser and the flow (no retry, busy, timeout)
{
  assert.strictEqual(WL.TARE_CMD, 't');
  assert.strictEqual(WL.CMD, 'b5a10003-5e1d-4c2a-9a3b-2f3c8d6e0001');
  assert.deepStrictEqual(['tared', 'TARED\n', 'taring: keep the platform empty and still (2 s)', 'busy', 'calibrated: 255.6 counts per gram', '', null].map(x => WL.parseCmdReply(x).kind),
    ['tared', 'tared', 'taring', 'busy', 'other', 'other', 'other']);
  let f = new WL.TareFlow(6000);
  assert.strictEqual(f.state, 'idle'); assert.strictEqual(f.onReply('tared'), 'idle', 'an unasked reply is ignored');
  assert.strictEqual(f.begin(1000), true); assert.strictEqual(f.state, 'sending'); assert.strictEqual(f.begin(1100), false, 'no second tare while one runs');
  assert.strictEqual(f.onReply('taring: keep the platform empty and still (2 s)'), 'taring'); assert.ok(f.active);
  assert.strictEqual(f.tick(5000), 'taring'); assert.strictEqual(f.onReply('tared'), 'done'); assert.ok(!f.active); f.reset(); assert.strictEqual(f.state, 'idle');
  f.begin(0); assert.strictEqual(f.onReply('busy'), 'busy'); assert.ok(!f.active, 'busy ends the flow; the page does not retry'); f.reset();
  f.begin(0); f.onReply('taring: x'); assert.strictEqual(f.tick(6001), 'timeout'); f.reset();
  f.begin(0); assert.strictEqual(f.fail(), 'error'); f.reset(); assert.strictEqual(f.begin(1), true, 'a new tap starts a new flow');
  f.begin(1); f.reset(); f.begin(2); f.onReply('weird reply'); assert.strictEqual(f.state, 'sending', 'other replies are ignored');
}
// 14. battery level (R-012): parser, and attachBattery with fake GATT servers (value, change, missing, bad values, no writes, no polling)
{
  const dvOf = n => { const b = new ArrayBuffer(1); new DataView(b).setUint8(0, n); return new DataView(b); };
  assert.deepStrictEqual([0, 78, 100, 101, 255].map(n => WL.parseBattery(dvOf(n))), [0, 78, 100, null, null]);
  assert.strictEqual(WL.parseBattery(new DataView(new ArrayBuffer(0))), null); assert.strictEqual(WL.parseBattery(null), null);
  assert.strictEqual(WL.BAT_SVC, 0x180f); assert.strictEqual(WL.BAT_CHR, 0x2a19);
  const fakeServer = (opts = {}) => {
    const log = { reads: 0, notifies: 0, writes: 0, listeners: [] };
    const chr = {
      async readValue() { log.reads++; return dvOf(opts.value == null ? 78 : opts.value); },
      addEventListener(t, fn) { log.listeners.push(fn); },
      async startNotifications() { log.notifies++; },
      writeValue() { log.writes++; }, writeValueWithResponse() { log.writes++; }, writeValueWithoutResponse() { log.writes++; },
    };
    const server = {
      async getPrimaryService(uuid) { if (opts.noService || uuid !== 0x180f) { const e = new Error('No Services matching UUID'); e.name = 'NotFoundError'; throw e; } return { async getCharacteristic(c) { if (opts.noChar || c !== 0x2a19) { const e = new Error('No Characteristics matching UUID'); e.name = 'NotFoundError'; throw e; } return chr; } }; },
    };
    return { server, log, chr };
  };
  (async () => {
    // value + change
    let f = fakeServer({ value: 78 }); const got = [];
    assert.strictEqual(await WL.attachBattery(f.server, v => got.push(v)), true);
    assert.deepStrictEqual(got, [78]); assert.strictEqual(f.log.reads, 1); assert.strictEqual(f.log.notifies, 1); assert.strictEqual(f.log.listeners.length, 1);
    f.log.listeners[0]({ target: { value: dvOf(74) } }); f.log.listeners[0]({ target: { value: dvOf(250) } }); f.log.listeners[0]({ target: { value: dvOf(14) } });
    assert.deepStrictEqual(got, [78, 74, 14], 'changes arrive, a bad value (250) is ignored');
    assert.strictEqual(f.log.reads, 1, 'no polling: read once'); assert.strictEqual(f.log.writes, 0, 'nothing is written');
    // service missing
    f = fakeServer({ noService: true }); let called = 0;
    assert.strictEqual(await WL.attachBattery(f.server, () => called++), false); assert.strictEqual(called, 0); assert.strictEqual(f.log.reads, 0);
    // characteristic missing
    f = fakeServer({ noChar: true }); assert.strictEqual(await WL.attachBattery(f.server, () => called++), false); assert.strictEqual(called, 0);
    // a first reading that is not valid shows nothing, but notifications still work
    f = fakeServer({ value: 200 }); const g2 = []; assert.strictEqual(await WL.attachBattery(f.server, v => g2.push(v)), false); f.log.listeners[0]({ target: { value: dvOf(60) } }); assert.deepStrictEqual(g2, [60]);
    assert.ok(!/write/i.test(WL.attachBattery.toString()), 'attachBattery has no write call');
    console.log('battery tests passed');
  })().catch(e => { console.error(e); process.exit(1); });
}
// 12. page wiring: every id the script uses exists once in the markup, no mockup parts, the script compiles
{
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const markup = html.slice(0, html.indexOf('<script'));
  const ids = [...markup.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  assert.deepStrictEqual(dup, [], 'duplicate ids: ' + dup);
  const start = html.indexOf('<script>');
  const code = html.slice(start + 8, html.indexOf('</script>', start));
  const used = new Set([...code.matchAll(/\$\('([A-Za-z]+)'\)/g)].map(m => m[1]));
  const dynamic = ['emptyopen'];   // created by the script itself
  const missing = [...used].filter(x => !ids.includes(x) && !dynamic.includes(x));
  assert.deepStrictEqual(missing, [], 'ids used by the script but missing in the markup: ' + missing);
  assert.ok(!/@container|MOCKUP|mockbar/.test(html), 'no mockup parts left in the page');
  new Function(code);   // throws on a syntax error
  assert.ok(ids.length > 60, 'the markup has its elements');
  // R-012: the battery service is requested as OPTIONAL, shown in #bat, and never written
  assert.ok(/optionalServices:\[WL\.SVC,WL\.BAT_SVC\]/.test(code), 'battery service is an optional service');
  assert.ok(ids.includes('bat') && ids.includes('bat2') && /WL\.attachBattery\(/.test(code) && !/filters:\[[^\]]*BAT_SVC/.test(code), 'battery shown, not required by the filter');
  // the scale's tare has no stability check: the button itself must say that the platform has to be empty
  assert.ok(/class="zs">empty platform/.test(html) && /can\?'empty platform/.test(code), 'the Tare button says: empty platform');
  // contract C1 v1.1: the only write to the scale is the literal TARE_CMD, inside sendTare()
  const writes = (code.match(/\.writeValue(WithResponse|WithoutResponse)?\s*\(/g) || []).length;
  const fn = code.slice(code.indexOf('async function sendTare()'), code.indexOf('function afterTare()'));
  const inFn = (fn.match(/\.writeValue(WithResponse|WithoutResponse)?\s*\(/g) || []).length;
  assert.ok(fn.includes('WL.TARE_CMD'), 'sendTare sends WL.TARE_CMD');
  assert.strictEqual(writes, inFn, 'no write to the scale outside sendTare()');
  assert.ok(writes >= 1 && writes <= 2, 'one write path (with a fallback call)');
  const sendCalls = (code.match(/sendTare\(\)/g) || []).length;   // the definition + the call inside tare()
  assert.strictEqual(sendCalls, 2, 'sendTare() is called from tare() only');
  assert.ok(!/['"]c ['"]|['"]ota['"]/.test(code), 'the page never mentions the calibrate or ota commands');
}
console.log('all tests passed');
