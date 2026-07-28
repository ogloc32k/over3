const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../config/defaults');
const { supabase } = require('../database');

const CONFIG = loadConfig();
const STATE_FILE = '/var/data/deriv_multimarket_state.json';
const TIMEZONE = 'Africa/Nairobi';

// Helper: Get ISO Date string (YYYY-MM-DD) in Africa/Nairobi timezone
function getNairobiDateStr(date = new Date()) {
    return date.toLocaleDateString("en-CA", { timeZone: TIMEZONE });
}

const state = {
    active: false,
    tradingMode: 'demo',
    
    // ---- Connection & Execution State (Used by client.js) ----
    isConnected: false,
    isTrading: false, 
    tradeInProgress: false, // Kept for backward compatibility with other files
    balance: null,
    currency: 'USD',
    lastTick: null,
    lastDigit: null,

    // ---- PnL & Performance Metrics ----
    sessionPnl: 0,
    dailyPnl: 0,
    totalProfit: 0, // Used by client.js
    totalWins: 0,   // Used by client.js
    totalLosses: 0, // Used by client.js
    consecutiveLosses: 0,
    dailyStartBalance: null,

    // ---- Risk Management & Locks ----
    locked: false,
    lockReason: '',
    lossCooldownUntil: 0,
    cooldownTicksLeft: 0,
    
    // ---- Trade Context ----
    activeRealTrade: null,
    currentStake: 0.35,
    marketMetrics: {},
    logs: [],
    lastTriggerTime: 0,
    pendingSettlement: false,
    
    // ---- Midnight heartbeat tracking ----
    currentTradingDayStr: getNairobiDateStr(),
    dailyLimitReached: false,
    lastTradeTimestamp: 0
};

// ---------- Atomic File Persistence ----------
function saveState() {
    try {
        const dir = path.dirname(STATE_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const payload = JSON.stringify({
            dateStr: getNairobiDateStr(),
            tradingMode: state.tradingMode,
            locked: state.locked,
            lockReason: state.lockReason,
            sessionActive: state.active,
            sessionPnl: state.sessionPnl,
            dailyPnl: state.dailyPnl,
            totalProfit: state.totalProfit,
            totalWins: state.totalWins,
            totalLosses: state.totalLosses,
            consecutiveLosses: state.consecutiveLosses,
            dailyLimitReached: state.dailyLimitReached,
            dailyStartBalance: state.dailyStartBalance
        }, null, 2);

        // Safe atomic write pattern
        const tempPath = `${STATE_FILE}.tmp`;
        fs.writeFileSync(tempPath, payload, 'utf8');
        fs.renameSync(tempPath, STATE_FILE);
    } catch (e) {
        console.error('❌ [State Manager] Failed to save state:', e.message);
    }
}

function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const raw = fs.readFileSync(STATE_FILE, 'utf8');
            const saved = JSON.parse(raw);
            const todayStr = getNairobiDateStr();

            if (saved.dateStr === todayStr) {
                state.tradingMode = saved.tradingMode || 'demo';
                state.locked = saved.locked || false;
                state.lockReason = saved.lockReason || '';
                state.active = saved.sessionActive || false;
                state.sessionPnl = saved.sessionPnl || 0;
                state.dailyPnl = saved.dailyPnl || 0;
                state.totalProfit = saved.totalProfit || 0;
                state.totalWins = saved.totalWins || 0;
                state.totalLosses = saved.totalLosses || 0;
                state.consecutiveLosses = saved.consecutiveLosses || 0;
                state.dailyLimitReached = saved.dailyLimitReached || false;
                state.dailyStartBalance = saved.dailyStartBalance || null;
            } else {
                console.log(`[State Manager] New day detected on startup. Resetting daily counters.`);
                state.locked = false;
                state.lockReason = '';
                state.active = saved.sessionActive || false;
                state.sessionPnl = 0;
                state.dailyPnl = 0;
                state.totalProfit = 0;
                state.totalWins = 0;
                state.totalLosses = 0;
                state.consecutiveLosses = 0;
                state.dailyLimitReached = false;
                state.dailyStartBalance = null;
            }
            state.currentTradingDayStr = todayStr;
        }
    } catch (e) {
        console.error('⚠️ [State Manager] Error reading state file (resetting to defaults):', e.message);
    }
}

