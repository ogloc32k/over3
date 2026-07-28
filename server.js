require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { supabase } = require('./database');
const { loadState, saveState, state, CONFIG, syncDailyPnlFromDB } = require('./state/manager');
const { connectDeriv, disconnectDeriv } = require('./ws/client');
const { addLog, broadcastSSE } = require('./api/sse');
const apiRoutes = require('./api/routes');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// ---------- Middleware ----------
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use('/api', apiRoutes);

// ---------- Scheduled Restart (safety net) ----------
function scheduleRestart() {
    const now = Date.now();
    const nextMidnightUTC = new Date(now);
    nextMidnightUTC.setUTCHours(0, 0, 0, 0);
    if (nextMidnightUTC.getTime() < now) {
        nextMidnightUTC.setUTCDate(nextMidnightUTC.getUTCDate() + 1);
    }
    const delay = nextMidnightUTC.getTime() - now;
    console.log(`⏰ Next full restart scheduled at ${nextMidnightUTC.toISOString()} (03:00 EAT)`);
    setTimeout(() => {
        console.log('🔄 Scheduled full restart at midnight. Resetting daily state...');
        state.locked = false;
        state.lockReason = '';
        state.dailyPnl = 0;
        saveState();
        process.exit(0);
    }, delay);
}
scheduleRestart();

// ---------- Database Health Check ----------
async function checkDatabaseConnection() {
    try {
        const { count, error } = await supabase
            .from('trading_ledger')
            .select('id', { count: 'exact', head: true });
        if (error) throw error;
        console.log(`✅ Supabase Database Connected (Total Records: ${count})`);
        return true;
    } catch (err) {
        console.error(`❌ Database Connection Error: ${err.message}`);
        return false;
    }
}

// ---------- Background PnL Sync ----------
let syncInterval = null;
function startPnlSync() {
    syncInterval = setInterval(async () => {
        if (state.balance !== null) {
            try {
                await syncDailyPnlFromDB();
            } catch (err) {
                console.error('[SYNC ERROR] Daily PnL Sync failed:', err.message);
            }
        }
    }, CONFIG.PNL_SYNC_INTERVAL_MS || 300000);
}

// ---------- Graceful Shutdown ----------
async function gracefulShutdown(signal) {
    console.log(`\n⚠️  Received ${signal}. Starting graceful shutdown...`);
    if (syncInterval) clearInterval(syncInterval);
    try {
        if (typeof disconnectDeriv === 'function') disconnectDeriv();
    } catch (e) {
        console.error('Error closing WebSocket:', e.message);
    }
    try {
        saveState();
        console.log('💾 State saved.');
    } catch (e) {
        console.error('Failed to save state:', e.message);
    }
    server.close(() => {
        console.log('🛑 Server stopped.');
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
    console.error('🚨 UNHANDLED REJECTION:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('🚨 UNCAUGHT EXCEPTION:', error.message);
    console.error(error.stack);
});

// ---------- Boot ----------
async function boot() {
    console.log('⚡ Initializing Trading Engine...');

    // 1. Load persisted state
    loadState();

    // 2. Check DB
    const dbOk = await checkDatabaseConnection();
    if (!dbOk) {
        console.warn('⚠️  Database connection failed. Cloud persistence may fail.');
    }

    // 3. Connect to Deriv WebSocket
    console.log('[DEBUG] About to call connectDeriv()...');
    try {
        connectDeriv();
        console.log('[DEBUG] connectDeriv() returned successfully.');
    } catch (err) {
        console.error('[DEBUG] connectDeriv() threw an error:', err.message);
        console.error(err.stack);
    }

    // 4. Start PnL sync
    startPnlSync();

    // 5. Start HTTP server
    server.listen(PORT, () => {
        console.log(`🚀 System Online & Armed on port ${PORT}`);
    });
}

boot();
