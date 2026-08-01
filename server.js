// server.js – Final Production Version (TP/SL based on daily P&L)
require('dotenv').config();

process.on('uncaughtException', err => { console.error('🔥 UNCAUGHT EXCEPTION', err); process.exit(1); });
process.on('unhandledRejection', reason => { console.error('🔥 UNHANDLED REJECTION', reason); process.exit(1); });

const express = require('express');
const path = require('path');
const supabase = require('./services/supabase');

let store, logger, derivClient;
try { store = require('./store'); console.log('✅ Store loaded'); } catch(e) { console.error('❌ store.js:', e); process.exit(1); }
try { logger = require('./logger'); console.log('✅ Logger loaded'); } catch(e) { console.error('❌ logger.js:', e); process.exit(1); }
try { derivClient = require('./services/deriv'); console.log('✅ Deriv client loaded'); } catch(e) { console.error('❌ deriv.js:', e); derivClient = null; }

if (derivClient) derivClient.setStore(store);

const app = express();
app.use(express.json());
app.use((req, res, next) => { console.log(`📡 ${req.method} ${req.url}`); next(); });
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// SSE STREAM
// ============================================================
app.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
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
// REST API
// ============================================================

// ---------- Global trade lock ----------
const tradeInProgressSym = {};

function isTradeActive() {
  return tradeInProgressSym['global'] === true;
}

// Control endpoint
app.post('/api/control', (req, res) => {
  const { action, mode } = req.body;
  console.log('🟡 POST /api/control body:', req.body);
  try {
    if (action === 'start') {
      store.updateState({ active: true, locked: false });
      store.addLog('info', '✅ Bot started');
      res.json({ message: 'Bot started' });
    } else if (action === 'stop') {
      store.updateState({ active: false });
      tradeInProgressSym['global'] = false;
      store.addLog('info', '⏹️ Bot stopped');
      res.json({ message: 'Bot stopped' });
    } else if (action === 'set_mode') {
      if (isTradeActive()) {
        return res.json({ error: 'Cannot switch accounts while a trade is active.' });
      }
      if (derivClient) derivClient.setMode(mode);
      res.json({ message: `Switched to ${mode}` });
    } else res.json({ error: 'Unknown action' });
  } catch (err) { res.json({ error: err.message }); }
});

// Manual trade
app.post('/api/trade/manual', async (req, res) => {
  try {
    if (!derivClient) return res.json({ error: 'Deriv client not connected' });

    const stake = parseFloat(req.body.stake) || store.state.currentStake || 0.35;
    const balance = store.state.balance ?? 0;

    if (stake < 0.35) return res.json({ error: 'Minimum stake is $0.35' });
    if (stake > balance) return res.json({ error: `Stake cannot exceed balance of $${balance.toFixed(2)}` });

    const contractId = await derivClient.buyContract({ ...req.body, stake });
    if (!contractId) return res.json({ error: 'Trade execution failed on Deriv side' });

    tradeInProgressSym['global'] = true;
    store.addLog('info', `📈 Manual trade placed: ${req.body.contractType} ${req.body.symbol}`);
    res.json({ message: 'Trade request sent' });
  } catch (err) {
    tradeInProgressSym['global'] = false;
    res.json({ error: err.message });
  }
});

// Config – stores sniper bot settings
app.get('/api/config', (req, res) => res.json(store.config || {}));
app.post('/api/config', (req, res) => {
  try {
    store.config = { ...store.config, ...req.body };
    store.emit('configChanged');
    res.json({ success: true });
  } catch (err) { res.json({ error: err.message }); }
});

