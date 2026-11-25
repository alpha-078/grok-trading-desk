(() => {
  'use strict';

  const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
  const STORAGE_KEY_LIVE = 'grok_trading_desk_v1';
  const STORAGE_KEY_REPLAY = 'grok_trading_desk_replay_v1';
  const INITIAL_BALANCE = 135.0;
  const LEVERAGE = 10;
  const STOP_PCT = 0.015; // 1.5% price move => 15% ROE at 10x
  const TP_PCT = 0.018;   // 1.8% price move => 18% ROE at 10x
  const LEGACY_LEVERAGE = 20; // fallback for positions opened before leverage was stored
  const TAKER_FEE = 0.00035; // 0.035% notional simulated taker fee
  const MAX_POSITIONS = 3;
  const POLL_MS = 4000;
  const REPLAY_STEP_MS = 650;
  const CANDLE_REFRESH_MS = 60000;
  const CANDLE_STAGGER_MS = 450;
  const VETO_AGENT_ORDER = ['sniper', 'liquidity', 'narrative', 'court', 'risk'];

  const COINS = [
    { symbol: 'BTC',      label: 'BTC',   short: 'BTC', color: '#f7931a' },
    { symbol: 'ETH',      label: 'ETH',   short: 'ETH', color: '#627eea' },
    { symbol: 'SOL',      label: 'SOL',   short: 'SOL', color: '#9945ff' },
    { symbol: 'HYPE',     label: 'HYPE',  short: 'HYP', color: '#00d1c7' },
    { symbol: 'ZEC',      label: 'ZEC',   short: 'ZEC', color: '#f4b728' },
    { symbol: 'UNI',      label: 'UNI',   short: 'UNI', color: '#ff007a' },
    { symbol: 'DOGE',     label: 'DOGE',  short: 'DOG', color: '#eab308' },
    { symbol: 'xyz:NVDA', label: 'NVDA',  short: 'NVD', color: '#76b900', dex: 'xyz' },
    { symbol: 'PUMP',     label: 'PUMP',  short: 'PMP', color: '#10b981' },
    { symbol: 'XRP',      label: 'XRP',   short: 'XRP', color: '#23292f' },
    { symbol: 'NEAR',     label: 'NEAR',  short: 'NEAR', color: '#00c08b' },
    { symbol: 'XMR',      label: 'XMR',   short: 'XMR', color: '#ff6600' }
  ];

  const COIN_MAP = Object.fromEntries(COINS.map(c => [c.symbol, c]));

  // Runtime state
  let state = loadState('live');
  let market = {}; // symbol -> { price, prevDayPx, dayNtlVlm, isDelisted, chg24h, chg15m, volRatio, candles: [] }
  let mode = 'live'; // 'live' | 'replay'
  let liveTimer = null;
  let replayTimer = null;
  let replayReturnTimer = null;
  let replayFrames = [];
  let replayIdx = 0;
  let lastCandleRefreshAt = 0;
  let candleRefreshInFlight = false;
  let liveMarketBackup = null;
  let activeTab = 'positions';
  let deferredInstallPrompt = null;
  let popupTimer = null;
  let scanTick = 0;

  // DOM refs
  const el = {
    heroBalance: document.getElementById('hero-balance'),
    lastPnlPill: document.getElementById('last-pnl-pill'),
    multBadge: document.getElementById('mult-badge'),
    tradesSummary: document.getElementById('trades-summary'),
    toastStack: document.getElementById('toast-stack'),
    hlBadge: document.getElementById('hl-status-badge'),
    hlStatusText: document.getElementById('hl-status-text'),
    chartBalancePill: document.getElementById('chart-balance-pill'),
    chartModeLabel: document.getElementById('chart-mode-label'),
    equitySvg: document.getElementById('equity-svg'),
    bubblesLayer: document.getElementById('chart-bubbles-layer'),
    chartTooltip: document.getElementById('chart-tooltip'),
    tabPositions: document.getElementById('tab-positions'),
    tabHistory: document.getElementById('tab-history'),
    countPositions: document.getElementById('count-positions'),
    countHistory: document.getElementById('count-history'),
    sumEquity: document.getElementById('sum-equity'),
    sumUpnl: document.getElementById('sum-upnl'),
    sumMargin: document.getElementById('sum-margin'),
    positionsTable: document.getElementById('positions-table'),
    historyTable: document.getElementById('history-table'),
    positionsTbody: document.getElementById('positions-tbody'),
    historyTbody: document.getElementById('history-tbody'),
    boardGrid: document.getElementById('board-grid'),
    boardTf: document.getElementById('board-tf'),
    volumeBarFill: document.getElementById('volume-bar-fill'),
    volumeMult: document.getElementById('volume-mult'),
    feedList: document.getElementById('feed-list'),
    signalBarFill: document.getElementById('signal-bar-fill'),
    signalVal: document.getElementById('signal-val'),
    vetoList: document.getElementById('veto-list'),
    grokHub: document.getElementById('agent-grok'),
    grokActionText: document.getElementById('grok-action-text'),
    tradePopup: document.getElementById('trade-closed-popup'),
    btnLive: document.getElementById('btn-mode-live'),
    btnReplay: document.getElementById('btn-mode-replay'),
    btnReset: document.getElementById('btn-reset'),
    btnInstall: document.getElementById('btn-install'),
    confettiCanvas: document.getElementById('confetti-canvas')
  };

  function defaultState() {
    const now = Date.now();
    return {
      balance: INITIAL_BALANCE,
      positions: [],
      history: [],
      equityCurve: [
        { t: now - 60000, v: INITIAL_BALANCE, label: fmtTime(now - 60000) },
        { t: now, v: INITIAL_BALANCE, label: fmtTime(now) }
      ],
      feed: [
        {
          id: 'init-1',
          agent: 'Grok Bot',
          time: fmtTime(now),
          text: 'Connecté à Hyperliquid · ' + COINS.length + ' perps en écoute (simulation ' + LEVERAGE + 'x)',
          badge: 'LIVE',
          kind: 'open'
        }
      ],
      vetoCounts: {
        SNIPER: 0,
        LIQUIDITY: 0,
        NARRATIVE: 0,
        COURT: 0,
        RISK: 0,
        GROK_SCANS: 0
      },
      lastClosedPnl: null,
      grokSignal: 0.50
    };
  }

  function storageKey(which = mode) {
    return which === 'replay' ? STORAGE_KEY_REPLAY : STORAGE_KEY_LIVE;
  }

  function loadState(which = 'live') {
    try {
      const raw = localStorage.getItem(storageKey(which));
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.balance !== 'number') return defaultState();
      return parsed;
    } catch {
      return defaultState();
    }
  }

  function saveState() {
    try {
      // Keep curve & feed bounded
      if (state.equityCurve.length > 260) {
        const closedPoints = new Set(state.history.map(h => h.curveTime));
        state.equityCurve = state.equityCurve.filter((pt, idx) =>
          idx === 0 || idx >= state.equityCurve.length - 180 || closedPoints.has(pt.t)
        );
      }
      if (state.feed.length > 60) state.feed = state.feed.slice(0, 60);
      if (state.history.length > 150) state.history = state.history.slice(0, 150);
      // Persist only under the current mode's key — replay never overwrites live.
      localStorage.setItem(storageKey(mode), JSON.stringify(state));
    } catch {
      // Ignore quota errors
    }
  }

  // Close leftover positions on coins no longer on the board.
  // Margin is returned at entry (flat) so the saved free balance is preserved.
  function sanitizeLegacyPositions() {
    const known = new Set(COINS.map(c => c.symbol));
    const open = Array.isArray(state.positions) ? state.positions : [];
    const kept = [];
    const dropped = [];
    for (const pos of open) {
      if (pos && known.has(pos.symbol)) kept.push(pos);
      else if (pos) dropped.push(pos);
    }
    if (dropped.length === 0) {
      state.positions = kept;
      return false;
    }
    const nowTs = Date.now();
    for (const pos of dropped) {
      const margin = Number(pos.margin) || 0;
      state.balance = Math.max(1.0, (Number(state.balance) || 0) + margin);
      state.history = state.history || [];
      state.history.unshift({
        id: pos.id,
        time: fmtShortTime(nowTs),
        ts: nowTs,
        curveTime: nowTs,
        symbol: pos.symbol,
        side: pos.side,
        size: pos.size,
        entryPrice: pos.entryPrice,
        exitPrice: pos.entryPrice,
        pnl: 0,
        roe: 0,
        margin,
        balanceAfter: state.balance,
        reason: 'BOARD UPDATE: coin retiré'
      });
      pushFeed('Grok Bot', `clôture $${coinLabel(pos.symbol)} (plus au board) · marge restituée`, 'FLAT', 'open', nowTs);
    }
    state.positions = kept;
    saveState();
    return true;
  }

  function backupLiveMarket() {
    try {
      liveMarketBackup = JSON.parse(JSON.stringify(market));
    } catch {
      liveMarketBackup = market;
    }
  }

  function restoreLiveMarket() {
    if (liveMarketBackup) {
      market = liveMarketBackup;
      liveMarketBackup = null;
    }
  }

  // Formatting helpers
  function fmtPrice(px) {
    if (!Number.isFinite(px) || px <= 0) return '0.00';
    if (px >= 1000) return px.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (px >= 100) return px.toFixed(2);
    if (px >= 1) return px.toFixed(4);
    if (px >= 0.05) return px.toFixed(5);
    if (px >= 0.005) return px.toFixed(6);
    return px.toFixed(7);
  }

  function fmtUsd(val, withSign = false) {
    const abs = Math.abs(val);
    const str = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (!withSign) return `$${str}`;
    return `${val >= 0 ? '+' : '-'}$${str}`;
  }

  function fmtSize(qty) {
    if (!Number.isFinite(qty)) return '0';
    if (qty >= 1000) return Math.round(qty).toLocaleString('en-US');
    if (qty >= 10) return qty.toFixed(1);
    if (qty >= 1) return qty.toFixed(2);
    if (qty >= 0.1) return qty.toFixed(3);
    if (qty >= 0.01) return qty.toFixed(4);
    return qty.toFixed(5);
  }

  function coinLabel(symbol) {
    return (COIN_MAP[symbol] && COIN_MAP[symbol].label) || symbol;
  }

  // New opens store leverage. Older saved positions were always 20x.
  function posLeverage(pos) {
    const lev = Number(pos && pos.leverage);
    return Number.isFinite(lev) && lev > 0 ? lev : LEGACY_LEVERAGE;
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function fmtShortTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }

  // Hyperliquid API Calls
  async function hlPost(payload) {
    const res = await fetch(HL_INFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function fetchMarketSnapshot() {
    const dexes = [...new Set(COINS.map(c => c.dex || ''))];
    const settled = await Promise.allSettled(
      dexes.map(dex => dex
        ? hlPost({ type: 'metaAndAssetCtxs', dex })
        : hlPost({ type: 'metaAndAssetCtxs' }))
    );
    const idxByName = {};
    settled.forEach((res, i) => {
      if (res.status !== 'fulfilled') {
        console.warn('Hyperliquid meta fetch failed for dex', dexes[i] || 'default', res.reason);
        return;
      }
      const data = res.value;
      const universe = data[0]?.universe || [];
      const ctxs = data[1] || [];
      universe.forEach((m, j) => { idxByName[m.name] = { meta: m, ctx: ctxs[j] }; });
    });

    let totalVolRatio = 0;
    let activeCount = 0;

    COINS.forEach(c => {
      const entry = idxByName[c.symbol];
      if (!entry || !entry.ctx) return;
      const { meta, ctx } = entry;
      const price = parseFloat(ctx.midPx || ctx.markPx || ctx.oraclePx || '0');
      const prevDayPx = parseFloat(ctx.prevDayPx || price || '1');
      const dayNtlVlm = parseFloat(ctx.dayNtlVlm || '0');
      const chg24h = prevDayPx > 0 ? ((price - prevDayPx) / prevDayPx) * 100 : 0;

      const existing = market[c.symbol] || { candles: [], ticks: [] };
      const ticks = existing.ticks.slice(-30);
      if (price > 0) ticks.push(price);

      // Compute short-term 15m change from candles or ticks
      let chg15m = chg24h * 0.08;
      let volRatio = 1.0;
      if (existing.candles && existing.candles.length >= 4) {
        const recent = existing.candles.slice(-4);
        const oldPx = parseFloat(recent[0].o);
        if (oldPx > 0 && price > 0) {
          chg15m = ((price - oldPx) / oldPx) * 100;
        }
        const vols = existing.candles.map(k => parseFloat(k.v || '0'));
        const avgV = vols.reduce((a, b) => a + b, 0) / Math.max(1, vols.length);
        const lastV = vols[vols.length - 1] || 0;
        volRatio = avgV > 0 ? Math.min(3.5, Math.max(0.2, lastV / avgV)) : 1.0;
      } else if (ticks.length >= 3) {
        const base = ticks[0];
        if (base > 0) chg15m = ((price - base) / base) * 100;
      }

      const isDelisted = Boolean(meta.isDelisted) || dayNtlVlm <= 0;
      if (!isDelisted) {
        totalVolRatio += volRatio;
        activeCount++;
      }

      market[c.symbol] = {
        symbol: c.symbol,
        price,
        prevDayPx,
        dayNtlVlm,
        isDelisted,
        chg24h,
        chg15m,
        volRatio,
        candles: existing.candles,
        ticks
      };
    });

    const avgBoardVol = activeCount > 0 ? totalVolRatio / activeCount : 1.0;
    el.volumeMult.textContent = `${avgBoardVol.toFixed(1)}x`;
    el.volumeBarFill.style.width = `${Math.min(100, Math.max(12, avgBoardVol * 45))}%`;
    setHlStatus(true, mode === 'replay' ? 'Replay · HL Data' : 'Live API');
  }

  function applyCandlesToMarket(symbol, candles) {
    if (!Array.isArray(candles) || !market[symbol] || candles.length === 0) return;
    market[symbol].candles = candles;
    const curPx = market[symbol].price || parseFloat(candles[candles.length - 1].c);
    if (candles.length >= 4) {
      const oldPx = parseFloat(candles[Math.max(0, candles.length - 4)].o);
      if (oldPx > 0 && curPx > 0) {
        market[symbol].chg15m = ((curPx - oldPx) / oldPx) * 100;
      }
    }
    const vols = candles.map(k => parseFloat(k.v || '0'));
    const avgV = vols.reduce((a, b) => a + b, 0) / Math.max(1, vols.length);
    const lastV = vols[vols.length - 1] || 0;
    market[symbol].volRatio = avgV > 0 ? Math.min(3.5, Math.max(0.2, lastV / avgV)) : 1.0;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function preloadCandles(interval = '5m', minutesBack = 120) {
    const endTime = Date.now();
    const startTime = endTime - minutesBack * 60 * 1000;
    const activeCoins = COINS.filter(c => market[c.symbol] && !market[c.symbol].isDelisted);

    await Promise.all(
      activeCoins.map(async c => {
        try {
          const candles = await hlPost({
            type: 'candleSnapshot',
            req: { coin: c.symbol, interval, startTime, endTime }
          });
          applyCandlesToMarket(c.symbol, candles);
        } catch {
          // Ignore single coin candle error
        }
      })
    );
  }

  // Live-mode only: refresh 5m candles every 60s so COURT/chg15m/volRatio stay current.
  // Staggers one coin at a time and skips delisted markets to avoid hammering the API.
  async function refreshLiveCandles({ force = false } = {}) {
    if (mode !== 'live') return;
    if (candleRefreshInFlight) return;
    const now = Date.now();
    if (!force && lastCandleRefreshAt && now - lastCandleRefreshAt < CANDLE_REFRESH_MS) return;

    candleRefreshInFlight = true;
    lastCandleRefreshAt = now;
    try {
      const activeCoins = COINS.filter(c => market[c.symbol] && !market[c.symbol].isDelisted);
      const endTime = Date.now();
      const startTime = endTime - 120 * 60 * 1000;
      for (const c of activeCoins) {
        if (mode !== 'live') break;
        try {
          const candles = await hlPost({
            type: 'candleSnapshot',
            req: { coin: c.symbol, interval: '5m', startTime, endTime }
          });
          applyCandlesToMarket(c.symbol, candles);
        } catch {
          // Ignore single coin candle error
        }
        await sleep(CANDLE_STAGGER_MS);
      }
    } finally {
      candleRefreshInFlight = false;
    }
  }

  function setHlStatus(ok, text) {
    const dot = el.hlBadge.querySelector('.hl-dot');
    dot.classList.toggle('error', !ok);
    el.hlStatusText.textContent = text;
  }


  // Fixed 1.8% take-profit from entry. Recomputed if a saved position has no tpPrice.
  function takeProfitPrice(pos) {
    if (Number.isFinite(pos.tpPrice) && pos.tpPrice > 0) return pos.tpPrice;
    const entry = Number(pos.entryPrice);
    if (!Number.isFinite(entry) || entry <= 0) return 0;
    return pos.side === 'Long' ? entry * (1 + TP_PCT) : entry * (1 - TP_PCT);
  }

  // Paper Trading Engine + 6 Agents
  function calcPositionMetrics(pos, markPrice) {
    const priceDiff = pos.side === 'Long'
      ? (markPrice - pos.entryPrice)
      : (pos.entryPrice - markPrice);
    const pnlGross = priceDiff * pos.size;
    const roe = pos.margin > 0 ? (pnlGross / pos.margin) * 100 : 0;
    return { pnlGross, roe };
  }

  function getAccountEquity() {
    let marginUsed = 0;
    let unrealized = 0;
    state.positions.forEach(pos => {
      const m = market[pos.symbol];
      const mark = m ? m.price : pos.entryPrice;
      const { pnlGross } = calcPositionMetrics(pos, mark);
      marginUsed += pos.margin;
      unrealized += pnlGross;
    });
    return {
      equity: state.balance + marginUsed + unrealized,
      freeBalance: state.balance,
      marginUsed,
      unrealized
    };
  }

  function pushFeed(agent, text, badge, kind, ts = Date.now()) {
    state.feed.unshift({
      id: `${ts}-${Math.random().toString(36).slice(2, 6)}`,
      agent,
      time: fmtShortTime(ts),
      text,
      badge,
      kind
    });
    if (state.feed.length > 50) state.feed.length = 50;
  }

  function pushToast(source, title, subtitle, kind = 'info') {
    const icon = kind === 'win' ? '🚀' : (kind === 'stop' || kind === 'veto' ? '⚖️' : '🤖');
    const div = document.createElement('div');
    div.className = `toast-item ${kind}`;
    div.innerHTML = `
      <div class="toast-icon">${icon}</div>
      <div class="toast-body">
        <div class="toast-top"><span>GROK BOT · ${source}</span><span>now</span></div>
        <div class="toast-msg">${escapeHtml(title)}</div>
        <div class="toast-sub">${escapeHtml(subtitle)}</div>
      </div>
    `;
    el.toastStack.prepend(div);
    while (el.toastStack.children.length > 2) {
      el.toastStack.lastElementChild.remove();
    }
  }

  function showTradeClosedPopup(trade) {
    if (popupTimer) clearTimeout(popupTimer);
    const isWin = trade.pnl >= 0;
    el.tradePopup.className = `trade-popup ${isWin ? '' : 'loss'}`;
    el.tradePopup.innerHTML = `
      <div class="popup-top">
        <span class="popup-brand">🤖 Grok Bot · ${trade.symbol}-USD</span>
        <span class="popup-status">${trade.side} · ${posLeverage(trade)}x · Closed</span>
      </div>
      <div class="popup-main">
        <span class="popup-pair">ROI ${trade.roe >= 0 ? '+' : ''}${trade.roe.toFixed(1)}%</span>
        <span class="popup-pnl">${fmtUsd(trade.pnl, true)}</span>
      </div>
      <div class="popup-meta">
        <span>${trade.reason}</span>
        <span>Balance ${fmtUsd(trade.balanceAfter)}</span>
      </div>
    `;
    el.tradePopup.classList.remove('hidden');
    popupTimer = setTimeout(() => {
      el.tradePopup.classList.add('hidden');
    }, 4400);

    if (trade.pnl >= 2.5 || trade.roe >= 14) {
      launchConfetti();
    }
  }

  function setAgentCard(id, status, desc, badgeText) {
    const box = document.getElementById(`agent-${id}`);
    const descEl = document.getElementById(`desc-${id}`);
    const badgeEl = document.getElementById(`badge-${id}`);
    if (!box) return;
    box.classList.remove('approved', 'veto', 'scanning', 'skipped');
    if (status) box.classList.add(status);
    if (descEl) descEl.textContent = desc;
    if (badgeEl) badgeEl.textContent = badgeText;
  }

  function markLaterAgentsSkipped(vetoCardId) {
    const idx = VETO_AGENT_ORDER.indexOf(vetoCardId);
    if (idx < 0) return;
    VETO_AGENT_ORDER.slice(idx + 1).forEach(id => {
      setAgentCard(id, 'skipped', 'skipped / not consulted', '—');
    });
  }

  function monitorOpenPositions(nowTs) {
    const remaining = [];
    for (const pos of state.positions) {
      const m = market[pos.symbol];
      if (!m || !m.price) {
        remaining.push(pos);
        continue;
      }
      const mark = m.price;
      pos.ageTicks = (pos.ageTicks || 0) + 1;

      // Track peak price for trailing stop
      if (pos.side === 'Long') {
        pos.peakPrice = Math.max(pos.peakPrice || pos.entryPrice, mark);
      } else {
        pos.peakPrice = Math.min(pos.peakPrice || pos.entryPrice, mark);
      }

      const movePct = pos.side === 'Long'
        ? (mark - pos.entryPrice) / pos.entryPrice
        : (pos.entryPrice - mark) / pos.entryPrice;

      const peakMovePct = pos.side === 'Long'
        ? (pos.peakPrice - pos.entryPrice) / pos.entryPrice
        : (pos.entryPrice - pos.peakPrice) / pos.entryPrice;

      // Arm trailing stop once in profit >= +0.85%
      if (peakMovePct >= 0.0085) {
        const trailStop = pos.side === 'Long'
          ? pos.peakPrice * (1 - 0.0035)
          : pos.peakPrice * (1 + 0.0035);
        pos.stopPrice = pos.side === 'Long'
          ? Math.max(pos.stopPrice, trailStop)
          : Math.min(pos.stopPrice, trailStop);
      }

      const hitStop = pos.side === 'Long' ? mark <= pos.stopPrice : mark >= pos.stopPrice;
      const hitTp = movePct >= TP_PCT;
      const hitTimeExit = pos.ageTicks >= (mode === 'replay' ? 22 : 90) && Math.abs(movePct) > 0.001;

      if (hitStop || hitTp || hitTimeExit) {
        const { pnlGross } = calcPositionMetrics(pos, mark);
        const exitFee = pos.size * mark * TAKER_FEE;
        const netPnl = pnlGross - pos.entryFee - exitFee;
        const roe = (netPnl / pos.margin) * 100;

        state.balance = Math.max(1.0, state.balance + pos.margin + netPnl);
        state.lastClosedPnl = netPnl;

        const reason = hitTp
          ? 'COURT: TAKE PROFIT'
          : (hitStop && netPnl < 0 ? 'COURT: KILLED AT STOP' : (hitStop ? 'EXIT GUARD: TRAIL' : 'EXIT GUARD: TIME'));

        const closedTrade = {
          id: pos.id,
          time: fmtShortTime(nowTs),
          ts: nowTs,
          curveTime: nowTs,
          symbol: pos.symbol,
          side: pos.side,
          size: pos.size,
          entryPrice: pos.entryPrice,
          exitPrice: mark,
          pnl: netPnl,
          roe,
          margin: pos.margin,
          leverage: posLeverage(pos),
          balanceAfter: state.balance,
          reason
        };

        state.history.unshift(closedTrade);
        state.equityCurve.push({
          t: nowTs,
          v: state.balance,
          label: fmtShortTime(nowTs),
          tradeId: closedTrade.id
        });

        if (netPnl < 0) {
          state.vetoCounts.COURT += 1;
          pushFeed('COURT', `stop $${coinLabel(pos.symbol)} ${fmtUsd(netPnl, true)}`, 'STOP', 'stop', nowTs);
          pushToast('COURT', 'COURT: KILLED AT STOP', `#${state.history.length} ${coinLabel(pos.symbol)} ${pos.side.toLowerCase()} · ${fmtUsd(netPnl, true)} · stop`, 'stop');
          setAgentCard('court', 'veto', `killed $${coinLabel(pos.symbol)} at stop`, '✕');
        } else {
          pushFeed('Grok Bot', `closed $${coinLabel(pos.symbol)} ${pos.side} ${fmtUsd(netPnl, true)}`, fmtUsd(netPnl, true), 'win', nowTs);
          pushToast('TRADE CLOSED', `${coinLabel(pos.symbol)} ${pos.side} ${fmtUsd(netPnl, true)}`, `ROI +${roe.toFixed(1)}% · Balance ${fmtUsd(state.balance)}`, 'win');
          setAgentCard('court', 'approved', `closed $${coinLabel(pos.symbol)} +${roe.toFixed(1)}%`, '✓');
        }

        showTradeClosedPopup(closedTrade);
      } else {
        remaining.push(pos);
      }
    }
    state.positions = remaining;
  }

  function runSixAgentCycle(nowTs) {
    scanTick++;
    state.vetoCounts.GROK_SCANS += 1;

    // 1. Evaluate board breadth (NARRATIVE context)
    const activeCoins = COINS.map(c => market[c.symbol]).filter(m => m && !m.isDelisted && m.price > 0);
    if (activeCoins.length === 0) return;

    const greenCoins = activeCoins.filter(m => m.chg15m >= 0).length;
    const totalActive = activeCoins.length;
    const greenRatio = greenCoins / totalActive;

    // 2. GROK selects strongest momentum/setup candidate
    let best = null;
    for (const m of activeCoins) {
      // Score combines short-term momentum & candle thrust
      const dir = m.chg15m >= 0 ? 'Long' : 'Short';
      const rawStrength = Math.abs(m.chg15m) * 0.45 + Math.abs(m.chg24h) * 0.03 + (m.volRatio * 0.2);
      const score = Math.min(0.95, Math.max(0.35, 0.42 + rawStrength * 0.18));
      if (!best || score > best.score) {
        best = { m, dir, score };
      }
    }
    if (!best) return;

    state.grokSignal = best.score;
    el.signalVal.textContent = best.score.toFixed(2);
    el.signalBarFill.style.width = `${Math.round(best.score * 100)}%`;

    const cand = best.m;
    const dir = best.dir;

    // Skip new entries if already at max positions or holding this symbol
    const alreadyHolding = state.positions.some(p => p.symbol === cand.symbol);
    const { equity } = getAccountEquity();

    // Update GROK hub visual
    el.grokHub.classList.remove('active', 'veto');
    el.grokActionText.classList.remove('veto', 'scanning');

    if (state.positions.length >= MAX_POSITIONS) {
      setAgentCard('risk', 'approved', `${LEVERAGE}x · ${state.positions.length}/${MAX_POSITIONS} open · stop 1.5%`, '✓');
      setAgentCard('narrative', 'approved', `${greenCoins}/${totalActive} green · ${state.positions.length} active`, '✓');
      el.grokHub.classList.add('active');
      el.grokActionText.textContent = `${state.positions.length} open · ${LEVERAGE}x`;
      return;
    }

    // Only attempt an entry when signal >= 0.56 (or every 2nd tick in replay)
    const entryThreshold = mode === 'replay' ? 0.50 : 0.56;
    if (best.score < entryThreshold) {
      el.grokActionText.classList.add('scanning');
      el.grokActionText.textContent = 'scanning';
      setAgentCard('sniper', 'scanning', 'watching entry windows', '•');
      setAgentCard('liquidity', 'approved', `board vol ${el.volumeMult.textContent} · ok`, '✓');
      setAgentCard('narrative', 'approved', `${greenCoins}/${totalActive} green · scanning`, '✓');
      setAgentCard('court', 'approved', 'stop 1.5% · R:R ready', '✓');
      setAgentCard('risk', 'approved', `${LEVERAGE}x · ${state.positions.length}/3 open · stop 1.5%`, '✓');
      return;
    }

    // === 5 VETO AGENTS CHECK THE PROPOSED TRADE ===
    // Any single veto kills the trade ("ONE VETO KILLS")
    let killedBy = null;

    // Agent 2: SNIPER (Anti-Chase: veto if coin already pumped/dumped > 1.9% in 15m)
    if (Math.abs(cand.chg15m) > 1.9) {
      state.vetoCounts.SNIPER += 1;
      killedBy = { agent: 'SNIPER', card: 'sniper', reason: `fresh ${cand.chg15m >= 0 ? 'pump' : 'dump'} (${cand.chg15m.toFixed(2)}%)` };
      setAgentCard('sniper', 'veto', `VETO · ${cand.symbol} ${cand.chg15m.toFixed(2)}%`, '✕');
    } else {
      setAgentCard('sniper', 'approved', 'no fresh pump · clear', '✓');
    }

    // Agent 3: LIQUIDITY (Volume & book filter)
    if (!killedBy && (cand.isDelisted || cand.dayNtlVlm < 100000 || cand.volRatio < 0.42)) {
      state.vetoCounts.LIQUIDITY += 1;
      killedBy = { agent: 'LIQUIDITY', card: 'liquidity', reason: `vol ${cand.volRatio.toFixed(1)}x < 0.42x avg` };
      setAgentCard('liquidity', 'veto', `VOLUME ${cand.volRatio.toFixed(1)}x · nobody here`, '✕');
    } else if (!killedBy) {
      setAgentCard('liquidity', 'approved', `volume ${cand.volRatio.toFixed(1)}x of avg · ok`, '✓');
    }

    // Agent 4: NARRATIVE (Board breadth alignment)
    const opposesBullSweep = dir === 'Short' && greenRatio >= 0.72;
    const opposesBearSweep = dir === 'Long' && greenRatio <= 0.28;
    if (!killedBy && (opposesBullSweep || opposesBearSweep)) {
      state.vetoCounts.NARRATIVE += 1;
      killedBy = { agent: 'NARRATIVE', card: 'narrative', reason: `${cand.symbol} alone vs ${greenCoins}/${totalActive} board` };
      setAgentCard('narrative', 'veto', `VETO · alone vs board`, '✕');
    } else if (!killedBy) {
      setAgentCard('narrative', 'approved', `${greenCoins}/${totalActive} green · ${cand.symbol} cleanest`, '✓');
    }

    // Agent 5: COURT (Volatility vs 1.5% stop viability)
    let recentRangePct = 0.4;
    if (cand.candles && cand.candles.length >= 2) {
      const lastC = cand.candles[cand.candles.length - 1];
      const h = parseFloat(lastC.h), l = parseFloat(lastC.l);
      if (l > 0) recentRangePct = ((h - l) / l) * 100;
    }
    if (!killedBy && recentRangePct > 1.85) {
      state.vetoCounts.COURT += 1;
      killedBy = { agent: 'COURT', card: 'court', reason: `wick ${recentRangePct.toFixed(2)}% > stop 1.5%` };
      setAgentCard('court', 'veto', `VETO · stop 1.5% too tight`, '✕');
    } else if (!killedBy) {
      setAgentCard('court', 'approved', 'dies at stop 1.5% → OK', '✓');
    }

    // Agent 6: RISK (Treasury, max exposure & duplicate check)
    const marginAlloc = Math.min(state.balance * 0.85, equity * 0.31);
    if (!killedBy && (alreadyHolding || marginAlloc < 5)) {
      state.vetoCounts.RISK += 1;
      killedBy = { agent: 'RISK', card: 'risk', reason: alreadyHolding ? `${cand.symbol} déjà ouvert` : 'marge insuffisante' };
      setAgentCard('risk', 'veto', `VETO · ${alreadyHolding ? 'déjà en cours' : 'low margin'}`, '✕');
    } else if (!killedBy) {
      setAgentCard('risk', 'approved', `${LEVERAGE}x · ${state.positions.length + 1}/3 open · stop 1.5%`, '✓');
    }

    if (killedBy) {
      markLaterAgentsSkipped(killedBy.card);
      el.grokHub.classList.add('veto');
      el.grokActionText.classList.add('veto');
      el.grokActionText.textContent = `${killedBy.agent}: VETO`;
      if (scanTick % 2 === 0 || mode === 'replay') {
        pushFeed(killedBy.agent, `VETO $${cand.symbol} ${dir} (${killedBy.reason})`, 'VETO', 'veto', nowTs);
      }
      return;
    }

    // === ALL 6 AGENTS APPROVED -> OPEN 10x PAPER POSITION ===
    const notional = marginAlloc * LEVERAGE;
    const size = notional / cand.price;
    const entryFee = notional * TAKER_FEE;
    const stopPrice = dir === 'Long'
      ? cand.price * (1 - STOP_PCT)
      : cand.price * (1 + STOP_PCT);
    const tpPrice = dir === 'Long'
      ? cand.price * (1 + TP_PCT)
      : cand.price * (1 - TP_PCT);

    state.balance -= marginAlloc;
    const newPos = {
      id: `${nowTs}-${cand.symbol}`,
      symbol: cand.symbol,
      side: dir,
      size,
      entryPrice: cand.price,
      peakPrice: cand.price,
      stopPrice,
      tpPrice,
      leverage: LEVERAGE,
      margin: marginAlloc,
      entryFee,
      openedAt: nowTs,
      ageTicks: 0
    };
    state.positions.push(newPos);

    el.grokHub.classList.add('active');
    el.grokActionText.textContent = `${state.positions.length} ${dir.toLowerCase()}s · ${LEVERAGE}x`;
    pushFeed('Grok Bot', `${dir === 'Long' ? 'L' : 'S'} $${coinLabel(cand.symbol)} @ $${fmtPrice(cand.price)} · ${LEVERAGE}x`, 'OPEN', 'open', nowTs);
    pushToast('OPEN', `${dir.toUpperCase()} $${coinLabel(cand.symbol)} · ${LEVERAGE}x`, `Entry $${fmtPrice(cand.price)} · Margin ${fmtUsd(marginAlloc)} · Stop 1.5%`, 'info');
  }

  // Rendering
  function renderAll() {
    const { equity, marginUsed, unrealized } = getAccountEquity();

    // Hero Balance
    const whole = Math.floor(Math.max(0, equity));
    const cents = (Math.max(0, equity) - whole).toFixed(2).slice(1); // ".xx"
    el.heroBalance.className = `hero-balance ${equity >= INITIAL_BALANCE ? 'positive' : 'negative'}`;
    el.heroBalance.innerHTML = `$${whole.toLocaleString('en-US')}<span class="cents">${cents}</span>`;
    el.chartBalancePill.textContent = fmtUsd(equity);

    // Last PnL Pill
    if (state.lastClosedPnl !== null) {
      el.lastPnlPill.textContent = fmtUsd(state.lastClosedPnl, true);
      el.lastPnlPill.className = `delta-pill ${state.lastClosedPnl >= 0 ? 'positive' : 'negative'}`;
    } else {
      el.lastPnlPill.textContent = '+$0.00';
      el.lastPnlPill.className = 'delta-pill neutral';
    }

    // Multiplier & Trades Summary
    const mult = equity / INITIAL_BALANCE;
    const greens = state.history.filter(t => t.pnl >= 0).length;
    const reds = state.history.filter(t => t.pnl < 0).length;
    el.multBadge.textContent = `${mult.toFixed(2)}×`;
    el.tradesSummary.textContent = `${state.history.length} trades · ${greens} green · ${reds} red`;

    // Summary Strip
    el.sumEquity.textContent = fmtUsd(equity);
    el.sumUpnl.textContent = fmtUsd(unrealized, true);
    el.sumUpnl.className = `s-val ${unrealized >= 0 ? 'positive' : 'negative'}`;
    el.sumMargin.textContent = fmtUsd(marginUsed);

    // Tabs counts
    el.countPositions.textContent = String(state.positions.length);
    el.countHistory.textContent = String(state.history.length);

    renderPositionsTable();
    renderHistoryTable();
    renderChart(equity);
    renderBoard();
    renderFeed();
    renderVetoTracking();
  }

  function renderPositionsTable() {
    if (state.positions.length === 0) {
      el.positionsTbody.innerHTML = `<tr class="empty-row"><td colspan="9">Aucune position ouverte — les 6 agents analysent Hyperliquid…</td></tr>`;
      return;
    }
    el.positionsTbody.innerHTML = state.positions.map(pos => {
      const m = market[pos.symbol];
      const mark = m ? m.price : pos.entryPrice;
      const { pnlGross, roe } = calcPositionMetrics(pos, mark);
      const netEst = pnlGross - pos.entryFee;
      const netRoe = (netEst / pos.margin) * 100;
      const coinMeta = COIN_MAP[pos.symbol] || { color: '#8b5cf6', short: pos.symbol.slice(0, 3) };
      const cls = netEst >= 0 ? 'pnl-pos' : 'pnl-neg';
      const tpPx = takeProfitPrice(pos);
      return `
        <tr>
          <td>
            <span class="coin-cell">
              <span class="coin-mini-dot" style="background:${coinMeta.color}">${coinMeta.short}</span>
              ${coinLabel(pos.symbol)}
              <span class="lev-tag">${posLeverage(pos)}x</span>
            </span>
          </td>
          <td><span class="side-pill ${pos.side.toLowerCase()}">${pos.side}</span></td>
          <td>${fmtSize(pos.size)} ${coinLabel(pos.symbol)}</td>
          <td>${fmtPrice(pos.entryPrice)}</td>
          <td>${fmtPrice(mark)}</td>
          <td class="${cls}">${fmtUsd(netEst, true)} (${netRoe >= 0 ? '+' : ''}${netRoe.toFixed(1)}%)</td>
          <td class="stop-cell">${fmtPrice(pos.stopPrice)}</td>
          <td class="tp-cell">${fmtPrice(tpPx)}</td>
          <td class="right">${fmtUsd(pos.margin)}</td>
        </tr>
      `;
    }).join('');
  }

  function renderHistoryTable() {
    if (state.history.length === 0) {
      el.historyTbody.innerHTML = `<tr class="empty-row"><td colspan="9">Aucun trade clôturé pour l'instant</td></tr>`;
      return;
    }
    el.historyTbody.innerHTML = state.history.slice(0, 40).map(tr => {
      const coinMeta = COIN_MAP[tr.symbol] || { color: '#8b5cf6', short: tr.symbol.slice(0, 3) };
      const cls = tr.pnl >= 0 ? 'pnl-pos' : 'pnl-neg';
      return `
        <tr>
          <td>${tr.time}</td>
          <td>
            <span class="coin-cell">
              <span class="coin-mini-dot" style="background:${coinMeta.color}">${coinMeta.short}</span>
              ${coinLabel(tr.symbol)}
            </span>
          </td>
          <td><span class="side-pill ${tr.side.toLowerCase()}">${tr.side}</span></td>
          <td>${fmtSize(tr.size)}</td>
          <td>${fmtPrice(tr.entryPrice)}</td>
          <td>${fmtPrice(tr.exitPrice)}</td>
          <td class="${cls}">${fmtUsd(tr.pnl, true)} (${tr.roe >= 0 ? '+' : ''}${tr.roe.toFixed(1)}%)</td>
          <td>${fmtUsd(tr.margin)}</td>
          <td class="right">${fmtUsd(tr.balanceAfter)}</td>
        </tr>
      `;
    }).join('');
  }

  function renderChart(currentEquity) {
    const pts = [...state.equityCurve];
    if (pts.length === 0) return;
    // Update tail point with live equity
    pts[pts.length - 1] = { ...pts[pts.length - 1], v: currentEquity };

    const W = 920;
    const H = 220;
    const padL = 22;
    const padR = 72;
    const padT = 22;
    const padB = 30;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const vals = pts.map(p => p.v);
    let minV = Math.min(...vals, INITIAL_BALANCE * 0.96);
    let maxV = Math.max(...vals, INITIAL_BALANCE * 1.04);
    if (maxV - minV < 12) {
      minV -= 6;
      maxV += 6;
    }
    const span = maxV - minV;

    const coords = pts.map((p, i) => {
      const x = padL + (pts.length === 1 ? plotW : (i / (pts.length - 1)) * plotW);
      const y = padT + (1 - (p.v - minV) / span) * plotH;
      return { x, y, pt: p };
    });

    // Smooth curve path
    let lineD = `M ${coords[0].x.toFixed(1)} ${coords[0].y.toFixed(1)}`;
    for (let i = 1; i < coords.length; i++) {
      const prev = coords[i - 1];
      const curr = coords[i];
      const cx = ((prev.x + curr.x) / 2).toFixed(1);
      lineD += ` C ${cx} ${prev.y.toFixed(1)}, ${cx} ${curr.y.toFixed(1)}, ${curr.x.toFixed(1)} ${curr.y.toFixed(1)}`;
    }
    const areaD = `${lineD} L ${coords[coords.length - 1].x.toFixed(1)} ${(padT + plotH).toFixed(1)} L ${coords[0].x.toFixed(1)} ${(padT + plotH).toFixed(1)} Z`;

    // Y gridlines (4 levels)
    const gridLevels = [0, 0.33, 0.66, 1].map(f => {
      const val = minV + span * f;
      const y = padT + (1 - f) * plotH;
      return { val, y };
    });

    const last = coords[coords.length - 1];

    el.equitySvg.innerHTML = `
      <defs>
        <linearGradient id="lineGrad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#8b5cf6" />
          <stop offset="50%" stop-color="#38bdf8" />
          <stop offset="100%" stop-color="#34d399" />
        </linearGradient>
        <linearGradient id="areaGrad" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="rgba(56, 189, 248, 0.34)" />
          <stop offset="60%" stop-color="rgba(139, 92, 246, 0.14)" />
          <stop offset="100%" stop-color="rgba(139, 92, 246, 0.0)" />
        </linearGradient>
        <filter id="glowLine">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      ${gridLevels.map(g => `
        <line x1="${padL}" y1="${g.y.toFixed(1)}" x2="${W - padR}" y2="${g.y.toFixed(1)}" stroke="rgba(148,163,184,0.12)" stroke-dasharray="4 5" />
        <text x="${W - padR + 8}" y="${(g.y + 4).toFixed(1)}" fill="#8e88b5" font-size="11" font-family="JetBrains Mono, monospace">$${Math.round(g.val)}</text>
      `).join('')}

      <path d="${areaD}" fill="url(#areaGrad)" />
      <path d="${lineD}" fill="none" stroke="url(#lineGrad)" stroke-width="3" stroke-linecap="round" filter="url(#glowLine)" />

      <line x1="${last.x.toFixed(1)}" y1="${padT}" x2="${last.x.toFixed(1)}" y2="${padT + plotH}" stroke="rgba(167,139,250,0.3)" stroke-dasharray="3 4" />
      <circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="9" fill="rgba(52, 211, 153, 0.28)" />
      <circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="4.5" fill="#ffffff" stroke="#34d399" stroke-width="2.5" />

      <text x="${padL}" y="${H - 8}" fill="#7f79a8" font-size="11" font-family="JetBrains Mono, monospace">${pts[0].label || ''}</text>
      <text x="${Math.round(padL + plotW * 0.5)}" y="${H - 8}" fill="#7f79a8" font-size="11" font-family="JetBrains Mono, monospace">${pts[Math.floor(pts.length / 2)].label || ''}</text>
      <text x="${last.x.toFixed(1)}" y="${H - 8}" text-anchor="middle" fill="#a5b4fc" font-size="11" font-family="JetBrains Mono, monospace">now</text>
    `;

    // Render Trade Bubbles along curve
    const tradeByTime = Object.fromEntries(state.history.map(h => [h.id, h]));
    el.bubblesLayer.innerHTML = '';
    const placed = [];

    coords.forEach(c => {
      if (!c.pt.tradeId) return;
      const tr = tradeByTime[c.pt.tradeId];
      if (!tr) return;
      const xPct = (c.x / W) * 100;
      const yPct = (c.y / H) * 100;

      // Avoid heavy overlap on bubbles
      const tooClose = placed.find(p => Math.abs(p.xPct - xPct) < 2.1 && Math.abs(p.yPct - yPct) < 6);
      if (tooClose) return;
      placed.push({ xPct, yPct });

      const coinMeta = COIN_MAP[tr.symbol] || { short: tr.symbol.slice(0, 3), color: '#8b5cf6' };
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `trade-bubble ${tr.pnl >= 0 ? 'win' : 'loss'}`;
      b.style.left = `${xPct}%`;
      b.style.top = `${yPct}%`;
      b.style.backgroundColor = coinMeta.color;
      b.textContent = coinMeta.short.slice(0, 2);
      b.title = `${fmtUsd(tr.pnl, true)} ${posLeverage(tr)}x ${tr.symbol}`;

      const showTip = () => {
        el.chartTooltip.innerHTML = `<strong>${fmtUsd(tr.pnl, true)}</strong> · ${posLeverage(tr)}x · ${tr.symbol} ${tr.side} (${tr.roe >= 0 ? '+' : ''}${tr.roe.toFixed(1)}%)`;
        el.chartTooltip.style.left = `${Math.min(72, Math.max(8, xPct))}%`;
        el.chartTooltip.style.top = `${Math.max(8, yPct - 18)}%`;
        el.chartTooltip.classList.remove('hidden');
      };
      const hideTip = () => el.chartTooltip.classList.add('hidden');

      b.addEventListener('mouseenter', showTip);
      b.addEventListener('mouseleave', hideTip);
      b.addEventListener('click', showTip);

      el.bubblesLayer.appendChild(b);
    });
  }

  function renderBoard() {
    el.boardTf.textContent = mode === 'replay' ? 'Replay 1m' : 'Hyperliquid Live';
    el.boardGrid.innerHTML = COINS.map(c => {
      const m = market[c.symbol];
      const px = m ? m.price : 0;
      const chg = m ? m.chg15m : 0;
      const isUp = chg >= 0;
      const delisted = m?.isDelisted;
      return `
        <div class="board-tile ${isUp ? 'up' : 'down'} ${delisted ? 'delisted' : ''}" title="${c.symbol} · 24h: ${m ? m.chg24h.toFixed(2) : '0.00'}% · Vol 24h: ${m ? fmtUsd(m.dayNtlVlm) : '$0'}">
          <div class="tile-left">
            <span class="coin-mini-dot" style="background:${c.color}">${c.short}</span>
            <div class="tile-info">
              <div class="tile-sym">
                <span>${c.label}</span>
                ${delisted ? '<span class="tile-delist">DELIST</span>' : ''}
              </div>
              <div class="tile-price">$${fmtPrice(px)}</div>
            </div>
          </div>
          <div class="tile-chg ${isUp ? 'up' : 'down'}">${isUp ? '+' : ''}${chg.toFixed(2)}%</div>
        </div>
      `;
    }).join('');
  }

  function renderFeed() {
    el.feedList.innerHTML = state.feed.slice(0, 18).map(item => `
      <div class="feed-item">
        <div>
          <div class="feed-head">${escapeHtml(item.agent)}<span class="feed-time">${item.time}</span></div>
          <div class="feed-msg">${escapeHtml(item.text)}</div>
        </div>
        <span class="feed-badge ${item.kind}">${escapeHtml(item.badge)}</span>
      </div>
    `).join('');
  }

  function renderVetoTracking() {
    const rows = [
      { key: 'SNIPER', cls: 'sniper', rule: 'first 15m of a fresh pump', val: state.vetoCounts.SNIPER, unit: 'vetoes' },
      { key: 'LIQUIDITY', cls: 'liquidity', rule: 'vol < 0.42x avg or delisted', val: state.vetoCounts.LIQUIDITY, unit: 'vetoes' },
      { key: 'NARRATIVE', cls: 'narrative', rule: 'no lone wolf vs board', val: state.vetoCounts.NARRATIVE, unit: 'vetoes' },
      { key: 'COURT', cls: 'court', rule: 'kills at 1.5% stop / noisy wick', val: state.vetoCounts.COURT, unit: 'stops/vetoes' },
      { key: 'RISK', cls: 'risk', rule: `${LEVERAGE}x · max 3 open · stop 1.5%`, val: state.vetoCounts.RISK, unit: 'vetoes' },
      { key: 'GROK', cls: 'grok', rule: `${COINS.length} perps real-time scans`, val: state.vetoCounts.GROK_SCANS, unit: 'scans', neutral: true }
    ];
    el.vetoList.innerHTML = rows.map(r => `
      <div class="veto-row">
        <div>
          <div class="veto-agent-name ${r.cls}">${r.key}</div>
          <div class="veto-agent-rule">${r.rule}</div>
        </div>
        <div class="veto-count-box">
          <div class="veto-count-num ${!r.neutral && r.val > 0 ? 'nonzero' : ''}">${r.val}</div>
          <div class="veto-count-lbl">${r.unit}</div>
        </div>
      </div>
    `).join('');
  }

  // Confetti burst
  function launchConfetti() {
    const canvas = el.confettiCanvas;
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const colors = ['#34d399', '#60a5fa', '#a78bfa', '#f472b6', '#facc15'];
    const particles = Array.from({ length: 75 }, () => ({
      x: canvas.width * (0.25 + Math.random() * 0.5),
      y: canvas.height * 0.18,
      vx: (Math.random() - 0.5) * 11,
      vy: -Math.random() * 8 - 2,
      size: Math.random() * 6 + 4,
      color: colors[Math.floor(Math.random() * colors.length)],
      rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 0.25,
      life: 1
    }));

    let animId;
    function step() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      let alive = 0;
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.32;
        p.rot += p.vr;
        p.life -= 0.014;
        if (p.life <= 0) continue;
        alive++;
        ctx.save();
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx.restore();
      }
      if (alive > 0) animId = requestAnimationFrame(step);
      else ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    if (animId) cancelAnimationFrame(animId);
    requestAnimationFrame(step);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  // Live & Replay Loops
  async function liveTick() {
    if (mode !== 'live') return;
    try {
      await fetchMarketSnapshot();
      // Fire-and-forget 60s candle refresh so COURT uses current 5m candles
      // without blocking the 4s live poll.
      refreshLiveCandles();
      const now = Date.now();
      monitorOpenPositions(now);
      runSixAgentCycle(now);

      // Append curve point periodically so live chart progresses smoothly
      const lastPt = state.equityCurve[state.equityCurve.length - 1];
      if (!lastPt || now - lastPt.t >= 20000) {
        state.equityCurve.push({ t: now, v: getAccountEquity().equity, label: fmtShortTime(now) });
      }
      saveState();
      renderAll();
    } catch (err) {
      setHlStatus(false, 'Reconnecting…');
      console.warn('Hyperliquid poll error:', err);
    }
  }

  function startLiveMode() {
    const comingFromReplay = mode === 'replay';
    if (comingFromReplay) {
      saveState(); // write replay snapshot to the replay key only
    }
    stopTimers();
    mode = 'live';
    if (comingFromReplay) {
      state = loadState('live');
      sanitizeLegacyPositions();
      restoreLiveMarket();
    }
    el.btnLive.classList.add('active');
    el.btnReplay.classList.remove('active');
    el.btnReplay.textContent = '▶ Replay 45m';
    el.chartModeLabel.textContent = 'Replay on real prices: paper money · Live Hyperliquid';
    liveTick();
    liveTimer = setInterval(liveTick, POLL_MS);
    if (comingFromReplay) refreshLiveCandles({ force: true });
  }

  async function startReplayMode() {
    // Persist the live account first, then leave it untouched for the whole replay.
    if (mode === 'live') {
      saveState();
      backupLiveMarket();
    }
    stopTimers();
    el.btnReplay.classList.add('active');
    el.btnLive.classList.remove('active');
    el.btnReplay.textContent = '⏳ Chargement…';
    el.chartModeLabel.textContent = 'Replay on real prices: paper money · 45m real 1m candles';

    try {
      if (Object.keys(market).length === 0) await fetchMarketSnapshot();
      const endTime = Date.now();
      const startTime = endTime - 55 * 60 * 1000;
      const activeSymbols = COINS.filter(c => !market[c.symbol]?.isDelisted).map(c => c.symbol);

      const allSeries = {};
      await Promise.all(
        activeSymbols.map(async sym => {
          const candles = await hlPost({
            type: 'candleSnapshot',
            req: { coin: sym, interval: '1m', startTime, endTime }
          });
          if (Array.isArray(candles)) allSeries[sym] = candles;
        })
      );

      // Align timestamps across series
      const baseSym = activeSymbols.find(s => (allSeries[s] || []).length > 10);
      if (!baseSym) throw new Error('No candles returned');

      const baseCandles = allSeries[baseSym];
      replayFrames = baseCandles.map((bc, idx) => {
        const prices = {};
        activeSymbols.forEach(sym => {
          const arr = allSeries[sym] || [];
          const c = arr[Math.min(idx, arr.length - 1)];
          if (c) prices[sym] = c;
        });
        return { ts: bc.t, prices };
      });

      // Switch to a fresh $135 replay session (separate key / never touches live state)
      mode = 'replay';
      state = defaultState();
      const t0 = replayFrames[0]?.ts || Date.now();
      state.equityCurve = [{ t: t0, v: INITIAL_BALANCE, label: fmtShortTime(t0) }];
      state.feed = [{
        id: 'rep-start',
        agent: 'Grok Bot',
        time: fmtShortTime(t0),
        text: `Démarrage Replay sur ${replayFrames.length} vraies bougies 1m Hyperliquid ($135.00 fictifs)`,
        badge: 'REPLAY',
        kind: 'open'
      }];
      replayIdx = 0;
      el.btnReplay.textContent = '▶ Replay 45m';
      setHlStatus(true, 'Replay · 1m Candles');
      saveState();
      renderAll();

      replayTimer = setInterval(() => {
        if (replayIdx >= replayFrames.length) {
          stopTimers();
          pushFeed('Grok Bot', 'Fin du Replay 45m — retour au Live dans 3s', 'DONE', 'win');
          saveState();
          renderAll();
          replayReturnTimer = setTimeout(() => {
            replayReturnTimer = null;
            startLiveMode();
          }, 3000);
          return;
        }
        const frame = replayFrames[replayIdx++];
        Object.entries(frame.prices).forEach(([sym, candle]) => {
          if (!market[sym]) return;
          const closePx = parseFloat(candle.c);
          const openPx = parseFloat(candle.o);
          market[sym].price = closePx;
          market[sym].candles = [...(market[sym].candles || []).slice(-29), candle];
          const lookback = market[sym].candles[Math.max(0, market[sym].candles.length - 8)];
          const refPx = lookback ? parseFloat(lookback.o) : openPx;
          market[sym].chg15m = refPx > 0 ? ((closePx - refPx) / refPx) * 100 : 0;
          const vols = market[sym].candles.map(k => parseFloat(k.v || '0'));
          const avgV = vols.reduce((a, b) => a + b, 0) / Math.max(1, vols.length);
          market[sym].volRatio = avgV > 0 ? Math.min(3.5, Math.max(0.25, parseFloat(candle.v || '0') / avgV)) : 1.0;
        });

        monitorOpenPositions(frame.ts);
        runSixAgentCycle(frame.ts);
        state.equityCurve.push({ t: frame.ts, v: getAccountEquity().equity, label: fmtShortTime(frame.ts) });
        saveState();
        renderAll();
      }, REPLAY_STEP_MS);
    } catch (err) {
      console.error('Replay init error:', err);
      el.btnReplay.textContent = '▶ Replay 45m';
      startLiveMode();
    }
  }

  function stopTimers() {
    if (liveTimer) clearInterval(liveTimer);
    if (replayTimer) clearInterval(replayTimer);
    if (replayReturnTimer) clearTimeout(replayReturnTimer);
    liveTimer = null;
    replayTimer = null;
    replayReturnTimer = null;
  }

  // Tabs & UI Event Handlers
  el.tabPositions.addEventListener('click', () => {
    activeTab = 'positions';
    el.tabPositions.classList.add('active');
    el.tabHistory.classList.remove('active');
    el.positionsTable.classList.remove('hidden');
    el.historyTable.classList.add('hidden');
  });

  el.tabHistory.addEventListener('click', () => {
    activeTab = 'history';
    el.tabHistory.classList.add('active');
    el.tabPositions.classList.remove('active');
    el.historyTable.classList.remove('hidden');
    el.positionsTable.classList.add('hidden');
  });

  el.btnLive.addEventListener('click', () => startLiveMode());
  el.btnReplay.addEventListener('click', () => startReplayMode());

  el.btnReset.addEventListener('click', () => {
    const isReplay = mode === 'replay';
    const label = isReplay ? 'la simulation Replay' : 'le compte Live';
    const other = isReplay ? 'le compte Live' : 'le Replay';
    if (!confirm(`Réinitialiser ${label} à $135.00 ? Cette action n'affecte pas ${other}.`)) return;
    state = defaultState();
    saveState(); // writes only the current mode's storage key
    renderAll();
  });

  // PWA Install Prompt & Service Worker
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    el.btnInstall.classList.remove('hidden');
  });

  el.btnInstall.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    el.btnInstall.classList.add('hidden');
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }

  // Boot
  (async function init() {
    sanitizeLegacyPositions();
    const boardTitle = document.querySelector('.board-card .panel-title');
    if (boardTitle) boardTitle.textContent = `BOARD · ${COINS.length} PERPS`;
    const chromeTitle = document.querySelector('.chrome-title');
    if (chromeTitle) chromeTitle.textContent = `grok — trading-desk — 6 agents — ${COINS.length} perps`;
    renderAll();
    try {
      await fetchMarketSnapshot();
      await preloadCandles('5m', 120);
      lastCandleRefreshAt = Date.now();
      renderAll();
    } catch (e) {
      console.warn('Initial Hyperliquid fetch warning:', e);
    }
    startLiveMode();
  })();
})();
