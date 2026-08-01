// server.js – v16: lock cleanup, live P&L, stake multiplier
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
function tradeInProgressCount() {
  let count = 0;
  for (const sym in tradeInProgressSym) if (tradeInProgressSym[sym]) count++;
  return count;
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
      // Release all locks immediately
      for (const sym in tradeInProgressSym) tradeInProgressSym[sym] = false;
      store.addLog('info', '⏹️ Bot stopped');
      res.json({ message: 'Bot stopped' });
    } else if (action === 'set_mode') {
      if (tradeInProgressCount() > 0) return res.json({ error: 'Cannot switch accounts while a trade is active.' });
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
    tradeInProgressSym[req.body.symbol] = true;
    store.addLog('info', `📈 Manual trade placed: ${req.body.contractType} ${req.body.symbol}`);
    res.json({ message: 'Trade request sent' });
  } catch (err) {
    if (req.body.symbol) tradeInProgressSym[req.body.symbol] = false;
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
    lockedSymbols: Object.entries(tradeInProgressSym)
      .filter(([sym, locked]) => locked)
      .map(([sym]) => sym)
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ==================== START ====================
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`);

  if (derivClient) {
    const indicators = require('./engine/indicators');
    const bot = require('./engine/bot');

    const lastTradeCloseTime = {};
    const lastProposalTime = {};
    const lockTimestamps = {};        // symbol → Date.now() when locked

    // Automatic lock cleanup every 30 seconds
    setInterval(() => {
      const now = Date.now();
      for (const sym in tradeInProgressSym) {
        if (tradeInProgressSym[sym] && lockTimestamps[sym] && (now - lockTimestamps[sym] > 120000)) {
          console.log(`🔓 Force‑unlocking ${sym} – trade assumed settled`);
          tradeInProgressSym[sym] = false;
          delete lockTimestamps[sym];
        }
      }
    }, 30000);

    store.on('configChanged', () => store.tickBuffer.setMaxSize(store.config.ANALYSIS_WINDOW || 500));

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

        if (store.state.active) {
          const now = Date.now();
          if (lastProposalTime[symbol] && (now - lastProposalTime[symbol] < 2000)) return;

          const signal = bot.evaluate(symbol, computed, store.state, {
            tradeInProgress: tradeInProgressSym[symbol] || false,
            lastCloseTime: lastTradeCloseTime[symbol] || 0
          });
          if (signal) {
            const stake = signal.stake || store.state.currentStake || 0.35;
            const balance = store.state.balance ?? 0;
            if (stake < 0.35 || stake > balance) return;
            lastProposalTime[symbol] = now;

            derivClient.buyContract(signal).then(contractId => {
              if (contractId) {
                tradeInProgressSym[symbol] = true;
                lockTimestamps[symbol] = Date.now();
                store.addLog('info', `🤖 Bot trade: ${signal.contractType} ${symbol}`);
              }
            });
          }
        }
      }
    });

    // -------------------- TRADE SETTLED (with P&L and multiplier) --------------------
    derivClient.on('trade_settled', async (trade) => {
      if (trade.symbol) {
        tradeInProgressSym[trade.symbol] = false;
        delete lockTimestamps[trade.symbol];
        lastTradeCloseTime[trade.symbol] = Date.now();
      }

      const profit = parseFloat(trade.profit || 0);
      const result = profit > 0 ? 'WIN' : (profit < 0 ? 'LOSS' : 'BREAKEVEN');
      const ct = trade.contract_type || trade.symbol ? (trade.symbol ? '?' : trade.contract_type) : '?';
      const sym = trade.symbol || '?';
      store.addLog('info', `🏁 Trade settled: ${ct} ${sym} – ${result} $${profit.toFixed(2)}`);

      // --- Update live P&L ---
      const prevSession = store.state.sessionPnl || 0;
      const prevDaily = store.state.dailyPnl || 0;
      store.updateState({
        sessionPnl: prevSession + profit,
        dailyPnl: prevDaily + profit
      });

      // --- Stake multiplier ---
      if (trade.bot_name === 'sniper' || trade.bot_name === 'manual') {
        if (profit > 0) {
          const newStake = Math.min((store.state.currentStake || 0.35) * 2, 100);
          store.updateState({ currentStake: newStake });
          store.addLog('info', `📈 Stake doubled to $${newStake.toFixed(2)} after win`);
        } else {
          store.updateState({ currentStake: 0.35 });
          store.addLog('info', `📉 Stake reset to $0.35 after loss`);
        }
      }

      // --- Supabase ---
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
