// Grok Bot Trading Desk — server engine (paper money only, no orders, no wallet).
// Exact port of the live engine in ../app.js, adapted to a 1-minute cron cadence.

export const ENGINE_VERSION = 'server-v1';
export const INITIAL_BALANCE = 135.0;
export const LEVERAGE = 10;
export const LEGACY_LEVERAGE = 20;
export const STOP_PCT = 0.015;
export const TP_PCT = 0.018;
export const EXIT_MODE_V2 = 'v2-trail-at-tp';
export const TRAIL_AFTER_TP_PCT = 0.01;
export const LEGACY_TRAIL_ARM_PCT = 0.0085;
export const LEGACY_TRAIL_GAP_PCT = 0.0035;
export const TAKER_FEE = 0.00035;
export const MAX_POSITIONS = 3;
export const ENTRY_THRESHOLD = 0.56;
export const CANDLE_MS = 60000;
export const CANDLE_MAX_BARS = 4000;
// The phone's time exit was 90 live ticks x 4s = 6 minutes; on the server it is time-based.
export const TIME_EXIT_MS = 90 * 4000;
export const VETO_AGENT_ORDER = ['sniper', 'liquidity', 'narrative', 'court', 'risk'];

export const COINS = [
  { symbol: 'BTC', label: 'BTC' },
  { symbol: 'ETH', label: 'ETH' },
  { symbol: 'SOL', label: 'SOL' },
  { symbol: 'HYPE', label: 'HYPE' },
  { symbol: 'ZEC', label: 'ZEC' },
  { symbol: 'UNI', label: 'UNI' },
  { symbol: 'DOGE', label: 'DOGE' },
  { symbol: 'xyz:NVDA', label: 'NVDA', dex: 'xyz' },
  { symbol: 'PUMP', label: 'PUMP' },
  { symbol: 'XRP', label: 'XRP' },
  { symbol: 'NEAR', label: 'NEAR' },
  { symbol: 'XMR', label: 'XMR' }
];
const COIN_MAP = Object.fromEntries(COINS.map(c => [c.symbol, c]));
export const KNOWN_SYMBOLS = new Set(COINS.map(c => c.symbol));

