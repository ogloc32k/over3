docs/api-routes.md
markdown
# QUANTCORE API Routes

Base URL: `https://trader-uy9c.onrender.com` (or your Render URL)

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
