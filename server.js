// server.js – full integration with Deriv (OTP flow), frontend, and account switching
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

// Load custom modules individually
try {
  store = require('./store');
  console.log('✅ Store loaded');
} catch (err) {
  console.error('❌ Failed to load ./store:', err);
  process.exit(1);
}
try {
  logger = require('./logger');
  console.log('✅ Logger loaded');
} catch (err) {
  console.error('❌ Failed to load ./logger:', err);
  process.exit(1);
}
try {
  derivClient = require('./services/deriv');
  console.log('✅ Deriv client loaded');
} catch (err) {
  console.error('❌ Failed to load ./services/deriv:', err);
  derivClient = null; // continue without it
}

// ============================================================
// 3. EXPRESS APP SETUP
// ============================================================
const app = express();
app.use(express.json());

// Request logger
app.use((req, res, next) => {
  console.log(`📡 ${req.method} ${req.url}`);
  next();
});

// Static files (frontend)
const publicPath = path.join(__dirname, 'public');
console.log(`📁 Static files served from: ${publicPath}`);
app.use(express.static(publicPath));

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    deriv: derivClient ? 'loaded' : 'not loaded',
    store: store ? 'loaded' : 'missing',
    logger: logger ? 'loaded' : 'missing'
  });
});

// ============================================================
// 4. SSE ENDPOINT (/api/logs)
// ============================================================
app.get('/api/logs', (req, res) => {
  console.log('🔗 SSE client connected');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write('\n');

  // Send initial state
  try {
    const initial = store.getStatePayload();
    res.write(`data: ${JSON.stringify(initial)}\n\n`);
  } catch (err) {
    console.error('SSE initial state error:', err);
  }

  const onChange = () => {
    try {
      const payload = store.getStatePayload();
      if (payload.logs && payload.logs.length > 0) {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    } catch (err) {
      console.error('SSE onChange error:', err);
    }
  };
  store.on('stateChanged', onChange);

  req.on('close', () => {
    console.log('🔌 SSE client disconnected');
    store.removeListener('stateChanged', onChange);
  });
});

// ============================================================
// 5. REST API
// ============================================================

// Control endpoint (start, stop, set_mode)
app.post('/api/control', (req, res) => {
  const { action, mode } = req.body;
  try {
    if (action === 'start') {
      // Placeholder for engine start
      store.updateState({ active: true, locked: false });
      logger.info('Bot started');
      res.json({ message: 'Bot started' });
    } else if (action === 'stop') {
      store.updateState({ active: false });
      logger.info('Bot stopped');
      res.json({ message: 'Bot stopped' });
    } else if (action === 'set_mode') {
      if (derivClient) {
        derivClient.setMode(mode); // 'demo' or 'real'
        res.json({ message: `Switched to ${mode} mode` });
      } else {
        res.json({ error: 'Deriv client not available' });
      }
    } else {
      res.json({ error: 'Unknown action' });
    }
  } catch (err) {
    res.json({ error: err.message });
  }
});

// Manual trade placeholder
app.post('/api/trade/manual', (req, res) => {
  try {
    // Forward to derivClient.buyContract()
    if (!derivClient) return res.json({ error: 'Deriv client not connected' });
    derivClient.buyContract(req.body);
    res.json({ message: 'Trade request sent' });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// Config endpoints (GET / POST)
app.get('/api/config', (req, res) => {
  // Return current config from store (placeholder)
  res.json(store.config || {});
});
app.post('/api/config', (req, res) => {
  try {
    // Placeholder: update config in store
    store.config = { ...store.config, ...req.body };
    res.json({ success: true });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// Analytics (placeholder)
app.get('/api/ledger/aggregated', (req, res) => {
  // Return dummy data for now
  res.json({
    totalProfit: 0,
    tradeCount: 0,
    winCount: 0,
    lossCount: 0,
    grossProfit: 0,
    grossLoss: 0,
    maxDrawdown: 0,
    totalDuration: 0,
    assetContributions: [],
    equityData: [{ timestamp: Date.now(), equity: store.state.balance || 0 }]
  });
});

// ============================================================
// 6. FALLBACK (SPA)
// ============================================================
app.get('*', (req, res) => {
  const indexPath = path.join(publicPath, 'index.html');
  console.log(`↩️  Fallback: sending ${indexPath}`);
  res.sendFile(indexPath, (err) => {
    if (err) {
      console.error('❌ Failed to send index.html:', err);
      res.status(500).send('Internal Server Error');
    }
  });
});

// ============================================================
// 7. START SERVER & DERIV CONNECTION
// ============================================================
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);

  // ---- Deriv integration ----
  if (derivClient) {
    console.log('🔌 Attempting Deriv connection...');
    try {
      derivClient.connect();
    } catch (err) {
      console.error('❌ Deriv connect() threw:', err);
    }

    derivClient.on('balance', (data) => {
      try {
        const balance = data?.balance?.balance;
        const currency = data?.balance?.currency || 'USD';
        const loginid = data?.balance?.loginid || derivClient.accountId;
        if (balance !== undefined) {
          store.updateState({
            balance: parseFloat(balance),
            currency,
            loginid,
            tradingMode: derivClient.isDemo ? 'demo' : 'real'
          });
          logger.info(`💰 Balance updated: ${currency} ${balance}`);
        }
      } catch (err) {
        console.error('Balance update error:', err);
      }
    });

    derivClient.on('authorized', (data) => {
      logger.info(`🔐 Authorized as ${data.loginid || derivClient.accountId}`);
    });

    derivClient.on('tick', (tick) => {
      // This will be used by the engine later; for now log briefly
      console.log(`📈 Tick: ${tick.symbol} ${tick.quote}`);
    });

    derivClient.on('history', (history) => {
      logger.info(`📜 Received ${history.prices?.length || 0} historical prices`);
    });

  } else {
    console.warn('⚠️ Deriv client not loaded – running without real data');
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received – shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
