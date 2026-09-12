// server.js
require('dotenv').config();

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const realSupabase = require('./services/supabase');
const fakeSupabase = require('./services/fakeLedger');
const USE_FAKE_DATA = !process.env.DERIV_APP_ID || !process.env.DERIV_PAT;
// Fake-data mode: swap Supabase for the in-memory ledger so analytics work without keys.
const supabase = (USE_FAKE_DATA || !realSupabase) ? fakeSupabase : realSupabase;
const virtualFilter = require('./engine/virtualFilter');
const durationUtil = require('./services/duration');
const cloudStore = require('./services/cloudStore');
const { createGate, COOKIE_NAME } = require('./services/auth');
cloudStore.init(supabase);
const authGate = process.env.DASHBOARD_PASSWORD ? createGate(process.env.DASHBOARD_PASSWORD) : null;
const { resetStrategyConfig, PRESERVED_CONFIG_KEYS } = require('./engine/configReset');
const midnight = require('./engine/midnight');
// Daily-reset timezone: midnight here = daily session reset. Default IST.
const RESET_TZ = () => process.env.BOT_TIMEZONE || (store && store.config && store.config.BOT_TIMEZONE) || midnight.DEFAULT_TZ;
const { STATUS, REASONS, resolvePauseReason, resolveRiskTransition, isStaleLock } = require('./engine/lifecycle');

let store, logger, derivClient;
const processError = (kind, error) => {
  const message = error?.stack || error?.message || String(error);
  console.error(`🔥 ${kind}`, message);
  if (store && typeof store.recordError === 'function') {
    store.recordError(`${kind}: ${error?.message || String(error)}`);
  }
};
try { store       = require('./store');           console.log('✅ Store loaded');        } catch(e) { console.error('❌ store.js:', e); process.exit(1); }
try { logger      = require('./logger');          console.log('✅ Logger loaded');       } catch(e) { console.error('❌ logger.js:', e); process.exit(1); }
if (USE_FAKE_DATA) {
  try { derivClient = require('./services/fakeDeriv'); console.log('✅ FAKE Deriv client loaded (simulated market data, no env keys needed)'); } catch(e) { console.error('❌ fakeDeriv.js:', e); process.exit(1); }
} else {
  try { derivClient = require('./services/deriv'); console.log('✅ Deriv client loaded'); } catch(e) { console.error('❌ deriv.js:', e); derivClient = null; }
}

process.on('uncaughtException', err => processError('UNCAUGHT EXCEPTION', err));
process.on('unhandledRejection', reason => processError('UNHANDLED REJECTION', reason));

if (derivClient) derivClient.setStore(store);

// ============================================================
// PERSISTENT CONFIG  (bot_config.json next to server.js)
// ============================================================

// Per-symbol live duration limits fetched from Deriv via contracts_for.
// Empty until the real client connects; fallbacks used otherwise.
let liveDurationRanges = {};

// Normalize a saved config's duration settings; returns true if clamped.
function normalizeConfigDuration(scope) {
  const unit = durationUtil.normalizeUnit(store.config.BOT_DURATION_UNIT);
  const range = durationUtil.rangeFor(null, null, unit);
  const original = parseInt(store.config.BOT_DURATION);
  const clamped = durationUtil.clampDuration(store.config.BOT_DURATION, unit, null, 'R_100');
  let changed = false;
  if (store.config.BOT_DURATION_UNIT !== unit) { store.config.BOT_DURATION_UNIT = unit; changed = true; }
  if (original !== clamped.duration) { store.config.BOT_DURATION = clamped.duration; changed = true; }
  if (changed && scope) store.addLog('warn', `⚖️ ${scope}: trade duration normalized to ${clamped.duration} ${durationUtil.UNIT_LABELS[unit]} (valid ${range.min}–${range.max}).`);
  return changed;
}
const CONFIG_PATH = process.env.BOT_CONFIG_PATH || path.join(__dirname, 'bot_config.json');

const DEFAULT_CONFIG = {
  BOT_DURATION:           5,
  BOT_DURATION_UNIT:     't',
  BOT_BASE_STAKE:         0.35,
  BOT_TAKE_PROFIT:        null,
  BOT_STOP_LOSS:          null,
  BOT_MAX_RUNS:           null,
  BOT_COOLDOWN:           5,
  BOT_RSI_OVERSOLD:       30,
  BOT_RSI_OVERBOUGHT:     70,
  SNIPER_ZONE_PCT:        20,
  SNIPER_TICKS:           2,
  SNIPER_DOMINANCE:       50,
  SNIPER_BREAKOUT_BUFFER: 0.5,
  SNIPER_MAX_AUTOCORRELATION: -0.05,
  BOT_SYMBOLS:               [],
  BOT_VIRTUAL_FILTER_ENABLED: true,
  BOT_VIRTUAL_LOSS_THRESHOLD: 4,
  BOT_VIRTUAL_RETURN_MODE: 'any',
  BOT_MARTINGALE_ENABLED: false,
  BOT_MARTINGALE_MULTIPLIER: 2.0,
  BOT_MARTINGALE_MAX_STEPS: 4
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw  = fs.readFileSync(CONFIG_PATH, 'utf8');
      const saved = JSON.parse(raw);
      store.config = { ...DEFAULT_CONFIG, ...saved };
      console.log('✅ Config loaded from bot_config.json');
    } else {
      store.config = { ...DEFAULT_CONFIG };
      console.log('ℹ️  No saved config – using defaults');
    }
  } catch(e) {
    console.error('❌ Failed to load config:', e.message);
    store.config = { ...DEFAULT_CONFIG };
  }
}

