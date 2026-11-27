// Grok Bot Trading Desk — 24/7 paper bot (Cloudflare Worker + SQLite Durable Object).
// Paper money on real Hyperliquid prices. No orders, no wallet, no keys.
import { DurableObject } from 'cloudflare:workers';
import * as E from './engine.js';

const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
const CANDLE_COINS_PER_TICK = 4;
const MAX_BODY = 600 * 1024;

async function hlPost(payload) {
  const res = await fetch(HL_INFO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(9000)
  });
  if (!res.ok) throw new Error(`Hyperliquid HTTP ${res.status}`);
  return res.json();
}

async function fetchCandleRange(symbol, startTime, endTime) {
  const all = [];
  const seen = new Set();
  let start = startTime;
  let guard = 0;
  while (start < endTime && guard++ < 3) {
    const end = Math.min(endTime, start + E.CANDLE_MAX_BARS * E.CANDLE_MS);
    const candles = await hlPost({ type: 'candleSnapshot', req: { coin: symbol, interval: '1m', startTime: start, endTime: end } });
    if (Array.isArray(candles)) {
      for (const c of candles) {
        const t = Number(c.t);
        if (!Number.isFinite(t) || seen.has(t)) continue;
        seen.add(t);
        all.push({ t: c.t, T: c.T, h: c.h, l: c.l });
      }
    }
    if (end >= endTime) break;
    start = end;
  }
  all.sort((a, b) => Number(a.t) - Number(b.t));
  return all;
}

export class DeskBot extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.loaded = false;
    ctx.blockConcurrencyWhile(async () => { await this.load(); });
  }

  async load() {
    const got = await this.ctx.storage.get(['state', 'market', 'meta']);
    this.state = got.get('state') || null;
    this.market = got.get('market') || {};
    this.meta = got.get('meta') || { initialized: false, runCount: 0, lastRunAt: null, lastTradeRunAt: null, lastError: null, candleCursor: 0, createdAt: Date.now() };
    this.loaded = true;
  }

  async persist() {
    await this.ctx.storage.put({ state: this.state, market: this.market, meta: this.meta });
  }

  // Cron entry point. blockConcurrencyWhile keeps seed/reset/GET from interleaving with a tick.
  async tick(payload) {
    return this.ctx.blockConcurrencyWhile(() => this.runTick(payload));
  }

  async runTick(payload) {
    const started = Date.now();
    const meta = this.meta;
    meta.runCount = (meta.runCount || 0) + 1;
    meta.lastRunAt = started;
    const errors = (payload && Array.isArray(payload.errors)) ? payload.errors.slice(0, 4) : [];
    try {
      // 1. Market data collected by the cron Worker (12 coins only, keeps DO CPU low).
      const idxByName = (payload && payload.idxByName) || {};
      if (Object.keys(idxByName).length === 0) throw new Error(errors.join('; ') || 'no market data');
      const { market } = E.buildMarket(this.market, idxByName);
      this.market = market;
      // 2. Rotating 5m candles (4 coins per minute, every coin every 3 minutes).
      for (const [sym, candles] of Object.entries((payload && payload.candles) || {})) {
        E.applyCandlesToMarket(market, sym, candles);
      }
      const avgBoardVol = E.boardVolume(market);

      // 3. Trading only once the account is initialized (seeded from the phone or reset).
      if (meta.initialized && this.state) {
        const state = this.state;
        if (!state.ui) state.ui = E.defaultUi();
        state.ui.volumeMult = avgBoardVol;
        const now = Date.now();
        // 3a. Exact exits from 1m candles since the last check.
        const remaining = [];
        for (const pos of state.positions) {
          try {
            const start = Number(pos.lastCheckedTs) || Number(pos.openedAt) || now;
            const candles = now - start > 5000 ? await fetchCandleRange(pos.symbol, Math.max(0, start - E.CANDLE_MS), now) : [];
            const closed = E.walkPositionCandles(state, pos, candles, now);
            if (!closed) remaining.push(pos);
          } catch (err) {
            errors.push(`walk ${pos.symbol}: ${err.message}`);
            remaining.push(pos); // keep lastCheckedTs, retry next minute
          }
        }
        state.positions = remaining;
        // 3b. Mark check (price exits only), then the 6-agent cycle.
        E.monitorWithMark(state, market, now);
        E.runSixAgentCycle(state, market, now);
        state.equityCurve.push({ t: now, v: E.getAccountEquity(state, market).equity, label: E.fmtShortTime(now) });
        E.trimState(state);
        meta.lastTradeRunAt = now;
      }
      meta.lastError = errors.length ? errors.slice(0, 4).join(' | ') : null;
    } catch (err) {
      meta.lastError = String(err && err.message || err);
    }
    meta.lastDurationMs = Date.now() - started;
    await this.persist();
    return { ok: !meta.lastError, runCount: meta.runCount, lastRunAt: meta.lastRunAt };
  }

  getState() {
    const state = this.state;
    const market = this.market || {};
    return {
      meta: {
        initialized: !!this.meta.initialized,
        engine: E.ENGINE_VERSION,
        runCount: this.meta.runCount || 0,
        lastRunAt: this.meta.lastRunAt,
        lastTradeRunAt: this.meta.lastTradeRunAt,
        lastError: this.meta.lastError,
        lastDurationMs: this.meta.lastDurationMs,
        seededAt: this.meta.seededAt || null,
        resetAt: this.meta.resetAt || null,
        serverTime: Date.now(),
        cron: '* * * * *'
      },
      state: state || null,
      equity: state ? E.getAccountEquity(state, market) : null,
      market: E.marketSummary(market)
    };
  }

  async seed(input) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (this.meta.initialized) return { ok: false, status: 409, error: 'already_initialized' };
      let state;
      try { state = E.sanitizeSeed(input, Date.now()); } catch (err) { return { ok: false, status: 400, error: String(err.message) }; }
      this.state = state;
      this.meta.initialized = true;
      this.meta.seededAt = Date.now();
      await this.persist();
      return { ok: true, status: 200 };
    });
  }

  async reset() {
    return this.ctx.blockConcurrencyWhile(async () => {
      this.state = E.defaultState(Date.now());
      this.meta.initialized = true;
      this.meta.resetAt = Date.now();
      await this.persist();
      return { ok: true, status: 200 };
    });
  }
}

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(env, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders(env) }
  });
}

