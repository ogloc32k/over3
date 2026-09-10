const test = require('node:test');
const assert = require('node:assert/strict');
const { PRESERVED_CONFIG_KEYS, resetStrategyConfig } = require('../engine/configReset');

test('strategy reset preserves risk and virtual-filter safety controls', () => {
  const defaults = {
    BOT_DURATION: 70,
    BOT_BASE_STAKE: 0.35,
    BOT_TAKE_PROFIT: null,
    BOT_STOP_LOSS: null,
    BOT_MAX_RUNS: null,
    BOT_COOLDOWN: 5,
    BOT_VIRTUAL_FILTER_ENABLED: true,
    BOT_VIRTUAL_LOSS_THRESHOLD: 4,
    BOT_VIRTUAL_RETURN_MODE: 'any'
  };
  const current = {
    ...defaults,
    BOT_DURATION: 120,
    BOT_BASE_STAKE: 1,
    BOT_COOLDOWN: 15,
    BOT_TAKE_PROFIT: 7.5,
    BOT_STOP_LOSS: 12,
    BOT_MAX_RUNS: 25,
    BOT_VIRTUAL_FILTER_ENABLED: false,
    BOT_VIRTUAL_LOSS_THRESHOLD: 9,
    BOT_VIRTUAL_RETURN_MODE: 'loss'
  };

  const result = resetStrategyConfig(defaults, current);

  assert.equal(result.config.BOT_DURATION, defaults.BOT_DURATION);
  assert.equal(result.config.BOT_BASE_STAKE, defaults.BOT_BASE_STAKE);
  assert.equal(result.config.BOT_COOLDOWN, defaults.BOT_COOLDOWN);
  for (const key of PRESERVED_CONFIG_KEYS) {
    assert.equal(result.config[key], current[key], `${key} should survive reset`);
    assert.equal(result.preserved[key], current[key], `${key} should be reported as preserved`);
  }
});

test('strategy reset does not replace defaults with missing safety values', () => {
  const defaults = {
    BOT_TAKE_PROFIT: null,
    BOT_STOP_LOSS: null,
    BOT_MAX_RUNS: null,
    BOT_VIRTUAL_FILTER_ENABLED: true,
    BOT_VIRTUAL_LOSS_THRESHOLD: 4,
    BOT_VIRTUAL_RETURN_MODE: 'any',
    BOT_DURATION: 70
  };

  const result = resetStrategyConfig(defaults, { BOT_DURATION: 100 });

  assert.deepEqual(result.config, defaults);
  assert.deepEqual(result.preserved, {});
});