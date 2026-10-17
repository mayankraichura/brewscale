// Pure functions for the weight logger (no DOM, no Bluetooth): packet parsing, flow rate, CSV, loss counting.
// Runs in the browser (window.WL) and in Node (module.exports) so it can be tested without a browser.
(function (root) {
  'use strict';

  // BrewScale weight packet, 7 bytes little endian: int32 weight in 0.01 g, uint16 sequence, uint8 flags
  // (bit0 tared, bit1 calibrated, bit2 no data from the HX711).
  function parsePacket(dv) {
    if (!dv || dv.byteLength < 7) return null;
    const cg = dv.getInt32(0, true), seq = dv.getUint16(4, true), flags = dv.getUint8(6);
    const noData = (flags & 4) !== 0;
    return { seq, flags, noData, tared: !!(flags & 1), calibrated: !!(flags & 2), g: noData ? null : cg / 100 };
  }

  // Flow in g/s: mean weight over the last 0.5 s minus the mean over the window 1.0 to 1.5 s earlier
  // (centres 1.0 s apart). Works on real time stamps, so uneven arrival (Bluetooth jitter) does not matter.
  class FlowCalc {
    constructor() { this.s = []; }
    reset() { this.s = []; }
    push(t, g) {
      if (g == null) { this.s = []; return null; }  // a hole in the data: start over
      this.s.push([t, g]);
      while (this.s.length && t - this.s[0][0] > 2.0) this.s.shift();
      const mean = (a, b) => {
        let n = 0, sum = 0;
        for (const [ts, w] of this.s) if (ts > a && ts <= b) { n++; sum += w; }
        return n >= 2 ? sum / n : null;
      };
      const now = mean(t - 0.5, t), before = mean(t - 1.5, t - 1.0);
      return now == null || before == null ? null : now - before;
    }
  }

  // Moving average over the last n samples (n = 1: off). A null (no data) empties the window.
  class MovingAvg {
    constructor(n) { this.n = Math.max(1, n | 0); this.w = []; }
    reset() { this.w = []; }
    push(g) {
      if (g == null) { this.w = []; return null; }
      this.w.push(g);
      if (this.w.length > this.n) this.w.shift();
      let s = 0;
      for (const x of this.w) s += x;
      return s / this.w.length;
    }
  }

  // Noise of a series: standard deviation after removing a straight line (a slow drift is not noise).
  function noiseSd(v) {
    const n = v.length;
    if (n < 5) return null;
    const mx = (n - 1) / 2;
    let my = 0;
    for (const y of v) my += y;
    my /= n;
    let sxy = 0, sxx = 0;
    v.forEach((y, i) => { sxy += (i - mx) * (y - my); sxx += (i - mx) * (i - mx); });
    const b = sxy / sxx;
    let q = 0;
    v.forEach((y, i) => { const r = y - my - b * (i - mx); q += r * r; });
    return Math.sqrt(q / n);
  }

  // Counts lost packets from the 16 bit sequence number.
  class SeqTracker {
    constructor() { this.last = null; this.lost = 0; this.count = 0; }
    reset() { this.last = null; }
    feed(seq) {
      this.count++;
      let d = 0;
      if (this.last != null) {
        d = (seq - this.last - 1) & 0xFFFF;
        if (d > 1000) d = 0;  // the scale restarted: not a loss
        this.lost += d;
      }
      this.last = seq;
      return d;
    }
  }

  // Samples per second over the last `win` seconds.
  class RateMeter {
    constructor(win = 5) { this.win = win; this.t = []; }
    feed(t) { this.t.push(t); while (this.t.length && t - this.t[0] > this.win) this.t.shift(); }
    hz() { return this.t.length < 2 ? 0 : (this.t.length - 1) / (this.t[this.t.length - 1] - this.t[0]); }
  }

  // Cup removal: the raw weight falls by `dropG` or more below its highest value of the last `windowS` seconds
  // (lifting a cup or a server off the scale; no pour or draw makes the weight fall like that).
  // The brew is complete where the last stable reading ended: endT = the last sample within 0.3 g of that highest
  // value, finalRaw = the median of the last 3 readings up to it. Feed it unsmoothed readings: push(t, raw, armed).
  class CupRemoval {
    constructor(dropG = 20, windowS = 2) { this.dropG = dropG; this.windowS = windowS; this.b = []; }
    reset() { this.b = []; }
    push(t, raw, armed = true) {
      if (raw == null) return null;
      this.b.push([t, raw]);
      while (this.b.length && t - this.b[0][0] > this.windowS + 1) this.b.shift();
      if (!armed) return null;
      let max = -Infinity;
      for (const [ts, v] of this.b) if (ts >= t - this.windowS && ts < t) max = Math.max(max, v);
      if (max - raw < this.dropG) return null;
      let k = -1;
      for (let i = 0; i < this.b.length; i++) if (this.b[i][0] >= t - this.windowS && this.b[i][0] < t && this.b[i][1] >= max - 0.3) k = i;
      const near = this.b.slice(Math.max(0, k - 2), k + 1).map(x => x[1]).sort((a, c) => a - c);
      return { endT: this.b[k][0], finalRaw: near[near.length >> 1], detectT: t };
    }
  }

  // Brews kept in the browser storage (localStorage or a compatible object). A brew is
  // {id, start (ms since 1970), label, sm (smoothing samples), dur (s), interrupted, rows: [[t, g, flow, raw, seq, flags], ...]}.
  // Each brew has its own key, a small index lists them (newest first), and the running brew has the key wl.active.
  // When the storage is full the oldest brews are dropped, never the one being saved.
  class BrewStore {
    constructor(storage, maxBrews = 20) { this.st = storage; this.max = maxBrews; }
    _get(k) { try { const v = this.st.getItem(k); return v == null ? null : JSON.parse(v); } catch (e) { return null; } }
    _set(k, v) { try { this.st.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
    _del(k) { try { this.st.removeItem(k); } catch (e) { /* ignore */ } }
    index() { const i = this._get('wl.index'); return Array.isArray(i) ? i : []; }
    meta(b) {
      const r = b.rows || [], last = r.length ? r[r.length - 1] : null;
      return { id: b.id, start: b.start, label: b.label || '', sm: b.sm, dur: b.dur, n: r.length, finalG: b.end && b.end.finalG != null ? b.end.finalG : last ? last[1] : null,
        interrupted: !!b.interrupted, reason: b.interrupted ? 'interrupted' : (b.end && b.end.reason) || null };
    }
    // Index entries written before the end reason existed get it from the brew itself (once).
    upgradeIndex() {
      const idx = this.index();
      let changed = false;
      for (const m of idx) {
        if ('reason' in m) continue;
        const b = this.get(m.id);
        m.reason = b ? (b.interrupted ? 'interrupted' : (b.end && b.end.reason) || null) : null;
        changed = true;
      }
      if (changed) this._set('wl.index', idx);
      return idx;
    }
    save(b) {
      const idx = this.index().filter(m => m.id !== b.id);
      for (;;) {
        if (this._set('wl.b.' + b.id, b)) break;
        if (!idx.length) return false;
        this._del('wl.b.' + idx.pop().id);
      }
      idx.unshift(this.meta(b));
      while (idx.length > this.max) this._del('wl.b.' + idx.pop().id);
      this._set('wl.index', idx);
      return true;
    }
    get(id) { return this._get('wl.b.' + id); }
    remove(id) { this._del('wl.b.' + id); this._set('wl.index', this.index().filter(m => m.id !== id)); }
    clearAll() { for (const m of this.index()) this._del('wl.b.' + m.id); this._del('wl.index'); }
    saveActive(b) { return this._set('wl.active', b); }
    loadActive() { const a = this._get('wl.active'); return a && Array.isArray(a.rows) ? a : null; }
    clearActive() { this._del('wl.active'); }
  }

  const f = (v, d) => (v == null || Number.isNaN(v) ? '' : v.toFixed(d));
  // rows: {t (s since the log started), g (zeroed weight), f (flow), raw, seq, flags}
  function toCsv(rows) {
    const out = ['time_s,weight_g,flow_gps,raw_g,seq,flags'];
    for (const r of rows) out.push([f(r.t, 2), f(r.g, 2), f(r.f, 2), f(r.raw, 2), r.seq, r.flags].join(','));
    return out.join('\n') + '\n';
  }

  // How a brew ended, in words for the lists and the compare table.
  function reasonLabel(reason) {
    return { 'cup-removed': 'cup removed', manual: 'stopped', imported: 'file', interrupted: 'interrupted' }[reason] || '';
  }
  // rows as stored in a brew: [t, g, flow, raw, seq, flags]
  function rowsToCsv(rows) {
    return toCsv(rows.map(r => ({ t: r[0], g: r[1], f: r[2], raw: r[3], seq: r[4], flags: r[5] })));
  }
  // ---- Battery level of the scale (standard Battery Service 0x180F, contract C1 v1.2) --------------------------------
  // Characteristic 0x2A19: one byte, percent 0..100, read + notify (notified only when the value changes). It is an ESTIMATE
  // from the cell voltage. The page only reads and subscribes; it never writes to this service. If the service or the
  // characteristic is missing (old firmware, USB-powered unit) nothing is shown: no error, no retry, no polling.
  const BAT_SVC = 0x180f, BAT_CHR = 0x2a19;
  function parseBattery(dv) {
    if (!dv || dv.byteLength < 1) return null;
    const v = dv.getUint8(0);
    return v <= 100 ? v : null;
  }
  // server: a GATT server (or a fake one in the tests). onLevel(percent) is called with the first reading and on every change.
  // Returns true when a level was read.
  async function attachBattery(server, onLevel) {
    let got = false;
    try {
      const svc = await server.getPrimaryService(BAT_SVC);
      const chr = await svc.getCharacteristic(BAT_CHR);
      const first = parseBattery(await chr.readValue());          // once after connecting
      if (first != null) { got = true; onLevel(first); }
      chr.addEventListener('characteristicvaluechanged', e => { const p = parseBattery(e.target.value); if (p != null) onLevel(p); });
      await chr.startNotifications();                              // then only changes arrive: no polling
    } catch (e) { /* no battery service: show nothing */ }
    return got;
  }

  // ---- Tare over Bluetooth (contract C1 v1.1) ------------------------------------------------------------------
  // The page may write ONE command to the scale's command characteristic: the literal text "t" (tare), only after a tap.
  const TARE_CMD = 't';
  // The scale answers a tare with "taring: keep the platform empty and still (2 s)", then "tared"; "busy" while another job runs.
  function parseCmdReply(text) {
    const t = String(text == null ? '' : text).trim().toLowerCase();
    if (t === 'tared') return { kind: 'tared', text: t };
    if (t.startsWith('taring')) return { kind: 'taring', text: t };
    if (t === 'busy') return { kind: 'busy', text: t };
    return { kind: 'other', text: t };
  }
  // idle -> sending -> taring -> done; or busy / timeout / error. The page reads `state`, handles a final state, then calls reset().
  // It never retries by itself (condition of C1 v1.1).
  class TareFlow {
    constructor(timeoutMs = 6000) { this.timeoutMs = timeoutMs; this.state = 'idle'; this.t0 = 0; }
    get active() { return this.state === 'sending' || this.state === 'taring'; }
    begin(now) { if (this.active) return false; this.state = 'sending'; this.t0 = now; return true; }
    onReply(text) {
      if (!this.active) return this.state;     // a reply nobody asked for is ignored
      const r = parseCmdReply(text);
      if (r.kind === 'taring') this.state = 'taring';
      else if (r.kind === 'tared') this.state = 'done';
      else if (r.kind === 'busy') this.state = 'busy';
      return this.state;
    }
    fail() { this.state = 'error'; return this.state; }
    tick(now) { if (this.active && now - this.t0 > this.timeoutMs) this.state = 'timeout'; return this.state; }
    reset() { this.state = 'idle'; }
  }

  // Time (s) of the first drip: the first row with a weight of 1 g or more; null if the weight never gets there.
  function firstDripTime(rows) {
    for (const r of rows) if (r[1] != null && r[1] >= 1) return r[0];
    return null;
  }
  // Numbers for the comparison table: {dur, firstDrip, yieldG, avgFlow, peakFlow}. A brew is {rows, dur, end?}.
  // avgFlow = yield / (completion - first drip); peakFlow = highest flow after the first drip (null if none).
  function brewMetrics(b) {
    const rows = b.rows || [], last = [...rows].reverse().find(r => r[1] != null);
    const dur = b.dur != null ? b.dur : rows.length ? rows[rows.length - 1][0] : 0;
    const yieldG = b.end && b.end.finalG != null ? b.end.finalG : last ? last[1] : null;
    const fd = firstDripTime(rows);
    const avgFlow = fd != null && yieldG != null && dur - fd > 1 ? yieldG / (dur - fd) : null;
    let peak = null;
    for (const r of rows) if (fd != null && r[0] >= fd && r[2] != null && (peak == null || r[2] > peak)) peak = r[2];
    return { dur, firstDrip: fd, yieldG, avgFlow, peakFlow: peak };
  }

  // Reads a CSV exported by this page (time_s,weight_g,flow_gps,raw_g,seq,flags). Columns are found by name; the flow is
  // computed when it is missing; with only raw_g the weight is raw_g minus the first reading. Returns {rows, bad} or {error}.
  function parseCsv(text) {
    text = String(text || '').replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
    if (lines.length < 2) return { error: 'The file has no data rows.' };
    const head = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/^"|"$/g, ''));
    const col = n => head.indexOf(n);
    const ct = col('time_s'), cg = col('weight_g'), cf = col('flow_gps'), cr = col('raw_g'), cs = col('seq'), cl = col('flags');
    if (ct < 0 || (cg < 0 && cr < 0)) return { error: 'This does not look like a Weight Log CSV: it needs the columns time_s and weight_g.' };
    const num = v => { if (v === undefined) return null; v = String(v).trim().replace(/^"|"$/g, ''); if (v === '') return null; const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
    const rows = []; let bad = 0, firstRaw = null;
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split(',');
      const t = num(c[ct]);
      if (t == null) { bad++; continue; }
      const raw = cr >= 0 ? num(c[cr]) : null;
      let g = cg >= 0 ? num(c[cg]) : null;
      if (cg < 0 && raw != null) { if (firstRaw == null) firstRaw = raw; g = raw - firstRaw; }
      rows.push([t, g, cf >= 0 ? num(c[cf]) : undefined, raw, cs >= 0 ? (num(c[cs]) || 0) : 0, cl >= 0 ? (num(c[cl]) || 0) : 0]);
    }
    if (rows.length < 5) return { error: 'Fewer than 5 valid rows were found in the file.' };
    for (let i = 1; i < rows.length; i++) if (rows[i][0] < rows[i - 1][0]) return { error: 'Time goes backwards at data row ' + (i + 1) + ': this is not a single brew.' };
    if (cf < 0) { const fc = new FlowCalc(); for (const r of rows) r[2] = fc.push(r[0], r[1]); }
    return { rows, bad };
  }

  // weightlog-<label>-<raw|maN>-YYYYMMDD-HHMMSS.csv -> {label, sm, start}; fields are null when the name has another form
  function parseFileName(name) {
    const m = /^weightlog-(?:(.*?)-)?(raw|ma\d+)-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.csv$/i.exec(String(name || ''));
    if (!m) return { label: null, sm: null, start: null };
    return { label: m[1] || '', sm: m[2].toLowerCase() === 'raw' ? 1 : parseInt(m[2].slice(2), 10),
      start: new Date(+m[3], +m[4] - 1, +m[5], +m[6], +m[7], +m[8]).getTime() };
  }

  // 83.4 -> "1:23.4" (timer display)
  function fmtTimer(sec) {
    const t = Math.max(0, Math.floor(sec * 10 + 1e-9)), m = Math.floor(t / 600), s = Math.floor((t % 600) / 10), d = t % 10;
    return m + ':' + String(s).padStart(2, '0') + '.' + d;
  }

  root.WL = { BAT_SVC, BAT_CHR, parseBattery, attachBattery, TARE_CMD, parseCmdReply, TareFlow, parsePacket, FlowCalc, MovingAvg, noiseSd, BrewStore, reasonLabel, CupRemoval, firstDripTime, brewMetrics, parseCsv, parseFileName, rowsToCsv, fmtTimer, SeqTracker, RateMeter, toCsv, SVC: 'b5a10001-5e1d-4c2a-9a3b-2f3c8d6e0001', WEIGHT: 'b5a10002-5e1d-4c2a-9a3b-2f3c8d6e0001', CMD: 'b5a10003-5e1d-4c2a-9a3b-2f3c8d6e0001' };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.WL;
})(typeof self !== 'undefined' ? self : globalThis);
