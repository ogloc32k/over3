markdown
# QUANTCORE // TERMINAL v6.0 — Project State

This document is the single source of truth for the current state of the QuantCore Terminal application.  
It reflects all code that is **actually deployed / working** as of the last update.  
No speculation, no wish‑list—only what exists in the files.

---

## 1. Project Overview & Architecture

QuantCore Terminal is a real‑time trading dashboard for Deriv volatility indices (R_10 … 1HZ100V).  
It connects to a Deriv account, displays live market data, and allows manual one‑click trading.  
The application is split into a vanilla JavaScript frontend and a Node.js/Express backend that proxies Deriv’s WebSocket API and streams state to the browser via Server‑Sent Events.

**Tech Stack**
- **Frontend**: Vanilla JS (no framework), Chart.js, CSS custom properties for theming.
- **Backend**: Node.js, Express, `ws` library (for Deriv WebSocket), `@supabase/supabase-js` (active).
- **Deployment**: Dockerfile → Koyeb (or any Docker host); previously deployed on Render.
- **Database**: Supabase PostgreSQL – `trading_ledger` table is active and stores completed trades.

---

## 2. File Structure & Directory Map
project-root/
├── Dockerfile # Docker build instructions for production
├── package.json # Node dependencies and start script
├── package-lock.json # Auto‑generated lockfile
├── config.js # Reads DERIV_APP_ID, DERIV_PAT, SUPABASE_URL, SUPABASE_KEY
├── server.js # Express server, SSE /stream, REST API, Deriv event wiring
├── store.js # In‑memory global state (EventEmitter), pushes to SSE
├── logger.js # Ring buffer for log messages (max 200), used by SSE
├── .env # (local only) environment variables
├── services/
│ ├── deriv.js # Deriv WebSocket client – OTP flow, tick subscription, trade execution
│ └── supabase.js # Supabase client (active – used for trade storage & analytics)
├── public/
│ ├── index.html # Single HTML shell – nav drawer, header, sidebar, all tab pages
│ ├── css/
│ │ ├── styles.css # Global styles, desktop layout, Manual Trade & Bots base styles
│ │ └── styles-mobile.css # Loaded on ≤768px – mobile drawer, home, markets, manual, bots
│ └── js/
│ ├── core.js # Global state, SSE client, renderUI(), formatPrice(), setFocusMarket()
│ ├── dashboard.js # sendControl(), swapEnvironment(), fireManual() (with overrides)
│ ├── analytics.js # Chart.js charts, timeframePreset(), real analytics from Supabase
│ ├── logs.js # Log stream rendering, clearLogs()
│ ├── settings.js # Load/save config via /api/config
│ └── app.js # Tab switching (switchTab), mobile drawer open/close,
│ syncMobileUI(), renderMobileMarkets(), initManualTrade(),
│ fireMobileManual(), _syncBotCard(), mobile home charts
└── docs/
└── PROJECT_STATE.md # This file

text

**Key file summaries**

| File | Role |
|------|------|
| `server.js` | Express server, static files, SSE `/stream`, REST API, listens to Deriv events, stores trades in Supabase, serves real analytics |
| `store.js` | In‑memory state (balance, tradingMode, marketMetrics, etc.), emits `stateChanged` for SSE |
| `logger.js` | Stores last 200 log entries, drained on every SSE push |
| `services/deriv.js` | Deriv WebSocket connection (OTP flow), tick subscriptions for 10 volatility indices, buyContract, setMode (demo/real), trade settlement tracking |
| `services/supabase.js` | Supabase client – connection test on startup, used for trade storage and analytics queries |
| `public/js/core.js` | SSE client (connects to `/stream`), renders desktop table & focus bar, updates balance/profile in sidebar |
| `public/js/app.js` | Tab navigation (unified desktop + mobile), mobile drawer open/close, syncs mobile UI, renders mobile markets/manual/bots, loads mobile home analytics charts |
| `public/js/dashboard.js` | sendControl (start/stop), swapEnvironment (demo/real), fireManual (manual trade with optional overrides) |
| `public/js/analytics.js` | Analytics tab charts and metrics, timeframePreset (24h, session, 1w, 1m, 1y) – fetches real data from `/api/ledger/aggregated` |
| `public/js/logs.js` | Renders log stream, provides clearLogs() |
| `public/js/settings.js` | Loads and saves bot configuration via `/api/config` |

