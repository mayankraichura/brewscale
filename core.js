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

  const f = (v, d) => (v == null || Number.isNaN(v) ? '' : v.toFixed(d));
  // rows: {t (s since the log started), g (zeroed weight), f (flow), raw, seq, flags}
  function toCsv(rows) {
    const out = ['time_s,weight_g,flow_gps,raw_g,seq,flags'];
    for (const r of rows) out.push([f(r.t, 2), f(r.g, 2), f(r.f, 2), f(r.raw, 2), r.seq, r.flags].join(','));
    return out.join('\n') + '\n';
  }

  root.WL = { parsePacket, FlowCalc, MovingAvg, noiseSd, SeqTracker, RateMeter, toCsv, SVC: 'b5a10001-5e1d-4c2a-9a3b-2f3c8d6e0001', WEIGHT: 'b5a10002-5e1d-4c2a-9a3b-2f3c8d6e0001' };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.WL;
})(typeof self !== 'undefined' ? self : globalThis);