function saveConfig(pushCloud = true) {
  try {
    const temporaryPath = `${CONFIG_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(store.config, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, CONFIG_PATH);
    if (pushCloud && cloudStore.available) {
      cloudStore.set('bot_config', store.config).catch(err =>
        store.addLog('warn', `☁️ Cloud config sync failed: ${err.message}`)
      );
    }
    return true;
  } catch(e) {
    store.recordError(`Failed to save bot configuration: ${e.message}`);
    return false;
  }
}

// ============================================================
// MARTINGALE stake progression (bot trades only)
// After a losing bot trade the next stake is base x multiplier^step.
// A win (or hitting the step cap) resets to the base stake.
// Disabled by default; manual trades never follow the progression.
// ============================================================
function martingaleParams() {
  const cfg = store.config || {};
  return {
    enabled:    cfg.BOT_MARTINGALE_ENABLED === true,
    base:       parseFloat(cfg.BOT_BASE_STAKE) || 0.35,
    multiplier: parseFloat(cfg.BOT_MARTINGALE_MULTIPLIER) > 1 ? parseFloat(cfg.BOT_MARTINGALE_MULTIPLIER) : 2,
    maxSteps:   Math.max(1, parseInt(cfg.BOT_MARTINGALE_MAX_STEPS) || 4)
  };
}

function martingaleStakeForLevel(mg, level) {
  const l = Math.min(Math.max(level || 0, 0), mg.maxSteps);
  return Math.round(mg.base * Math.pow(mg.multiplier, l) * 100) / 100;
}

// ============================================================
// PERSISTED ACTIVITY FLAG (bot_state.json) – lets AUTO-RESUME
// know whether the bot was running before the last restart.
// ============================================================
const BOT_STATE_PATH = process.env.BOT_STATE_PATH || path.join(__dirname, 'bot_state.json');
let wasActiveBeforeRestart = false;
try {
  if (fs.existsSync(BOT_STATE_PATH)) {
    wasActiveBeforeRestart = JSON.parse(fs.readFileSync(BOT_STATE_PATH, 'utf8')).active === true;
  }
} catch (_) { /* corrupt state file – treat as inactive */ }
function saveBotState(active) {
  try { fs.writeFileSync(BOT_STATE_PATH, JSON.stringify({ active: !!active, at: Date.now() })); }
  catch (_) { /* non-fatal */ }
  if (cloudStore.available) {
    cloudStore.set('bot_active', { active: !!active, at: Date.now() }).catch(err =>
      console.warn(`☁️ Cloud state sync failed: ${err.message}`)
    );
  }
}

loadConfig();
// Self-heal legacy configs (e.g. the old invalid 70-tick default) and persist.
if (normalizeConfigDuration('Loaded config')) saveConfig(false);
store.transitionLifecycle(STATUS.IDLE, REASONS.SERVER_RESTART, {
  active: false,
  locked: false,
  tradeInProgress: false
});
logger.info(`⚙️ Bot configuration loaded. Virtual filter: ${virtualFilter.isEnabled(store.config) ? 'ON' : 'OFF'}; threshold: ${virtualFilter.lossThreshold(store.config)} losses; return policy: ${virtualFilter.returnMode(store.config)}.`);

// ============================================================
// EXPRESS
// ============================================================
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // parse the login form (form-encoded POST)
app.use((req, res, next) => { console.log(`📡 ${req.method} ${req.url}`); next(); });

// ============================================================
// AUTH — password gate (active only when DASHBOARD_PASSWORD is set)
// One login per browser for 30 days; changing the password
// invalidates all existing cookies instantly.
// ============================================================
function parseCookies(header = '') {
  const out = {};
  String(header).split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function loginPageHTML(error = '') {
  const msg = error || 'Enter password to access the terminal';
  const errStyle = error ? 'color:#ff5f56;' : 'color:var(--mut);';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>QuantCore Terminal — Login</title>
<style>
  :root { --mut:#8a929e; --bg:#0b0e12; --card:#12161d; --line:#232a35; --acc:#4ee1a0; --err:#ff5f56; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:var(--bg); color:#e6e9ee; font-family:'SF Mono','Fira Code',Consolas,monospace;
         min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:38px 34px;
          width:100%; max-width:400px; }
  .logo { font-size:15px; letter-spacing:3px; color:var(--acc); margin-bottom:4px; }
  .sub  { font-size:11px; color:var(--mut); letter-spacing:2px; margin-bottom:28px; }
  p.msg { font-size:12px; margin-bottom:14px; ${errStyle} letter-spacing:0.5px; }
  input { width:100%; background:#0b0e12; border:1px solid var(--line); border-radius:6px;
          color:#e6e9ee; padding:13px 14px; font:inherit; font-size:14px; outline:none; }
  input:focus { border-color:var(--acc); }
  button { width:100%; margin-top:14px; padding:13px; font:inherit; font-size:13px; letter-spacing:2px;
           background:var(--acc); border:none; border-radius:6px; color:#06281a; font-weight:700;
           cursor:pointer; }
  button:hover { filter:brightness(1.08); }
  .foot { margin-top:22px; font-size:10px; color:var(--mut); text-align:center; letter-spacing:1px; }
</style>
</head>
<body>
  <div class="card">
    <div class="logo">QUANTCORE // TERMINAL</div>
    <div class="sub">RESTRICTED ACCESS</div>
    <p class="msg">${msg}</p>
    <form method="POST" action="/login">
      <input type="password" name="password" placeholder="password" autofocus autocomplete="current-password" required>
      <button type="submit">AUTHENTICATE</button>
    </form>
    <div class="foot">SESSION LASTS 30 DAYS PER BROWSER</div>
  </div>
</body>
</html>`;
}

if (authGate) {
  console.log('🔒 Dashboard auth: ON (password gate active)');
  app.set('trust proxy', 1);
  const authAttempts = new Map(); // ip → { count, lockedUntil }

  app.use((req, res, next) => {
    const ip  = req.ip || 'unknown';
    const att = authAttempts.get(ip);
    if (att && att.lockedUntil > Date.now()) {
      return res.status(429).type('text').send('Too many attempts. Try again in a minute.');
    }
    if (req.path === '/health' || req.path === '/login') return next();
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (token && authGate.validCookie(token)) return next();
    if (req.path.startsWith('/api/') || req.path.startsWith('/stream') || req.path.startsWith('/debug')) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    return res.redirect('/login');
  });

  app.get('/login', (req, res) => {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (token && authGate.validCookie(token)) return res.redirect('/');
    return res.type('html').send(loginPageHTML());
  });

  app.post('/login', (req, res) => {
    const ip = req.ip || 'unknown';
    if (authGate.check(req.body && req.body.password)) {
      authAttempts.delete(ip);
      const secure = req.secure ? '; Secure' : '';
      res.setHeader('Set-Cookie', `${COOKIE_NAME}=${authGate.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60*60*24*30}${secure}`);
      return res.redirect('/');
    }
    let att = authAttempts.get(ip) || { count: 0, lockedUntil: 0 };
    att.count += 1;
    if (att.count >= 10) { att.lockedUntil = Date.now() + 60000; att.count = 0; }
    authAttempts.set(ip, att);
    res.setHeader('Retry-After', '60');
    return res.status(401).type('html').send(loginPageHTML('ACCESS DENIED — wrong password'));
  });

  app.post('/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return res.redirect('/login');
  });
}

app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// SSE STREAM
// ============================================================
app.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive'
  });
  res.write('\n');

  const initial = store.getStatePayload();
  res.write(`data: ${JSON.stringify(initial)}\n\n`);

  let closed = false;
  let dirty = false;
  let flushTimer = null;
  // Coalesce bursts of state changes (10 symbols tick up to ~10x/sec)
  // into at most one payload write per 120ms. Zero perceived lag,
  // massively less work for server and browser.
  const writeState = () => {
    if (closed || res.writableEnded) return;
    dirty = false;
    flushTimer = null;
    try {
      const payload = store.getStatePayload();
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (err) {
      closed = true;
      store.removeListener('stateChanged', onChange);
      clearInterval(heartbeat);
      console.error('❌ SSE write failed:', err.message);
      try { res.end(); } catch (_) {}
    }
  };
  const onChange = () => {
    if (closed || res.writableEnded) return;
    dirty = true;
    if (flushTimer) return;
    flushTimer = setTimeout(writeState, 120);
  };
  const heartbeat = setInterval(() => {
    if (closed || res.writableEnded) return;
    try { res.write(': heartbeat\n\n'); } catch (_) { closed = true; }
  }, 25000);
  store.on('stateChanged', onChange);
  req.on('close', () => {
    closed = true;
    store.removeListener('stateChanged', onChange);
    clearInterval(heartbeat);
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  });
});

