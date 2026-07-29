// server.js – hardened with full debug logging & crash resilience

// ============================================================
// 1. GLOBAL ERROR CATCHERS (must be first)
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
// 2. LOAD ENVIRONMENT VARIABLES
// ============================================================
try {
  require('dotenv').config();
  console.log('✅ dotenv loaded (local dev only, ignored on Render)');
} catch (e) {
  console.warn('⚠️ dotenv not available (this is fine on Render)');
}

// ============================================================
// 3. SAFE MODULE LOADING WITH DETAILED LOGS
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

// Load our custom modules (wrapped individually to pinpoint failures)
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
  // We can continue without it, but trading won't work
  derivClient = null;
}

// ============================================================
// 4. CREATE EXPRESS APP
// ============================================================
const app = express();
app.use(express.json());

// ----------------------------------------------------------
// 4a. Request logging (basic)
app.use((req, res, next) => {
  console.log(`📡 ${req.method} ${req.url}`);
  next();
});

// ----------------------------------------------------------
// 4b. Serve static frontend
const publicPath = path.join(__dirname, 'public');
console.log(`📁 Static files served from: ${publicPath}`);
app.use(express.static(publicPath));

// ----------------------------------------------------------
// 4c. Health endpoint (for Render & debugging)
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

// ----------------------------------------------------------
// 4d. SSE endpoint
app.get('/api/logs', (req, res) => {
  console.log('🔗 SSE client connected');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write('\n');

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

// ----------------------------------------------------------
// 4e. Fallback – serve index.html for everything else (SPA)
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
// 5. START SERVER & OPTIONALLY CONNECT DERIV
// ============================================================
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);

  // ---- Dummy tick updates (optional – comment out when real ticks are ready) ----
  // Uncomment the block below if you want to see live dummy prices until Deriv is connected.
  /*
  setInterval(() => {
    try {
      const metrics = store.state.marketMetrics;
      const sym = 'R_75';
      const old = metrics[sym].price;
      const newPrice = old + (Math.random() - 0.5) * 10;
      metrics[sym].price = newPrice;
      store.updateState({ marketMetrics: metrics });
      store.addLog('info', `Tick ${sym}: ${newPrice.toFixed(4)}`);
    } catch (e) {
      console.error('Dummy tick error:', e);
    }
  }, 3000);
  */

  // ---- Deriv integration ----
  if (derivClient) {
    console.log('🔌 Attempting Deriv connection...');
    try {
      derivClient.connect();
      console.log('✅ Deriv connect() called (async)');
    } catch (err) {
      console.error('❌ Deriv connect() threw:', err);
    }

    derivClient.on('balance', (data) => {
      try {
        const balance = data?.balance?.balance;
        const currency = data?.balance?.currency || 'USD';
        const loginid = data?.balance?.loginid || '';
        if (balance !== undefined) {
          store.updateState({
            balance: parseFloat(balance),
            currency,
            loginid
          });
          console.log(`💰 Balance updated: ${currency} ${balance}`);
        }
      } catch (err) {
        console.error('Balance update error:', err);
      }
    });

    derivClient.on('authorized', (data) => {
      console.log(`🔐 Deriv authorized as ${data.loginid}`);
      if (logger) logger.info(`Logged into Deriv as ${data.loginid}`);
    });

    derivClient.on('tick', (tick) => {
      // will be used by engine later
      console.log(`📈 Tick: ${tick.symbol} ${tick.quote}`);
    });
  } else {
    console.warn('⚠️ Deriv client not loaded – skipping real-time features');
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
