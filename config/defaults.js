const fs = require('fs');
const path = require('path');

const CONFIG_FILE = '/var/data/deriv_config.json';

const DEFAULT_CONFIG = {
    // ---------- Trade Execution ----------
    DURATION: 7,                     // 7 ticks for auto trading
    MAX_CONSECUTIVE_LOSSES: 3,
    LOSS_COOLDOWN_MS: 300000,
    COOLDOWN_TICKS: 5,

    // ---------- Strategy ----------
    ANALYSIS_WINDOW: 500,
    BOLLINGER_PERIOD: 20,
    BOLLINGER_STD: 2,
    RSI_PERIOD: 20,
    MIN_VOLATILITY_PERCENT: 0.10,    // increased to 0.10% for sniper mode
    MA_DIFF_THRESHOLD: 0.08,         // minimum absolute MA diff for entry

    // ---------- Risk ----------
    RISK_PERCENT: 1,
    TP_PERCENT: 5,
    SL_PERCENT: 10,
    MIN_STAKE: 0.35,

    // ---------- Timing ----------
    MIN_TRIGGER_INTERVAL: 300000,    // 5 minutes cooldown between trades
    SETTLEMENT_TIMEOUT_MS: 15000,
    PNL_SYNC_INTERVAL_MS: 300000
};

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            return { ...DEFAULT_CONFIG, ...saved };
        }
    } catch(e) {}
    return { ...DEFAULT_CONFIG };
}

function saveConfig(config) {
    try {
        const dir = path.dirname(CONFIG_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    } catch(e) {}
}

module.exports = { DEFAULT_CONFIG, loadConfig, saveConfig };
