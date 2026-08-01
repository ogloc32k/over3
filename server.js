// server.js – TP / SL + midnight reset (test mode)
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

// SSE
app.get('/stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.write('\n');
  res.write(`data: ${JSON.stringify(store.getStatePayload())}\n\n`);
  const onChange = () => { res.write(`data: ${JSON.stringify(store.getStatePayload())}\n\n`); };
  store.on('stateChanged', onChange);
  req.on('close', () => store.removeListener('stateChanged', onChange));
});

// REST
const tradeInProgressSym = {};

function isTradeActive() {
  return tradeInProgressSym['global'] === true;
}

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
      if (isTradeActive()) return res.json({ error: 'Cannot switch accounts while a trade is active.' });
      if (derivClient) derivClient.setMode(mode);
      res.json({ message: `Switched to ${mode}` });
    } else res.json({ error: 'Unknown action' });
  } catch (err) { res.json({ error: err.message }); }
});

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

app.get('/api/config', (req, res) => res.json(store.config || {}));
app.post('/api/config', (req, res) => { store.config = { ...store.config, ...req.body }; store.emit('configChanged'); res.json({ success: true }); });

// Analytics (unchanged)
app.get('/api/ledger/aggregated', async (req, res) => { /* same as before */ });

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

    // TP/SL constants (test values)
    const TAKE_PROFIT = 0.31;
    const STOP_LOSS = 0.35;

    // Midnight reset check every 10 seconds (test: every 1 sec)
    setInterval(() => {
      const now = Date.now();
      if (store.state.botResetTime && now >= store.state.botResetTime) {
        // Reset at midnight (or after test countdown)
        store.updateState({
          active: true,
          botResetTime: null,
          sessionPnl: 0,
          dailyPnl: 0
        });
        store.addLog('info', '🕛 Midnight reset – bot re‑enabled');
      }

      // Force‑unlock stuck trades after 2 minutes
      if (tradeInProgressSym['global'] && lockTimestamps['global'] && (now - lockTimestamps['global'] > 120000)) {
        tradeInProgressSym['global'] = false;
        delete lockTimestamps['global'];
      }
    }, 1000);

    store.on('configChanged', () => {
      store.tickBuffer.setMaxSize(store.config.ANALYSIS_WINDOW || 500);
    });

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

    derivClient.on('tick', (tick) => {
      const symbol = tick.symbol;
      const price = tick.quote;
      store.tickBuffer.push(symbol, price);
      const prices = store.tickBuffer.get(symbol);
      if (prices.length < 2) return;
      const history = store.getBandwidthHistory(symbol);
      const computed = indicators.computeMetrics(symbol, prices, store.config || {}, history);
      if (computed) {
        if (computed.bandwidth !== null && computed.bandwidth !== undefined) store.pushBandwidth(symbol, computed.bandwidth);
        store.updateMarketMetrics(symbol, computed);

        if (store.state.active && !isTradeActive()) {
          const now = Date.now();
          if (lastProposalTime && (now - lastProposalTime < 2000)) return;
          const signal = bot.evaluate(symbol, computed, store.state, {
            tradeInProgress: isTradeActive(),
            lastCloseTime: lastTradeCloseTime
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

    // -------------------- TRADE SETTLED --------------------
    derivClient.on('trade_settled', async (trade) => {
      tradeInProgressSym['global'] = false;
      delete lockTimestamps['global'];
      lastTradeCloseTime = Date.now();

      const profit = parseFloat(trade.profit || 0);
      const result = profit > 0 ? 'WIN' : (profit < 0 ? 'LOSS' : 'BREAKEVEN');
      const sym = trade.symbol || '?';
      store.addLog('info', `🏁 Trade settled: ${trade.contract_type || '?'} ${sym} – ${result} $${profit.toFixed(2)}`);

      // Update P&L
      const prevSession = store.state.sessionPnl || 0;
      const prevDaily = store.state.dailyPnl || 0;
      const newSessionPnl = prevSession + profit;
      const newDailyPnl = prevDaily + profit;
      store.updateState({
        sessionPnl: newSessionPnl,
        dailyPnl: newDailyPnl
      });

      // Martingale stake
      if (profit > 0) {
        store.updateState({ currentStake: 0.35 });
        store.addLog('info', `📉 Stake reset to $0.35 after win`);
      } else {
        const newStake = Math.min((store.state.currentStake || 0.35) * 2, 100);
        store.updateState({ currentStake: newStake });
        store.addLog('info', `📈 Stake doubled to $${newStake.toFixed(2)} after loss`);
      }

      // --- Take Profit / Stop Loss ---
      if (newSessionPnl >= TAKE_PROFIT) {
        store.updateState({ active: false });
        // set reset time: for testing, 10 seconds from now; later replace with midnight EAT
        const resetTime = Date.now() + 10000;  // 10 seconds test
        store.updateState({ botResetTime: resetTime });
        store.addLog('info', `🛑 Take Profit reached ($${newSessionPnl.toFixed(2)}). Bot paused until ${new Date(resetTime).toLocaleTimeString()}`);
      } else if (newSessionPnl <= -STOP_LOSS) {
        store.updateState({ active: false });
        const resetTime = Date.now() + 10000;
        store.updateState({ botResetTime: resetTime });
        store.addLog('info', `🛑 Stop Loss hit (-$${Math.abs(newSessionPnl).toFixed(2)}). Bot paused until ${new Date(resetTime).toLocaleTimeString()}`);
      }

      // Supabase (unchanged)
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

process.on('SIGTERM', () => server.close(() => process.exit(0)));
