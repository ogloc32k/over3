// server.js
require('dotenv').config();
const express = require('express');
const path = require('path');
const store = require('./store');
const logger = require('./logger');
const derivClient = require('./services/deriv');

const app = express();
app.use(express.json());

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// SSE endpoint
app.get('/api/logs', (req, res) => {
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
    if (payload.logs.length > 0) {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
  };
  store.on('stateChanged', onChange);

  req.on('close', () => {
    store.removeListener('stateChanged', onChange);
  });
});

// Fallback for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);

  // Connect to Deriv
  derivClient.connect();

  // When balance arrives, update the store (and the frontend)
  derivClient.on('balance', (data) => {
    const balance = data?.balance?.balance;
    const currency = data?.balance?.currency || 'USD';
    const loginid = data?.balance?.loginid || '';

    if (balance !== undefined) {
      store.updateState({
        balance: parseFloat(balance),
        currency,
        loginid
      });
      logger.info(`Balance updated: ${currency} ${balance}`);
    }
  });

  derivClient.on('authorized', (data) => {
    logger.info(`Authorized as ${data.loginid}`);
  });
});
