// backend/server.js
require('dotenv').config();
const express = require('express');
const path = require('path');
const store = require('./store');
const logger = require('./logger');

const app = express();
app.use(express.json());

// Serve static frontend from ../public
app.use(express.static(path.join(__dirname, '..', 'public')));

// SSE endpoint
app.get('/api/logs', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write('\n');

  // send initial state
  const initial = store.getStatePayload();
  res.write(`data: ${JSON.stringify(initial)}\n\n`);

  const onChange = () => {
    const payload = store.getStatePayload();
    if (payload.logs.length > 0) {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
  };
  store.on('stateChanged', onChange);

  req.on('close', () => {
    store.removeListener('stateChanged', onChange);
  });
});

// Dummy updates for testing
setInterval(() => {
  const metrics = store.state.marketMetrics;
  const sym = 'R_75';
  const old = metrics[sym].price;
  const newPrice = old + (Math.random() - 0.5) * 10;
  metrics[sym].price = newPrice;
  store.updateState({ marketMetrics: metrics });
  store.addLog('info', `Tick ${sym}: ${newPrice.toFixed(4)}`);
}, 3000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});