---

## 3. Data Schemas & Models

### Database (Supabase)

**`trading_ledger` table** (active, populated with trade data)

| Column | Type | Description |
|--------|------|-------------|
| `id` | integer (PK) | Auto‑increment |
| `created_at` | timestamptz | Trade settlement time |
| `asset` | text | Deriv symbol (e.g., "Volatility 75 Index") |
| `contract_type` | text | "CALL" or "PUT" |
| `stake` | numeric | Amount staked |
| `payout` | numeric | Payout from Deriv |
| `profit_loss` | numeric | Profit (positive) or loss (negative) |
| `is_win` | boolean | true = profit > 0 |
| `barrier` | numeric (nullable) | Barrier level |
| `exit_tick` | numeric (nullable) | Exit price |
| `contract_id` | text (nullable) | Deriv contract identifier |
| `entry_price` | numeric (nullable) | Entry price |
| `exit_price` | numeric (nullable) | Exit price |
| `duration_ticks` | integer | Trade duration in ticks |
| `bot_name` | text | "manual" or bot identifier |
| `account` | text | 'demo' or 'real' – which account placed the trade |

Currently only manual trades are recorded (`bot_name = 'manual'`). The table is used by:
- `server.js` – inserts new rows on `trade_settled` event from Deriv.
- `GET /api/ledger/aggregated` – queries rows within a time window, filters by account, and computes analytics.

### In‑Memory Store (GlobalState)

