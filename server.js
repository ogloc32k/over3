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
app.use((req, res, next) => { console.log(`📡 ${req.method} ${req.url}`); next(); });
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// SSE STREAM (replaces /api/logs)
// ============================================================
app.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write('\n');

  // Send initial state
  const initial = store.getStatePayload();
  res.write(`data: ${JSON.stringify(initial)}\n\n`);

  const onChange = () => {
    const payload = store.getStatePayload();
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  store.on('stateChanged', onChange);

  req.on('close', () => store.removeListener('stateChanged', onChange));
});

// Helper to send analytics delta event (call when trade closes)
function sendAnalyticsDelta(delta) {
  // Notify all SSE clients about the delta
  // (we need a list of active SSE connections — simplified here)
  // We'll emit a custom event that the SSE handler can pick up.
  // In a real multi-client setup you'd use a pub/sub or broadcast.
  // For now, we emit via the store so the SSE loop picks it up.
  store.emit('analyticsDelta', delta);
}

// ============================================================
// REST API
// ============================================================
app.post('/api/control', (req, res) => {
  const { action, mode } = req.body;
  console.log('🟡 POST /api/control body:', req.body);
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
      if (derivClient) derivClient.setMode(mode);
      res.json({ message: `Switched to ${mode}` });
    } else {
      res.json({ error: 'Unknown action' });
    }
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

app.get('/api/ledger/aggregated', (req, res) => res.json({
  totalProfit: 0, tradeCount: 0, winCount: 0, lossCount: 0,
  grossProfit: 0, grossLoss: 0, maxDrawdown: 0, totalDuration: 0,
  assetContributions: [],
  equityData: [{ timestamp: Date.now(), equity: store.state.balance || 0 }]
}));

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
        console.error('❌ Unknown balance format');
        return;
      }

      if (!derivClient.activeAccountId) return; // transition
      if (loginid && loginid !== derivClient.activeAccountId) return; // stale

      const mode = derivClient.isDemo ? 'demo' : 'real';
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
      // Will be wired into the engine later
    });

    derivClient.connect();
  }
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