// ============================================================
// TRADE LOCK
// ============================================================
const tradeInProgressSym = {};
const lockTimestamps     = {};

function isTradeActive() { return tradeInProgressSym['global'] === true; }
function releaseTradeLock(reason) {
  tradeInProgressSym['global'] = false;
  delete lockTimestamps['global'];
  store.updateState({ tradeInProgress: false, locked: false });
  if (reason) store.addLog('warn', reason);
}

// ============================================================
// CONTROL
// ============================================================
app.post('/api/control', (req, res) => {
  const { action, mode } = req.body;
  console.log('🟡 POST /api/control body:', req.body);
  try {
    if (action === 'start') {
      // Validate required risk fields before allowing start
      const tp      = parseFloat(store.config.BOT_TAKE_PROFIT);
      const sl      = parseFloat(store.config.BOT_STOP_LOSS);
      const maxRuns = parseInt(store.config.BOT_MAX_RUNS);
      if (!tp  || tp  <= 0) {
        store.addLog('warn', '⛔ Start blocked: Take Profit is missing or invalid.');
        return res.json({ error: 'Set Take Profit before starting the bot.' });
      }
      if (!sl  || sl  <= 0) {
        store.addLog('warn', '⛔ Start blocked: Stop Loss is missing or invalid.');
        return res.json({ error: 'Set Stop Loss before starting the bot.' });
      }
      if (!maxRuns || maxRuns <= 0) {
        store.addLog('warn', '⛔ Start blocked: Max Runs is missing or invalid.');
        return res.json({ error: 'Set Max Runs before starting the bot.' });
      }

      // Reset the session and begin with paper trades when the filter is on.
      store.transitionLifecycle(STATUS.STARTING, REASONS.USER_START, {
        active: true,
        locked: false,
        tradeInProgress: false,
        sessionTradeCount: 0,
        ...virtualFilter.createState(store.config),
        currentStake: parseFloat(store.config.BOT_BASE_STAKE) || 0.35,
        martingaleLevel: 0,
        martingaleNextStake: parseFloat(store.config.BOT_BASE_STAKE) || 0.35
      });
      if (derivClient && derivClient.isConnected()) {
        store.transitionLifecycle(STATUS.ARMED, REASONS.ARMED);
      } else {
        store.transitionLifecycle(STATUS.RECOVERING, REASONS.CONNECTION_WAIT, {
          active: true
        });
      }
      store.addLog('info', `✅ Bot started in ${store.state.executionMode.toUpperCase()} mode. TP=$${tp.toFixed(2)}, SL=$${sl.toFixed(2)}, max runs=${maxRuns}.`);
      saveBotState(true);
      res.json({ message: 'Bot started', state: store.state.lifecycleStatus });

    } else if (action === 'stop') {
      releaseTradeLock();
      store.transitionLifecycle(STATUS.STOPPED, resolvePauseReason({ userStop: true }), {
        active: false, locked: false, tradeInProgress: false, virtualTrade: null
      });
      store.addLog('info', '⏹️ Bot stopped by user. Any pending virtual observation was cancelled.');
      saveBotState(false);
      res.json({ message: 'Bot stopped', state: store.state.lifecycleStatus });

    } else if (action === 'set_mode') {
      if (isTradeActive()) return res.json({ error: 'Cannot switch accounts while a trade is active.' });
      if (derivClient) derivClient.setMode(mode);
      res.json({ message: `Switched to ${mode}` });

    } else {
      res.json({ error: 'Unknown action' });
    }
  } catch(err) { res.json({ error: err.message }); }
});

// ============================================================
// MANUAL TRADE
// ============================================================
app.post('/api/trade/manual', async (req, res) => {
  try {
    if (!derivClient || !derivClient.isConnected()) return res.status(503).json({ error: 'Deriv client is disconnected; reconnecting' });

    const stake   = parseFloat(req.body.stake) || store.state.currentStake || 0.35;
    const balance = store.state.balance ?? 0;

    // Enforce Deriv's duration limits on manual trades too.
    const norm = durationUtil.clampDuration(
      req.body.duration || 5,
      req.body.durationUnit || 't',
      liveDurationRanges,
      req.body.symbol
    );
    if (norm.clamped) store.addLog('warn', `⚖️ Manual trade duration clamped to ${norm.duration} ${durationUtil.UNIT_LABELS[norm.unit]} (valid ${norm.min}–${norm.max}).`);

    if (stake < 0.35)    return res.json({ error: 'Minimum stake is $0.35' });
    if (stake > balance) return res.json({ error: `Stake cannot exceed balance of $${balance.toFixed(2)}` });

    const contractId = await derivClient.buyContract({ ...req.body, stake, duration: norm.duration, durationUnit: norm.unit });
    if (!contractId) return res.json({ error: 'Trade execution failed on Deriv side' });

    tradeInProgressSym['global'] = true;
    lockTimestamps['global'] = Date.now();
    store.updateState({ tradeInProgress: true });
    store.addLog('info', `📈 Manual trade placed: ${req.body.contractType} ${req.body.symbol}`);
    res.json({ message: 'Trade request sent' });
  } catch(err) {
    releaseTradeLock(`❌ Manual trade failed and lock was released: ${err.message}`);
    res.json({ error: err.message });
  }
});

// ============================================================
// CONFIG – get / save / reset
// ============================================================
app.get('/api/config', (req, res) => res.json(store.config || {}));

app.post('/api/config', (req, res) => {
  try {
    store.config = { ...store.config, ...req.body };
    normalizeConfigDuration('Saved config');
    if (!saveConfig()) return res.status(500).json({ error: 'Could not persist bot configuration' });
    store.emit('configChanged');
    store.addLog('info', `⚙️ Bot configuration updated. Virtual filter: ${virtualFilter.isEnabled(store.config) ? 'ON' : 'OFF'}; threshold: ${virtualFilter.lossThreshold(store.config)}; return policy: ${virtualFilter.returnMode(store.config)}.`);
    res.json({ success: true });
  } catch(err) { res.json({ error: err.message }); }
});

app.post('/api/config/reset', (req, res) => {
  try {
    // Reset strategy params while preserving all user-selected safety controls.
    const reset = resetStrategyConfig(DEFAULT_CONFIG, store.config);
    store.config = reset.config;
    if (!saveConfig()) return res.status(500).json({ error: 'Could not persist bot configuration' });
    store.emit('configChanged');
    const virtualState = virtualFilter.isEnabled(reset.preserved) ? 'ON' : 'OFF';
    const message = `Strategy defaults restored. Risk and virtual-filter safety controls preserved (TP=$${parseFloat(reset.preserved.BOT_TAKE_PROFIT) || 0}, SL=$${parseFloat(reset.preserved.BOT_STOP_LOSS) || 0}, max runs=${parseInt(reset.preserved.BOT_MAX_RUNS) || 0}, virtual filter=${virtualState}, threshold=${virtualFilter.lossThreshold(reset.preserved)}, return policy=${virtualFilter.returnMode(reset.preserved)}).`;
    store.addLog('info', `↩ ${message}`);
    res.json({
      success: true,
      config: store.config,
      message,
      preservedKeys: PRESERVED_CONFIG_KEYS
    });
  } catch(err) { res.json({ error: err.message }); }
});