// ============================================================
// ANALYTICS – FULL ENDPOINT
// ============================================================
app.get('/api/ledger/aggregated', async (req, res) => {
  try {
    const { mode = 'session', account = 'demo', start: customStart, end: customEnd } = req.query;
    const now = new Date();
    let start, end;

    const modeMap = { 'year': '1y', 'week': '1w', 'month': '1m', '24h': '24h', 'session': 'session' };
    const cleanMode = modeMap[mode] || mode;

    switch (cleanMode) {
      case '24h': start = new Date(now.getTime() - 24*60*60*1000); break;
      case '1w':  start = new Date(now.getTime() - 7*24*60*60*1000); break;
      case '1m':  start = new Date(now.getTime() - 30*24*60*60*1000); break;
      case '1y':  start = new Date(now.getTime() - 365*24*60*60*1000); break;
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
        assetContributions: [], equityData: []
      });
    }

    let totalProfit=0, grossProfit=0, grossLoss=0, wins=0, losses=0, sumWin=0, sumLoss=0, sumDuration=0;
    const assetMap = {};
    const equityCurve = [];
    let runningEquity=0, peakEquity=0, maxDrawdown=0;
    let currentStreak=0, maxWinStreak=0, maxLossStreak=0;

    for (const t of trades) {
      const pnl = parseFloat(t.profit_loss);
      totalProfit += pnl;
      if (pnl > 0) { wins++; grossProfit += pnl; sumWin += pnl; }
      else if (pnl < 0) { losses++; grossLoss += Math.abs(pnl); sumLoss += pnl; }
      sumDuration += parseInt(t.duration_ticks) || 0;
      const asset = t.asset || 'Unknown';
      assetMap[asset] = (assetMap[asset] || 0) + pnl;
      runningEquity += pnl;
      equityCurve.push({ timestamp: t.created_at, equity: runningEquity });
      if (runningEquity > peakEquity) peakEquity = runningEquity;
      if (peakEquity > 0) { const dd = ((peakEquity - runningEquity) / peakEquity)*100; if (dd > maxDrawdown) maxDrawdown = dd; }
      if (pnl > 0) currentStreak = currentStreak >= 0 ? currentStreak+1 : 1;
      else currentStreak = currentStreak <= 0 ? currentStreak-1 : -1;
      if (currentStreak > maxWinStreak) maxWinStreak = currentStreak;
      if (currentStreak < maxLossStreak) maxLossStreak = currentStreak;
    }

    const total = trades.length;
    const strikeRate = total>0 ? (wins/total)*100 : 0;
    let profitFactor = 0;
    if (grossLoss===0) profitFactor = grossProfit>0 ? parseFloat(grossProfit.toFixed(2)) : 0;
    else profitFactor = grossProfit / grossLoss;
    const avgWin = wins>0 ? sumWin/wins : 0;
    const avgLoss = losses>0 ? Math.abs(sumLoss/losses) : 0;
    const avgDuration = total>0 ? sumDuration/total : 0;
    const assetContributions = Object.entries(assetMap).map(([name, pnl]) => ({ name, pnl }));

    res.json({
      totalProfit, tradeCount: total, winCount: wins, lossCount: losses,
      grossProfit, grossLoss, maxDrawdown, totalDuration: sumDuration,
      avgWin, avgLoss, strikeRate, profitFactor,
      assetContributions, equityData: equityCurve
    });
  } catch (err) {
    console.error('❌ Analytics error:', err);
    res.json({
      totalProfit: 0, tradeCount: 0, winCount: 0, lossCount: 0,
      grossProfit: 0, grossLoss: 0, maxDrawdown: 0, totalDuration: 0,
      avgWin: 0, avgLoss: 0, strikeRate: 0, profitFactor: 0,
      assetContributions: [], equityData: []
    });
  }
});

