const test = require('node:test');
const assert = require('node:assert/strict');
const durationUtil = require('../services/duration');
const { FakeDerivClient } = require('../services/fakeDeriv');

test('normalizeUnit accepts only t/s/m and defaults to ticks', () => {
  assert.equal(durationUtil.normalizeUnit('t'), 't');
  assert.equal(durationUtil.normalizeUnit('s'), 's');
  assert.equal(durationUtil.normalizeUnit('m'), 'm');
  assert.equal(durationUtil.normalizeUnit('x'), 't');
  assert.equal(durationUtil.normalizeUnit(undefined), 't');
});

test('clampDuration enforces fallback ranges (ticks 1-10, seconds 15-60, minutes 1-60)', () => {
  assert.equal(durationUtil.clampDuration(70, 't', null, 'R_100').duration, 10);
  assert.equal(durationUtil.clampDuration(0, 't', null, 'R_100').duration, 1);
  assert.equal(durationUtil.clampDuration(5, 't', null, 'R_100').clamped, false);
  assert.equal(durationUtil.clampDuration(7, 's', null, 'R_100').duration, 15);
  assert.equal(durationUtil.clampDuration(90, 'm', null, 'R_100').duration, 60);
  assert.equal(durationUtil.clampDuration('nope', 'm', null, 'R_100').duration, 1);
});

test('clampDuration prefers live per-symbol ranges from contracts_for', () => {
  const live = { R_100: { s: [5, 30] } };
  const clamped = durationUtil.clampDuration(45, 's', live, 'R_100');
  assert.equal(clamped.duration, 30);
  assert.equal(clamped.live, true);
  // Other symbols still fall back to documented ranges.
  assert.equal(durationUtil.clampDuration(45, 's', live, '1HZ10V').duration, 45);
});

test('durationToTicks converts seconds/minutes to feed ticks per symbol interval', () => {
  // R_* series tick every 2s; 1HZ series every 1s.
  assert.equal(durationUtil.durationToTicks(15, 's', 'R_100'), 8);   // ceil(15/2)
  assert.equal(durationUtil.durationToTicks(15, 's', '1HZ10V'), 15);
  assert.equal(durationUtil.durationToTicks(2, 'm', '1HZ10V'), 120);
  assert.equal(durationUtil.durationToTicks(2, 'm', 'R_100'), 60);
  assert.equal(durationUtil.durationToTicks(7, 't', 'R_100'), 7);    // ticks pass through
});

test('fakeDeriv settles seconds/minutes contracts with converted tick counts', async () => {
  const client = new FakeDerivClient();
  client.connect();
  await new Promise(r => setTimeout(r, 2500)); // let the simulated feed warm up
  try {
    const id = await client.buyContract({ symbol: 'R_100', contractType: 'CALL', stake: 0.5, duration: 15, durationUnit: 's' });
    const contract = client._openContracts[id];
    assert.equal(contract.durationTicks, 8);
    assert.equal(contract.durationUnit, 's');

    const id2 = await client.buyContract({ symbol: '1HZ10V', contractType: 'PUT', stake: 0.5, duration: 2, durationUnit: 'm' });
    assert.equal(client._openContracts[id2].durationTicks, 120);
  } finally {
    client._disconnect();
  }
});
