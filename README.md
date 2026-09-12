# QuantCore Terminal

Real-time trading dashboard and automated bot for **Deriv synthetic (volatility) indices** — live charts, one-click manual trading, and a fully configurable signal-driven bot with a virtual-trade filter and martingale stake progression.

Vanilla-JS frontend, Node/Express backend, Supabase PostgreSQL ledger. Runs in **demo mode with zero keys required**.

---

## Table of Contents

- [Features](#features)
- [Screens](#screens)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
  - [Environment Variables](#environment-variables)
  - [Bot Settings](#bot-settings)
  - [Martingale Stake Progression](#martingale-stake-progression)
- [How the Bot Works](#how-the-bot-works)
- [API Reference](#api-reference)
- [Project Structure](#project-structure)
- [Testing](#testing)
- [Changelog](#changelog)

---

## Features

- **Live market data** — Deriv volatility indices streamed over WebSocket, proxied to the browser via throttled Server-Sent Events.
- **Manual trading** — one-click up/down trades with your own stake; never touches bot state or the martingale ladder.
- **Signal-driven bot** — RSI oversold/overbought + sniper-zone breakout confluence, with a **virtual filter**: the bot first paper-trades a signal and only goes live after a configurable loss-streak threshold is met.
- **Martingale progression** — optional, OFF by default; custom multiplier, max steps, bot trades only.
- **Risk controls** — Take Profit, Stop Loss, Max Runs, cooldown between trades. The bot refuses to start without TP/SL/Max Runs set.
- **Persistent ledger** — every settled trade (manual, virtual, and real) is stored; aggregated analytics include strike rate, profit factor, max drawdown, streaks, and per-asset breakdowns.
- **Demo mode** — no credentials? `npm start` boots a realistic simulated feed (mean-reverting random walk with volatility impulses) and an in-memory ledger so the whole loop works out of the box.

## Screens

| Tab | What's there |
|---|---|
| **Home** | Live tick chart, active signal, bot card with status and next stake |
| **Markets** | Price feeds for all tracked indices |
| **Manual** | One-click manual trading panel |
| **Bots** | Bot lifecycle controls, full settings panel (incl. martingale), current progression state |
| **Analytics** | Aggregated ledger stats: P&L, strike rate, profit factor, drawdown, streaks, per-asset |
| **Logs** | Streaming audit log of everything the server does |

---

## Quick Start

```bash
# 1. Install
npm install

# 2a. Demo mode (no keys needed)
npm start
# → http://localhost:3000

# 2b. Live mode
DERIV_APP_ID=xxxx DERIV_PAT=xxxx SUPABASE_URL=xxxx SUPABASE_KEY=xxxx npm start
```

> Node ≥ 18 required. On live mode, `DERIV_APP_ID` + `DERIV_PAT` switch the market feed from the simulator to the real Deriv WebSocket; `SUPABASE_URL` + `SUPABASE_KEY` switch the ledger from in-memory to Postgres.

### Docker

```bash
docker build -t quantcore-terminal .
docker run -p 3000:3000 --env-file .env quantcore-terminal
```

---

## Configuration

### Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `DERIV_APP_ID` | for live mode | Deriv API app ID (omitted → simulated feed) |
| `DERIV_PAT` | for live mode | Deriv personal access token |
| `SUPABASE_URL` | for persistent ledger | Supabase project URL (omitted → in-memory ledger) |
| `SUPABASE_KEY` | for persistent ledger | Supabase anon/service key |
| `PORT` | no | HTTP port (default `3000`) |
| `BOT_CONFIG_PATH` | no | Where bot config is persisted (default `./bot_config.json`) |
| `BOT_STATE_PATH` | no | Where bot state is persisted (default `./bot_state.json`) |

### Bot Settings

All editable from the **Bots → Bot Settings** panel (persisted to `bot_config.json`, survive restarts). Defaults:

| Key | Default | Meaning |
|---|---|---|
| `BOT_DURATION` | `5` | Trade duration (quantity; unit is `BOT_DURATION_UNIT`) |
| `BOT_BASE_STAKE` | `$0.35` | Starting stake |
| `BOT_TAKE_PROFIT` | unset | Session stops when profit ≥ TP (**required to start**) |
| `BOT_STOP_LOSS` | unset | Session stops when loss ≥ SL (**required to start**) |
| `BOT_MAX_RUNS` | unset | Max number of real trades per session (**required to start**) |
| `BOT_COOLDOWN` | `5` | Seconds between trades |
| `BOT_DURATION_UNIT` | `t` | Duration unit: `t` ticks (1–10) · `s` seconds (15–60) · `m` minutes (1–60). Clamped to live per-symbol limits fetched from Deriv via `contracts_for` |
| `BOT_RSI_OVERBOUGHT` | `70` | RSI sell-signal threshold |
| `SNIPER_ZONE_PCT` | `20` | % of recent range defining the sniper zone |
| `SNIPER_TICKS` | `2` | Consecutive zone-touch ticks required |
| `SNIPER_DOMINANCE` | `50` | Required tick dominance % in the zone |
| `SNIPER_BREAKOUT_BUFFER` | `0.5` | Breakout confirmation buffer |
| `SNIPER_MAX_AUTOCORRELATION` | `-0.05` | Reject choppy (mean-reverting) markets |
| `BOT_VIRTUAL_FILTER_ENABLED` | `true` | Paper-trade signals before going live |
| `BOT_VIRTUAL_LOSS_THRESHOLD` | `4` | Virtual losses before a signal is allowed to trade real money |
| `BOT_VIRTUAL_RETURN_MODE` | `any` | `any` / `win` — when to return to virtual observation |

"Reset to defaults" restores strategy parameters while **preserving** your safety controls (TP/SL/Max Runs and virtual-filter settings).

### Martingale Stake Progression

Rebuilt in v2.0 and **OFF by default**. Configure in **Bots → Bot Settings → Martingale**:

| Key | Default | Range |
|---|---|---|
| `BOT_MARTINGALE_ENABLED` | `false` | toggle |
| `BOT_MARTINGALE_MULTIPLIER` | `2` | 1.1 – 5 |
| `BOT_MARTINGALE_MAX_STEPS` | `4` | 1 – 10 |

**Rules:**
- After each **losing bot trade**, the next stake = base × multiplier^step, up to max steps.
- A **win** or **reaching the step cap** resets the stake to base.
- A **breakeven** (tie) keeps the current step.
- **Bot trades only.** Manual trades always use your typed stake and never advance or reset the progression.
- Live status on the bot card: `OFF` / `ON · BASE $x` / `STEP n/N · NEXT $y`.

> ⚠️ Standard martingale disclaimer: multipliers grow stakes geometrically. Max steps caps exposure, but understand the worst-case ladder before enabling this with real funds.

---

## How the Bot Works

```
signal (RSI + sniper zone confluence)
        │
        ▼
virtual filter ON?  ──no──►  real trade
        │ yes
        ▼
paper-trade the signal for BOT_DURATION (ticks/seconds/minutes — virtual observation settles after the equivalent number of feed ticks)
        │
        ├─ wins / under threshold ──► keep observing (stay virtual)
        └─ N consecutive virtual losses ──► go live with real trade
                                           │
                                           ▼
                                    Deriv settlement ──► ledger
                                           │
                                     win → reset martingale
                                     loss → step up martingale
```

The bot lifecycle (`armed → trading → observing → …`) is state-machined; connection drops, trade failures, and settle events are all handled without losing state. Every transition is written to the audit log (Logs tab) and survives restarts via `bot_state.json`.

---

## API Reference

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/state` | Full state snapshot (same shape as the SSE payload) |
| `GET` | `/stream` | Server-Sent Events live feed (throttled, ~120ms min interval) |
| `GET` | `/api/config` | Current bot configuration |
| `POST` | `/api/config` | Update config (merged + persisted) |
| `POST` | `/api/config/reset` | Reset strategy defaults, preserve safety controls |
| `POST` | `/api/control` | `{action: start/stop/reset}` bot lifecycle (validates TP/SL/Max Runs) |
| `POST` | `/api/trade/manual` | `{stake, direction}` one-click manual trade |
| `GET` | `/api/ledger/aggregated` | Stats: P&L, strike rate, profit factor, drawdown, streaks, per-asset |
| `GET` | `/debug/state` | Compact diagnostics: lifecycle, connection, heartbeat, ticks, last error |
| `GET` | `/health` | Liveness probe |

Detailed request/response shapes: [`docs/api-routes.md`](docs/api-routes.md)

---

## Project Structure

```
├── server.js              # Express server, SSE stream, REST API, Deriv event wiring
├── store.js               # Central state store (config, bot state, lifecycle, events)
├── config.js              # Env var loader
├── database.js            # Supabase ledger client (falls back to in-memory)
├── Dockerfile
├── engine/
│   ├── bot.js             # Bot orchestration
│   ├── lifecycle.js       # State machine (armed/trading/observing…)
│   ├── virtualFilter.js   # Paper-trade filter logic
│   ├── indicators.js      # RSI, autocorrelation, zones
│   ├── tickBuffer.js      # Ring buffer for tick history
│   └── configReset.js     # Default reset w/ preserved safety keys
├── services/
│   ├── deriv.js           # Deriv WebSocket client (live)
│   ├── fakeDeriv.js       # Simulated feed (demo mode)
│   ├── supabase.js        # Ledger persistence (live)
│   └── fakeLedger.js      # In-memory ledger (demo mode)
├── public/
│   ├── index.html         # Single-page app (6 tabs)
│   ├── css/               # styles.css + styles-mobile.css (cache-busted)
│   └── js/                # core, dashboard, analytics, logs, settings, app, chart-utils
├── test/                  # node:test smoke suites
└── docs/                  # API routes + project state documents
```

---

## Testing

```bash
npm test          # runs the node:test suites (lifecycle, virtual filter, config, indicators)
```

Smoke suites cover: bot settings round-trip, lifecycle transitions, config reset behavior, Deriv message handling, and chart utils.

---

## Changelog

### v2.0 — Sept 2026
- **Fixed:** scroll bug (body flex layout — every tab scrolls internally at any window size, desktop → mobile)
- **Fixed:** server overload — SSE throttled server-side with per-client backpressure; state payload compacted
- **Fixed:** Chart.js pinned to exact version (was pulling `latest` on every load)
- **New:** martingale stake progression (custom multiplier, max steps, bot-only, OFF by default)
- **New:** realistic demo mode — `npm start` with no keys runs a simulated feed + in-memory ledger
- Verified end-to-end: signal → virtual observation → real trade → settlement → ledger → analytics; martingale progression and reset; UI at desktop/short-window/mobile viewports.

### v1.x — earlier
Initial Deriv dashboard, manual trading, signal bot with virtual filter, Supabase ledger, Docker deployment.
