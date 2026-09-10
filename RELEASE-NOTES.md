# QuantCore Terminal — Stability & UI Fix Release (Sept 2026)

## What was fixed

### 1. Scroll bug (content cut off, only "fixed" by resizing the window)
**Root cause:** `body` had `min-height: 100vh` but no flex layout, so `.app-body { flex: 1 }`
was ignored. Tab pages sized themselves to content height, overflowed the viewport,
and had no scrollbar.

**Fix:** `body { display: flex; flex-direction: column; min-height: 100vh; }` —
the app shell now constrains properly and every tab page scrolls internally.
Verified headless at 1280x800, 1366x700 (short window) and 390x844 (mobile): all tabs scroll or fit. No JS errors.

### 2. Server overload / crash under load
- SSE feed now throttled server-side (120ms min interval) with per-client backpressure.
- State payload reduced to a compact snapshot (ticks capped, counts instead of arrays).

### 3. Chart.js instability
- Pinned to exact version (was pulling "latest" on every load). Cache bumped to v=19.

### 4. Fake/demo mode realism
- `services/fakeDeriv.js`: mean-reverting random walk with volatility impulses so
  RSI/zone/breakout signals actually fire in demo mode.

### 5. Trade engine — verified end-to-end
Full loop smoke-tested with relaxed test config (duration 5, threshold 2):
signal -> virtual observation -> settle -> loss-streak -> REAL trade -> Deriv
settlement -> ledger insert -> analytics aggregation. 3 real trades, 2W/1L, +$0.31.
Test config was then removed; app boots with production defaults (duration 70, RSI 30/70, zone 20%).

### 6. Martingale stake progression (re-added, Sept 9 2026)
The martingale had been stripped out in a past update; rebuilt from scratch per your spec:
- **Settings panel** (Bots tab → Bot Settings → Martingale): enable toggle (default OFF),
  custom multiplier (default x2, range 1.1-5), max steps (default 4, range 1-10).
- **Behavior:** after each losing BOT trade the next stake is base x multiplier^step.
  A win, or hitting the step cap, resets the stake to base. Breakeven keeps the step.
- **Scope:** bot trades only — manual trades always use your typed stake and never
  touch the progression (a manual settle leaves it untouched too).
- **Live status:** bot card shows `Martingale: OFF` / `ON · BASE $x` / `STEP n/N · NEXT $y`.
- **Verified live in demo mode:** loss -> step 1, next stake $0.70; following win -> reset to $0.35.
- Config keys: `BOT_MARTINGALE_ENABLED`, `BOT_MARTINGALE_MULTIPLIER`, `BOT_MARTINGALE_MAX_STEPS`
  (persisted in bot_config.json, reset-safe). JS cache-busted to v=20.

## Running
- **Demo (no keys):** just `npm start` — auto-selects fake Deriv + in-memory ledger.
- **Live:** set `DERIV_APP_ID` + `DERIV_PAT` env vars; Supabase keys in `database.js`/env as before.
