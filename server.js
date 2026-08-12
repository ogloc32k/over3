// server.js
require('dotenv').config();

process.on('uncaughtException',  err    => { console.error('🔥 UNCAUGHT EXCEPTION', err);  process.exit(1); });
process.on('unhandledRejection', reason => { console.error('🔥 UNHANDLED REJECTION', reason); process.exit(1); });

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const supabase = require('./services/supabase');

let store, logger, derivClient;
try { store       = require('./store');           console.log('✅ Store loaded');        } catch(e) { console.error('❌ store.js:', e); process.exit(1); }
try { logger      = require('./logger');          console.log('✅ Logger loaded');       } catch(e) { console.error('❌ logger.js:', e); process.exit(1); }
try { derivClient = require('./services/deriv'); console.log('✅ Deriv client loaded'); } catch(e) { console.error('❌ deriv.js:', e); derivClient = null; }

if (derivClient) derivClient.setStore(store);

// ============================================================
// PERSISTENT CONFIG  (bot_config.json next to server.js)
// ============================================================
const CONFIG_PATH = path.join(__dirname, 'bot_config.json');

const DEFAULT_CONFIG = {
  // ── Risk controls (required to start) ──────────────────────
  BOT_TAKE_PROFIT:              null,
  BOT_STOP_LOSS:                null,
  BOT_MAX_RUNS:                 null,
  BOT_COOLDOWN:                 5,

  // ── Trade execution ─────────────────────────────────────────
  BOT_DURATION:                 70,
  BOT_BASE_STAKE:               0.35,
  TRADE_DIRECTION:              'CALL',   // 'CALL' or 'PUT'

  // ── Martingale staking ──────────────────────────────────────
  // Set MARTINGALE_MULTIPLIER to 1 to disable doubling (flat staking)
  MARTINGALE_MULTIPLIER:        2,
  MARTINGALE_MAX_STAKE:         100,

  // ── Market scanner ──────────────────────────────────────────
  // Bot only evaluates these symbols. Dashboard still shows all markets.
  SELECTED_MARKETS: [
    'R_10','R_25','R_50','R_75','R_100',
    '1HZ10V','1HZ25V','1HZ50V','1HZ75V','1HZ100V'
  ],

  // ── Entry conditions ────────────────────────────────────────
  // All enabled conditions must pass together (AND logic).
  // If none are enabled the bot stays silent.

  // Condition 1 – Price breaks below Support
  COND_PRICE_UNDER_SUPPORT_ENABLED:   false,

  // Condition 2 – Price breaks above Resistance
  COND_PRICE_OVER_RESISTANCE_ENABLED: false,

  // Condition 3 – Support % in range
  // (supportPct: 100 = at support, 0 = at resistance)
  COND_SUPPORT_PCT_ENABLED: false,
  COND_SUPPORT_PCT_MIN:     0,
  COND_SUPPORT_PCT_MAX:     20,

  // Condition 4 – Resistance % in range
  // (resistancePct: 100 = at resistance, 0 = at support)
  COND_RESISTANCE_PCT_ENABLED: false,
  COND_RESISTANCE_PCT_MIN:     80,
  COND_RESISTANCE_PCT_MAX:     100,

  // Condition 5 – Rise % in range
  COND_RISE_PCT_ENABLED: false,
  COND_RISE_PCT_MIN:     50,
  COND_RISE_PCT_MAX:     100,

  // Condition 6 – Fall % in range
  COND_FALL_PCT_ENABLED: false,
  COND_FALL_PCT_MIN:     50,
  COND_FALL_PCT_MAX:     100,

  // Condition 7 – RSI in range
  COND_RSI_ENABLED: false,
  COND_RSI_MIN:     0,
  COND_RSI_MAX:     30,

  // Condition 8 – BB Squeeze percentile in range
  COND_BB_SQUEEZE_ENABLED: false,
  COND_BB_SQUEEZE_MIN:     0,
  COND_BB_SQUEEZE_MAX:     20,

  // Condition 9 – Last-N ticks sequence (R = rise, F = fall)
  COND_TICK_SEQ_ENABLED: false,
  COND_TICK_SEQ_PATTERN: 'RR',

  // ── Always-on / auto-restart ─────────────────────────────────
  // When true the bot re-arms itself automatically after a server restart.
  // Set by the Start/Stop buttons — do not edit manually.
  BOT_ARMED: false,
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw   = fs.readFileSync(CONFIG_PATH, 'utf8');
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
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(store.config, null, 2), 'utf8');
  } catch(e) {
    console.error('❌ Failed to save config:', e.message);
  }
}

