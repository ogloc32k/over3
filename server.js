require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { supabase } = require('./database');
const { loadState, saveState, state, CONFIG, syncDailyPnlFromDB, startMidnightHeartbeat } = require('./state/manager');
const { connectDeriv } = require('./ws/client');
const { addLog } = require('./api/sse');
const apiRoutes = require('./api/routes');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use('/api', apiRoutes);

// =====================================================================
//  SCHEDULED RESTART (safety net)
// =====================================================================
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
        state.dailyLimitReached = false;
        saveState();
        process.exit(0);
    }, delay);
}
scheduleRestart();

// =====================================================================
//  DATABASE HEALTH CHECK
// =====================================================================
async function checkDatabaseConnection() {
    try {
        const { count, error } = await supabase
            .from('trading_ledger')
            .select('id', { count: 'exact', head: true });
        if (error) throw error;
        console.log(`✅ Supabase Database Connected (Total Records: ${count})`);
        return true;
    } catch (err) {
        console.error(`❌ Database Connection Failed: ${err.message}`);
        return false;
    }
}

// =====================================================================
//  PERIODIC SYNC
// =====================================================================
setInterval(() => {
    if (state.balance !== null) {
        syncDailyPnlFromDB().catch(err => console.error('Periodic sync error:', err));
    }
}, CONFIG.PNL_SYNC_INTERVAL_MS);

// =====================================================================
//  STARTUP
// =====================================================================
loadState();

// ---- Start the midnight heartbeat (resets daily limits without restart) ----
startMidnightHeartbeat();

checkDatabaseConnection().then(() => {
    connectDeriv();
    server.listen(PORT, () => console.log(`🚀 System Armed on port ${PORT}`));
});
