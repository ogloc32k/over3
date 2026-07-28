const fs = require('fs');
const path = require('path');
const { defaultConfig } = require('../config/defaults');
const { supabase } = require('../database');

// Path to persist state across restarts
const STATE_FILE = path.join(__dirname, '../../data/state.json');

// Global CONFIG object initialized with defaults
const CONFIG = { ...defaultConfig };

/**
 * Mutable Global State Container
 */
const state = {
    // Connection & Mode
    isConnected: false,
    active: false,             // Is automated bot armed?
    tradingMode: 'demo',       // 'demo' or 'real'
    currency: 'USD',
    balance: 0.00,

    // Lock & Limits
    locked: false,
    lockReason: null,

    // Trade Tracking
    isTrading: false,           // WS execution in flight
    tradeInProgress: false,     // Manual trade or bot pipeline active
    activeRealTrade: null,      // Active contract details (includes barrier, symbol, duration)
    currentStake: CONFIG.MIN_STAKE,

    // Performance Metrics
    sessionPnl: 0.00,
    dailyPnl: 0.00,
    totalProfit: 0.00,
    totalWins: 0,
    totalLosses: 0,
    consecutiveLosses: 0,

    // Real-Time Digit & Market Feed
    lastTick: 0,
    lastDigit: null,
    digitHistory: [],           // Array of last N digits (e.g., max 100)
    marketMetrics: {
        digitCounts: { 0:0, 1:0, 2:0, 3:0, 4:0, 5:0, 6:0, 7:0, 8:0, 9:0 },
        digitPercentages: { 0:0, 1:0, 2:0, 3:0, 4:0, 5:0, 6:0, 7:0, 8:0, 9:0 },
        evenPercent: 50,
        oddPercent: 50,
        overPercent: 50,        // Over 4 (5-9)
        underPercent: 50,       // Under 5 (0-4)
        sampleSize: 0
    },

    // In-memory System Logs
    logs: []
};

/**
 * Recalculates digit distribution statistics from digitHistory
 */
function updateMarketMetrics() {
    const history = state.digitHistory || [];
    const total = history.length;

    if (total === 0) return;

    const counts = { 0:0, 1:0, 2:0, 3:0, 4:0, 5:0, 6:0, 7:0, 8:0, 9:0 };
    let evens = 0;
    let odds = 0;
    let overs = 0;   // 5, 6, 7, 8, 9
    let unders = 0;  // 0, 1, 2, 3, 4

    history.forEach(d => {
        if (counts[d] !== undefined) counts[d]++;
        if (d % 2 === 0) evens++; else odds++;
        if (d >= 5) overs++; else unders++;
    });

    const percentages = {};
    for (let i = 0; i <= 9; i++) {
        percentages[i] = parseFloat(((counts[i] / total) * 100).toFixed(1));
    }

    state.marketMetrics = {
        digitCounts: counts,
        digitPercentages: percentages,
        evenPercent: parseFloat(((evens / total) * 100).toFixed(1)),
        oddPercent: parseFloat(((odds / total) * 100).toFixed(1)),
        overPercent: parseFloat(((overs / total) * 100).toFixed(1)),
        underPercent: parseFloat(((unders / total) * 100).toFixed(1)),
        sampleSize: total
    };
}

/**
 * Returns a comprehensive, serialized snapshot of the state
 * (Calculates live market metrics right before returning for SSE emission)
 */
function getFullState() {
    updateMarketMetrics();

    return {
        isConnected: state.isConnected,
        active: state.active,
        tradingMode: state.tradingMode,
        currency: state.currency,
        balance: state.balance,
        locked: state.locked,
        lockReason: state.lockReason,
        isTrading: state.isTrading,
        tradeInProgress: state.tradeInProgress,
        activeRealTrade: state.activeRealTrade,
        currentStake: state.currentStake,
        sessionPnl: parseFloat((state.sessionPnl || 0).toFixed(2)),
        dailyPnl: parseFloat((state.dailyPnl || 0).toFixed(2)),
        totalProfit: parseFloat((state.totalProfit || 0).toFixed(2)),
        totalWins: state.totalWins,
        totalLosses: state.totalLosses,
        consecutiveLosses: state.consecutiveLosses,
        lastTick: state.lastTick,
        lastDigit: state.lastDigit,
        digitHistory: state.digitHistory.slice(-20), // Send last 20 ticks for UI sparklines
        marketMetrics: state.marketMetrics,
        config: CONFIG
    };
}

/**
 * Checks risk management rules (Daily Stop Loss / Take Profit)
 */
function checkDailyLimits() {
    if (state.locked) return true;

    if (CONFIG.TAKE_PROFIT > 0 && state.dailyPnl >= CONFIG.TAKE_PROFIT) {
        state.locked = true;
        state.lockReason = `🎯 Target Take Profit achieved (+$${state.dailyPnl.toFixed(2)}). Trading locked.`;
        state.active = false;
        return true;
    }

    if (CONFIG.STOP_LOSS > 0 && state.dailyPnl <= -Math.abs(CONFIG.STOP_LOSS)) {
        state.locked = true;
        state.lockReason = `🛑 Daily Stop Loss hit (-$${Math.abs(state.dailyPnl).toFixed(2)}). Trading locked.`;
        state.active = false;
        return true;
    }

    return false;
}

/**
 * Syncs cumulative PnL for today from Supabase ledger
 */
async function syncDailyPnlFromDB() {
    try {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        const { data, error } = await supabase
            .from('trading_ledger')
            .select('profit_loss')
            .gte('created_at', todayStart.toISOString());

        if (error) throw error;

        const sum = data.reduce((acc, row) => acc + (row.profit_loss || 0), 0);
        state.dailyPnl = sum;
        checkDailyLimits();
    } catch (err) {
        console.error('❌ Failed to sync daily PnL from DB:', err.message);
    }
}

/**
 * Persists session state to JSON file
 */
function saveState() {
    try {
        const dir = path.dirname(STATE_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const snapshot = {
            sessionPnl: state.sessionPnl,
            totalWins: state.totalWins,
            totalLosses: state.totalLosses,
            consecutiveLosses: state.consecutiveLosses,
            locked: state.locked,
            lockReason: state.lockReason
        };

        fs.writeFileSync(STATE_FILE, JSON.stringify(snapshot, null, 2));
    } catch (err) {
        console.error('Failed to save state:', err.message);
    }
}

/**
 * Loads session state from JSON file
 */
function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const raw = fs.readFileSync(STATE_FILE, 'utf8');
            const data = JSON.parse(raw);
            Object.assign(state, data);
            console.log('📂 Restored previous session state.');
        }
    } catch (err) {
        console.error('Failed to load state file:', err.message);
    }
}

// Load state on startup
loadState();

module.exports = {
    CONFIG,
    state,
    getFullState,
    checkDailyLimits,
    syncDailyPnlFromDB,
    saveState,
    loadState
};