loadConfig();

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

  const onChange = () => {
    const payload = store.getStatePayload();
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  store.on('stateChanged', onChange);
  req.on('close', () => store.removeListener('stateChanged', onChange));
});

// ============================================================
// TRADE LOCK
// ============================================================
const tradeInProgressSym = {};
const lockTimestamps     = {};

function isTradeActive() { return tradeInProgressSym['global'] === true; }

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
      if (!tp  || tp  <= 0) return res.json({ error: 'Set Take Profit before starting the bot.' });
      if (!sl  || sl  <= 0) return res.json({ error: 'Set Stop Loss before starting the bot.' });
      if (!maxRuns || maxRuns <= 0) return res.json({ error: 'Set Max Runs before starting the bot.' });

      // Warn if no markets selected
      const selMkts = store.config.SELECTED_MARKETS;
      if (Array.isArray(selMkts) && selMkts.length === 0) {
        return res.json({ error: 'Select at least one market in the Market Scanner before starting.' });
      }

      // Fresh start: reset session stats and stake
      const baseStake = parseFloat(store.config.BOT_BASE_STAKE) || 0.35;
      store.updateState({ active: true, locked: false, sessionTradeCount: 0, sessionPnl: 0, currentStake: baseStake, botResetTime: null });

      // Persist armed state so the bot auto-resumes after a server restart
      store.config.BOT_ARMED = true;
      saveConfig();
      store.addLog('info', '✅ Bot started');
      res.json({ message: 'Bot started' });

    } else if (action === 'stop') {
      store.updateState({ active: false });
      tradeInProgressSym['global'] = false;
      // Clear armed flag so the bot does NOT auto-restart after a server reboot
      store.config.BOT_ARMED = false;
      saveConfig();
      store.addLog('info', '⏹️ Bot stopped');
      res.json({ message: 'Bot stopped' });

    } else if (action === 'set_mode') {
      if (isTradeActive()) return res.json({ error: 'Cannot switch accounts while a trade is active.' });
      if (derivClient) derivClient.setMode(mode);
      // Clear all P&L so the bot card shows fresh stats for the new account
      store.updateState({ sessionPnl: 0, dailyPnl: 0, sessionTradeCount: 0, currentStake: 0.35, active: false, botResetTime: null });
      store.config.BOT_ARMED = false;
      saveConfig();
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
    if (!derivClient) return res.json({ error: 'Deriv client not connected' });

    const stake   = parseFloat(req.body.stake) || store.state.currentStake || 0.35;
    const balance = store.state.balance ?? 0;

    if (stake < 0.35)    return res.json({ error: 'Minimum stake is $0.35' });
    if (stake > balance) return res.json({ error: `Stake cannot exceed balance of $${balance.toFixed(2)}` });

    const contractId = await derivClient.buyContract({ ...req.body, stake });
    if (!contractId) return res.json({ error: 'Trade execution failed on Deriv side' });

    tradeInProgressSym['global'] = true;
    // [MANUAL] prefix lets the log stream visually separate manual from bot trades
    store.addLog('info', `[MANUAL] 📈 ${req.body.contractType} on ${req.body.symbol} — stake $${stake.toFixed(2)}`);
    res.json({ message: 'Trade request sent' });
  } catch(err) {
    tradeInProgressSym['global'] = false;
    res.json({ error: err.message });
  }
});

// ============================================================
// CONFIG – get / save / reset
// ============================================================
app.get('/api/config', (req, res) => res.json(store.config || {}));

