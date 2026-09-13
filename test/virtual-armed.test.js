'use strict';
// Per-asset arming: paper-loss streaks and real-mode arming are banked
// per market, survive restarts, and expire after BOT_VIRTUAL_ARMED_TTL.
const test = require('node:test');
const assert = require('node:assert');
const vf = require('../engine/virtualFilter');
const midnight = require('../engine/midnight');

const CFG = { BOT_VIRTUAL_FILTER_ENABLED: true, BOT_VIRTUAL_LOSS_THRESHOLD: 4, BOT_VIRTUAL_ARMED_TTL: 60 };

test('armedTtlMs: default 60 minutes, configurable', () => {
  assert.equal(vf.armedTtlMs({}), 60 * 60 * 1000);
  assert.equal(vf.armedTtlMs({ BOT_VIRTUAL_ARMED_TTL: '15' }), 15 * 60 * 1000);
});

test('arm/prune/isArmed: expiry window honored', () => {
  const now = Date.now();
  const armed = vf.armAsset({}, 'R_10', CFG, now);
  assert.equal(armed['R_10'], now + 60 * 60 * 1000);
  assert.equal(vf.isArmed(armed, 'R_10', CFG, now + 59 * 60 * 1000), true);
  assert.equal(vf.isArmed(armed, 'R_10', CFG, now + 61 * 60 * 1000), false);
  assert.equal(Object.keys(vf.pruneArmed(armed, now + 61 * 60 * 1000)).length, 0);
});

test('per-asset isolation: other markets untouched', () => {
  const now = Date.now();
  let armed = vf.armAsset({}, 'R_10', CFG, now);
  armed = vf.armAsset(armed, 'R_25', CFG, now);
  assert.equal(vf.isArmed(armed, 'R_25', CFG, now), true);
  const after = vf.disarmAsset(armed, 'R_10');
  assert.equal(vf.isArmed(after, 'R_10', CFG, now), false);
  assert.equal(vf.isArmed(after, 'R_25', CFG, now), true);
});

test('filter disabled: every signal is real', () => {
  assert.equal(vf.isArmed({}, 'R_10', { BOT_VIRTUAL_FILTER_ENABLED: false }), true);
});

test('restart on the same day preserves the per-asset hunt', () => {
  const now = Date.now();
  const armed = vf.armAsset({}, 'R_10', CFG, now);
  const rt = {
    active: true, at: now - 60_000,
    dailyPnl: 1.5, sessionPnl: 0.5, sessionTradeCount: 3,
    executionMode: 'real',
    virtualLossStreaks: { R_10: 2, R_25: 1 },
    armedAssets: armed
  };
  const act = midnight.resolveRestore(rt, now, 'Africa/Nairobi');
  assert.equal(act.action, 'resume');
  assert.equal(act.patch.armedAssets['R_10'], armed['R_10']);
  assert.equal(act.patch.virtualLossStreaks.R_25, 1);
  assert.equal(act.patch.executionMode, 'real');
});

test('restart across midnight clears the hunt (fresh day)', () => {
  const now = Date.now();
  const rt = {
    active: true, at: now - 26 * 3600 * 1000,
    executionMode: 'real',
    virtualLossStreaks: { R_10: 3 },
    armedAssets: vf.armAsset({}, 'R_10', CFG, now - 26 * 3600 * 1000)
  };
  const act = midnight.resolveRestore(rt, now, 'Africa/Nairobi');
  assert.equal(act.action, 'resume');
  assert.deepStrictEqual(act.patch.virtualLossStreaks, {});
  assert.deepStrictEqual(act.patch.armedAssets, {});
});

test('global mode (default): shared streak key, any market may fire real', () => {
  const g = { ...CFG, BOT_VIRTUAL_PER_ASSET: false };
  assert.equal(vf.perAssetEnabled(g), false);
  assert.equal(vf.streakKey('R_10', g), '*');
  assert.equal(vf.streakKey('R_25', g), '*');       // every market banks together
  const armed = vf.armAsset({}, vf.streakKey('R_10', g), g);
  assert.equal(vf.isArmed(armed, vf.streakKey('R_25', g), g), true);  // any market passes the gate
});

test('per-asset mode (opt-in): markets bank separately', () => {
  const p = { ...CFG, BOT_VIRTUAL_PER_ASSET: true };
  assert.equal(vf.streakKey('R_10', p), 'R_10');
  const armed = vf.armAsset({}, 'R_10', p);
  assert.equal(vf.isArmed(armed, 'R_10', p), true);
  assert.equal(vf.isArmed(armed, 'R_25', p), false); // other markets stay on paper
});