// Debug
app.get('/debug/state', (req, res) => {
  res.json({
    botActive: store.state.active,
    balance: store.state.balance,
    account: derivClient?.isDemo ? 'demo' : 'real',
    activeAccountId: derivClient?.activeAccountId,
    tradeActive: isTradeActive(),
    botResetTime: store.state.botResetTime
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ==================== START SERVER & DERIV ====================
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`);

  if (derivClient) {
    const indicators = require('./engine/indicators');
    const bot = require('./engine/bot');

    let lastTradeCloseTime = 0;
    let lastProposalTime = 0;
    const lockTimestamps = {};

    // Auto‑cleanup stuck locks (2 min)
    setInterval(() => {
      const now = Date.now();
      if (tradeInProgressSym['global'] && lockTimestamps['global'] && (now - lockTimestamps['global'] > 120000)) {
        tradeInProgressSym['global'] = false;
        delete lockTimestamps['global'];
      }
    }, 30000);

    // Midnight reset check (runs every second)
    setInterval(() => {
      const now = Date.now();
      if (store.state.botResetTime && now >= store.state.botResetTime) {
        // Reset daily state
        store.updateState({
          active: true,
          botResetTime: null,
          sessionPnl: 0,
          dailyPnl: 0
        });
        store.addLog('info', '🕛 Midnight reset – bot re‑enabled');
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
      store.updateState({
        balance: parseFloat(balanceValue),
        currency,
        loginid: derivClient.activeAccountId,
        tradingMode: mode
      });
      logger.info(`💰 Balance updated: ${currency} ${balanceValue} (${mode})`);
    });

    derivClient.on('authorized', (data) => {
      logger.info(`🔐 Authorized as ${data.loginid || derivClient.activeAccountId}`);
    });

    // ---------- TICK HANDLER ----------
    derivClient.on('tick', (tick) => {
      const symbol = tick.symbol;
      const price = tick.quote;

      store.tickBuffer.push(symbol, price);
      const prices = store.tickBuffer.get(symbol);
      if (prices.length < 2) return;

      const history = store.getBandwidthHistory(symbol);
      const computed = indicators.computeMetrics(symbol, prices, store.config || {}, history);

      if (computed) {
        if (computed.bandwidth !== null && computed.bandwidth !== undefined) {
          store.pushBandwidth(symbol, computed.bandwidth);
        }
        store.updateMarketMetrics(symbol, computed);

        if (store.state.active && !isTradeActive()) {
          const now = Date.now();
          if (lastProposalTime && (now - lastProposalTime < 2000)) return;

          // Pass config to bot
          const signal = bot.evaluate(symbol, computed, store.state, {
            tradeInProgress: isTradeActive(),
            lastCloseTime: lastTradeCloseTime,
            config: store.config
          });

          if (signal) {
            const stake = signal.stake || store.state.currentStake || 0.35;
            const balance = store.state.balance ?? 0;
            if (stake < 0.35 || stake > balance) return;

            lastProposalTime = now;

            derivClient.buyContract(signal).then(contractId => {
              if (contractId) {
                tradeInProgressSym['global'] = true;
                lockTimestamps['global'] = Date.now();
                store.addLog('info', `🤖 Bot trade: ${signal.contractType} ${signal.symbol}`);
              }
            });
          }
        }
      }
    });

    // -------------------- TRADE SETTLED (daily P&L TP/SL) --------------------
    derivClient.on('trade_settled', async (trade) => {
      tradeInProgressSym['global'] = false;
      delete lockTimestamps['global'];
      lastTradeCloseTime = Date.now();

      const profit = parseFloat(trade.profit || 0);
      const result = profit > 0 ? 'WIN' : (profit < 0 ? 'LOSS' : 'BREAKEVEN');
      const sym = trade.symbol || '?';
      store.addLog('info', `🏁 Trade settled: ${trade.contract_type || '?'} ${sym} – ${result} $${profit.toFixed(2)}`);

      // Update P&L (both session and daily)
      const prevSession = store.state.sessionPnl || 0;
      const prevDaily   = store.state.dailyPnl   || 0;
      const newSessionPnl = prevSession + profit;
      const newDailyPnl   = prevDaily   + profit;
      store.updateState({
        sessionPnl: newSessionPnl,
        dailyPnl:   newDailyPnl
      });

      // Martingale stake
      if (profit > 0) {
        store.updateState({ currentStake: store.config?.BOT_BASE_STAKE || 0.35 });
        store.addLog('info', `📉 Stake reset to $${store.state.currentStake.toFixed(2)} after win`);
      } else {
        const newStake = Math.min((store.state.currentStake || 0.35) * 2, 100);
        store.updateState({ currentStake: newStake });
        store.addLog('info', `📈 Stake doubled to $${newStake.toFixed(2)} after loss`);
      }

      // Take Profit / Stop Loss – based on DAILY P&L
      const tp = parseFloat(store.config?.BOT_TAKE_PROFIT) || 5;
      const sl = parseFloat(store.config?.BOT_STOP_LOSS) || 10;

      if (newDailyPnl >= tp) {
        store.updateState({ active: false });
        const resetTime = getNextMidnightEAT();
        store.updateState({ botResetTime: resetTime });
        store.addLog('info', `🛑 Take Profit reached ($${newDailyPnl.toFixed(2)}). Bot paused until ${new Date(resetTime).toLocaleTimeString()}`);
      } else if (newDailyPnl <= -sl) {
        store.updateState({ active: false });
        const resetTime = getNextMidnightEAT();
        store.updateState({ botResetTime: resetTime });
        store.addLog('info', `🛑 Stop Loss hit (-$${Math.abs(newDailyPnl).toFixed(2)}). Bot paused until ${new Date(resetTime).toLocaleTimeString()}`);
      }

      // Supabase
      try {
        const account = derivClient.isDemo ? 'demo' : 'real';
        const record = {
          asset: trade.symbol,
          contract_type: trade.contract_type,
          stake: parseFloat(trade.stake),
          payout: parseFloat(trade.payout || 0),
          profit_loss: profit,
          is_win: profit > 0,
          barrier: trade.barrier ? parseFloat(trade.barrier) : null,
          exit_tick: trade.exit_price ? parseFloat(trade.exit_price) : null,
          contract_id: trade.contract_id,
          entry_price: trade.entry_price ? parseFloat(trade.entry_price) : null,
          exit_price: trade.exit_price ? parseFloat(trade.exit_price) : null,
          duration_ticks: parseInt(trade.duration_ticks) || 0,
          bot_name: trade.bot_name || 'manual',
          account
        };

        const { error } = await supabase.from('trading_ledger').insert(record);
        if (error) console.error('❌ Failed to insert trade:', error);
        else console.log('✅ Trade recorded:', record.asset, profit, 'account:', account);
      } catch (e) { console.error('❌ trade_settled handler error:', e); }
    });

    derivClient.connect();
  }
});

// Helper: next midnight East Africa Time (UTC+3)
function getNextMidnightEAT() {
  const now = new Date();
  const eatOffset = 3 * 60 * 60 * 1000;
  const eatNow = new Date(now.getTime() + eatOffset);
  const nextMidnightEAT = new Date(eatNow);
  nextMidnightEAT.setUTCHours(21, 0, 0, 0); // 21:00 UTC = 00:00 EAT
  if (nextMidnightEAT <= now) {
    nextMidnightEAT.setUTCDate(nextMidnightEAT.getUTCDate() + 1);
  }
  return nextMidnightEAT.getTime();
}

process.on('SIGTERM', () => server.close(() => process.exit(0)));