app.post('/api/config', (req, res) => {
  try {
    // SELECTED_MARKETS must remain an array; guard against bad client data
    const incoming = { ...req.body };
    if (incoming.SELECTED_MARKETS !== undefined && !Array.isArray(incoming.SELECTED_MARKETS)) {
      try { incoming.SELECTED_MARKETS = JSON.parse(incoming.SELECTED_MARKETS); } catch(_) {
        incoming.SELECTED_MARKETS = DEFAULT_CONFIG.SELECTED_MARKETS;
      }
    }
    store.config = { ...store.config, ...incoming };
    saveConfig();
    store.emit('configChanged');
    res.json({ success: true });
  } catch(err) { res.json({ error: err.message }); }
});

app.post('/api/config/reset', (req, res) => {
  try {
    // Preserve user's critical settings so a reset doesn't wipe trade safety values
    const preserve = {
      BOT_TAKE_PROFIT:  store.config.BOT_TAKE_PROFIT,
      BOT_STOP_LOSS:    store.config.BOT_STOP_LOSS,
      BOT_MAX_RUNS:     store.config.BOT_MAX_RUNS,
      SELECTED_MARKETS: store.config.SELECTED_MARKETS,  // also preserve market selection
    };
    store.config = { ...DEFAULT_CONFIG, ...preserve };
    saveConfig();
    store.emit('configChanged');
    res.json({ success: true, config: store.config });
  } catch(err) { res.json({ error: err.message }); }
});

// ============================================================
// ANALYTICS
// ============================================================
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

    let query = supabase.from('trading_ledger').select('*')
      .eq('account', account).gte('created_at', start.toISOString());
    if (end) query = query.lte('created_at', end.toISOString());
    query = query.order('created_at', { ascending: true });

    const { data: trades, error } = await query;

    if (error || !trades || trades.length === 0) {
      return res.json({
        totalProfit: 0, tradeCount: 0, winCount: 0, lossCount: 0,
        grossProfit: 0, grossLoss: 0, maxDrawdown: 0, totalDuration: 0,
        avgWin: 0, avgLoss: 0, strikeRate: 0, profitFactor: 0,
        maxWinStreak: 0, maxLossStreak: 0,
        assetContributions: [], equityData: []
      });
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
    res.json({
      totalProfit: 0, tradeCount: 0, winCount: 0, lossCount: 0,
      grossProfit: 0, grossLoss: 0, maxDrawdown: 0, totalDuration: 0,
      avgWin: 0, avgLoss: 0, strikeRate: 0, profitFactor: 0,
      maxWinStreak: 0, maxLossStreak: 0,
      assetContributions: [], equityData: []
    });
  }
});