function getFullState() {
    const { logs, ...rest } = state;
    return { ...rest, marketMetrics: state.marketMetrics || {} };
}

// ---------- Midnight Heartbeat ----------
function startMidnightHeartbeat() {
    setInterval(() => {
        const todayStr = getNairobiDateStr();
        if (todayStr !== state.currentTradingDayStr) {
            console.log(`[System] 🕛 Midnight crossed (${TIMEZONE}). Resetting daily limits for new session.`);
            state.currentTradingDayStr = todayStr;
            
            // Reset Session / Daily Trackers
            state.dailyPnl = 0;
            state.sessionPnl = 0;
            state.totalProfit = 0;
            state.totalWins = 0;
            state.totalLosses = 0;
            state.consecutiveLosses = 0;
            
            // Reset Lock States
            state.dailyLimitReached = false;
            state.locked = false;
            state.lockReason = '';
            
            state.lastTradeTimestamp = 0;
            
            if (state.balance !== null) {
                state.dailyStartBalance = state.balance;
            }
            saveState();
        }
    }, 30000); // Check every 30 seconds
}

// ---------- Strategy Check ----------
function checkStrategy(symbol, metric) {
    if (!metric) return null;

    // Aligned with pipeline output property: maDiffExpanding
    const { rsi, volatility, maDiff, maDiffExpanding } = metric;

    if (volatility < CONFIG.MIN_VOLATILITY_PERCENT) return null;
    if (!maDiffExpanding) return null;
    if (Math.abs(maDiff) < CONFIG.MA_DIFF_THRESHOLD) return null;

    // Signal confirmation
    if (maDiff > 0 && rsi >= 50 && rsi <= (CONFIG.OVERBOUGHT_THRESHOLD || 85)) {
        return { direction: 'CALL', score: volatility * 1.5 };
    }
    if (maDiff < 0 && rsi <= 50 && rsi >= (CONFIG.OVERSOLD_THRESHOLD || 15)) {
        return { direction: 'PUT', score: volatility * 1.5 };
    }
    return null;
}

// ---------- Database Sync ----------
async function syncDailyPnlFromDB() {
    try {
        // Calculate Nairobi midnight in UTC ISO format
        const nowStr = getNairobiDateStr();
        const startOfDayNairobi = new Date(`${nowStr}T00:00:00+03:00`);

        const { data, error } = await supabase
            .from('trading_ledger')
            .select('profit_loss')
            .gte('created_at', startOfDayNairobi.toISOString());

        if (error) throw error;

        const total = data.reduce((sum, row) => sum + (row.profit_loss || 0), 0);
        state.dailyPnl = total;

        if (state.balance !== null && state.dailyStartBalance === null) {
            state.dailyStartBalance = state.balance - state.dailyPnl;
        }

        return checkDailyLimits();
    } catch (err) {
        console.error('❌ Failed to sync daily P&L from DB:', err.message);
        return false;
    }
}

// ---------- Risk Limits ----------
function checkDailyLimits() {
    // If start balance is missing, attempt fallback to current balance
    const baseBalance = state.dailyStartBalance || state.balance;
    if (!baseBalance || baseBalance <= 0) return false;

    const tpLimit = baseBalance * (CONFIG.TP_PERCENT / 100);
    const slLimit = baseBalance * (CONFIG.SL_PERCENT / 100);

    if (state.dailyPnl >= tpLimit) {
        state.locked = true;
        state.dailyLimitReached = true;
        state.lockReason = `🎯 Daily Target Reached: +$${state.dailyPnl.toFixed(2)} (${CONFIG.TP_PERCENT}%). Trading paused.`;
        saveState();
        return true;
    }

    if (state.dailyPnl <= -slLimit) {
        state.locked = true;
        state.dailyLimitReached = true;
        state.lockReason = `🛑 Daily Loss Limit Breached: -$${Math.abs(state.dailyPnl).toFixed(2)} (${CONFIG.SL_PERCENT}%). Trading paused.`;
        saveState();
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
    startMidnightHeartbeat,
    checkStrategy,
    syncDailyPnlFromDB,
    checkDailyLimits
};
