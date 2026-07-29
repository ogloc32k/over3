// server.js – full integration with Deriv, frontend, account switching
require('dotenv').config();

// ============================================================
// 1. GLOBAL ERROR CATCHERS
// ============================================================
process.on('uncaughtException', (err) => {
  console.error('🔥 UNCAUGHT EXCEPTION – server will exit');
  console.error(err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('🔥 UNHANDLED REJECTION – server will exit');
  console.error(reason);
  process.exit(1);
});

// ============================================================
// 2. MODULE LOADING
// ============================================================
let express, path, store, logger, derivClient;
try {
  express = require('express');
  path = require('path');
  console.log('✅ Core modules loaded (express, path)');
} catch (err) {
  console.error('❌ Failed to load core modules:', err);
  process.exit(1);
}

try { store = require('./store'); console.log('✅ Store loaded'); } catch (e) { console.error('❌ store.js:', e); process.exit(1); }
try { logger = require('./logger'); console.log('✅ Logger loaded'); } catch (e) { console.error('❌ logger.js:', e); process.exit(1); }
try { derivClient = require('./services/deriv'); console.log('✅ Deriv client loaded'); } catch (e) { console.error('❌ deriv.js:', e); derivClient = null; }

// Give Deriv client access to the store (needed for mode switch)
if (derivClient) {
  derivClient.setStore(store);
}

// ============================================================
// 3. EXPRESS APP SETUP
// ============================================================
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  console.log(`📡 ${req.method} ${req.url}`);
  next();
});

const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ============================================================
// 4. SSE ENDPOINT
// ============================================================
app.get('/api/logs', (req, res) => {
  console.log('🔗 SSE client connected');
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.write('\n');
  try { res.write(`data: ${JSON.stringify(store.getStatePayload())}\n\n`); } catch(e) {}

  const onChange = () => {
    try {
      const payload = store.getStatePayload();
      if (payload.logs && payload.logs.length > 0) res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch(e) {}
  };
  store.on('stateChanged', onChange);
  req.on('close', () => { store.removeListener('stateChanged', onChange); });
});

// ============================================================
// 5. REST API
// ============================================================
app.post('/api/control', (req, res) => {
  const { action, mode } = req.body;
  try {
    if (action === 'start') {
      store.updateState({ active: true, locked: false });
      logger.info('Bot started');
      res.json({ message: 'Bot started' });
    } else if (action === 'stop') {
      store.updateState({ active: false });
      logger.info('Bot stopped');
      res.json({ message: 'Bot stopped' });
    } else if (action === 'set_mode') {
      derivClient?.setMode(mode);
      res.json({ message: `Switched to ${mode}` });
    } else {
      res.json({ error: 'Unknown action' });
    }
  } catch (err) { res.json({ error: err.message }); }
});

app.post('/api/trade/manual', (req, res) => {
  try {
    derivClient?.buyContract(req.body);
    res.json({ message: 'Trade request sent' });
  } catch (err) { res.json({ error: err.message }); }
});

app.get('/api/config', (req, res) => res.json(store.config || {}));
app.post('/api/config', (req, res) => {
  store.config = { ...store.config, ...req.body };
  res.json({ success: true });
});

app.get('/api/ledger/aggregated', (req, res) => {
  res.json({
    totalProfit: 0, tradeCount: 0, winCount: 0, lossCount: 0,
    grossProfit: 0, grossLoss: 0, maxDrawdown: 0, totalDuration: 0,
    assetContributions: [],
    equityData: [{ timestamp: Date.now(), equity: store.state.balance || 0 }]
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'), (err) => err && res.status(500).send('Error'));
});

// ============================================================
// 6. START SERVER & DERIV CONNECTION
// ============================================================
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);

  if (derivClient) {
    console.log('🔌 Attempting Deriv connection...');
    try { derivClient.connect(); } catch (err) { console.error('Deriv connect error:', err); }

    derivClient.on('balance', (data) => {
      console.log('🔍 RAW BALANCE DATA:', JSON.stringify(data));
      try {
        // The balance data might be nested: data.balance or directly the object
        const balanceObj = data?.balance || data;
        const balance = balanceObj?.balance;
        const currency = balanceObj?.currency || 'USD';
        if (balance !== undefined) {
          store.updateState({
            balance: parseFloat(balance),
            currency,
            loginid: derivClient.accountId,
            tradingMode: derivClient.isDemo ? 'demo' : 'real'
          });
          logger.info(`💰 Balance updated: ${currency} ${balance}`);
        } else {
          console.warn('⚠️ Balance field missing in data');
        }
      } catch (err) { console.error('Balance update error:', err); }
    });

    derivClient.on('authorized', (data) => {
      logger.info(`🔐 Authorized as ${data.loginid || derivClient.accountId}`);
    });

    derivClient.on('tick', (tick) => {
      console.log(`📈 Tick: ${tick.symbol} ${tick.quote}`);
    });

    derivClient.on('history', (history) => {
      logger.info(`📜 Received ${history.prices?.length || 0} historical prices`);
    });
  }
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