```javascript
{
  tradingMode: 'demo' | 'real',
  balance: number | null,        // null when unknown, otherwise float
  sessionPnl: number,
  dailyPnl: number,
  currentStake: number,
  locked: boolean,
  active: boolean,               // bot armed / running
  lastTriggerTime: number,       // epoch ms
  tradeInProgress: boolean,
  loginid: string,
  currency: string,
  marketMetrics: {
    [symbol: string]: {
      price: number,
      step: 0|1|2|3,            // entry proximity
      support: number|null,
      resistance: number|null,
      isBreakout: boolean,
      isBreakdown: boolean,
      rsi: number,
      volatility: number,        // percentage
      score: number,
      bandwidth: number,         // Bollinger bandwidth %
      tickDirections: number[],  // +1/-1/0
      supportPct: number|null,
      resistancePct: number|null,
      risePct: number|null,
      fallPct: number|null,
      lastPrices: number[],
      formattedPrice: string     // added by frontend, not sent from backend
    }
  }
}
Configuration object (returned by /api/config)

json
{
  "ANALYSIS_WINDOW": 500,
  "BOLLINGER_PERIOD": 20,
  "BOLLINGER_STD": 2,
  "RSI_PERIOD": 20,
  "OVERSOLD_THRESHOLD": 30,
  "OVERBOUGHT_THRESHOLD": 70,
  "MIN_VOLATILITY_PERCENT": 0.06,
  "DURATION_SECONDS": 7,
  "MAX_CONSECUTIVE_LOSSES": 3,
  "RISK_PERCENT": 1,
  "TP_PERCENT": 5,
  "SL_PERCENT": 10,
  "MIN_STAKE": 0.35,
  "COOLDOWN_TICKS": 5,
  "MIN_TRIGGER_INTERVAL": 300000,
  "LOSS_COOLDOWN_MS": 300000,
  "SETTLEMENT_TIMEOUT_MS": 15000,
  "PNL_SYNC_INTERVAL_MS": 300000
}
4. Backend API Routes
All routes are defined in server.js.

Method	Path	Auth	Description
GET	/health	None	Returns { status: "ok" }
GET	/stream	None	SSE stream; pushes { state, logs } on every store change.
POST	/api/control	None	Body: { action: "start"|"stop"|"set_mode", mode?: "demo"|"real" }
POST	/api/trade/manual	None	Body: { symbol, contractType, duration, durationUnit, price, stake? }
GET	/api/config	None	Returns current configuration object
POST	/api/config	None	Body: partial config object; merges into store.config
GET	/api/ledger/aggregated?mode=session|24h|1w|1m|1y&account=demo|real	None	Queries trading_ledger table with timeframe and account filter, returns calculated metrics, asset contributions, and equity curve. Also supports mode=custom with start and end ISO timestamps.
Analytics response shape (example)

json
{
  "totalProfit": 198.18,
  "tradeCount": 109,
  "winCount": 48,
  "lossCount": 61,
  "grossProfit": 2388.66,
  "grossLoss": 2190.48,
  "maxDrawdown": 2.85,
  "totalDuration": 763,
  "avgWin": 49.76,
  "avgLoss": 35.91,
  "strikeRate": 44.04,
  "profitFactor": 1.09,
  "assetContributions": [
    { "name": "Volatility 100 Index", "pnl": 25.76 }
  ],
  "equityData": [
    { "timestamp": "2026-07-26T15:03:08.749Z", "equity": -37.87 }
  ]
}
Timeframe mode mapping (frontend sends short names, backend also accepts long names):

session → today's trades (since midnight UTC)

24h → last 24 hours

1w (or week) → last 7 days

1m (or month) → last 30 days

1y (or year) → last 365 days

custom → requires start and end query parameters

Account filtering:

account=demo or account=real – must be passed; defaults to demo if missing.

5. Frontend State & UI/UX
Visual Layout
Dark theme by default, with light theme toggle (localStorage).

Desktop: Left sidebar (160px) with profile, balance, account switcher. Right side: header tabs, focus bar, and tab pages (Home, Manual, Bots, Analytics, Logs, Settings). Home tab contains a full‑width market table (8 columns). Manual tab shows the same trade interface as mobile (centered, max‑width 560px). Bots tab shows a bot status card.

Mobile (≤768px): No sidebar or focus bar. A slide‑in navigation drawer is triggered by a profile button in the top‑left of the header. Tab pages include Home (equity chart with real data, asset performance bar, status strip), Markets (vertical cards with metrics), Manual (chip selector, tick chart, CALL/PUT buttons), Bots, Analytics, Logs, Settings. Analytics collapses to single column. Logs and Settings are scrollable.

Core Mechanics
Tab Navigation (app.js → switchTab()):

Deactivates all pages, activates target.

For tab-analytics: renders charts, adds .analytics-active to body (collapses sidebar).

For tab-settings: calls loadConfig().

For tab-logs: scrolls to bottom.

When leaving Analytics, sidebar is explicitly restored.

Lazy‑loads mobile markets and manual trade on first open.

Loads mobile home analytics data when Home tab is opened.

Mobile Drawer:

Hidden by default (.nav-drawer { display: none !important }).

On mobile, styles-mobile.css sets position: fixed; left: -100%; .open moves it to left: 0.

openNavDrawer() / closeNavDrawer() toggle classes and overlay.

Drawer menu items are fully styled (no default browser button appearance).

Account Switching:

swapEnvironment() (dashboard.js) sends POST /api/control { action: "set_mode", mode: "demo"|"real" }.

Backend calls derivClient.setMode(mode), which disconnects, updates store with new tradingMode, and reconnects.

UI updates instantly via SSE; balance refreshes immediately.

Analytics and mobile home screens automatically re‑fetch data for the selected account.

Manual Trade:

Desktop: full interface (chips, chart, metrics, CALL/PUT buttons).

Mobile: same interface, plus touch‑optimised sizing.

fireManual() in dashboard.js accepts an optional overrides object for mobile use.

Trade request sent to /api/trade/manual.

Analytics Dashboard:

Timeframe buttons (24H, Session, 1W, 1M, 1Y) fetch /api/ledger/aggregated?mode=...&account=....

Eight metric cards are updated with real numbers.

Asset Performance bar chart and Equity Curve line chart are rendered with real data; equity curve colour dynamically reflects profit/loss (green if up, red if down).

Date pickers sync with preset buttons and reject future dates; custom ranges validated.

Empty‑state overlays are hidden when data exists.

Account switching triggers an automatic refresh of the Analytics tab if it is active.

Mobile Home Screen:

Loads 1W analytics by default on page load and when switching accounts.

Equity curve and asset performance bar are rendered; equity colour is dynamic (green/red).

Timeframe buttons (1W/1M) re‑fetch data and update charts.

Empty‑state messages hidden when data is present.

Real‑time Data:

Backend subscribes to ticks for 10 volatility indices.

Tick data is logged but not yet processed into marketMetrics (indicators not computed).

SSE connection to /stream pushes { state, logs } on every store change.

6. Current Progress (What is Done)
✅ Deriv authentication (new OTP flow) works; demo and real account switching works.

✅ Live balance displayed in sidebar (desktop) and drawer/home screen (mobile). Balance immediately updates on account switch.

✅ Real‑time tick subscription for all volatility indices (ticks logged, not yet used for indicators).

✅ Manual trade execution (CALL/PUT) with configurable duration and stake.

✅ Full responsive layout: desktop sidebar + tabs, mobile drawer + vertical pages.

✅ Mobile‑specific pages: Home (real equity chart and asset performance bar from Supabase), Markets (vertical cards with breakout badges), Manual Trade (with live tick chart), Bots (bot card with P&L display).

✅ Analytics tab with Chart.js charts, real data from Supabase via /api/ledger/aggregated. Timeframe filtering works (24h, session, 1w, 1m, 1y, custom). Dynamic chart colors.

✅ Logs tab with live SSE‑fed log stream.

✅ Settings tab with full configuration form (load/save via API).

✅ Theme toggle (light/dark) persists in localStorage.

✅ Account switcher updates profile label and balance immediately.

✅ All API routes: control, manual trade, config, health, SSE stream, analytics.

✅ Dockerfile ready for deployment on Koyeb / any Docker host.

✅ Supabase trading_ledger table active – trades are inserted automatically when settled, analytics queries work with account and timeframe filtering.

✅ Drawer styling polished (buttons, close icon, switch account).

✅ Settings page and mobile markets page are scrollable.

✅ Mobile home timeframe buttons (1W / 1M) functional.

✅ Date picker sync, validation (no future dates, auto‑swap reversed dates).

✅ Account column added to trading_ledger; all new trades tagged; analytics filter by account.

✅ Equity curve color changes based on performance (green/red) on both Analytics and Mobile Home.

7. Pending Tasks & Missing Features
⬜ MarketMetrics population: Backend receives ticks but does not compute indicators (RSI, Bollinger, S/R, etc.). The store’s marketMetrics remain dummy values; the frontend renders them as zeros. The desktop table and mobile market cards show no real market data.

⬜ Automated trading engine: The bot.js strategy file and the engine (executor, indicators) are designed but not yet coded. There is no logic to evaluate entry conditions or automatically place trades.

⬜ Bot start/stop: sendControl('start') / 'stop' update store.state.active, but there is no engine loop to act on that flag.

⬜ Config persistence: Config is stored in memory only; reloading the server resets to defaults. No database storage for config.

⬜ Multi‑user / security: No authentication for the web interface; anyone with the URL can access the dashboard.

⬜ Desktop sidebar trade buttons: The sidebar originally had CALL/PUT buttons; they were removed during redesign. Desktop manual trading now requires navigating to the Manual tab. This is intentional but could be revisited.

⬜ Error handling for Deriv disconnections: Exponential backoff is implemented, but no user notification or UI feedback.

⬜ SSE broadcast for analytics deltas: Not yet implemented for multiple clients (currently only one SSE connection receives deltas).

⬜ Testing & documentation: No unit tests or integration tests.

This document was generated from the actual codebase state as of the last update. It should be updated whenever new features are merged.

text
also this one need an update   QUANTCORE API Routes
Base URL: https://trader-uy9c.onrender.com (or your Render URL)

1. Health check
Method	Path	Auth	Description
GET	/health	None	Server status and uptime
Response

{
  "status": "ok",
  "uptime": 123.456,
  "memory": { "rss": 12345678, "heapTotal": 12345678, "heapUsed": 12345678 },
  "deriv": "loaded",
  "store": "loaded",
  "logger": "loaded"
}
2. SSE stream (real‑time state & logs)
Method	Path	Auth	Description
GET	/stream	None	Server‑sent events with global state and log entries
Event data format

json
{
  "state": { /* full GlobalState object */ },
  "logs": [
    { "time": 1712345678000, "message": "[INFO] ..." }
  ]
}
State is pushed on every state change.

Logs are buffered and drained each push (max 200 entries).

Events with "event":"analytics_delta" are sent when a trade closes (only to keep analytics charts live).

3. Bot control
Method	Path	Auth	Description
POST	/api/control	None	Start / stop the bot, or switch account mode
Request body

json
{ "action": "start" }
{ "action": "stop" }
{ "action": "set_mode", "mode": "demo" | "real" }
Response

json
{ "message": "Bot started" }
{ "message": "Bot stopped" }
{ "message": "Switched to real" }
On error:

json
{ "error": "Unknown action" }
4. Manual trade
Method	Path	Auth	Description
POST	/api/trade/manual	None	Place a manual trade
Request body

json
{
  "symbol": "R_75",
  "contractType": "CALL" | "PUT",
  "duration": 7,
  "durationUnit": "t" | "s" | "m",
  "price": 50739.0548
}
Optional: "stake" (if omitted, engine uses RISK_PERCENT config).

Response

json
{ "message": "Trade request sent" }
On error:

json
{ "error": "Deriv client not connected" }
5. Configuration (settings)
Method	Path	Auth	Description
GET	/api/config	None	Retrieve current bot configuration
POST	/api/config	None	Update configuration (full object)
GET response – same shape as the config object in the store.

POST request body – any subset of config fields:

json
{
  "ANALYSIS_WINDOW": 1000,
  "BOLLINGER_PERIOD": 20,
  "BOLLINGER_STD": 2,
  "RSI_PERIOD": 20,
  "OVERSOLD_THRESHOLD": 30,
  "OVERBOUGHT_THRESHOLD": 70,
  "MIN_VOLATILITY_PERCENT": 0.06,
  "DURATION_SECONDS": 7,
  "MAX_CONSECUTIVE_LOSSES": 3,
  "RISK_PERCENT": 1,
  "TP_PERCENT": 5,
  "SL_PERCENT": 10,
  "MIN_STAKE": 0.35,
  "COOLDOWN_TICKS": 5,
  "MIN_TRIGGER_INTERVAL": 300000,
  "LOSS_COOLDOWN_MS": 300000,
  "SETTLEMENT_TIMEOUT_MS": 15000,
  "PNL_SYNC_INTERVAL_MS": 300000
}
POST response

json
{ "success": true }
On error:

json
{ "error": "..." }
6. Analytics data
Method	Path	Auth	Description
GET	/api/ledger/aggregated?mode=session|24h|week|month|year	Get aggregated trade stats for a timeframe	
Response (placeholder until trade history is stored)

json
{
  "totalProfit": 0,
  "tradeCount": 0,
  "winCount": 0,
  "lossCount": 0,
  "grossProfit": 0,
  "grossLoss": 0,
  "maxDrawdown": 0,
  "totalDuration": 0,
  "assetContributions": [],
  "equityData": [
    { "timestamp": 1712345678000, "equity": 10000 }
  ]
}
text

Copy this into `docs/api-routes.md`. As we add new endpoints (like bot‑specific trade history or strategy config), we’ll update it together.
We need to update the API routes document to reflect current reality: the backend serves real analytics from Supabase, includes account filtering, custom date ranges, and the balance/account logic is fully implemented. I'll rewrite the document with accurate endpoints, request/response examples, and remove placeholder notes.

Here is the fully updated docs/api-routes.md reflecting everything currently deployed.

markdown
# QUANTCORE API Routes

**Base URL**: `https://shrill-lynx-betin-ff0e7725.koyeb.app` (or your actual Koyeb URL)