// ============================================================
// DEBUG / HEALTH
// ============================================================
app.get('/debug/state', (req, res) => {
  res.json({
    botActive:         store.state.active,
    balance:           store.state.balance,
    account:           derivClient?.isDemo ? 'demo' : 'real',
    activeAccountId:   derivClient?.activeAccountId,
    tradeActive:       isTradeActive(),
    botResetTime:      store.state.botResetTime,
    sessionTradeCount: store.state.sessionTradeCount,
    selectedMarkets:   store.config.SELECTED_MARKETS,
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ============================================================
// START SERVER & DERIV
// ============================================================
const PORT   = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`);

  if (derivClient) {
    const indicators = require('./engine/indicators');
    const bot        = require('./engine/bot');

    let lastTradeCloseTime = 0;
    let lastProposalTime   = 0;

    // Auto-cleanup stuck locks (2 min)
    setInterval(() => {
      const now = Date.now();
      if (tradeInProgressSym['global'] && lockTimestamps['global'] &&
          (now - lockTimestamps['global'] > 120000)) {
        tradeInProgressSym['global'] = false;
        delete lockTimestamps['global'];
        store.addLog('warn', '⚠️ Trade lock auto-released after 2 minutes');
      }
    }, 30000);

    // Midnight reset check (every second)
    setInterval(() => {
      const now = Date.now();
      if (store.state.botResetTime && now >= store.state.botResetTime) {
        store.updateState({
          active:            true,
          botResetTime:      null,
          sessionPnl:        0,
          dailyPnl:          0,
          sessionTradeCount: 0
        });
        store.addLog('info', '🕛 Midnight reset – bot re-enabled');
      }
    }, 1000);

    store.on('configChanged', () => {
      store.tickBuffer.setMaxSize(store.config.ANALYSIS_WINDOW || 500);
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

      // ── Always-on auto-resume ─────────────────────────────────
      // If BOT_ARMED was true when the server last shut down, re-arm the bot
      // automatically so it keeps running through accidental restarts.
      if (store.config.BOT_ARMED) {
        const tp      = parseFloat(store.config.BOT_TAKE_PROFIT);
        const sl      = parseFloat(store.config.BOT_STOP_LOSS);
        const maxRuns = parseInt(store.config.BOT_MAX_RUNS);
        const selMkts = store.config.SELECTED_MARKETS;
        const hasMarkets = Array.isArray(selMkts) && selMkts.length > 0;
        if (tp > 0 && sl > 0 && maxRuns > 0 && hasMarkets) {
          const baseStake = parseFloat(store.config.BOT_BASE_STAKE) || 0.35;
          store.updateState({ active: true, locked: false, sessionTradeCount: 0, sessionPnl: 0, currentStake: baseStake, botResetTime: null });
          logger.info('🔄 Auto-resumed: bot was armed before server restart');
        } else {
          store.config.BOT_ARMED = false;
          saveConfig();
          logger.warn('⚠️ Auto-resume skipped: TP / SL / Max Runs / Markets not fully configured');
        }
      }
    });

    // ── TICK HANDLER ─────────────────────────────────────────
    derivClient.on('tick', (tick) => {
      const symbol = tick.symbol;
      const price  = tick.quote;

      store.tickBuffer.push(symbol, price);
      const prices = store.tickBuffer.get(symbol);
      if (prices.length < 2) return;

      const history  = store.getBandwidthHistory(symbol);
      const computed = indicators.computeMetrics(symbol, prices, store.config || {}, history);

      if (computed) {
        if (computed.bandwidth !== null && computed.bandwidth !== undefined) {
          store.pushBandwidth(symbol, computed.bandwidth);
        }
        // Always update dashboard metrics regardless of selected markets
        store.updateMarketMetrics(symbol, computed);

        // Only evaluate bot signals for selected markets
        const selectedMarkets = store.config.SELECTED_MARKETS;
        const isSelected = Array.isArray(selectedMarkets) && selectedMarkets.length > 0
          ? selectedMarkets.includes(symbol)
          : false; // empty selection = bot does not trade

        if (isSelected && store.state.active && !isTradeActive()) {
          const now = Date.now();
          // Throttle proposals to max once every 2 seconds
          if (lastProposalTime && (now - lastProposalTime < 2000)) return;

          const signal = bot.evaluate(symbol, computed, store.state, {
            tradeInProgress: isTradeActive(),
            lastCloseTime:   lastTradeCloseTime,
            config:          store.config
          });

          if (signal) {
            const stake   = signal.stake || store.state.currentStake || 0.35;
            const balance = store.state.balance ?? 0;
            if (stake < 0.35 || stake > balance) return;

            lastProposalTime = now;

            derivClient.buyContract(signal).then(contractId => {
              if (contractId) {
                tradeInProgressSym['global'] = true;
                lockTimestamps['global']     = Date.now();
                // [BOT] prefix lets the log stream distinguish bot from manual trades
                store.addLog('info', `[BOT] 🤖 ${signal.contractType} on ${signal.symbol} — stake $${stake.toFixed(2)}`);
              }
            });
          }
        }
      }
    });

    // ── TRADE SETTLED ────────────────────────────────────────
    derivClient.on('trade_settled', async (trade) => {
      tradeInProgressSym['global'] = false;
      delete lockTimestamps['global'];
      lastTradeCloseTime = Date.now();

      const profit = parseFloat(trade.profit || 0);
      const result = profit > 0 ? 'WIN' : (profit < 0 ? 'LOSS' : 'BREAKEVEN');
      const sym    = trade.symbol || '?';
      const src    = trade.bot_name === 'manual' ? '[MANUAL]' : '[BOT]';
      store.addLog('info', `${src} 🏁 ${trade.contract_type || '?'} ${sym} – ${result} $${profit.toFixed(2)}`);

      const prevSession = store.state.sessionPnl || 0;
      const prevDaily   = store.state.dailyPnl   || 0;
      const newSessionPnl = prevSession + profit;
      const newDailyPnl   = prevDaily   + profit;
      const newTradeCount = (store.state.sessionTradeCount || 0) + 1;

      store.updateState({ sessionPnl: newSessionPnl, dailyPnl: newDailyPnl, sessionTradeCount: newTradeCount });

      // ── Martingale staking (configurable multiplier + cap) ──
      if (profit > 0) {
        // Win → reset to base stake
        const baseStake = parseFloat(store.config?.BOT_BASE_STAKE) || 0.35;
        store.updateState({ currentStake: baseStake });
        store.addLog('info', `[BOT] 📉 Stake reset to $${baseStake.toFixed(2)} after WIN`);
      } else {
        // Loss → multiply stake, capped at MARTINGALE_MAX_STAKE
        const multiplier = parseFloat(store.config?.MARTINGALE_MULTIPLIER) || 2;
        const maxStake   = parseFloat(store.config?.MARTINGALE_MAX_STAKE)  || 100;
        const current    = parseFloat(store.state.currentStake)           || 0.35;
        const newStake   = parseFloat(Math.min(current * multiplier, maxStake).toFixed(2));
        store.updateState({ currentStake: newStake });
        if (multiplier > 1) {
          store.addLog('info', `[BOT] 📈 Stake ×${multiplier} → $${newStake.toFixed(2)} after LOSS (cap $${maxStake})`);
        }
      }

      // ── Take Profit / Stop Loss (checked against daily P&L) ──
      const tp = parseFloat(store.config?.BOT_TAKE_PROFIT) || 0;
      const sl = parseFloat(store.config?.BOT_STOP_LOSS)   || 0;

      if (tp > 0 && newDailyPnl >= tp) {
        store.updateState({ active: false });
        const resetTime = getNextMidnightEAT();
        store.updateState({ botResetTime: resetTime });
        store.addLog('info', `🛑 Take Profit reached (+$${newDailyPnl.toFixed(2)}). Bot paused until midnight EAT.`);
      } else if (sl > 0 && newDailyPnl <= -sl) {
        store.updateState({ active: false });
        const resetTime = getNextMidnightEAT();
        store.updateState({ botResetTime: resetTime });
        store.addLog('info', `🛑 Stop Loss hit (-$${Math.abs(newDailyPnl).toFixed(2)}). Bot paused until midnight EAT.`);
      }

      // ── Max runs: stop bot when session limit reached ──────
      const maxRuns = parseInt(store.config?.BOT_MAX_RUNS);
      if (maxRuns > 0 && newTradeCount >= maxRuns) {
        store.updateState({ active: false });
        store.addLog('info', `🛑 Max runs reached (${newTradeCount}/${maxRuns}). Bot stopped.`);
      }

      // ── Supabase ledger insert ─────────────────────────────
      try {
        const account = derivClient.isDemo ? 'demo' : 'real';
        const record  = {
          asset:          trade.symbol,
          contract_type:  trade.contract_type,
          stake:          parseFloat(trade.stake),
          payout:         parseFloat(trade.payout || 0),
          profit_loss:    profit,
          is_win:         profit > 0,
          barrier:        trade.barrier    ? parseFloat(trade.barrier)     : null,
          exit_tick:      trade.exit_price ? parseFloat(trade.exit_price)  : null,
          contract_id:    trade.contract_id,
          entry_price:    trade.entry_price ? parseFloat(trade.entry_price) : null,
          exit_price:     trade.exit_price  ? parseFloat(trade.exit_price)  : null,
          duration_ticks: parseInt(trade.duration_ticks) || 0,
          bot_name:       trade.bot_name || 'manual',   // 'manual' or 'sniper'
          account
        };
        const { error } = await supabase.from('trading_ledger').insert(record);
        if (error) console.error('❌ Failed to insert trade:', error);
        else       console.log('✅ Trade recorded:', record.asset, profit, '→', account);
      } catch(e) { console.error('❌ trade_settled handler error:', e); }
    });

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
