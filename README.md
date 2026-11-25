# Grok Bot Trading Desk (Simulation / Paper Money)

Simulation de tableau de bord trading perpétuel 10x sur prix réels Hyperliquid (`api.hyperliquid.xyz`), inspirée de la vidéo `@x_cha1n`.

> ⚠️ **Simulation uniquement (`Replay on real prices: paper money`)** — Aucun ordre réel, aucune clé API, aucun wallet connecté. Solde fictif initial : **$135.00 USDC**.

## Fonctionnalités
- **Prix réels Hyperliquid** (`BTC`, `ETH`, `SOL`, `HYPE`, `ZEC`, `UNI`, `DOGE`, `xyz:NVDA`, `PUMP`, `XRP`, `NEAR`, `XMR`) via `POST https://api.hyperliquid.xyz/info`. NVDA est le perp HIP-3 `xyz:NVDA`.
- **6 Agents IA (`ONE VETO KILLS`)** : `GROK`, `SNIPER`, `LIQUIDITY`, `NARRATIVE`, `COURT`, `RISK`.
- **Courbe d'équité SVG** avec bulles de trades clôturés interactives et popups + confettis sur les gros gains.
- **Mode Live Réel** (polling 4s) & **Mode Replay 45m** (relecture accélérée de vraies bougies 1m Hyperliquid).
- **PWA installable** (`manifest.json`, `sw.js`, icônes).
