const test = require('node:test');
const assert = require('node:assert/strict');
const { DerivClient } = require('../services/deriv');

test('Deriv client emits an explicit recovering state', () => {
  const client = new DerivClient();
  const states = [];
  client.on('connection_state', event => states.push(event));
  client._setConnectionState('recovering', 'socket closed');
  assert.equal(client.getConnectionState(), 'recovering');
  assert.equal(states.at(-1).reason, 'socket closed');
});

test('disconnected sends fail safely and pending requests reject', async () => {
  const client = new DerivClient();
  assert.equal(client.send({ ping: 1 }), false);
  const pending = client._sendAndWait('proposal', { proposal: 1 }).catch(error => error.message);
  const message = await pending;
  assert.match(message, /disconnected/i);
});