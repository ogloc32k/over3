require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { supabase } = require('./database');
const { loadState, saveState, state, CONFIG, syncDailyPnlFromDB } = require('./state/manager');
const { connectDeriv, disconnectDeriv } = require('./ws/client');
const apiRoutes = require('./api/routes');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// ---------- Middleware & Routes ----------
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use('/api', apiRoutes);

// ---------- Database Health Check ----------
async function checkDatabaseConnection() {
    try {
        const { count, error } = await supabase
            .from('trading_ledger')
            .select('id', { count: 'exact', head: true });
        
        if (error) throw error;
        console.log(`✅ Supabase Connected (Total Ledger Records: ${count ?? 0})`);
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

// ---------- Graceful Shutdown Handling ----------
async function gracefulShutdown(signal) {
    console.log(`\n⚠️  Received ${signal}. Starting graceful shutdown...`);
    
    if (syncInterval) clearInterval(syncInterval);
    
    // 1. Close WebSockets
    try {
        if (typeof disconnectDeriv === 'function') disconnectDeriv();
    } catch (e) {
        console.error('Error closing WebSocket:', e.message);
    }

    // 2. Persist state to disk
    try {
        saveState();
        console.log('💾 State successfully saved before exit.');
    } catch (e) {
        console.error('Failed to save state during shutdown:', e.message);
    }

    // 3. Stop HTTP server & exit
    server.close(() => {
        console.log('🛑 HTTP Server stopped. Process exiting cleanly.');
        process.exit(0);
    });

    // Hard exit safeguard after 5 seconds if server hangs
    setTimeout(() => process.exit(1), 5000);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('unhandledRejection', (reason, promise) => {
    console.error('🚨 UNHANDLED REJECTION:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('🚨 UNCAUGHT EXCEPTION:', error.message);
    console.error(error.stack);
});

// ---------- Boot Sequence ----------
async function boot() {
    console.log('⚡ Initializing Trading Engine...');
    
    // 1. Load persisted disk state
    loadState();

    // 2. Verify DB before connecting to live broker
    const dbOk = await checkDatabaseConnection();
    if (!dbOk) {
        console.warn('⚠️  Database connection failed during boot. System will start, but cloud persistence may fail.');
    }

    // 3. Connect to Deriv WebSocket & start sync timers
    connectDeriv();
    startPnlSync();

    // 4. Bind HTTP Server
    server.listen(PORT, () => {
        console.log(`🚀 System Online & Armed on port ${PORT}`);
    });
}

boot();