// ============================================================
// ANALYTICS
// ============================================================
function emptyAnalytics() {
  return {
    totalProfit: 0, tradeCount: 0, winCount: 0, lossCount: 0,
    grossProfit: 0, grossLoss: 0, maxDrawdown: 0, totalDuration: 0,
    avgWin: 0, avgLoss: 0, strikeRate: 0, profitFactor: 0,
    maxWinStreak: 0, maxLossStreak: 0,
    assetContributions: [], equityData: []
  };
}

app.get('/api/ledger/aggregated', async (req, res) => {
  try {
    const { mode = 'session', account = 'demo', start: customStart, end: customEnd } = req.query;
    const now = new Date();
    let start, end;

    const modeMap = { 'year': '1y', 'week': '1w', 'month': '1m', '24h': '24h', 'session': 'session', 'today': 'today' };
    const cleanMode = modeMap[mode] || mode;

    switch (cleanMode) {
      case '24h':    start = new Date(now.getTime() - 24*60*60*1000); break;
      case 'today':  start = new Date(midnight.getStartOfDay(RESET_TZ(), Date.now())); break; // trading day: midnight → now (tz-aware)
      case '1w':     start = new Date(now.getTime() - 7*24*60*60*1000); break;
      case '1m':     start = new Date(now.getTime() - 30*24*60*60*1000); break;
      case '1y':     start = new Date(now.getTime() - 365*24*60*60*1000); break;
      case 'custom':
        if (customStart) start = new Date(customStart);
        if (customEnd)   end   = new Date(customEnd);
        if (!start) start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        break;
      case 'session':
      default: start = new Date(now.getFullYear(), now.getMonth(), now.getDate()); break;
    }

    if (!supabase) return res.status(503).json({ error: 'Analytics persistence is not configured', ...emptyAnalytics() });
    let query = supabase.from('trading_ledger').select('*')
      .eq('account', account).gte('created_at', start.toISOString());
    if (end) query = query.lte('created_at', end.toISOString());
    query = query.order('created_at', { ascending: true });

    const { data: trades, error } = await query;

    if (error) {
      store.recordError(`Analytics query failed: ${error.message || error}`);
      return res.json(emptyAnalytics());
    }
    if (!trades || trades.length === 0) {
      return res.json(emptyAnalytics());
    }

    let totalProfit = 0, grossProfit = 0, grossLoss = 0;
    let wins = 0, losses = 0, sumWin = 0, sumLoss = 0, sumDuration = 0;
    const assetMap = {};
    const equityCurve = [];
    let runningEquity = 0, peakEquity = 0, maxDrawdown = 0;
    let currentStreak = 0, maxWinStreak = 0, maxLossStreak = 0;

    for (const t of trades) {
      const pnl = parseFloat(t.profit_loss);
      totalProfit += pnl;
      if (pnl > 0) { wins++;   grossProfit += pnl;             sumWin  += pnl; }
      else if (pnl < 0) { losses++; grossLoss += Math.abs(pnl); sumLoss += pnl; }
      sumDuration += parseInt(t.duration_ticks) || 0;

      const asset = t.asset || 'Unknown';
      assetMap[asset] = (assetMap[asset] || 0) + pnl;

      runningEquity += pnl;
      equityCurve.push({ timestamp: t.created_at, equity: runningEquity });
      if (runningEquity > peakEquity) peakEquity = runningEquity;
      if (peakEquity > 0) {
        const dd = ((peakEquity - runningEquity) / peakEquity) * 100;
        if (dd > maxDrawdown) maxDrawdown = dd;
      }

      // Streak tracking
      if (pnl > 0) {
        currentStreak = currentStreak >= 0 ? currentStreak + 1 : 1;
      } else {
        currentStreak = currentStreak <= 0 ? currentStreak - 1 : -1;
      }
      if (currentStreak > maxWinStreak)  maxWinStreak  = currentStreak;
      if (currentStreak < maxLossStreak) maxLossStreak = currentStreak;
    }

    const total        = trades.length;
    const strikeRate   = total > 0 ? (wins / total) * 100 : 0;
    const profitFactor = grossLoss === 0 ? (grossProfit > 0 ? grossProfit : 0) : grossProfit / grossLoss;
    const avgWin       = wins   > 0 ? sumWin   / wins   : 0;
    const avgLoss      = losses > 0 ? Math.abs(sumLoss / losses) : 0;
    const assetContributions = Object.entries(assetMap).map(([name, pnl]) => ({ name, pnl }));

    res.json({
      totalProfit, tradeCount: total, winCount: wins, lossCount: losses,
      grossProfit, grossLoss, maxDrawdown, totalDuration: sumDuration,
      avgWin, avgLoss, strikeRate, profitFactor,
      maxWinStreak, maxLossStreak: Math.abs(maxLossStreak),
      assetContributions, equityData: equityCurve
    });
  } catch(err) {
    console.error('❌ Analytics error:', err);
    res.json(emptyAnalytics());
  }
});

// ============================================================
// DEBUG / HEALTH
// ============================================================
app.get('/debug/state', (req, res) => {
  res.json({
    botActive:       store.state.active,
    balance:         store.state.balance,
    account:         derivClient?.isDemo ? 'demo' : 'real',
    activeAccountId: derivClient?.activeAccountId,
    tradeActive:     isTradeActive(),
    botResetTime:    store.state.botResetTime,
    resetTimezone:   RESET_TZ(),
    sessionTradeCount: store.state.sessionTradeCount,
    executionMode: store.state.executionMode,
    virtualLossStreak: store.state.virtualLossStreak,
    virtualTradeCount: store.state.virtualTradeCount,
    lifecycleStatus: store.state.lifecycleStatus,
    lifecycleReason: store.state.lifecycleReason,
    lastLifecycleEvent: store.state.lastLifecycleEvent,
    connectionState: store.state.connectionState,
    connectionReason: store.state.connectionReason,
    lastTickAt: store.state.lastTickAt,
    lastHeartbeatAt: store.state.lastHeartbeatAt,
    lastError: store.state.lastError
  });
});

app.get('/api/state', (req, res) => res.json(store.getStatePayload()));
app.get('/health', (req, res) => res.json({
  status: 'ok',
  uptime: process.uptime(),
  memory: process.memoryUsage(),
  deriv: derivClient ? 'loaded' : 'unavailable',
  connection: store.state.connectionState,
  lifecycle: store.state.lifecycleStatus,
  lifecycleReason: store.state.lifecycleReason,
  lastTickAt: store.state.lastTickAt,
  lastHeartbeatAt: store.state.lastHeartbeatAt,
  lastError: store.state.lastError
}));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ============================================================
// START SERVER & DERIV
// ============================================================
const PORT   = process.env.PORT || 3000;

