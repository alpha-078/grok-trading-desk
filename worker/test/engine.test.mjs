import assert from 'node:assert/strict';
import * as E from '../src/engine.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const T0 = 1_700_000_000_000;
const mk = (side, entry, extra = {}) => ({
  id: 'p', symbol: 'XMR', side, size: 1, entryPrice: entry, peakPrice: entry,
  stopPrice: side === 'Long' ? entry * (1 - E.STOP_PCT) : entry * (1 + E.STOP_PCT),
  tpPrice: side === 'Long' ? entry * (1 + E.TP_PCT) : entry * (1 - E.TP_PCT),
  leverage: 10, exitMode: E.EXIT_MODE_V2, trailActive: false, trailStop: null,
  margin: entry / 10, entryFee: entry * E.TAKER_FEE, openedAt: T0, lastCheckedTs: T0, ageTicks: 0, ...extra
});
const st = () => { const s = E.defaultState(T0); s.balance = 100; return s; };
const c = (i, h, l) => ({ t: T0 + i * 60000, T: T0 + i * 60000 + 59999, h: String(h), l: String(l) });

// 1. Short stop: 444 short gaps up -> fill at stop 450.66, ROE ~ -15.71%
{
  const s = st(); const p = mk('Short', 444); s.positions = [p];
  const closed = E.walkPositionCandles(s, p, [c(0, 445, 443), c(1, 470, 446)], T0 + 3 * 60000);
  assert.equal(closed, true);
  near(s.history[0].exitPrice, 450.66, 1e-9);
  near(s.history[0].roe, -15.7055, 1e-3);
  assert.equal(s.history[0].reason, 'COURT: KILLED AT STOP');
}
// 2. +1.8% activates trail, does NOT close; later 1% pullback from peak closes at the trail.
{
  const s = st(); const p = mk('Long', 100); s.positions = [p];
  let closed = E.walkPositionCandles(s, p, [c(0, 101.85, 100.9)], T0 + 60000);
  assert.equal(closed, false); assert.equal(p.trailActive, true);
  near(p.trailStop, 101.85 * 0.99);
  closed = E.walkPositionCandles(s, p, [c(1, 103, 102.5)], T0 + 120000);
  assert.equal(closed, false); near(p.trailStop, 103 * 0.99);
  closed = E.walkPositionCandles(s, p, [c(2, 102.9, 101.5)], T0 + 180000);
  assert.equal(closed, true); near(s.history[0].exitPrice, 101.97); assert.equal(s.history[0].reason, 'Trailing stop');
}
// 3. Trail floor at entry + 2 fees
{
  const p = mk('Long', 100); p.peakPrice = 100.5; p.trailActive = true; E.applyV2Trail(p);
  near(p.trailStop, 100 * (1 + 2 * E.TAKER_FEE));
}
// 4. Candles before entry are ignored
{
  const s = st(); const p = mk('Long', 100, { openedAt: T0 + 30000, lastCheckedTs: T0 + 30000 }); s.positions = [p];
  const closed = E.walkPositionCandles(s, p, [c(0, 100.2, 90)], T0 + 50000);
  assert.equal(closed, false);
}
// 5. No time exit: positions stay open for days unless a price exit hits
{
  const s = st(); const p = mk('Long', 100); s.positions = [p];
  const market = { XMR: { price: 100.5 } };
  for (const mins of [5, 6, 60, 3 * 24 * 60]) E.monitorWithMark(s, market, T0 + mins * 60000);
  assert.equal(s.positions.length, 1); assert.equal(s.history.length, 0);
  // still closes on the 1.5% stop (long: below entry)
  E.monitorWithMark(s, { XMR: { price: 98.4 } }, T0 + 4 * 24 * 3600000);
  assert.equal(s.positions.length, 0); near(s.history[0].exitPrice, 98.5); assert.equal(s.history[0].reason, 'COURT: KILLED AT STOP');
  // short stop is above entry
  const s3 = st(); const sh = mk('Short', 100); s3.positions = [sh];
  E.monitorWithMark(s3, { XMR: { price: 99.2 } }, T0 + 9 * 24 * 3600000); assert.equal(s3.positions.length, 1);
  E.monitorWithMark(s3, { XMR: { price: 101.6 } }, T0 + 9 * 24 * 3600000); assert.equal(s3.positions.length, 0); near(s3.history[0].exitPrice, 101.5);
  const s2 = st(); const q = mk('Long', 100, { trailActive: true, peakPrice: 102, trailStop: 100.98 }); s2.positions = [q];
  E.monitorWithMark(s2, { XMR: { price: 101.5 } }, T0 + 60 * 60000); assert.equal(s2.positions.length, 1);
}
// 6. Agent cycle opens a 10x position with margin = min(bal*0.85, eq*0.31)
{
  const s = E.defaultState(T0);
  const market = {};
  for (const coin of E.COINS) market[coin.symbol] = { symbol: coin.symbol, price: 10, dayNtlVlm: 1e7, isDelisted: false, chg24h: 1, chg15m: 0.2, volRatio: 1, candles: [{ h: '10.05', l: '10' }, { h: '10.05', l: '10' }] };
  market.SOL.chg15m = 1.2; market.SOL.volRatio = 2;
  const pos = E.runSixAgentCycle(s, market, T0);
  assert.ok(pos, 'should open'); assert.equal(pos.symbol, 'SOL'); assert.equal(pos.side, 'Long');
  near(pos.margin, 135 * 0.31); near(pos.size, 135 * 0.31 * 10 / 10); near(pos.stopPrice, 9.88); near(pos.tpPrice, 10.12);
  assert.equal(pos.exitMode, E.EXIT_MODE_V3); assert.equal(pos.leverage, 10);
  near(s.balance, 135 - 135 * 0.31);
  // Sniper veto
  const s2 = E.defaultState(T0); market.SOL.chg15m = 2.5;
  assert.equal(E.runSixAgentCycle(s2, market, T0), null); assert.equal(s2.vetoCounts.SNIPER, 1);
  assert.equal(s2.ui.agents.liquidity.status, 'skipped');
}
// 7. Seed sanitize keeps positions + closes unknown coins flat
{
  const seed = E.sanitizeSeed({ balance: 80, positions: [mk('Long', 100), { ...mk('Long', 5), symbol: 'QNT' }], history: [], vetoCounts: { SNIPER: 3 } }, T0);
  assert.equal(seed.positions.length, 1); near(seed.balance, 80.5); assert.equal(seed.vetoCounts.SNIPER, 3);
  assert.throws(() => E.sanitizeSeed({ balance: 'x' }));
}
// ===== v3 (new trades) =====
const v3 = (side, entry, extra = {}) => mk(side, entry, {
  exitMode: E.EXIT_MODE_V3,
  stopPrice: side === 'Long' ? entry * (1 - E.STOP_PCT_V3) : entry * (1 + E.STOP_PCT_V3),
  tpPrice: side === 'Long' ? entry * (1 + E.TRAIL_ACTIVATE_V3_PCT) : entry * (1 - E.TRAIL_ACTIVATE_V3_PCT), ...extra });
