// Runs the exit helpers from ../app.js (local fallback + replay engine) on the same v2/v3 cases.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const src = fs.readFileSync(new URL('../../app.js', import.meta.url), 'utf8');
const consts = src.slice(src.indexOf('  const INITIAL_BALANCE'), src.indexOf('  const POLL_MS'));
const helpers = src.slice(src.indexOf('  // 1.8% level from entry'), src.indexOf('  function candleEndTs'));
const A = new Function(`${consts}\n${helpers}\nreturn { EXIT_MODE_V2, EXIT_MODE_V3, STOP_PCT_V3, TRAIL_ACTIVATE_V3_PCT, takeProfitPrice, applyV2Trail, evaluateExit, walkCandleForExit, v3TimeExitDue, exitReasonText, exitFillPrice, updatePeakPrice };`)();
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const T0 = 1_700_000_000_000;
const pos = (mode, side, entry, stopPct, tpPct) => ({ side, entryPrice: entry, peakPrice: entry, exitMode: mode, trailActive: false, trailStop: null, openedAt: T0,
  stopPrice: side === 'Long' ? entry * (1 - stopPct) : entry * (1 + stopPct), tpPrice: side === 'Long' ? entry * (1 + tpPct) : entry * (1 - tpPct) });
const co = (i, o, h, l) => ({ t: T0 + i * 60000, o: String(o), h: String(h), l: String(l) });

const p = pos(A.EXIT_MODE_V3, 'Long', 100, 0.012, 0.012);
assert.equal(A.walkCandleForExit(p, co(0, 100, 101.2, 100.9)).close, false); assert.equal(p.trailActive, true); near(p.trailStop, 101.2 * 0.995);
const r = A.walkCandleForExit(p, co(1, 101, 101.1, 100.6)); assert.equal(r.close, true); near(r.fillPrice, 101.2 * 0.995);
const s = pos(A.EXIT_MODE_V3, 'Short', 100, 0.012, 0.012);
const rs = A.walkCandleForExit(s, co(0, 100, 101.3, 99.9)); assert.equal(rs.close, true); near(rs.fillPrice, 101.2);
const t = pos(A.EXIT_MODE_V3, 'Long', 100, 0.012, 0.012);
assert.equal(A.walkCandleForExit(t, co(59, 100, 100.2, 99.9)).close, false);
const rt = A.walkCandleForExit(t, co(60, 100.1, 100.2, 99.9)); assert.equal(rt.close, true); assert.equal(A.exitReasonText(rt.ev, -0.1, false), 'EXIT GUARD: TIME 60m'); near(rt.fillPrice, 100.1);
const lv = pos(A.EXIT_MODE_V3, 'Long', 100, 0.012, 0.012);
assert.equal(A.evaluateExit(lv, 100.1, 'live', { timeTs: T0 + 3600000 }).hitTimeExit, true);
lv.peakPrice = 100.31; assert.equal(A.evaluateExit(lv, 100.1, 'live', { timeTs: T0 + 3600000 }).shouldClose, false);
const f = pos(A.EXIT_MODE_V3, 'Long', 100, 0.012, 0.012); f.peakPrice = 100.3; f.trailActive = true; A.applyV2Trail(f); near(f.trailStop, 100.07);
const v2 = pos(A.EXIT_MODE_V2, 'Long', 100, 0.015, 0.018);
assert.equal(A.walkCandleForExit(v2, co(0, 100, 101.5, 98.6)).close, false); assert.equal(v2.trailActive, false);
assert.equal(A.walkCandleForExit(v2, co(1, 101.5, 101.8, 101)).close, false); near(v2.trailStop, 101.8 * 0.99);
assert.equal(A.v3TimeExitDue(v2, T0 + 9e9), false);
assert.equal(A.evaluateExit(pos(A.EXIT_MODE_V2, 'Long', 100, 0.015, 0.018), 100.1, 'live', { timeTs: T0 + 9e9 }).shouldClose, false);
console.log('app.js parity tests: all passed');