---

## 1. Health check

| Method | Path     | Auth | Description               |
|--------|----------|------|---------------------------|
| GET    | `/health`| None | Server status and uptime   |

**Response**
```json
{
  "status": "ok",
  "uptime": 123.456,
  "memory": { "rss": 12345678, "heapTotal": 12345678, "heapUsed": 12345678 },
  "deriv": "loaded",
  "store": "loaded",
  "logger": "loaded"
}
2. SSE stream (real‑time state & logs)
Method	Path	Auth	Description
GET	/stream	None	Server‑sent events with global state and log entries
Event data format

json
{
  "state": { /* full GlobalState object */ },
  "logs": [
    { "time": 1712345678000, "message": "[INFO] ..." }
  ]
}
State is pushed on every state change.

Logs are buffered and drained each push (max 200 entries).

Events with "event":"analytics_delta" are planned for live trade results (not yet fully implemented).

3. Bot control
Method	Path	Auth	Description
POST	/api/control	None	Start / stop the bot, or switch account mode
Request body

json
{ "action": "start" }
{ "action": "stop" }
{ "action": "set_mode", "mode": "demo" | "real" }
Response

json
{ "message": "Bot started" }
{ "message": "Bot stopped" }
{ "message": "Switched to real" }
On error:

json
{ "error": "Unknown action" }
4. Manual trade
Method	Path	Auth	Description
POST	/api/trade/manual	None	Place a manual trade
Request body

json
{
  "symbol": "R_75",
  "contractType": "CALL" | "PUT",
  "duration": 7,
  "durationUnit": "t" | "s" | "m",
  "price": 50739.0548
}
Optional: "stake" (if omitted, engine uses RISK_PERCENT config).

Response

json
{ "message": "Trade request sent" }
On error:

json
{ "error": "Deriv client not connected" }
5. Configuration (settings)
Method	Path	Auth	Description
GET	/api/config	None	Retrieve current bot configuration
POST	/api/config	None	Update configuration (full object)
GET response – same shape as the config object in the store.

POST request body – any subset of config fields:

json
{
  "ANALYSIS_WINDOW": 1000,
  "BOLLINGER_PERIOD": 20,
  "BOLLINGER_STD": 2,
  "RSI_PERIOD": 20,
  "OVERSOLD_THRESHOLD": 30,
  "OVERBOUGHT_THRESHOLD": 70,
  "MIN_VOLATILITY_PERCENT": 0.06,
  "DURATION_SECONDS": 7,
  "MAX_CONSECUTIVE_LOSSES": 3,
  "RISK_PERCENT": 1,
  "TP_PERCENT": 5,
  "SL_PERCENT": 10,
  "MIN_STAKE": 0.35,
  "COOLDOWN_TICKS": 5,
  "MIN_TRIGGER_INTERVAL": 300000,
  "LOSS_COOLDOWN_MS": 300000,
  "SETTLEMENT_TIMEOUT_MS": 15000,
  "PNL_SYNC_INTERVAL_MS": 300000
}
POST response

json
{ "success": true }
On error:

json
{ "error": "..." }
6. Analytics data
Method	Path	Auth	Description
GET	/api/ledger/aggregated?mode=session|24h|1w|1m|1y|custom&account=demo|real&start=<ISO>&end=<ISO>	None	Aggregated trade stats from Supabase
Query parameters

mode – session (default), 24h, 1w, 1m, 1y, or custom (requires start & end in ISO format).

account – demo or real (defaults to demo).

start, end – only used when mode=custom.

Response (example with real data)

json
{
  "totalProfit": 198.18,
  "tradeCount": 109,
  "winCount": 48,
  "lossCount": 61,
  "grossProfit": 2388.66,
  "grossLoss": 2190.48,
  "maxDrawdown": 2.85,
  "totalDuration": 763,
  "avgWin": 49.76,
  "avgLoss": 35.91,
  "strikeRate": 44.04,
  "profitFactor": 1.09,
  "assetContributions": [
    { "name": "Volatility 100 Index", "pnl": 25.76 }
  ],
  "equityData": [
    { "timestamp": "2026-07-26T15:03:08.749Z", "equity": -37.87 }
  ]
}
If no trades match the timeframe/account, all numeric fields return 0 and arrays are empty.

All endpoints are fully implemented. Future endpoints (e.g., bot strategy config, trade history pagination) will be added here when built.
