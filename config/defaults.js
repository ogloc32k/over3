const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
const CONFIG_FILE = path.join(DATA_DIR, 'deriv_config.json');

/**
 * Core trading parameters (defaults)
 * NOTE: APP_ID and API_TOKEN are read from environment variables,
 * not stored in the config file.
 */
const DEFAULT_CONFIG = Object.freeze({
    // ---------- Trade Execution ----------
    DURATION: 7,                     // Ticks for auto trading
    MAX_CONSECUTIVE_LOSSES: 3,
    LOSS_COOLDOWN_MS: 300000,
    COOLDOWN_TICKS: 5,

    // ---------- Strategy ----------
    ANALYSIS_WINDOW: 500,
    BOLLINGER_PERIOD: 20,
    BOLLINGER_STD: 2,
    RSI_PERIOD: 20,
    MIN_VOLATILITY_PERCENT: 0.10,    // 0.10% for sniper mode
    MA_DIFF_THRESHOLD: 0.08,         // Minimum absolute MA diff for entry

    // ---------- Risk ----------
    RISK_PERCENT: 1,
    TP_PERCENT: 5,
    SL_PERCENT: 10,
    MIN_STAKE: 0.35,

    // ---------- Timing ----------
    MIN_TRIGGER_INTERVAL: 300000,    // 5 minutes cooldown between trades
    SETTLEMENT_TIMEOUT_MS: 15000,
    PNL_SYNC_INTERVAL_MS: 300000
});

/**
 * Loads persisted config from disk and merges with defaults,
 * then injects environment variables for credentials.
 */
function loadConfig() {
    let saved = {};
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const rawData = fs.readFileSync(CONFIG_FILE, 'utf8');
            saved = JSON.parse(rawData);
        }
    } catch (error) {
        console.error(`[CONFIG ERROR] Failed to load config from ${CONFIG_FILE}:`, error.message);
    }

    // Merge defaults + saved user config + environment credentials
    const merged = {
        ...DEFAULT_CONFIG,
        ...saved,
        APP_ID: (process.env.DERIV_APP_ID || '').trim(),
        API_TOKEN: (process.env.DERIV_PAT || '').trim()
    };

    return merged;
}

/**
 * Saves user-modifiable settings to disk (credentials are NOT saved)
 */
function saveConfig(config) {
    try {
        if (!config || typeof config !== 'object') {
            throw new Error('Invalid config object provided');
        }
        // Remove credentials before saving to disk
        const { APP_ID, API_TOKEN, ...safeConfig } = config;
        const merged = { ...DEFAULT_CONFIG, ...safeConfig };

        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
        return merged;
    } catch (error) {
        console.error(`[CONFIG ERROR] Failed to save config to ${CONFIG_FILE}:`, error.message);
        throw error;
    }
}

module.exports = {
    DEFAULT_CONFIG,
    loadConfig,
    saveConfig
};
