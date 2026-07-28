const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
const CONFIG_FILE = path.join(DATA_DIR, 'deriv_config.json');

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

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const rawData = fs.readFileSync(CONFIG_FILE, 'utf8');
            const saved = JSON.parse(rawData);
            return { ...DEFAULT_CONFIG, ...saved };
        }
    } catch (error) {
        console.error(`[CONFIG ERROR] Failed to load config from ${CONFIG_FILE}:`, error.message);
    }
    return { ...DEFAULT_CONFIG };
}

function saveConfig(config) {
    try {
        if (!config || typeof config !== 'object') {
            throw new Error('Invalid config object provided');
        }
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        
        const merged = { ...DEFAULT_CONFIG, ...config };
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
        return merged;
    } catch (error) {
        console.error(`[CONFIG ERROR] Failed to save config to ${CONFIG_FILE}:`, error.message);
        throw error; // Re-throw so caller (e.g. API route) knows it failed
    }
}

module.exports = { DEFAULT_CONFIG, loadConfig, saveConfig };
