// server.js
require('dotenv').config();

process.on('uncaughtException', err => { console.error('🔥 UNCAUGHT EXCEPTION', err); process.exit(1); });
process.on('unhandledRejection', reason => { console.error('🔥 UNHANDLED REJECTION', reason); process.exit(1); });

const express = require('express');
const path = require('path');
const supabase = require('./services/supabase');   // our Supabase client

let store, logger, derivClient;
try { store = require('./store'); console.log('✅ Store loaded'); } catch(e) { console.error('❌ store.js:', e); process.exit(1); }
try { logger = require('./logger'); console.log('✅ Logger loaded'); } catch(e) { console.error('❌ logger.js:', e); process.exit(1); }
try { derivClient = require('./services/deriv'); console.log('✅ Deriv client loaded'); } catch(e) { console.error('❌ deriv.js:', e); derivClient = null; }

if (derivClient) derivClient.setStore(store);

const app = express();
app.use(express.json());
app.use((req,res,next) => { console.log(`📡 ${req.method} ${req.url}`); next(); });
app.use(express.static(path.join(__dirname, 'public')));

// SSE
app.get('/stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
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

// REST
app.post('/api/control', (req, res) => {
  const { action, mode } = req.body;
  console.log('🟡 POST /api/control body:', req.body);
  try {
    if (action === 'start') { store.updateState({ active: true, locked: false }); res.json({ message: 'Bot started' }); }
    else if (action === 'stop') { store.updateState({ active: false }); res.json({ message: 'Bot stopped' }); }
    else if (action === 'set_mode') {
      if (derivClient) derivClient.setMode(mode);
      res.json({ message: `Switched to ${mode}` });
    }
    else res.json({ error: 'Unknown action' });
  } catch (err) { res.json({ error: err.message }); }
});

app.post('/api/trade/manual', (req, res) => {
  try {
    if (!derivClient) return res.json({ error: 'Deriv client not connected' });
    derivClient.buyContract(req.body);
    res.json({ message: 'Trade request sent' });
  } catch (err) { res.json({ error: err.message }); }
});

app.get('/api/config', (req, res) => res.json(store.config || {}));
app.post('/api/config', (req, res) => {
  try {
    store.config = { ...store.config, ...req.body };
    res.json({ success: true });
  } catch (err) { res.json({ error: err.message }); }
});

// ============================================================
// ANALYTICS – REAL DATA FROM SUPABASE
// ============================================================
app.get('/api/ledger/aggregated', async (req, res) => {
  try {
    const { mode } = req.query;
    let start = null;

    const now = new Date();
    switch (mode) {
      case '24h':
        start = new Date(now.getTime() - 24*60*60*1000);
        break;
      case 'week':
        start = new Date(now.getTime() - 7*24*60*60*1000);
        break;
      case 'month':
        start = new Date(now.getTime() - 30*24*60*60*1000);
        break;
      case 'year':
        start = new Date(now.getTime() - 365*24*60*60*1000);
        break;
      case 'session':
      default:
        // session = today's trades
        start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        break;
    }

    let query = supabase
      .from('trading_ledger')
      .select('*')
      .gte('created_at', start.toISOString())
      .order('created_at', { ascending: true });

    const { data: trades, error } = await query;

    if (error) {
      console.error('❌ Supabase query error:', error);
      return res.json({
        totalProfit: 0, tradeCount: 0, winCount: 0, lossCount: 0,
        grossProfit: 0, grossLoss: 0, maxDrawdown: 0, totalDuration: 0,
        assetContributions: [], equityData: []
      });
    }

    const total = trades.length;
    if (total === 0) {
      return res.json({
        totalProfit: 0, tradeCount: 0, winCount: 0, lossCount: 0,
        grossProfit: 0, grossLoss: 0, maxDrawdown: 0, totalDuration: 0,
        assetContributions: [], equityData: []
      });
    }

    // ---- compute metrics ----
    let totalProfit = 0, grossProfit = 0, grossLoss = 0;
    let wins = 0, losses = 0;
    let sumWin = 0, sumLoss = 0;
    let sumDuration = 0;

    const assetMap = {};
    const equityCurve = [];
    let runningEquity = 0;
    let peakEquity = -Infinity;
    let maxDrawdown = 0;

    let currentStreak = 0, maxWinStreak = 0, maxLossStreak = 0;

    trades.forEach((t, idx) => {
      const pnl = Number(t.profit_loss);
      totalProfit += pnl;

      if (pnl > 0) {
        wins++;
        grossProfit += pnl;
        sumWin += pnl;
      } else if (pnl < 0) {
        losses++;
        grossLoss += Math.abs(pnl);
        sumLoss += pnl;   // negative value
      }

      sumDuration += Number(t.duration_ticks || 0);

      // asset grouping
      const asset = t.asset || 'Unknown';
      assetMap[asset] = (assetMap[asset] || 0) + pnl;

      // equity curve
      runningEquity += pnl;
      equityCurve.push({ timestamp: t.created_at, equity: runningEquity });

      if (runningEquity > peakEquity) peakEquity = runningEquity;
      const dd = peakEquity > 0 ? ((peakEquity - runningEquity) / peakEquity) * 100 : 0;
      if (dd > maxDrawdown) maxDrawdown = dd;

      // streaks
      if (pnl > 0) {
        currentStreak = currentStreak >= 0 ? currentStreak + 1 : 1;
      } else {
        currentStreak = currentStreak <= 0 ? currentStreak - 1 : -1;
      }
      if (currentStreak > maxWinStreak) maxWinStreak = currentStreak;
      if (currentStreak < maxLossStreak) maxLossStreak = currentStreak;
    });

    const strikeRate = total > 0 ? ((wins / total) * 100) : 0;
    let profitFactor = 0;
    if (grossLoss === 0) {
      profitFactor = grossProfit > 0 ? parseFloat(grossProfit.toFixed(2)) : 0;
    } else {
      profitFactor = grossProfit / grossLoss;
    }

    const avgWin = wins > 0 ? sumWin / wins : 0;
    const avgLoss = losses > 0 ? Math.abs(sumLoss / losses) : 0;
    const avgDuration = total > 0 ? sumDuration / total : 0;

    const assetContributions = Object.entries(assetMap).map(([name, pnl]) => ({ name, pnl }));

    res.json({
      totalProfit,
      tradeCount: total,
      winCount: wins,
      lossCount: losses,
      grossProfit,
      grossLoss,
      maxDrawdown,
      totalDuration: sumDuration,
      avgWin,
      avgLoss,
      strikeRate,
      profitFactor,
      assetContributions,
      equityData: equityCurve,
    });
  } catch (err) {
    console.error('❌ Analytics error:', err);
    res.json({
      totalProfit: 0, tradeCount: 0, winCount: 0, lossCount: 0,
      grossProfit: 0, grossLoss: 0, maxDrawdown: 0, totalDuration: 0,
      assetContributions: [], equityData: []
    });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ============================================================
// START SERVER & DERIV CONNECTION
// ============================================================
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`);

  if (derivClient) {
    derivClient.on('balance', (data) => {
      // ... (unchanged balance handling) ...
    });

    derivClient.on('authorized', (data) => {
      logger.info(`🔐 Authorized as ${data.loginid || derivClient.activeAccountId}`);
    });

    // --- Listen for settled trades and insert into Supabase ---
    derivClient.on('trade_settled', async (trade) => {
      try {
        const isWin = trade.profit > 0;
        const record = {
          asset: trade.symbol,
          contract_type: trade.contract_type,
          stake: parseFloat(trade.stake),
          payout: parseFloat(trade.payout || 0),
          profit_loss: parseFloat(trade.profit || 0),
          is_win: isWin,
          barrier: trade.barrier || null,
          exit_tick: trade.exit_price ? parseFloat(trade.exit_price) : null,
          contract_id: trade.contract_id,
          entry_price: trade.entry_price ? parseFloat(trade.entry_price) : null,
          exit_price: trade.exit_price ? parseFloat(trade.exit_price) : null,
          duration_ticks: trade.duration_ticks || 0,
          bot_name: trade.bot_name || 'manual'
        };

        const { error } = await supabase.from('trading_ledger').insert(record);
        if (error) {
          console.error('❌ Failed to insert trade:', error);
        } else {
          console.log('✅ Trade recorded:', record.asset, record.profit_loss);
          // Optionally push an analytics delta to SSE clients
          // (not yet implemented for multiple clients)
        }
      } catch (e) {
        console.error('❌ trade_settled handler error:', e);
      }
    });

    derivClient.connect();
  }
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
