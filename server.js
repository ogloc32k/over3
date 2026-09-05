// server.js
require('dotenv').config();

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const supabase = require('./services/supabase');
const virtualFilter = require('./engine/virtualFilter');
const { resetStrategyConfig, PRESERVED_CONFIG_KEYS } = require('./engine/configReset');
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
try { derivClient = require('./services/deriv'); console.log('✅ Deriv client loaded'); } catch(e) { console.error('❌ deriv.js:', e); derivClient = null; }

process.on('uncaughtException', err => processError('UNCAUGHT EXCEPTION', err));
process.on('unhandledRejection', reason => processError('UNHANDLED REJECTION', reason));

if (derivClient) derivClient.setStore(store);

// ============================================================
// PERSISTENT CONFIG  (bot_config.json next to server.js)
// ============================================================
const CONFIG_PATH = process.env.BOT_CONFIG_PATH || path.join(__dirname, 'bot_config.json');

const DEFAULT_CONFIG = {
  BOT_DURATION:           70,
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
  BOT_VIRTUAL_FILTER_ENABLED: true,
  BOT_VIRTUAL_LOSS_THRESHOLD: 4,
  BOT_VIRTUAL_RETURN_MODE: 'any'
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

function saveConfig() {
  try {
    const temporaryPath = `${CONFIG_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(store.config, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, CONFIG_PATH);
    return true;
  } catch(e) {
    store.recordError(`Failed to save bot configuration: ${e.message}`);
    return false;
  }
}

loadConfig();
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
app.use((req, res, next) => { console.log(`📡 ${req.method} ${req.url}`); next(); });
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
  const writeState = () => {
    if (closed || res.writableEnded) return;
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
  const onChange = writeState;
  const heartbeat = setInterval(() => {
    if (closed || res.writableEnded) return;
    try { res.write(': heartbeat\n\n'); } catch (_) { closed = true; }
  }, 25000);
  store.on('stateChanged', onChange);
  req.on('close', () => {
    closed = true;
    store.removeListener('stateChanged', onChange);
    clearInterval(heartbeat);
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
        currentStake: parseFloat(store.config.BOT_BASE_STAKE) || 0.35
      });
      if (derivClient && derivClient.isConnected()) {
        store.transitionLifecycle(STATUS.ARMED, REASONS.ARMED);
      } else {
        store.transitionLifecycle(STATUS.RECOVERING, REASONS.CONNECTION_WAIT, {
          active: true
        });
      }
      store.addLog('info', `✅ Bot started in ${store.state.executionMode.toUpperCase()} mode. TP=$${tp.toFixed(2)}, SL=$${sl.toFixed(2)}, max runs=${maxRuns}.`);
      res.json({ message: 'Bot started', state: store.state.lifecycleStatus });

    } else if (action === 'stop') {
      releaseTradeLock();
      store.transitionLifecycle(STATUS.STOPPED, resolvePauseReason({ userStop: true }), {
        active: false, locked: false, tradeInProgress: false, virtualTrade: null
      });
      store.addLog('info', '⏹️ Bot stopped by user. Any pending virtual observation was cancelled.');
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

    if (stake < 0.35)    return res.json({ error: 'Minimum stake is $0.35' });
    if (stake > balance) return res.json({ error: `Stake cannot exceed balance of $${balance.toFixed(2)}` });

    const contractId = await derivClient.buyContract({ ...req.body, stake });
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

    const modeMap = { 'year': '1y', 'week': '1w', 'month': '1m', '24h': '24h', 'session': 'session' };
    const cleanMode = modeMap[mode] || mode;

    switch (cleanMode) {
      case '24h':    start = new Date(now.getTime() - 24*60*60*1000); break;
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
const server = app.listen(PORT, () => {
  console.log(`Server listening on port ${server.address().port}`);

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

    // Auto-cleanup stuck locks with a bounded timeout.
    setInterval(() => {
      const now = Date.now();
      if (tradeInProgressSym['global'] && isStaleLock(lockTimestamps['global'], now)) {
        releaseTradeLock(`⚠️ Trade lock expired after 120s; no contract response arrived.`);
        transitionArmed(REASONS.TRADE_LOCK_TIMEOUT);
      }
    }, 30000);

    // Midnight reset check (every second)
    setInterval(() => {
      const now = Date.now();
      if (store.state.botResetTime && now >= store.state.botResetTime) {
        store.transitionLifecycle(STATUS.ARMED, 'New session window started; bot is armed.', {
          active:       true,
          botResetTime: null,
          sessionPnl:   0,
          dailyPnl:     0,
          sessionTradeCount: 0,
          tradeInProgress: false,
          ...virtualFilter.createState(store.config)
        });
        store.addLog('info', '🕛 Midnight reset – bot re-enabled');
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
            if (store.state.executionMode === 'virtual') {
              const paperTrade = virtualFilter.createTrade(signal, computed.price);
              tradeInProgressSym['global'] = true;
              lockTimestamps['global'] = Date.now();
              store.transitionLifecycle(STATUS.TRADING, `Virtual signal accepted for ${signal.symbol}; observing the configured duration.`, {
                virtualTrade: paperTrade,
                tradeInProgress: true,
                locked: true
              });
              store.addLog('info', `🧪 Virtual signal: ${signal.contractType} ${signal.symbol}; observing ${signal.duration} ticks.`);
              return;
            }

            const stake   = signal.stake || store.state.currentStake || 0.35;
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
            store.addLog('info', `📤 Real signal accepted: ${signal.contractType} ${signal.symbol}, stake $${stake.toFixed(2)}, duration ${signal.duration} ticks.`);

            derivClient.buyContract(signal).then(contractId => {
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

      // Fixed stake only. Never double after a loss: martingale converts an
      // ordinary losing streak into an account-threatening exposure spike.
      const baseStake = parseFloat(store.config?.BOT_BASE_STAKE) || 0.35;
      store.updateState({ currentStake: baseStake });
      store.addLog('info', `💵 Fixed stake reset to $${baseStake.toFixed(2)} after settlement.`);

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
        const resetTime = getNextMidnightEAT();
        store.transitionLifecycle(riskTransition.status, riskTransition.reason, {
          active: false, botResetTime: resetTime
        });
        store.addLog('info', `🛑 Take Profit reached ($${newDailyPnl.toFixed(2)}). Bot paused until ${new Date(resetTime).toLocaleTimeString()}`);
      } else if (riskTransition?.status === STATUS.PAUSED && riskTransition.reason === REASONS.STOP_LOSS) {
        const resetTime = getNextMidnightEAT();
        store.transitionLifecycle(riskTransition.status, riskTransition.reason, {
          active: false, botResetTime: resetTime
        });
        store.addLog('info', `🛑 Stop Loss hit (-$${Math.abs(newDailyPnl).toFixed(2)}). Bot paused until ${new Date(resetTime).toLocaleTimeString()}`);
      }

      // Max runs check: stop bot if session limit reached
      const maxRuns = parseInt(store.config?.BOT_MAX_RUNS);
      if (riskTransition?.status === STATUS.COMPLETED && store.state.active) {
        store.transitionLifecycle(riskTransition.status, riskTransition.reason, {
          active: false
        });
        store.addLog('info', `🛑 Max runs reached (${newTradeCount}/${maxRuns}). Bot stopped.`);
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

// Helper: next midnight East Africa Time (UTC+3)
function getNextMidnightEAT() {
  const now          = new Date();
  const eatOffset    = 3 * 60 * 60 * 1000;
  const eatNow       = new Date(now.getTime() + eatOffset);
  const nextMidnight = new Date(eatNow);
  nextMidnight.setUTCHours(21, 0, 0, 0); // 21:00 UTC = 00:00 EAT
  if (nextMidnight <= now) nextMidnight.setUTCDate(nextMidnight.getUTCDate() + 1);
  return nextMidnight.getTime();
}

process.on('SIGTERM', () => server.close(() => process.exit(0)));
