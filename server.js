// server.js
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

// ---------- Trade‑in‑progress tracker ----------
const tradeInProgressSym = {};   // symbol → boolean

function tradeInProgressCount() {
  let count = 0;
  for (const sym in tradeInProgressSym) {
    if (tradeInProgressSym[sym]) count++;
  }
  return count;
}

// Control endpoint (start / stop / set_mode)
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
      store.addLog('info', '⏹️ Bot stopped');
      res.json({ message: 'Bot stopped' });
    } else if (action === 'set_mode') {
      // Guard: block switch if any trade is still open
      if (tradeInProgressCount() > 0) {
        return res.json({ error: 'Cannot switch accounts while a trade is active. Wait for it to settle.' });
      }
      if (derivClient) derivClient.setMode(mode);
      res.json({ message: `Switched to ${mode}` });
    }
    else res.json({ error: 'Unknown action' });
  } catch (err) { res.json({ error: err.message }); }
});

// Manual trade – locks AFTER Deriv confirms
app.post('/api/trade/manual', async (req, res) => {
  try {
    if (!derivClient) return res.json({ error: 'Deriv client not connected' });

    const stake = parseFloat(req.body.stake) || store.state.currentStake || 0.35;
    const balance = store.state.balance ?? 0;

    if (stake < 0.35) return res.json({ error: 'Minimum stake is $0.35' });
    if (stake > balance) return res.json({ error: `Stake cannot exceed balance of $${balance.toFixed(2)}` });

    // Fire trade – returns contract_id on success, null on failure
    const contractId = await derivClient.buyContract({ ...req.body, stake });

    if (!contractId) {
      return res.json({ error: 'Trade execution failed on Deriv side' });
    }

    // Now lock the symbol (only after successful Deriv confirmation)
    tradeInProgressSym[req.body.symbol] = true;
    store.addLog('info', `📈 Manual trade placed: ${req.body.contractType} ${req.body.symbol}`);
    res.json({ message: 'Trade request sent' });
  } catch (err) {
    // Unlock on error
    if (req.body.symbol) tradeInProgressSym[req.body.symbol] = false;
    res.json({ error: err.message });
  }
});

// Config
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

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ==================== START SERVER & DERIV ====================
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`);

  if (derivClient) {
    const indicators = require('./engine/indicators');
    const bot = require('./engine/bot');

    const lastTradeCloseTime = {};

    store.on('configChanged', () => {
      store.tickBuffer.setMaxSize(store.config.ANALYSIS_WINDOW || 500);
    });

    // Balance streaming is now started inside deriv.js on open

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

        // Sniper Bot
        if (store.state.active) {
          const signal = bot.evaluate(symbol, computed, store.state, {
            tradeInProgress: tradeInProgressSym[symbol] || false,
            lastCloseTime: lastTradeCloseTime[symbol] || 0
          });

          if (signal) {
            const stake = signal.stake || store.state.currentStake || 0.35;
            const balance = store.state.balance ?? 0;
            if (stake < 0.35 || stake > balance) return;

            // Bot fire – lock only after success
            derivClient.buyContract(signal).then(contractId => {
              if (contractId) {
                tradeInProgressSym[symbol] = true;
                store.addLog('info', `🤖 Bot trade: ${signal.contractType} ${symbol}`);
              }
            });
          }
        }
      }
    });

    // -------------------- TRADE SETTLED --------------------
    derivClient.on('trade_settled', async (trade) => {
      // Release lock
      if (trade.symbol) {
        tradeInProgressSym[trade.symbol] = false;
        lastTradeCloseTime[trade.symbol] = Date.now();
      }

      const profit = parseFloat(trade.profit || 0);
      const result = profit > 0 ? 'WIN' : (profit < 0 ? 'LOSS' : 'BREAKEVEN');
      store.addLog('info', `🏁 Trade settled: ${trade.contract_type || '?'} ${trade.symbol || '?'} – ${result} $${profit.toFixed(2)}`);

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
          account: account
        };

        const { error } = await supabase.from('trading_ledger').insert(record);
        if (error) console.error('❌ Failed to insert trade:', error);
        else console.log('✅ Trade recorded:', record.asset, profit, 'account:', account);
      } catch (e) { console.error('❌ trade_settled handler error:', e); }

      // Balance is already streaming – no explicit request needed
    });

    derivClient.connect();
  }
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
