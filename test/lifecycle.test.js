const test = require('node:test');
const assert = require('node:assert/strict');
const { STATUS, REASONS, resolvePauseReason, resolveRiskTransition, isArmedStatus, isStaleLock } = require('../engine/lifecycle');

test('lifecycle reason precedence preserves explicit user stops', () => {
  assert.equal(resolvePauseReason({ userStop: true, takeProfit: true, stopLoss: true, maxRuns: true }), REASONS.USER_STOP);
  assert.equal(resolvePauseReason({ takeProfit: true, stopLoss: true, maxRuns: true }), REASONS.TAKE_PROFIT);
  assert.equal(resolvePauseReason({ stopLoss: true, maxRuns: true }), REASONS.STOP_LOSS);
  assert.equal(resolvePauseReason({ maxRuns: true }), REASONS.MAX_RUNS);
});

test('recovering remains an armed lifecycle state', () => {
  assert.equal(isArmedStatus(STATUS.RECOVERING), true);
  assert.equal(isArmedStatus(STATUS.ARMED), true);
  assert.equal(isArmedStatus(STATUS.IDLE), false);
});

test('risk transition precedence preserves the first triggered safety stop', () => {
  assert.equal(resolveRiskTransition({ dailyPnl: 10, takeProfit: 10, stopLoss: 2, tradeCount: 20, maxRuns: 20 }).reason, REASONS.TAKE_PROFIT);
  assert.equal(resolveRiskTransition({ dailyPnl: -2, takeProfit: 10, stopLoss: 2, tradeCount: 20, maxRuns: 20 }).reason, REASONS.STOP_LOSS);
  assert.equal(resolveRiskTransition({ dailyPnl: 0, tradeCount: 20, maxRuns: 20 }).status, STATUS.COMPLETED);
});

test('stale locks are only released after the bounded timeout', () => {
  assert.equal(isStaleLock(1000, 120999, 120000), false);
  assert.equal(isStaleLock(1000, 121000, 120000), true);
});