const co = (i, o, h, l) => ({ t: T0 + i * 60000, T: T0 + i * 60000 + 59999, o: String(o), h: String(h), l: String(l) });
// 8. v3 stops: long 98.8, short 101.2
{
  const s = st(); const p = v3('Long', 100); near(p.stopPrice, 98.8); s.positions = [p];
  E.monitorWithMark(s, { XMR: { price: 98.85 } }, T0 + 60000); assert.equal(s.positions.length, 1);
  E.monitorWithMark(s, { XMR: { price: 98.7 } }, T0 + 120000); assert.equal(s.positions.length, 0); near(s.history[0].exitPrice, 98.8);
  const s2 = st(); const q = v3('Short', 100); near(q.stopPrice, 101.2); s2.positions = [q];
  assert.equal(E.walkPositionCandles(s2, q, [co(0, 100, 101.19, 99.9)], T0 + 60000), false);
  assert.equal(E.walkPositionCandles(s2, q, [co(1, 100.5, 101.3, 100.4)], T0 + 120000), true); near(s2.history[0].exitPrice, 101.2);
}
// 9. v3 trail: activates at 101.2 (no close there), trails 0.5% from peak, ratchets only up
{
  const s = st(); const p = v3('Long', 100); s.positions = [p]; near(E.takeProfitPrice(p), 101.2);
  assert.equal(E.walkPositionCandles(s, p, [co(0, 100, 101.19, 100.5)], T0 + 60000), false); assert.equal(p.trailActive, false);
  assert.equal(E.walkPositionCandles(s, p, [co(1, 101, 101.2, 100.9)], T0 + 120000), false); assert.equal(p.trailActive, true);
  near(p.trailStop, 101.2 * 0.995);
  assert.equal(E.walkPositionCandles(s, p, [co(2, 101.5, 102, 101.6)], T0 + 180000), false); near(p.trailStop, 102 * 0.995);
  E.monitorWithMark(s, { XMR: { price: 101.6 } }, T0 + 190000); assert.equal(s.positions.length, 1); near(p.trailStop, 102 * 0.995);
  assert.equal(E.walkPositionCandles(s, p, [co(3, 101.8, 101.9, 101.4)], T0 + 240000), true);
  near(s.history[0].exitPrice, 101.49); assert.equal(s.history[0].reason, 'Trailing stop');
  // short trails 0.5% above trough
  const sh = v3('Short', 100); sh.peakPrice = 98.5; E.applyV2Trail(sh); assert.equal(sh.trailActive, true); near(sh.trailStop, 98.5 * 1.005);
}
// 10. v3 floor: trail never below entry + 2 fees
{
  const p = v3('Long', 100); p.peakPrice = 100.3; p.trailActive = true; E.applyV2Trail(p); near(p.trailStop, 100.07);
  const q = v3('Short', 100); q.peakPrice = 99.8; q.trailActive = true; E.applyV2Trail(q); near(q.trailStop, 99.93);
}
// 11. v3 60m time exit only when MFE < 0.3% and trail inactive (live + candle catch-up)
{
  const s = st(); const p = v3('Long', 100); s.positions = [p];
  E.monitorWithMark(s, { XMR: { price: 100.2 } }, T0 + 59 * 60000); assert.equal(s.positions.length, 1);
  E.monitorWithMark(s, { XMR: { price: 100.1 } }, T0 + 60 * 60000); assert.equal(s.positions.length, 0);
  assert.equal(s.history[0].reason, 'EXIT GUARD: TIME 60m'); near(s.history[0].exitPrice, 100.1);
  // reached +0.3% once -> no time exit even after 3 hours
  const s2 = st(); const q = v3('Long', 100); s2.positions = [q];
  E.monitorWithMark(s2, { XMR: { price: 100.31 } }, T0 + 10 * 60000);
  E.monitorWithMark(s2, { XMR: { price: 100.0 } }, T0 + 180 * 60000); assert.equal(s2.positions.length, 1);
  // offline catch-up: closes at the open of the first candle at/after +60m, timestamped there
  const s3 = st(); const r = v3('Short', 100); s3.positions = [r];
  const candles = []; for (let i = 0; i < 70; i++) candles.push(co(i, 100.05, 100.2, 99.85));
  assert.equal(E.walkPositionCandles(s3, r, candles, T0 + 70 * 60000), true);
  assert.equal(s3.history[0].ts, T0 + 60 * 60000); near(s3.history[0].exitPrice, 100.05); assert.equal(s3.history[0].reason, 'EXIT GUARD: TIME 60m');
  // trail active -> never time exit
  const t = v3('Long', 100, { trailActive: true, peakPrice: 101.3, trailStop: 100.79 });
  assert.equal(E.v3TimeExitDue(t, T0 + 5 * 3600000), false);
}
// 12. v2 positions unchanged: 1.5% stop, +1.8% activation, 1% trail, no time exit
{
  const s = st(); const p = mk('Long', 100); s.positions = [p]; near(p.stopPrice, 98.5);
  E.monitorWithMark(s, { XMR: { price: 98.6 } }, T0 + 2 * 3600000); assert.equal(s.positions.length, 1);
  assert.equal(E.walkPositionCandles(s, p, [co(200, 100, 101.5, 99)], T0 + 201 * 60000), false); assert.equal(p.trailActive, false);
  assert.equal(E.walkPositionCandles(s, p, [co(201, 101.5, 101.8, 101)], T0 + 202 * 60000), false); assert.equal(p.trailActive, true);
  near(p.trailStop, 101.8 * 0.99); assert.equal(E.v3TimeExitDue(p, T0 + 9e9), false);
}
// 13. COURT veto at 1.45% range
{
  const s = E.defaultState(T0); const market = {};
  for (const coin of E.COINS) market[coin.symbol] = { symbol: coin.symbol, price: 10, dayNtlVlm: 1e7, isDelisted: false, chg24h: 1, chg15m: 0.2, volRatio: 1, candles: [{ h: '10.05', l: '10' }, { h: '10.05', l: '10' }] };
  market.SOL.chg15m = 1.2; market.SOL.volRatio = 2; market.SOL.candles = [{ h: '10', l: '10' }, { h: '10.15', l: '10' }];
  assert.equal(E.runSixAgentCycle(s, market, T0), null); assert.equal(s.vetoCounts.COURT, 1);
  market.SOL.candles = [{ h: '10', l: '10' }, { h: '10.14', l: '10' }];
  assert.ok(E.runSixAgentCycle(E.defaultState(T0), market, T0));
}
console.log('engine tests: all passed');
