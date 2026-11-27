# Grok Bot Trading Desk (Simulation / Paper Money)

Simulation de tableau de bord trading perpétuel 10x sur prix réels Hyperliquid (`api.hyperliquid.xyz`), inspirée de la vidéo `@x_cha1n`.

> ⚠️ **Simulation uniquement (`Replay on real prices: paper money`)** — Aucun ordre réel, aucune clé API, aucun wallet connecté. Solde fictif initial : **$135.00 USDC**.

## Fonctionnalités
- **Prix réels Hyperliquid** (`BTC`, `ETH`, `SOL`, `HYPE`, `ZEC`, `UNI`, `DOGE`, `xyz:NVDA`, `PUMP`, `XRP`, `NEAR`, `XMR`) via `POST https://api.hyperliquid.xyz/info`. NVDA est le perp HIP-3 `xyz:NVDA`.
- **6 Agents IA (`ONE VETO KILLS`)** : `GROK`, `SNIPER`, `LIQUIDITY`, `NARRATIVE`, `COURT`, `RISK`.
- **Courbe d'équité SVG** avec bulles de trades clôturés interactives et popups + confettis sur les gros gains.
- **Mode Live Réel** (polling 4s) & **Mode Replay 45m** (relecture accélérée de vraies bougies 1m Hyperliquid).
- **PWA installable** (`manifest.json`, `sw.js`, icônes).

## Serveur 24/7 (Cloudflare Workers, plan gratuit)

Le bot tourne aussi quand l'appli est fermée : `worker/` contient un Cloudflare Worker
(`grok-trading-desk-bot`) avec un Cron Trigger chaque minute et un Durable Object SQLite
qui garde le compte fictif. Même moteur que `app.js` (10x, stop 1.5%, trailing 1% activé à +1.8%,
6 agents, max 3 positions), sorties vérifiées sur les bougies 1m depuis le dernier passage.

- API : `GET /api/state`, `POST /api/seed` (une seule fois, compte vierge), `POST /api/reset` (`{"confirm":true}`)
- URL : https://grok-trading-desk-bot.alpha-078.workers.dev
- En mode Live, l'appli affiche l'état du serveur (toutes les ~8 s). Si le serveur est injoignable
  ou en retard (>5 min), elle repasse sur le moteur local de secours sans rien écrire sur le serveur.
- Déploiement : `cd worker && npm install && npx wrangler deploy` ; tests : `npm test`.

Argent fictif uniquement, prix réels Hyperliquid. Aucun ordre réel, aucun wallet.