// ---------- formatting (same output as the app) ----------
function pad2(n) { return String(n).padStart(2, '0'); }
// Africa/Dakar is UTC+0 all year; the app re-formats from ts in the device zone anyway.
export function fmtShortTime(ts) { const d = new Date(ts); return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`; }
export function fmtTime(ts) { const d = new Date(ts); return `${fmtShortTime(ts)}:${pad2(d.getUTCSeconds())}`; }
function groupThousands(str) {
  const [i, f] = str.split('.');
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f !== undefined ? '.' + f : '');
}
export function fmtPrice(px) {
  if (!Number.isFinite(px) || px <= 0) return '0.00';
  if (px >= 1000) return groupThousands(px.toFixed(2));
  if (px >= 100) return px.toFixed(2);
  if (px >= 1) return px.toFixed(4);
  if (px >= 0.05) return px.toFixed(5);
  if (px >= 0.005) return px.toFixed(6);
  return px.toFixed(7);
}
export function fmtUsd(val, withSign = false) {
  const str = groupThousands(Math.abs(val).toFixed(2));
  if (!withSign) return `$${str}`;
  return `${val >= 0 ? '+' : '-'}$${str}`;
}
export function coinLabel(symbol) { return (COIN_MAP[symbol] && COIN_MAP[symbol].label) || symbol; }
export function posLeverage(pos) {
  const lev = Number(pos && pos.leverage);
  return Number.isFinite(lev) && lev > 0 ? lev : LEGACY_LEVERAGE;
}

// ---------- state ----------
export function defaultUi() {
  const a = (status, desc, badge) => ({ status, desc, badge });
  return {
    agents: {
      sniper: a('scanning', 'watching entry windows', '•'),
      liquidity: a('scanning', 'waiting for volume', '•'),
      narrative: a('scanning', 'reading the board', '•'),
      court: a('scanning', 'stop 1.5% · R:R ready', '•'),
      risk: a('scanning', `${LEVERAGE}x · 0/3 open · stop 1.5%`, '•')
    },
    hub: '',
    actionText: 'scanning',
    actionCls: 'scanning',
    signal: 0.5,
    volumeMult: 1.0
  };
}

export function defaultState(now = Date.now()) {
  return {
    balance: INITIAL_BALANCE,
    positions: [],
    history: [],
    equityCurve: [
      { t: now - 60000, v: INITIAL_BALANCE, label: fmtTime(now - 60000) },
      { t: now, v: INITIAL_BALANCE, label: fmtTime(now) }
    ],
    feed: [{
      id: `init-${now}`, agent: 'Grok Bot', ts: now, time: fmtTime(now),
      text: `Serveur 24/7 · ${COINS.length} perps en écoute (simulation ${LEVERAGE}x)`, badge: 'LIVE', kind: 'open'
    }],
    vetoCounts: { SNIPER: 0, LIQUIDITY: 0, NARRATIVE: 0, COURT: 0, RISK: 0, GROK_SCANS: 0 },
    lastClosedPnl: null,
    grokSignal: 0.5,
    scanTick: 0,
    ui: defaultUi()
  };
}

export function trimState(state) {
  if (state.equityCurve.length > 260) {
    const closedPoints = new Set(state.history.map(h => h.curveTime));
    state.equityCurve = state.equityCurve.filter((pt, idx) =>
      idx === 0 || idx >= state.equityCurve.length - 180 || closedPoints.has(pt.t));
  }
  if (state.feed.length > 60) state.feed = state.feed.slice(0, 60);
  if (state.history.length > 150) state.history = state.history.slice(0, 150);
}

function num(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }

// Validate + normalize a state sent by the phone for the one-time seed.
export function sanitizeSeed(input, now = Date.now()) {
  if (!input || typeof input !== 'object') throw new Error('state manquant');
  const balance = Number(input.balance);
  if (!Number.isFinite(balance) || balance < 0 || balance > 1e9) throw new Error('balance invalide');
  const s = defaultState(now);
  s.balance = balance;
  const arr = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
  s.history = arr(input.history, 150).filter(h => h && typeof h === 'object' && Number.isFinite(Number(h.pnl)));
  const curve = arr(input.equityCurve, 400).filter(p => p && Number.isFinite(Number(p.t)) && Number.isFinite(Number(p.v)));
  if (curve.length) s.equityCurve = curve.map(p => ({ t: Number(p.t), v: Number(p.v), label: String(p.label || fmtShortTime(Number(p.t))), ...(p.tradeId ? { tradeId: String(p.tradeId) } : {}) }));
  const feed = arr(input.feed, 60).filter(f => f && typeof f === 'object');
  if (feed.length) s.feed = feed.map(f => ({ id: String(f.id || ''), agent: String(f.agent || ''), time: String(f.time || ''), ts: num(f.ts) || undefined, text: String(f.text || ''), badge: String(f.badge || ''), kind: String(f.kind || 'open') }));
  const vc = input.vetoCounts || {};
  for (const k of Object.keys(s.vetoCounts)) s.vetoCounts[k] = Math.max(0, Math.floor(num(vc[k])));
  s.lastClosedPnl = input.lastClosedPnl === null || input.lastClosedPnl === undefined ? null : num(input.lastClosedPnl, null);
  s.grokSignal = num(input.grokSignal, 0.5);

  const oldest = now - 3 * 24 * 3600 * 1000; // Hyperliquid keeps ~5000 recent 1m candles
  for (const p of arr(input.positions, 10)) {
    if (!p || typeof p !== 'object') continue;
    const side = p.side === 'Long' || p.side === 'Short' ? p.side : null;
    const entryPrice = num(p.entryPrice), size = num(p.size), margin = num(p.margin), stopPrice = num(p.stopPrice);
    if (!side || !(entryPrice > 0) || !(size > 0) || !(margin > 0) || !(stopPrice > 0)) continue;
    const pos = {
      id: String(p.id || `${now}-${p.symbol}`), symbol: String(p.symbol), side, size, entryPrice,
      peakPrice: num(p.peakPrice, entryPrice) || entryPrice, stopPrice,
      tpPrice: num(p.tpPrice) > 0 ? num(p.tpPrice) : undefined,
      leverage: num(p.leverage) > 0 ? num(p.leverage) : undefined,
      exitMode: p.exitMode === EXIT_MODE_V2 ? EXIT_MODE_V2 : undefined,
      trailActive: !!p.trailActive,
      trailStop: num(p.trailStop) > 0 ? num(p.trailStop) : null,
      margin, entryFee: num(p.entryFee),
      openedAt: num(p.openedAt) || now,
      lastCheckedTs: Math.max(oldest, num(p.lastCheckedTs) || num(p.openedAt) || now),
      ageTicks: Math.floor(num(p.ageTicks))
    };
    if (!KNOWN_SYMBOLS.has(pos.symbol)) {
      // Same as the app's sanitizeLegacyPositions: close flat, return margin.
      s.balance = Math.max(1.0, s.balance + margin);
      s.history.unshift({ id: pos.id, time: fmtShortTime(now), ts: now, curveTime: now, symbol: pos.symbol, side, size, entryPrice, exitPrice: entryPrice, pnl: 0, roe: 0, margin, balanceAfter: s.balance, reason: 'BOARD UPDATE: coin retiré' });
      continue;
    }
    if (s.positions.length < MAX_POSITIONS + 2) s.positions.push(pos);
  }
  if (input.ui && typeof input.ui === 'object') s.ui = { ...defaultUi(), ...input.ui };
  s.feed.unshift({ id: `seed-${now}`, agent: 'Grok Bot', ts: now, time: fmtShortTime(now), text: 'Compte du téléphone migré vers le serveur 24/7', badge: 'SEED', kind: 'open' });
  trimState(s);
  return s;
}

// ---------- market ----------
export function buildMarket(prevMarket, idxByName) {
  const market = {};
  let totalVolRatio = 0, activeCount = 0;
  for (const c of COINS) {
    const existing = (prevMarket && prevMarket[c.symbol]) || { candles: [], ticks: [] };
    const entry = idxByName[c.symbol];
    if (!entry || !entry.ctx) { if (prevMarket && prevMarket[c.symbol]) market[c.symbol] = existing; continue; }
    const { meta, ctx } = entry;
    const price = parseFloat(ctx.midPx || ctx.markPx || ctx.oraclePx || '0');
    const prevDayPx = parseFloat(ctx.prevDayPx || price || '1');
    const dayNtlVlm = parseFloat(ctx.dayNtlVlm || '0');
    const chg24h = prevDayPx > 0 ? ((price - prevDayPx) / prevDayPx) * 100 : 0;
    const ticks = (existing.ticks || []).slice(-30);
    if (price > 0) ticks.push(price);
    let chg15m = chg24h * 0.08;
    let volRatio = 1.0;
    const candles = existing.candles || [];
    if (candles.length >= 4) {
      const recent = candles.slice(-4);
      const oldPx = parseFloat(recent[0].o);
      if (oldPx > 0 && price > 0) chg15m = ((price - oldPx) / oldPx) * 100;
      const vols = candles.map(k => parseFloat(k.v || '0'));
      const avgV = vols.reduce((a, b) => a + b, 0) / Math.max(1, vols.length);
      const lastV = vols[vols.length - 1] || 0;
      volRatio = avgV > 0 ? Math.min(3.5, Math.max(0.2, lastV / avgV)) : 1.0;
    } else if (ticks.length >= 3) {
      const base = ticks[0];
      if (base > 0) chg15m = ((price - base) / base) * 100;
    }
    const isDelisted = Boolean(meta && meta.isDelisted) || dayNtlVlm <= 0;
    if (!isDelisted) { totalVolRatio += volRatio; activeCount++; }
    market[c.symbol] = { symbol: c.symbol, price, prevDayPx, dayNtlVlm, isDelisted, chg24h, chg15m, volRatio, candles, ticks };
  }
  const avgBoardVol = activeCount > 0 ? totalVolRatio / activeCount : 1.0;
  return { market, avgBoardVol };
}

export function applyCandlesToMarket(market, symbol, candles) {
  if (!Array.isArray(candles) || !market[symbol] || candles.length === 0) return;
  const slim = candles.slice(-30).map(k => ({ t: k.t, T: k.T, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v }));
  market[symbol].candles = slim;
  const curPx = market[symbol].price || parseFloat(slim[slim.length - 1].c);
  if (slim.length >= 4) {
    const oldPx = parseFloat(slim[Math.max(0, slim.length - 4)].o);
    if (oldPx > 0 && curPx > 0) market[symbol].chg15m = ((curPx - oldPx) / oldPx) * 100;
  }
  const vols = slim.map(k => parseFloat(k.v || '0'));
  const avgV = vols.reduce((a, b) => a + b, 0) / Math.max(1, vols.length);
  const lastV = vols[vols.length - 1] || 0;
  market[symbol].volRatio = avgV > 0 ? Math.min(3.5, Math.max(0.2, lastV / avgV)) : 1.0;
}

export function boardVolume(market) {
  let total = 0, n = 0;
  for (const c of COINS) { const m = market[c.symbol]; if (m && !m.isDelisted) { total += m.volRatio; n++; } }
  return n > 0 ? total / n : 1.0;
}

// ---------- exits (verbatim logic) ----------
export function takeProfitPrice(pos) {
  if (Number.isFinite(pos.tpPrice) && pos.tpPrice > 0) return pos.tpPrice;
  const entry = Number(pos.entryPrice);
  if (!Number.isFinite(entry) || entry <= 0) return 0;
  return pos.side === 'Long' ? entry * (1 + TP_PCT) : entry * (1 - TP_PCT);
}
export function isV2Exit(pos) { return !!(pos && pos.exitMode === EXIT_MODE_V2); }
export function favorableMovePct(pos, price) {
  const entry = pos.entryPrice;
  if (!(entry > 0) || !Number.isFinite(price)) return 0;
  return pos.side === 'Long' ? (price - entry) / entry : (entry - price) / entry;
}
export function updatePeakPrice(pos, mark) {
  if (pos.side === 'Long') pos.peakPrice = Math.max(pos.peakPrice || pos.entryPrice, mark);
  else pos.peakPrice = Math.min(pos.peakPrice || pos.entryPrice, mark);
}
export function applyLegacyTrail(pos) {
  const peakMovePct = favorableMovePct(pos, pos.peakPrice);
  if (peakMovePct >= LEGACY_TRAIL_ARM_PCT) {
    const trailStop = pos.side === 'Long' ? pos.peakPrice * (1 - LEGACY_TRAIL_GAP_PCT) : pos.peakPrice * (1 + LEGACY_TRAIL_GAP_PCT);
    pos.stopPrice = pos.side === 'Long' ? Math.max(pos.stopPrice, trailStop) : Math.min(pos.stopPrice, trailStop);
  }
}
export function reachedTrailActivation(pos) {
  const tp = takeProfitPrice(pos);
  if (tp > 0) return pos.side === 'Long' ? pos.peakPrice >= tp : pos.peakPrice <= tp;
  return favorableMovePct(pos, pos.peakPrice) >= TP_PCT;
}
export function applyV2Trail(pos) {
  if (!pos.trailActive && reachedTrailActivation(pos)) pos.trailActive = true;
  if (!pos.trailActive) return;
  const trailStop = pos.side === 'Long' ? pos.peakPrice * (1 - TRAIL_AFTER_TP_PCT) : pos.peakPrice * (1 + TRAIL_AFTER_TP_PCT);
  const feeBuffer = 2 * TAKER_FEE;
  const entryFloor = pos.side === 'Long' ? pos.entryPrice * (1 + feeBuffer) : pos.entryPrice * (1 - feeBuffer);
  const safeTrail = pos.side === 'Long' ? Math.max(trailStop, entryFloor) : Math.min(trailStop, entryFloor);
  if (!Number.isFinite(pos.trailStop) || pos.trailStop <= 0) pos.trailStop = safeTrail;
  else if (pos.side === 'Long') pos.trailStop = Math.max(pos.trailStop, safeTrail);
  else pos.trailStop = Math.min(pos.trailStop, safeTrail);
}
// opts.timeExitDue replaces the app's ageTicks >= 90 (4s ticks) with elapsed time.
export function evaluateExit(pos, mark, opts) {
  const allowTimeExit = !opts || opts.allowTimeExit !== false;
  const allowTp = !opts || opts.allowTp !== false;
  const movePct = favorableMovePct(pos, mark);
  const v2 = isV2Exit(pos);
  const hitInitialStop = pos.side === 'Long' ? mark <= pos.stopPrice : mark >= pos.stopPrice;
  const hitTrail = v2 && !!pos.trailActive && Number.isFinite(pos.trailStop) && pos.trailStop > 0
    && (pos.side === 'Long' ? mark <= pos.trailStop : mark >= pos.trailStop);
  const tpLevel = takeProfitPrice(pos);
  const hitTp = allowTp && !v2 && tpLevel > 0 && (pos.side === 'Long' ? mark >= tpLevel : mark <= tpLevel);
  const hitTimeExit = allowTimeExit && !(v2 && pos.trailActive) && !!(opts && opts.timeExitDue) && Math.abs(movePct) > 0.001;
  const shouldClose = !!(hitTrail || hitTp || hitInitialStop || hitTimeExit);
  return { shouldClose, hitTrail, hitTp, hitInitialStop, hitTimeExit, movePct };
}
export function exitFillPrice(pos, ev, mark) {
  if (ev.hitTrail && Number.isFinite(pos.trailStop) && pos.trailStop > 0) return pos.trailStop;
  if (ev.hitInitialStop && Number.isFinite(pos.stopPrice) && pos.stopPrice > 0) return pos.stopPrice;
  if (ev.hitTp) { const tp = takeProfitPrice(pos); if (tp > 0) return tp; }
  return mark;
}
export function exitReasonText(ev, netPnl) {
  if (ev.hitTrail) return 'Trailing stop';
  if (ev.hitTp) return 'COURT: TAKE PROFIT';
  if (ev.hitInitialStop && netPnl < 0) return 'COURT: KILLED AT STOP';
  if (ev.hitInitialStop) return 'EXIT GUARD: TRAIL';
  return 'EXIT GUARD: TIME';
}
export function walkCandleForExit(pos, candle) {
  const h = parseFloat(candle.h), l = parseFloat(candle.l);
  const adverse = pos.side === 'Long' ? l : h;
  const favorable = pos.side === 'Long' ? h : l;
  if (!(adverse > 0) && !(favorable > 0)) return { close: false };
  const noTimeNoTp = { allowTimeExit: false, allowTp: false };
  const ts = Number(candle.t) || Date.now();
  if (adverse > 0) {
    const ev = evaluateExit(pos, adverse, noTimeNoTp);
    if (ev.shouldClose) return { close: true, ev, fillPrice: exitFillPrice(pos, ev, adverse), ts };
  }
  if (favorable > 0) updatePeakPrice(pos, favorable);
  if (isV2Exit(pos)) applyV2Trail(pos); else applyLegacyTrail(pos);
  if (adverse > 0) {
    const ev = evaluateExit(pos, adverse, noTimeNoTp);
    if (ev.shouldClose) return { close: true, ev, fillPrice: exitFillPrice(pos, ev, adverse), ts };
  }
  if (!isV2Exit(pos) && favorable > 0) {
    const ev = evaluateExit(pos, favorable, { allowTimeExit: false, allowTp: true });
    if (ev.hitTp) return { close: true, ev, fillPrice: exitFillPrice(pos, ev, favorable), ts };
  }
  return { close: false };
}
export function candleEndTs(candle) {
  const end = Number(candle.T);
  if (Number.isFinite(end) && end > 0) return end;
  const start = Number(candle.t);
  return Number.isFinite(start) ? start + CANDLE_MS : Date.now();
}

// ---------- account ----------
export function calcPositionMetrics(pos, markPrice) {
  const priceDiff = pos.side === 'Long' ? (markPrice - pos.entryPrice) : (pos.entryPrice - markPrice);
  const pnlGross = priceDiff * pos.size;
  const roe = pos.margin > 0 ? (pnlGross / pos.margin) * 100 : 0;
  return { pnlGross, roe };
}
export function getAccountEquity(state, market) {
  let marginUsed = 0, unrealized = 0;
  for (const pos of state.positions) {
    const m = market[pos.symbol];
    const mark = m && m.price > 0 ? m.price : pos.entryPrice;
    marginUsed += pos.margin;
    unrealized += calcPositionMetrics(pos, mark).pnlGross;
  }
  return { equity: state.balance + marginUsed + unrealized, freeBalance: state.balance, marginUsed, unrealized };
}
export function pushFeed(state, agent, text, badge, kind, ts = Date.now()) {
  state.feed.unshift({ id: `${ts}-${Math.random().toString(36).slice(2, 6)}`, agent, ts, time: fmtShortTime(ts), text, badge, kind });
  if (state.feed.length > 50) state.feed.length = 50;
}
function setAgent(state, id, status, desc, badge) { state.ui.agents[id] = { status, desc, badge }; }

export function closeOpenPosition(state, pos, fillPrice, nowTs, ev) {
  const { pnlGross } = calcPositionMetrics(pos, fillPrice);
  const exitFee = pos.size * fillPrice * TAKER_FEE;
  const netPnl = pnlGross - (pos.entryFee || 0) - exitFee;
  const roe = (netPnl / pos.margin) * 100;
  state.balance = Math.max(1.0, state.balance + pos.margin + netPnl);
  state.lastClosedPnl = netPnl;
  const closedTrade = {
    id: pos.id, time: fmtShortTime(nowTs), ts: nowTs, curveTime: nowTs, symbol: pos.symbol, side: pos.side,
    size: pos.size, entryPrice: pos.entryPrice, exitPrice: fillPrice, pnl: netPnl, roe, margin: pos.margin,
    leverage: posLeverage(pos), balanceAfter: state.balance, reason: exitReasonText(ev, netPnl)
  };
  state.history.unshift(closedTrade);
  state.equityCurve.push({ t: nowTs, v: state.balance, label: fmtShortTime(nowTs), tradeId: closedTrade.id });
  if (netPnl < 0) {
    state.vetoCounts.COURT += 1;
    pushFeed(state, 'COURT', `stop $${coinLabel(pos.symbol)} ${fmtUsd(netPnl, true)} @ $${fmtPrice(fillPrice)}`, 'STOP', 'stop', nowTs);
    setAgent(state, 'court', 'veto', `killed $${coinLabel(pos.symbol)} at stop`, '✕');
  } else {
    pushFeed(state, 'Grok Bot', `closed $${coinLabel(pos.symbol)} ${pos.side} ${fmtUsd(netPnl, true)}`, ev.hitTrail ? 'TRAIL' : fmtUsd(netPnl, true), 'win', nowTs);
    setAgent(state, 'court', 'approved', `closed $${coinLabel(pos.symbol)} +${roe.toFixed(1)}%`, '✓');
  }
  return closedTrade;
}

// 1m-candle walk since lastCheckedTs (same conservative order as the app's catch-up).
// Returns true if the position was closed.
export function walkPositionCandles(state, pos, candles, now) {
  const start = Number(pos.lastCheckedTs) || Number(pos.openedAt) || 0;
  if (!start) { pos.lastCheckedTs = now; return false; }
  for (const candle of candles) {
    const t = Number(candle.t);
    const end = candleEndTs(candle);
    if (end <= start) continue;
    // Never use price action from before the entry.
    if (Number.isFinite(t) && t < (Number(pos.openedAt) || 0)) continue;
    const result = walkCandleForExit(pos, candle);
    if (result.close) {
      const ts = Math.min(now, Math.max(result.ts || t || now, Number(pos.openedAt) || 0));
      closeOpenPosition(state, pos, result.fillPrice, ts, result.ev);
      return true;
    }
    pos.lastCheckedTs = Math.max(pos.lastCheckedTs || 0, Math.min(end, now));
  }
  pos.lastCheckedTs = now;
  return false;
}

// Mark-price check (app's monitorOpenPositions), with a time-based time exit.
export function monitorWithMark(state, market, nowTs) {
  const remaining = [];
  for (const pos of state.positions) {
    const m = market[pos.symbol];
    if (!m || !m.price) { remaining.push(pos); continue; }
    const mark = m.price;
    pos.ageTicks = (pos.ageTicks || 0) + 1;
    const opts = { timeExitDue: nowTs - (Number(pos.openedAt) || nowTs) >= TIME_EXIT_MS };
    let ev = evaluateExit(pos, mark, opts);
    const crossedTrigger = ev.shouldClose && (ev.hitInitialStop || ev.hitTrail || ev.hitTp);
    if (!crossedTrigger) {
      updatePeakPrice(pos, mark);
      if (isV2Exit(pos)) applyV2Trail(pos); else applyLegacyTrail(pos);
      ev = evaluateExit(pos, mark, opts);
    }
    if (ev.shouldClose) closeOpenPosition(state, pos, exitFillPrice(pos, ev, mark), nowTs, ev);
    else { pos.lastCheckedTs = nowTs; remaining.push(pos); }
  }
  state.positions = remaining;
}

function markLaterAgentsSkipped(state, vetoCardId) {
  const idx = VETO_AGENT_ORDER.indexOf(vetoCardId);
  if (idx < 0) return;
  VETO_AGENT_ORDER.slice(idx + 1).forEach(id => setAgent(state, id, 'skipped', 'skipped / not consulted', '—'));
}

// Exact port of runSixAgentCycle (live branch). Vetoes are logged every 2nd scan like the app.
export function runSixAgentCycle(state, market, nowTs) {
  state.scanTick = (state.scanTick || 0) + 1;
  state.vetoCounts.GROK_SCANS += 1;
  const ui = state.ui;
  const activeCoins = COINS.map(c => market[c.symbol]).filter(m => m && !m.isDelisted && m.price > 0);
  if (activeCoins.length === 0) return null;
  const greenCoins = activeCoins.filter(m => m.chg15m >= 0).length;
  const totalActive = activeCoins.length;
  const greenRatio = greenCoins / totalActive;

  let best = null;
  for (const m of activeCoins) {
    const dir = m.chg15m >= 0 ? 'Long' : 'Short';
    const rawStrength = Math.abs(m.chg15m) * 0.45 + Math.abs(m.chg24h) * 0.03 + (m.volRatio * 0.2);
    const score = Math.min(0.95, Math.max(0.35, 0.42 + rawStrength * 0.18));
    if (!best || score > best.score) best = { m, dir, score };
  }
  if (!best) return null;
  state.grokSignal = best.score;
  ui.signal = best.score;
  const cand = best.m, dir = best.dir;
  const alreadyHolding = state.positions.some(p => p.symbol === cand.symbol);
  const { equity } = getAccountEquity(state, market);
  ui.hub = '';
  ui.actionCls = '';

  if (state.positions.length >= MAX_POSITIONS) {
    setAgent(state, 'risk', 'approved', `${LEVERAGE}x · ${state.positions.length}/${MAX_POSITIONS} open · stop 1.5%`, '✓');
    setAgent(state, 'narrative', 'approved', `${greenCoins}/${totalActive} green · ${state.positions.length} active`, '✓');
    ui.hub = 'active';
    ui.actionText = `${state.positions.length} open · ${LEVERAGE}x`;
    return null;
  }
  if (best.score < ENTRY_THRESHOLD) {
    ui.actionCls = 'scanning';
    ui.actionText = 'scanning';
    setAgent(state, 'sniper', 'scanning', 'watching entry windows', '•');
    setAgent(state, 'liquidity', 'approved', `board vol ${ui.volumeMult.toFixed(1)}x · ok`, '✓');
    setAgent(state, 'narrative', 'approved', `${greenCoins}/${totalActive} green · scanning`, '✓');
    setAgent(state, 'court', 'approved', 'stop 1.5% · R:R ready', '✓');
    setAgent(state, 'risk', 'approved', `${LEVERAGE}x · ${state.positions.length}/3 open · stop 1.5%`, '✓');
    return null;
  }

  let killedBy = null;
  if (Math.abs(cand.chg15m) > 1.9) {
    state.vetoCounts.SNIPER += 1;
    killedBy = { agent: 'SNIPER', card: 'sniper', reason: `fresh ${cand.chg15m >= 0 ? 'pump' : 'dump'} (${cand.chg15m.toFixed(2)}%)` };
    setAgent(state, 'sniper', 'veto', `VETO · ${cand.symbol} ${cand.chg15m.toFixed(2)}%`, '✕');
  } else setAgent(state, 'sniper', 'approved', 'no fresh pump · clear', '✓');

  if (!killedBy && (cand.isDelisted || cand.dayNtlVlm < 100000 || cand.volRatio < 0.42)) {
    state.vetoCounts.LIQUIDITY += 1;
    killedBy = { agent: 'LIQUIDITY', card: 'liquidity', reason: `vol ${cand.volRatio.toFixed(1)}x < 0.42x avg` };
    setAgent(state, 'liquidity', 'veto', `VOLUME ${cand.volRatio.toFixed(1)}x · nobody here`, '✕');
  } else if (!killedBy) setAgent(state, 'liquidity', 'approved', `volume ${cand.volRatio.toFixed(1)}x of avg · ok`, '✓');

  const opposesBullSweep = dir === 'Short' && greenRatio >= 0.72;
  const opposesBearSweep = dir === 'Long' && greenRatio <= 0.28;
  if (!killedBy && (opposesBullSweep || opposesBearSweep)) {
    state.vetoCounts.NARRATIVE += 1;
    killedBy = { agent: 'NARRATIVE', card: 'narrative', reason: `${cand.symbol} alone vs ${greenCoins}/${totalActive} board` };
    setAgent(state, 'narrative', 'veto', 'VETO · alone vs board', '✕');
  } else if (!killedBy) setAgent(state, 'narrative', 'approved', `${greenCoins}/${totalActive} green · ${cand.symbol} cleanest`, '✓');

  let recentRangePct = 0.4;
  if (cand.candles && cand.candles.length >= 2) {
    const lastC = cand.candles[cand.candles.length - 1];
    const h = parseFloat(lastC.h), l = parseFloat(lastC.l);
    if (l > 0) recentRangePct = ((h - l) / l) * 100;
  }
  if (!killedBy && recentRangePct > 1.85) {
    state.vetoCounts.COURT += 1;
    killedBy = { agent: 'COURT', card: 'court', reason: `wick ${recentRangePct.toFixed(2)}% > stop 1.5%` };
    setAgent(state, 'court', 'veto', 'VETO · stop 1.5% too tight', '✕');
  } else if (!killedBy) setAgent(state, 'court', 'approved', 'dies at stop 1.5% → OK', '✓');

  const marginAlloc = Math.min(state.balance * 0.85, equity * 0.31);
  if (!killedBy && (alreadyHolding || marginAlloc < 5)) {
    state.vetoCounts.RISK += 1;
    killedBy = { agent: 'RISK', card: 'risk', reason: alreadyHolding ? `${cand.symbol} déjà ouvert` : 'marge insuffisante' };
    setAgent(state, 'risk', 'veto', `VETO · ${alreadyHolding ? 'déjà en cours' : 'low margin'}`, '✕');
  } else if (!killedBy) setAgent(state, 'risk', 'approved', `${LEVERAGE}x · ${state.positions.length + 1}/3 open · stop 1.5%`, '✓');

  if (killedBy) {
    markLaterAgentsSkipped(state, killedBy.card);
    ui.hub = 'veto';
    ui.actionCls = 'veto';
    ui.actionText = `${killedBy.agent}: VETO`;
    if (state.scanTick % 2 === 0) pushFeed(state, killedBy.agent, `VETO $${cand.symbol} ${dir} (${killedBy.reason})`, 'VETO', 'veto', nowTs);
    return null;
  }

  const notional = marginAlloc * LEVERAGE;
  const size = notional / cand.price;
  const entryFee = notional * TAKER_FEE;
  const stopPrice = dir === 'Long' ? cand.price * (1 - STOP_PCT) : cand.price * (1 + STOP_PCT);
  const tpPrice = dir === 'Long' ? cand.price * (1 + TP_PCT) : cand.price * (1 - TP_PCT);
  state.balance -= marginAlloc;
  const newPos = {
    id: `${nowTs}-${cand.symbol}`, symbol: cand.symbol, side: dir, size, entryPrice: cand.price, peakPrice: cand.price,
    stopPrice, tpPrice, leverage: LEVERAGE, exitMode: EXIT_MODE_V2, trailActive: false, trailStop: null,
    margin: marginAlloc, entryFee, openedAt: nowTs, lastCheckedTs: nowTs, ageTicks: 0
  };
  state.positions.push(newPos);
  ui.hub = 'active';
  ui.actionText = `${state.positions.length} ${dir.toLowerCase()}s · ${LEVERAGE}x`;
  pushFeed(state, 'Grok Bot', `${dir === 'Long' ? 'L' : 'S'} $${coinLabel(cand.symbol)} @ $${fmtPrice(cand.price)} · ${LEVERAGE}x`, 'OPEN', 'open', nowTs);
  return newPos;
}

// Market summary sent to the phone (no candles).
export function marketSummary(market) {
  const out = {};
  for (const c of COINS) {
    const m = market[c.symbol];
    if (!m) continue;
    const lastC = m.candles && m.candles.length ? m.candles[m.candles.length - 1] : null;
    out[c.symbol] = { symbol: c.symbol, price: m.price, prevDayPx: m.prevDayPx, dayNtlVlm: m.dayNtlVlm, isDelisted: m.isDelisted, chg24h: m.chg24h, chg15m: m.chg15m, volRatio: m.volRatio, lastCandle: lastC };
  }
  return out;
}