async function readJson(request) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BODY) throw new Error('body too large');
  const text = await request.text();
  if (text.length > MAX_BODY) throw new Error('body too large');
  return text ? JSON.parse(text) : {};
}

// Runs in the cron Worker: fetch Hyperliquid data and keep only the 12 board coins.
async function collectMarket(scheduledTime) {
  const errors = [];
  const idxByName = {};
  const dexes = [...new Set(E.COINS.map(c => c.dex || ''))];
  const minute = Math.floor(scheduledTime / 60000);
  const rot = [];
  for (let i = 0; i < CANDLE_COINS_PER_TICK; i++) rot.push(E.COINS[(minute * CANDLE_COINS_PER_TICK + i) % E.COINS.length].symbol);
  const endTime = Date.now();
  const candles = {};
  await Promise.all([
    ...dexes.map(async dex => {
      try {
        const data = await hlPost(dex ? { type: 'metaAndAssetCtxs', dex } : { type: 'metaAndAssetCtxs' });
        const universe = (data[0] && data[0].universe) || [];
        const ctxs = data[1] || [];
        universe.forEach((m, j) => {
          if (!E.KNOWN_SYMBOLS.has(m.name) || !ctxs[j]) return;
          const c = ctxs[j];
          idxByName[m.name] = { meta: { isDelisted: !!m.isDelisted }, ctx: { midPx: c.midPx, markPx: c.markPx, oraclePx: c.oraclePx, prevDayPx: c.prevDayPx, dayNtlVlm: c.dayNtlVlm } };
        });
      } catch (err) { errors.push(`meta ${dex || 'default'}: ${err.message}`); }
    }),
    ...rot.map(async sym => {
      try {
        const k = await hlPost({ type: 'candleSnapshot', req: { coin: sym, interval: '5m', startTime: endTime - 120 * 60000, endTime } });
        if (Array.isArray(k)) candles[sym] = k.slice(-30).map(x => ({ t: x.t, T: x.T, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v }));
      } catch (err) { errors.push(`candles ${sym}: ${err.message}`); }
    })
  ]);
  return { idxByName, candles, errors };
}

function stub(env) { return env.DESK.get(env.DESK.idFromName('main')); }

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env) });
    try {
      if (url.pathname === '/api/state' && request.method === 'GET') {
        return json(env, await stub(env).getState());
      }
      if ((url.pathname === '/api/seed' || url.pathname === '/api/reset') && request.method === 'POST') {
        // Writes only from the desk app's origin (browser CORS); this is paper money only.
        const origin = request.headers.get('Origin');
        if (origin !== env.ALLOWED_ORIGIN) return json(env, { ok: false, error: 'forbidden_origin' }, 403);
        let body;
        try { body = await readJson(request); } catch (err) { return json(env, { ok: false, error: String(err.message) }, 400); }
        if (url.pathname === '/api/seed') {
          const r = await stub(env).seed(body && body.state);
          return json(env, r, r.status || 200);
        }
        if (!body || body.confirm !== true) return json(env, { ok: false, error: 'confirm_required' }, 400);
        const r = await stub(env).reset();
        return json(env, r, r.status || 200);
      }
      if (url.pathname === '/' || url.pathname === '/api/health') {
        return json(env, { ok: true, name: 'grok-trading-desk-bot', paper: true, note: 'Paper money on real Hyperliquid prices. No orders, no wallet.' });
      }
      return json(env, { ok: false, error: 'not_found' }, 404);
    } catch (err) {
      return json(env, { ok: false, error: String(err && err.message || err) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const payload = await collectMarket(event.scheduledTime || Date.now());
      await stub(env).tick(payload);
    })());
  }
};
