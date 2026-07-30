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

// SSE
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

// Analytics
app.get('/api/ledger/aggregated', async (req, res) => {
  try {
    const { mode = 'session' } = req.query;
    const now = new Date();
    let start;

    switch (mode) {
      case '24h': start = new Date(now.getTime() - 24*60*60*1000); break;
      case '1w':  start = new Date(now.getTime() - 7*24*60*60*1000); break;
      case '1m':  start = new Date(now.getTime() - 30*24*60*60*1000); break;
      case '1y':  start = new Date(now.getTime() - 365*24*60*60*1000); break;
      case 'session':
      default:    start = new Date(now.getFullYear(), now.getMonth(), now.getDate()); break;
    }

    const { data: trades, error } = await supabase
      .from('trading_ledger')
      .select('*')
      .gte('created_at', start.toISOString())
      .order('created_at', { ascending: true });

    if (error) {
      console.error('❌ Supabase query error:', error);
      return res.json({ totalProfit:0,tradeCount:0,winCount:0,lossCount:0,grossProfit:0,grossLoss:0,maxDrawdown:0,totalDuration:0,avgWin:0,avgLoss:0,strikeRate:0,profitFactor:0,assetContributions:[],equityData:[] });
    }

    if (!trades || trades.length === 0) {
      return res.json({ totalProfit:0,tradeCount:0,winCount:0,lossCount:0,grossProfit:0,grossLoss:0,maxDrawdown:0,totalDuration:0,avgWin:0,avgLoss:0,strikeRate:0,profitFactor:0,assetContributions:[],equityData:[] });
    }

    let totalProfit=0, grossProfit=0, grossLoss=0, wins=0, losses=0, sumWin=0, sumLoss=0, sumDuration=0;
    const assetMap = {};
    const equityCurve = [];
    let runningEquity=0, peakEquity=-Infinity, maxDrawdown=0;
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
    res.json({ totalProfit:0,tradeCount:0,winCount:0,lossCount:0,grossProfit:0,grossLoss:0,maxDrawdown:0,totalDuration:0,avgWin:0,avgLoss:0,strikeRate:0,profitFactor:0,assetContributions:[],equityData:[] });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ==================== START ====================
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`);

  if (derivClient) {
    derivClient.on('balance', (data) => {
      console.log('🔍 RAW BALANCE EVENT:', JSON.stringify(data));

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

    derivClient.connect();
  }
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
