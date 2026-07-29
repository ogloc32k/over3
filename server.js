// server.js
require('dotenv').config();

process.on('uncaughtException', err => { console.error('🔥 UNCAUGHT EXCEPTION', err); process.exit(1); });
process.on('unhandledRejection', reason => { console.error('🔥 UNHANDLED REJECTION', reason); process.exit(1); });

const express = require('express');
const path = require('path');

let store, logger, derivClient;
try { store = require('./store'); console.log('✅ Store loaded'); } catch(e) { console.error('❌ store.js:', e); process.exit(1); }
try { logger = require('./logger'); console.log('✅ Logger loaded'); } catch(e) { console.error('❌ logger.js:', e); process.exit(1); }
try { derivClient = require('./services/deriv'); console.log('✅ Deriv client loaded'); } catch(e) { console.error('❌ deriv.js:', e); derivClient = null; }

if (derivClient) derivClient.setStore(store);

const app = express();
app.use(express.json());
app.use((req,res,next) => { console.log(`📡 ${req.method} ${req.url}`); next(); });
app.use(express.static(path.join(__dirname, 'public')));

// SSE – now sends state on every change (not just when logs exist)
app.get('/api/logs', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.write('\n');
  const initial = store.getStatePayload();
  res.write(`data: ${JSON.stringify(initial)}\n\n`);

  const onChange = () => {
    const payload = store.getStatePayload();
    // Always send the state, even if logs are empty
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
      derivClient?.setMode(mode);
      res.json({ message: `Switched to ${mode}` });
    }
    else res.json({ error: 'Unknown action' });
  } catch (err) { res.json({ error: err.message }); }
});

app.post('/api/trade/manual', (req, res) => {
  try { derivClient?.buyContract(req.body); res.json({ message: 'Trade sent' }); }
  catch(err) { res.json({ error: err.message }); }
});

app.get('/api/config', (req, res) => res.json(store.config || {}));
app.post('/api/config', (req, res) => { store.config = { ...store.config, ...req.body }; res.json({ success: true }); });

app.get('/api/ledger/aggregated', (req, res) => res.json({
  totalProfit: 0, tradeCount: 0, winCount: 0, lossCount: 0,
  grossProfit: 0, grossLoss: 0, maxDrawdown: 0, totalDuration: 0,
  assetContributions: [], equityData: [{ timestamp: Date.now(), equity: store.state.balance || 0 }]
}));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ==================== START ====================
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`);

  if (derivClient) {
    derivClient.on('balance', (data) => {
      console.log('🔍 RAW BALANCE EVENT:', JSON.stringify(data));

      let balanceValue, currency, loginid;
      if (typeof data.balance === 'string' || typeof data.balance === 'number') {
        balanceValue = data.balance;
        currency = data.currency || 'USD';
        loginid = data.loginid || derivClient.accountId;
      } else if (data.balance && typeof data.balance === 'object') {
        balanceValue = data.balance.balance;
        currency = data.balance.currency || 'USD';
        loginid = data.balance.loginid || derivClient.accountId;
      } else {
        console.error('❌ Unknown balance format:', JSON.stringify(data));
        return;
      }

      console.log(`💰 Parsed balance: ${balanceValue} ${currency}`);
      store.updateState({
        balance: parseFloat(balanceValue),
        currency,
        loginid,
        tradingMode: derivClient.isDemo ? 'demo' : 'real'
      });
      logger.info(`💰 Balance updated: ${currency} ${balanceValue}`);
    });

    derivClient.on('authorized', (data) => {
      logger.info(`🔐 Authorized as ${data.loginid || derivClient.accountId}`);
    });

    derivClient.on('tick', (tick) => {
      console.log(`📈 Tick: ${tick.symbol} ${tick.quote}`);
    });

    derivClient.connect();
  }
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