// Pull config + active flag from the cloud store BEFORE the Deriv wiring
// attaches, so auto-resume sees the correct pre-restart state.
async function bootCloudSync() {
  if (!cloudStore.available) return;
  try {
    const cfg = await cloudStore.get('bot_config');
    if (cfg && typeof cfg === 'object' && Object.keys(cfg).length) {
      store.config = { ...DEFAULT_CONFIG, ...cfg };
      normalizeConfigDuration('Cloud config'); // clamp legacy values (e.g. old 70-tick default)
      saveConfig(false); // local file mirrors the cloud copy
      console.log('☁️  Config restored from cloud store');
    }
    const st = await cloudStore.get('bot_active');
    if (st && st.active === true && !wasActiveBeforeRestart) {
      wasActiveBeforeRestart = true;
      saveBotState(true);
      console.log('☁️  Cloud store says the bot was ACTIVE — auto-resume enabled');
    }

    // Restore the runtime snapshot so redeploys / instance sleeps resume
    // from where the bot was (mid-pause countdown, daily P&L, counters)
    // instead of hard-resetting to idle.
    const rt = await cloudStore.get('bot_runtime');
    if (rt && typeof rt === 'object') {
      const tz  = RESET_TZ();
      const act = midnight.resolveRestore(rt, Date.now(), tz);
      if (act.action === 'paused') {
        store.updateState(act.patch);
        store.transitionLifecycle(STATUS.PAUSED, rt.lifecycleReason || 'Restored mid-pause from cloud state.', {
          active: false, botResetTime: act.patch.botResetTime
        });
        console.log(`☁️  Runtime restored: PAUSED for the day (${fmtTz(act.patch.botResetTime)}), countdown resumed`);
      } else if (act.action === 'resume') {
        store.updateState({ ...act.patch, tzDayKey: midnight.dayKey(Date.now(), tz) });
        wasActiveBeforeRestart = true;
        saveBotState(true);
        if (store.state.active) store.transitionLifecycle(STATUS.ARMED, 'Restored from cloud state; bot re-armed for the new session.', { active: true, locked: false });
        console.log('☁️  Runtime restored: bot re-armed for a fresh session');
      } else if (act.action === 'idle') {
        store.updateState(act.patch);
        console.log('☁️  Runtime restored: bot was idle — counters recovered, staying idle');
      }
    }
  } catch (e) {
    console.warn(`☁️  Cloud state sync skipped (non-fatal): ${e.message}`);
    console.warn('    If the bot_store table is missing, run the SQL from docs/DEPLOY.md');
  }
}

