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
  near(pos.margin, 135 * 0.31); near(pos.size, 135 * 0.31 * 10 / 10); near(pos.stopPrice, 9.85); near(pos.tpPrice, 10.18);
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
console.log('engine tests: all passed');
