// Configuration reset helpers kept independent from the HTTP server so the
// safety contract can be regression-tested without live Deriv/Supabase services.
const PRESERVED_CONFIG_KEYS = [
  'BOT_TAKE_PROFIT',
  'BOT_STOP_LOSS',
  'BOT_MAX_RUNS',
  'BOT_VIRTUAL_FILTER_ENABLED',
  'BOT_VIRTUAL_LOSS_THRESHOLD',
  'BOT_VIRTUAL_RETURN_MODE'
];

function resetStrategyConfig(defaultConfig, currentConfig = {}) {
  const preserved = Object.fromEntries(
    PRESERVED_CONFIG_KEYS
      .filter(key => currentConfig[key] !== undefined)
      .map(key => [key, currentConfig[key]])
  );

  return {
    config: { ...defaultConfig, ...preserved },
    preserved
  };
}

module.exports = {
  PRESERVED_CONFIG_KEYS,
  resetStrategyConfig
};