const server = app.listen(PORT, async () => {
  console.log(`Server listening on port ${server.address().port}`);
  await bootCloudSync();
  store.updateState({ resetTimezone: RESET_TZ() }); // ships to the dashboard via the state payload
  logger.info(`🕛 Daily reset timezone: ${RESET_TZ()} (set BOT_TIMEZONE to change). Auto-resume after restarts: ${store.config.BOT_AUTO_RESUME !== false ? 'ON' : 'OFF'}`);

  // DAILY P&L RECONCILIATION — the in-memory dailyPnl counter starts at 0
  // on every restart (deploy/sleep/crash), but the trading day doesn't.
  // Sum the ledger (the authoritative record) from midnight (RESET_TZ)
  // to now so the bot card, the TP/SL risk checks and the ledger all
  // agree after any restart.
  (async () => {
    try {
      if (!supabase) return;
      const start = new Date(midnight.getStartOfDay(RESET_TZ(), Date.now()));
      const { data: trades, error } = await supabase
        .from('trading_ledger')
        .select('pnl')
        .gte('created_at', start.toISOString());
      if (error) throw error;
      const seeded = (trades || []).reduce((s, t) => s + (parseFloat(t.pnl) || 0), 0);
      const rounded = Math.round(seeded * 100) / 100;
      store.updateState({ dailyPnl: rounded });
      logger.info(`📅 Daily P&L reconciled with the ledger after restart: $${rounded.toFixed(2)} so far today (${RESET_TZ()}).`);
    } catch (err) {
      logger.warn(`⚠️ Daily P&L ledger reconcile failed (${err.message || err}); keeping the restored counter.`);
    }
  })();

  // RUNTIME SNAPSHOT — persist lifecycle/counters to the cloud store
  // whenever they change (5s debounce) so a redeploy or instance sleep
  // resumes from the same point instead of resetting to idle.
  let runtimeDirty = false, lastSnapshot = '';
  store.on('stateChanged', () => { runtimeDirty = true; });
  const snapshotRuntimeState = () => ({
    active: !!store.state.active,
    lifecycleStatus: store.state.lifecycleStatus,
    lifecycleReason: store.state.lifecycleReason,
    botResetTime: store.state.botResetTime,
    dailyPnl: store.state.dailyPnl || 0,
    sessionPnl: store.state.sessionPnl || 0,
    sessionTradeCount: store.state.sessionTradeCount || 0,
    virtualWinCount: store.state.virtualWinCount || 0,
    virtualLossCount: store.state.virtualLossCount || 0,
    virtualTradeCount: store.state.virtualTradeCount || 0,
    virtualLossStreak: store.state.virtualLossStreak || 0,
    executionMode: store.state.executionMode,
    martingaleLevel: store.state.martingaleLevel || 0,
    currentStake: store.state.currentStake || 0,
    martingaleNextStake: store.state.martingaleNextStake || 0,
    at: Date.now()
  });
  setInterval(() => {
    if (!runtimeDirty || !cloudStore.available) return;
    runtimeDirty = false;
    const snap = snapshotRuntimeState();
    const json = JSON.stringify(snap);
    if (json === lastSnapshot) return;
    lastSnapshot = json;
    cloudStore.set('bot_runtime', snap).catch(err =>
      console.warn(`☁️ Cloud runtime sync failed: ${err.message}`));
  }, 5000);

  if (derivClient) {
    const indicators = require('./engine/indicators');
    const bot        = require('./engine/bot');

    let lastTradeCloseTime = 0;
    let lastProposalTime   = 0;

    const transitionArmed = (reason = REASONS.ARMED) => {
      if (store.state.active && !store.state.tradeInProgress) {
        store.transitionLifecycle(STATUS.ARMED, reason, { active: true, locked: false });
      }
    };

    derivClient.on('connection_state', ({ state, reason }) => {
      store.setConnectionState(state, reason);
      if (!store.state.active) return;
      if (state === 'connected') {
        transitionArmed(REASONS.CONNECTION_RECOVERED);
        store.addLog('info', `✅ ${reason}`);
      } else if (state === 'recovering' || state === 'disconnected' || state === 'connecting') {
        const lockActive = isTradeActive();
        store.transitionLifecycle(STATUS.RECOVERING, reason || REASONS.CONNECTION_LOST, {
          active: true,
          locked: false,
          tradeInProgress: lockActive
        });
      }
    });
    derivClient.on('heartbeat', ({ at }) => store.updateState({ lastHeartbeatAt: at }));
    derivClient.on('duration_ranges', ({ ranges }) => {
      liveDurationRanges = ranges;
      store.addLog('info', `📏 Live Deriv duration limits applied for ${Object.keys(ranges).length} symbols.`);
    });

    // Auto-cleanup stuck locks with a bounded timeout.
    setInterval(() => {
      const now = Date.now();
      if (tradeInProgressSym['global'] && isStaleLock(lockTimestamps['global'], now)) {
        releaseTradeLock(`⚠️ Trade lock expired after 120s; no contract response arrived.`);
        transitionArmed(REASONS.TRADE_LOCK_TIMEOUT);
      }
    }, 30000);

    // ============================================================
    // WATCHDOG – make every silent stall LOUD.
    // The classic mystery-stop causes (stalled tick feed, stuck
    // RECOVERING, held trade lock) previously happened invisibly.
    // ============================================================
    let lastTickWarnAt = 0, recoveringWarnAt = 0, lockWarnAt = 0;
    setInterval(() => {
      const now = Date.now();
      if (!store.state.active) return;

      // 1. Tick feed stalled?
      const lastTick = store.state.lastTickAt || 0;
      if (lastTick && now - lastTick > 45000 && now - lastTickWarnAt > 60000) {
        lastTickWarnAt = now;
        store.addLog('error', `🚨 Watchdog: no market ticks for ${Math.round((now - lastTick) / 1000)}s — the price feed is stalled, so no new signals can fire. This is a data-feed issue, not a strategy stop.`);
      }

      // 2. Stuck in RECOVERING?
      if (store.state.lifecycleStatus === STATUS.RECOVERING && now - recoveringWarnAt > 90000) {
        recoveringWarnAt = now;
        store.addLog('warn', `🚨 Watchdog: bot has been RECOVERING for a while. Connection state: ${store.state.connectionState}. Reason: ${store.state.connectionReason || 'unknown'}. The bot stays armed but cannot trade until the connection returns.`);
      }

      // 3. Trade lock held suspiciously long?
      if (tradeInProgressSym['global'] && lockTimestamps['global'] && now - lockTimestamps['global'] > 60000 && now - lockWarnAt > 60000) {
        lockWarnAt = now;
        store.addLog('warn', `🚨 Watchdog: trade lock has been held for ${Math.round((now - lockTimestamps['global']) / 1000)}s. If no settlement arrives, stale-lock cleanup releases it at 120s and the bot re-arms automatically.`);
      }
    }, 20000);

    // ============================================================
    // AUTO-RESUME after a server restart (opt-in via BOT_AUTO_RESUME;
    // defaults ON in fake-data mode, OFF for real trading).
    // ============================================================
    const AUTO_RESUME = store.config.BOT_AUTO_RESUME !== false; // default ON (BOT_AUTO_RESUME=false to disable)
    let autoResumed = false;
    if (AUTO_RESUME) {
      derivClient.on('connection_state', ({ state }) => {
        if (autoResumed || state !== 'connected' || !wasActiveBeforeRestart) return;
        const tp = parseFloat(store.config.BOT_TAKE_PROFIT);
        const sl = parseFloat(store.config.BOT_STOP_LOSS);
        const maxRuns = parseInt(store.config.BOT_MAX_RUNS);
        if (!tp || tp <= 0 || !sl || sl <= 0 || !maxRuns || maxRuns <= 0) return;
        autoResumed = true;
        store.transitionLifecycle(STATUS.STARTING, 'Auto-resume: bot was active before the last server restart.', {
          active: true, locked: false, tradeInProgress: false,
          sessionTradeCount: 0,
          ...virtualFilter.createState(store.config),
          currentStake: parseFloat(store.config.BOT_BASE_STAKE) || 0.35,
          martingaleLevel: 0,
          martingaleNextStake: parseFloat(store.config.BOT_BASE_STAKE) || 0.35
        });
        transitionArmed('Auto-resume: connection is back; bot re-armed.');
        store.addLog('warn', `🔁 AUTO-RESUME: the server restarted (deploy/sleep/crash) while the bot was running. Re-arming automatically because BOT_AUTO_RESUME is on. Set BOT_AUTO_RESUME=false to disable.`);
      });
    }

    // Midnight reset check (every second)
    setInterval(() => {
      const now = Date.now();
      const tz  = RESET_TZ();
      const dayKeyNow = midnight.dayKey(now, tz);

      if (store.state.botResetTime && now >= store.state.botResetTime) {
        store.updateState({ tzDayKey: dayKeyNow });
        const virtualState = virtualFilter.createState(store.config);
        store.transitionLifecycle(STATUS.ARMED, 'New session window started; bot is armed.', {
          active:       true,
          botResetTime: null,
          sessionPnl:   0,
          dailyPnl:     0,
          sessionTradeCount: 0,
          tradeInProgress: false,
          ...virtualState,
          // Keep the paper-trade history visible across an automatic session
          // reset. A deliberate new Start still creates a fresh run.
          virtualWinCount: store.state.virtualWinCount || 0,
          virtualLossCount: store.state.virtualLossCount || 0,
          virtualTradeCount: store.state.virtualTradeCount || 0
        });
        store.addLog('info', `🕛 Midnight reset (${tz}) – bot re-enabled`);
      } else if (store.state.active && store.state.tzDayKey && dayKeyNow !== store.state.tzDayKey) {
        // Running across midnight without a TP/SL pause — roll the daily
        // P&L window so the next day starts fresh.
        store.transitionLifecycle(STATUS.ARMED, 'New day started; daily P&L window reset; bot re-armed.', {
          dailyPnl: 0, sessionPnl: 0, sessionTradeCount: 0, tzDayKey: dayKeyNow
        });
        store.addLog('info', `🕛 New day (${tz}) – daily P&L reset, bot still armed`);
      } else if (!store.state.tzDayKey) {
        store.updateState({ tzDayKey: dayKeyNow });
      }
    }, 1000);

    store.on('configChanged', () => {
      store.tickBuffer.setMaxSize(store.config.ANALYSIS_WINDOW || 500);
      // Make a live toggle safe and deterministic. Enabling the filter while
      // armed always returns to paper mode; disabling it explicitly allows
      // real entries after any current paper trade is finished.
      if (store.state.active && !store.state.virtualTrade && !isTradeActive()) {
        store.updateState({
          executionMode: virtualFilter.isEnabled(store.config) ? 'virtual' : 'real',
          virtualLossStreak: 0
        });
      }
    });

    // Balance streaming
    derivClient.on('balance', (data) => {
      if (!derivClient.activeAccountId) return;
      let balanceValue, currency, loginid;
      if (typeof data.balance === 'string' || typeof data.balance === 'number') {
        balanceValue = data.balance; currency = data.currency || 'USD'; loginid = data.loginid || derivClient.accountId;
      } else if (data.balance && typeof data.balance === 'object') {
        balanceValue = data.balance.balance; currency = data.balance.currency || 'USD'; loginid = data.balance.loginid;
      } else return;

      if (loginid && loginid !== derivClient.activeAccountId) return;
      const mode = data.isDemo !== undefined ? (data.isDemo ? 'demo' : 'real') : (derivClient.isDemo ? 'demo' : 'real');
      store.updateState({ balance: parseFloat(balanceValue), currency, loginid: derivClient.activeAccountId, tradingMode: mode });
      logger.info(`💰 Balance updated: ${currency} ${balanceValue} (${mode})`);
    });

    derivClient.on('authorized', (data) => {
      logger.info(`🔐 Authorized as ${data.loginid || derivClient.activeAccountId}`);
    });

    // ---- TICK HANDLER ----
    derivClient.on('tick', (tick) => {
      try {
      const symbol = tick.symbol;
      const price  = tick.quote;
      store.updateState({ lastTickAt: Date.now(), lastHeartbeatAt: Date.now() });

      store.tickBuffer.push(symbol, price);
      const prices = store.tickBuffer.get(symbol);
      if (prices.length < 2) return;

      const history  = store.getBandwidthHistory(symbol);
      const computed = indicators.computeMetrics(symbol, prices, store.config || {}, history);

      if (computed) {
        if (computed.bandwidth !== null && computed.bandwidth !== undefined) {
          store.pushBandwidth(symbol, computed.bandwidth);
        }
        store.updateMarketMetrics(symbol, computed);

        // Paper-trade settlement uses the live tick stream. No Deriv
        // contract is opened while the bot is in virtual mode.
        const paperTrade = store.state.virtualTrade;
        if (paperTrade && paperTrade.symbol === symbol) {
          const paperResult = virtualFilter.advanceTrade(paperTrade, computed.price);
          if (!paperResult.complete) {
              store.updateState({ virtualTrade: paperResult.trade, tradeInProgress: true });
            return;
          }

          const isWin = paperResult.result === 'WIN';
          const nextLossStreak = isWin
            ? 0
            : (store.state.virtualLossStreak || 0) + 1;
          const nextVirtualState = {
            virtualTrade: null,
            virtualTradeCount: (store.state.virtualTradeCount || 0) + 1,
            virtualLossStreak: nextLossStreak,
            virtualWinCount: (store.state.virtualWinCount || 0) + (isWin ? 1 : 0),
            virtualLossCount: (store.state.virtualLossCount || 0) + (isWin ? 0 : 1)
          };

          const threshold = virtualFilter.lossThreshold(store.config);
          if (!isWin && nextLossStreak >= threshold) {
            nextVirtualState.executionMode = 'real';
            store.addLog('warn', `🧪 Virtual LOSS: ${paperTrade.contractType} ${symbol} (${paperResult.entryPrice} → ${paperResult.exitPrice}); loss streak ${nextLossStreak}/${threshold}. Next qualifying signal may be REAL.`);
          } else {
            store.addLog('info', `🧪 Virtual ${paperResult.result}: ${paperTrade.contractType} ${symbol} (${paperResult.entryPrice} → ${paperResult.exitPrice}); loss streak ${nextLossStreak}/${threshold}.`);
          }

           releaseTradeLock();
           store.updateState(nextVirtualState);
           transitionArmed(REASONS.SETTLED);
          lastTradeCloseTime = Date.now();
          return;
        }

        if (store.state.active && !isTradeActive()) {
          const now = Date.now();
          if (lastProposalTime && (now - lastProposalTime < 2000)) return;

          const signal = bot.evaluate(symbol, computed, store.state, {
            tradeInProgress: isTradeActive(),
            lastCloseTime:   lastTradeCloseTime,
            config:          store.config   // ← correct: pass store.config
          });

          if (signal) {
            // Enforce Deriv's duration limits (live ranges when available).
            const norm = durationUtil.clampDuration(signal.duration, signal.durationUnit, liveDurationRanges, signal.symbol);
            if (norm.clamped) {
              store.addLog('warn', `⚖️ Trade duration ${signal.duration} out of range ${norm.min}–${norm.max}; clamped to ${norm.duration} ${durationUtil.UNIT_LABELS[norm.unit]}.`);
            }
            signal.duration = norm.duration;
            signal.durationUnit = norm.unit;

            if (store.state.executionMode === 'virtual') {
              const obsTicks = durationUtil.durationToTicks(signal.duration, signal.durationUnit, signal.symbol);
              const paperTrade = virtualFilter.createTrade({ ...signal, duration: obsTicks }, computed.price);
              tradeInProgressSym['global'] = true;
              lockTimestamps['global'] = Date.now();
              store.transitionLifecycle(STATUS.TRADING, `Virtual signal accepted for ${signal.symbol}; observing the configured duration.`, {
                virtualTrade: paperTrade,
                tradeInProgress: true,
                locked: true
              });
              store.addLog('info', `🧪 Virtual signal: ${signal.contractType} ${signal.symbol}; observing ${signal.duration} ${durationUtil.UNIT_LABELS[signal.durationUnit]} (~${obsTicks} ticks).`);
              return;
            }

            const mg      = martingaleParams();
            let   stake   = signal.stake || store.state.currentStake || 0.35;
            if (mg.enabled) stake = martingaleStakeForLevel(mg, store.state.martingaleLevel || 0);
            const balance = store.state.balance ?? 0;
            if (stake < 0.35) {
              store.addLog('warn', `⛔ Real signal skipped: stake $${stake.toFixed(2)} is below Deriv minimum.`);
              return;
            }
            if (stake > balance) {
              store.addLog('warn', `⛔ Real signal skipped: stake $${stake.toFixed(2)} exceeds available balance $${Number(balance).toFixed(2)}.`);
              return;
            }

            lastProposalTime = now;
            // Lock before the async proposal begins. Otherwise each tick
            // can open another real contract while proposal is pending.
            tradeInProgressSym['global'] = true;
            lockTimestamps['global']     = Date.now();
            store.transitionLifecycle(STATUS.TRADING, `Real ${signal.contractType} signal accepted; waiting for Deriv settlement.`, {
              tradeInProgress: true,
              locked: true
            });
            const mgNote = mg.enabled && (store.state.martingaleLevel || 0) > 0 ? ` (martingale step ${store.state.martingaleLevel}/${mg.maxSteps})` : '';
            store.addLog('info', `📤 Real signal accepted: ${signal.contractType} ${signal.symbol}, stake $${stake.toFixed(2)}${mgNote}, duration ${signal.duration} ticks.`);

            // CRITICAL: inject the resolved stake (including martingale raises) into the
            // buy request — signal.stake only carries the base stake from the engine.
            derivClient.buyContract({ ...signal, stake }).then(contractId => {
              if (contractId) {
                store.addLog('info', `🤖 Bot trade: ${signal.contractType} ${signal.symbol}`);
              } else {
                releaseTradeLock();
                transitionArmed(REASONS.TRADE_FAILED);
                store.addLog('error', '❌ Real bot trade was not accepted; bot remains armed.');
              }
            }).catch(err => {
              releaseTradeLock(`❌ Real bot trade failed; lock released: ${err.message}`);
              transitionArmed(REASONS.TRADE_FAILED);
            });
          }
        }
      }
      } catch (err) {
        store.recordError(`Tick handler failed: ${err.message}`);
      }
    });

    // ---- TRADE SETTLED ----
    derivClient.on('trade_settled', (trade) => {
      handleTradeSettled(trade).catch(err => {
        store.recordError(`Settlement handler failed: ${err.message}`);
        releaseTradeLock('❌ Settlement processing failed; lock released.');
        transitionArmed(REASONS.TRADE_FAILED);
      });
    });

    async function handleTradeSettled(trade) {
      releaseTradeLock();
      lastTradeCloseTime = Date.now();
      if (store.state.active) transitionArmed(REASONS.SETTLED);

      const profit = parseFloat(trade.profit || 0);
      const result = profit > 0 ? 'WIN' : (profit < 0 ? 'LOSS' : 'BREAKEVEN');
      const sym    = trade.symbol || '?';
      store.addLog('info', `🏁 Trade settled: ${trade.contract_type || '?'} ${sym} – ${result} $${profit.toFixed(2)}`);

      const prevSession = store.state.sessionPnl || 0;
      const prevDaily   = store.state.dailyPnl   || 0;
      const newSessionPnl = prevSession + profit;
      const newDailyPnl   = prevDaily   + profit;
      const newTradeCount = (store.state.sessionTradeCount || 0) + 1;

      store.updateState({ sessionPnl: newSessionPnl, dailyPnl: newDailyPnl, sessionTradeCount: newTradeCount });

      // Stake progression for the next bot trade. Manual trades never
      // affect the progression; bot trades follow martingale when enabled.
      const baseStake = parseFloat(store.config?.BOT_BASE_STAKE) || 0.35;
      const mg        = martingaleParams();
      const isBotTrade = (trade.bot_name || 'manual') !== 'manual';

      if (!isBotTrade) {
        // Manual trade settled: leave the bot's stake progression untouched.
      } else if (!mg.enabled) {
        store.updateState({ martingaleLevel: 0, currentStake: baseStake, martingaleNextStake: baseStake });
        store.addLog('info', `💵 Fixed stake reset to $${baseStake.toFixed(2)} after settlement.`);
      } else if (result === 'WIN') {
        store.updateState({ martingaleLevel: 0, currentStake: baseStake, martingaleNextStake: baseStake });
        store.addLog('info', `💵 Martingale: win → stake reset to base $${baseStake.toFixed(2)}.`);
      } else if (result === 'LOSS') {
        const level = (store.state.martingaleLevel || 0) + 1;
        if (level > mg.maxSteps) {
          store.updateState({ martingaleLevel: 0, currentStake: baseStake, martingaleNextStake: baseStake });
          store.addLog('warn', `⚠️ Martingale: step cap (${mg.maxSteps}) reached without a win → stake reset to base $${baseStake.toFixed(2)}.`);
        } else {
          const next = martingaleStakeForLevel(mg, level);
          store.updateState({ martingaleLevel: level, currentStake: baseStake, martingaleNextStake: next });
          store.addLog('info', `📉 Martingale: loss → next bot stake $${next.toFixed(2)} (step ${level}/${mg.maxSteps}, ×${mg.multiplier}).`);
        }
      }
      // BREAKEVEN keeps the current step unchanged.

      // A real Sniper trade is followed by paper mode according to the
      // selected policy. The default "any" policy prevents loss chasing.
      if (trade.bot_name === 'sniper-bot' &&
          store.state.executionMode === 'real' &&
          virtualFilter.isEnabled(store.config) &&
          virtualFilter.shouldReturnToVirtual(result, store.config)) {
        store.updateState({
          executionMode: 'virtual',
          virtualTrade: null,
          virtualLossStreak: 0
        });
        store.addLog('info', `🔁 Real ${result}; returning to virtual mode (${virtualFilter.returnMode(store.config)} policy).`);
      }

      // Take Profit / Stop Loss based on daily P&L
      const tp = parseFloat(store.config?.BOT_TAKE_PROFIT) || 0;
      const sl = parseFloat(store.config?.BOT_STOP_LOSS)   || 0;

      const riskTransition = resolveRiskTransition({
        dailyPnl: newDailyPnl,
        takeProfit: tp,
        stopLoss: sl,
        tradeCount: newTradeCount,
        maxRuns: parseInt(store.config?.BOT_MAX_RUNS) || 0
      });
      if (riskTransition?.status === STATUS.PAUSED && riskTransition.reason === REASONS.TAKE_PROFIT) {
        const resetTime = getNextMidnight();
        store.transitionLifecycle(riskTransition.status, riskTransition.reason, {
          active: false, botResetTime: resetTime
        });
        store.addLog('info', `🛑 Take Profit reached (${newDailyPnl.toFixed(2)}). Bot paused until ${fmtTz(resetTime)} — auto-restarts at midnight (countdown on the dashboard).`);
        saveBotState(false);
      } else if (riskTransition?.status === STATUS.PAUSED && riskTransition.reason === REASONS.STOP_LOSS) {
        const resetTime = getNextMidnight();
        store.transitionLifecycle(riskTransition.status, riskTransition.reason, {
          active: false, botResetTime: resetTime
        });
        store.addLog('info', `🛑 Stop Loss hit (-${Math.abs(newDailyPnl).toFixed(2)}). Bot paused until ${fmtTz(resetTime)} — auto-restarts at midnight (countdown on the dashboard).`);
        saveBotState(false);
      }

      // Max runs check: stop bot if session limit reached
      const maxRuns = parseInt(store.config?.BOT_MAX_RUNS);
      if (riskTransition?.status === STATUS.COMPLETED && store.state.active) {
        store.transitionLifecycle(riskTransition.status, riskTransition.reason, {
          active: false
        });
        store.addLog('info', `🛑 Max runs reached (${newTradeCount}/${maxRuns}). Bot stopped.`);
        saveBotState(false);
      }

      // Supabase insert
      try {
        const account = derivClient.isDemo ? 'demo' : 'real';
        const record  = {
          asset:          trade.symbol,
          contract_type:  trade.contract_type,
          stake:          parseFloat(trade.stake),
          payout:         parseFloat(trade.payout || 0),
          profit_loss:    profit,
          is_win:         profit > 0,
          barrier:        trade.barrier   ? parseFloat(trade.barrier)    : null,
          exit_tick:      trade.exit_price ? parseFloat(trade.exit_price) : null,
          contract_id:    trade.contract_id,
          entry_price:    trade.entry_price ? parseFloat(trade.entry_price) : null,
          exit_price:     trade.exit_price  ? parseFloat(trade.exit_price)  : null,
          duration_ticks: parseInt(trade.duration_ticks) || 0,
          bot_name:       trade.bot_name || 'manual',
          account
        };
        if (!supabase) throw new Error('Supabase is not configured; trade was not persisted.');
        const { error } = await supabase.from('trading_ledger').insert(record);
        if (error) {
          store.recordError(`Failed to persist settled trade: ${error.message || error}`);
        }
        else console.log('✅ Trade recorded:', record.asset, profit, 'account:', account);
      } catch(e) {
        store.recordError(`Trade persistence failed: ${e.message}`);
      }
    }

    derivClient.connect();
  }
});

// Helper: next midnight in the configured daily-reset timezone.
// (was hardcoded EAT/UTC+3 — 02:30 for IST users; now BOT_TIMEZONE,
//  default Africa/Nairobi = East Africa Time so "restart at midnight" means YOUR midnight)
function getNextMidnight() {
  return midnight.getNextMidnight(RESET_TZ());
}
function fmtTz(ts) {
  const tz = RESET_TZ();
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts)) + ' ' + tz;
}

process.on('SIGTERM', () => server.close(() => process.exit(0)));
