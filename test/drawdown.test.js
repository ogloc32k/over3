'use strict';

const test  = require('node:test');
const assert = require('node:assert');
const { equityDrawdown } = require('../engine/drawdown');

const P = (n) => ({ profit_loss: n });

test('no anchors: seeds from live balance minus window P&L', () => {
  // +1, -3, +2 => total 0, curve 101 -> 98 -> 100 from seed 100
  const dd = equityDrawdown([P(1), P(-3), P(2)], { liveBalance: 100 });
  assert.equal(dd.anchored, false);
  assert.equal(dd.startEquity, 100);
  assert.equal(dd.maxDrawdownAbs, 3);               // peak 101 -> trough 98
  assert.ok(Math.abs(dd.maxDrawdownPct - (3 / 101 * 100)) < 1e-9);
});

test('anchored: drawdown follows real balances', () => {
  // balance 100 -> +1 -> 101 -> -3 -> 98
  const dd = equityDrawdown([{ profit_loss: 1, balance_after: 101 }, { profit_loss: -3, balance_after: 98 }]);
  assert.equal(dd.anchored, true);
  assert.equal(dd.startEquity, 100);
  assert.equal(dd.maxDrawdownAbs, 3);
  assert.ok(Math.abs(dd.maxDrawdownPct - (3 / 101 * 100)) < 1e-9);
});

test('withdrawal mid-window: does NOT count as drawdown', () => {
  // Same trades, but $50 was withdrawn between them: balance dips to 48.
  const dd = equityDrawdown([{ profit_loss: 1, balance_after: 101 }, { profit_loss: -3, balance_after: 48 }]);
  assert.equal(dd.anchored, true);
  assert.equal(dd.maxDrawdownAbs, 3);               // still only the -3 trade
  assert.ok(Math.abs(dd.maxDrawdownPct - (3 / 101 * 100)) < 1e-9); // withdrawal never shrinks the trading peak
  assert.ok(dd.maxDrawdownPct < 100);
});

test('deposit mid-window: does NOT hide real dips', () => {
  // Same trades, but $10 was deposited between them: balance reads 108.
  const dd = equityDrawdown([{ profit_loss: 1, balance_after: 101 }, { profit_loss: -3, balance_after: 108 }]);
  assert.equal(dd.maxDrawdownAbs, 3);               // still the -3 trade
  assert.ok(Math.abs(dd.maxDrawdownPct - (3 / 101 * 100)) < 1e-9); // deposit never lifts the trading peak
});

test('legacy rows in front of the first anchor get calibrated', () => {
  // Old row (-2, no balance) then anchored rows: 98 implied pre-trade.
  const dd = equityDrawdown([P(-2), { profit_loss: 1, balance_after: 99 }]);
  assert.equal(dd.anchored, true);
  assert.equal(dd.startEquity, 100);                // 98 pre + the earlier -2
  assert.equal(dd.maxDrawdownAbs, 2);               // 100 -> 98 -> 99
});

test('start equity counts as the initial peak (dip from the very first trade)', () => {
  const dd = equityDrawdown([{ profit_loss: -5, balance_after: 95 }], {});
  assert.equal(dd.startEquity, 100);
  assert.equal(dd.maxDrawdownAbs, 5);
  assert.ok(Math.abs(dd.maxDrawdownPct - 5) < 1e-9);
});

test('drawdown never exceeds 100% of equity', () => {
  // Crash: lose 90 of 100, then a further wipe on a tiny base.
  const dd = equityDrawdown([
    { profit_loss: -90, balance_after: 10 },
    { profit_loss: -9,  balance_after: 1 },
    { profit_loss: -0.9, balance_after: 0.1 }
  ]);
  assert.equal(dd.startEquity, 100);
  assert.ok(dd.maxDrawdownPct > 0);
  assert.ok(dd.maxDrawdownPct <= 100);
});
