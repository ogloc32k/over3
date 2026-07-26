const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../config/defaults');
const { supabase } = require('../database');

const CONFIG = loadConfig();
const STATE_FILE = '/var/data/deriv_multimarket_state.json';

const state = {
    active: false,
    tradingMode: 'demo',
    balance: null,
    currency: 'USD',
    sessionPnl: 0,
    dailyPnl: 0,
    dailyStartBalance: null,
    locked: false,
    lockReason: '',
    tradeInProgress: false,
    activeRealTrade: null,
    currentStake: 0.35,
    cooldownTicksLeft: 0,
    marketMetrics: {},
    logs: [],
    lastTriggerTime: 0,
    lossCooldownUntil: 0,
    pendingSettlement: false,
    consecutiveLosses: 0
};

function saveState() {
    try {
        const dir = path.dirname(STATE_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(STATE_FILE, JSON.stringify({
            date: new Date().toLocaleDateString("en-US", { timeZone: "Africa/Nairobi" }),
            tradingMode: state.tradingMode,
            locked: state.locked,
            lockReason: state.lockReason,
            sessionActive: state.active,
            sessionPnl: state.sessionPnl
        }));
    } catch(e) {}
}

function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            const today = new Date().toLocaleDateString("en-US", { timeZone: "Africa/Nairobi" });
            if (saved.date === today) {
                state.tradingMode = saved.tradingMode || 'demo';
                state.locked = saved.locked || false;
                state.lockReason = saved.lockReason || '';
                state.active = saved.sessionActive || false;
                state.sessionPnl = saved.sessionPnl || 0;
            } else {
                state.locked = false; state.lockReason = '';
                state.active = saved.sessionActive || false;
                state.sessionPnl = 0;
            }
        }
    } catch(e) {}
}

function getFullState() {
    const { logs, ...rest } = state;
    return { ...rest, marketMetrics: state.marketMetrics || {} };
}

// ---- TIGHTENED STRATEGY ----
function checkStrategy(symbol, metric) {
    if (!metric) return null;

    const { rsi, volatility, maDiff, maDiffExpanding2Tick } = metric;

    // 1. Volatility must be >= 0.06%
    if (volatility < CONFIG.MIN_VOLATILITY_PERCENT) {
        return null;
    }

    // 2. MA Diff must be expanding vs 2 ticks ago
    if (!maDiffExpanding2Tick) {
        return null;
    }

    // 3. MA Diff must be ≥ threshold (0.05%) in either direction
    const absMaDiff = Math.abs(maDiff);
    if (absMaDiff < CONFIG.MA_DIFF_THRESHOLD) {
        return null;
    }

    // 4. CALL conditions (RSI 58-68, maDiff positive)
    if (maDiff > 0 && rsi >= 58 && rsi <= 68) {
        return { direction: 'CALL', score: volatility * 1.5 };
    }

    // 5. PUT conditions (RSI 32-42, maDiff negative)
    if (maDiff < 0 && rsi >= 32 && rsi <= 42) {
        return { direction: 'PUT', score: volatility * 1.5 };
    }

    return null;
}

// ---- P&L sync and limits (unchanged) ----
async function syncDailyPnlFromDB() {
    try {
        const now = new Date();
        const todayStart = new Date(now);
        todayStart.setUTCHours(0, 0, 0, 0);
        const { data, error } = await supabase
            .from('trading_ledger')
            .select('profit_loss')
            .gte('created_at', todayStart.toISOString());
        if (error) throw error;
        const total = data.reduce((sum, row) => sum + (row.profit_loss || 0), 0);
        state.dailyPnl = total;
        if (state.balance !== null) state.dailyStartBalance = state.balance - state.dailyPnl;
        const limitHit = checkDailyLimits();
        return limitHit;
    } catch (err) { console.error('❌ Failed to sync daily P&L:', err.message); return false; }
}

function checkDailyLimits() {
    if (state.dailyStartBalance === null || state.dailyStartBalance === 0) return false;
    const tpLimit = state.dailyStartBalance * (CONFIG.TP_PERCENT / 100);
    const slLimit = state.dailyStartBalance * (CONFIG.SL_PERCENT / 100);
    if (state.dailyPnl >= tpLimit) {
        state.locked = true;
        state.lockReason = `🎯 Daily Target Reached: +$${state.dailyPnl.toFixed(2)} (${CONFIG.TP_PERCENT}% of start). Trading paused. Will resume at midnight.`;
        return true;
    }
    if (state.dailyPnl <= -slLimit) {
        state.locked = true;
        state.lockReason = `🛑 Daily Loss Limit Breached: -$${Math.abs(state.dailyPnl).toFixed(2)} (${CONFIG.SL_PERCENT}% of start). Trading paused. Will resume at midnight.`;
        return true;
    }
    if (state.locked && state.dailyPnl < tpLimit && state.dailyPnl > -slLimit) {
        state.locked = false;
        state.lockReason = '';
        return true;
    }
    return false;
}

module.exports = {
    CONFIG,
    state,
    saveState,
    loadState,
    getFullState,
    checkStrategy,
    syncDailyPnlFromDB,
    checkDailyLimits
};
