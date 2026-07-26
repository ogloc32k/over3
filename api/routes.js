const express = require('express');
const router = express.Router();
const { CONFIG, state, getFullState, saveState, syncDailyPnlFromDB, checkDailyLimits } = require('../state/manager');
const { saveConfig } = require('../config/defaults');
const { addLog, broadcastSSE, sseClients } = require('./sse');
const { supabase } = require('../database');
const { MARKETS } = require('../markets/definitions');
const { disconnectDeriv, connectDeriv, send } = require('../ws/client');

// =====================================================================
//  CONFIG API
// =====================================================================
router.get('/config', (req, res) => { res.json(CONFIG); });

router.post('/config', (req, res) => {
    try {
        const newConfig = req.body;
        if (typeof newConfig !== 'object') throw new Error('Invalid config');
        Object.assign(CONFIG, newConfig);
        saveConfig(CONFIG);
        res.json({ success: true, config: CONFIG });
    } catch(err) {
        res.status(400).json({ error: err.message });
    }
});

// =====================================================================
//  ANALYTICS API
// =====================================================================
router.get('/ledger/analytics', async (req, res) => {
    const { start, end, mode } = req.query;

    if (mode === 'session') {
        const settlements = state.logs ? state.logs.filter(l => l.message.includes('Settlement')) : [];
        const wins = settlements.filter(l => l.message.includes('WIN')).length;
        const strikeRate = settlements.length > 0 ? ((wins / settlements.length) * 100).toFixed(1) : 0;
        return res.json({
            totalProfit: state.sessionPnl || 0,
            strikeRate: strikeRate,
            totalTrades: settlements.length,
            rawData: []
        });
    }

    let startDate = start, endDate = end;
    const now = new Date();
    if (mode === 'hour') {
        const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
        startDate = oneHourAgo.toISOString();
        endDate = now.toISOString();
    } else if (mode === '24h') {
        const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        startDate = oneDayAgo.toISOString();
        endDate = now.toISOString();
    } else if (mode === 'month') {
        const oneMonthAgo = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
        startDate = oneMonthAgo.toISOString();
        endDate = now.toISOString();
    } else if (mode === '6months') {
        const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
        startDate = sixMonthsAgo.toISOString();
        endDate = now.toISOString();
    } else if (mode === '1year') {
        const oneYearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
        startDate = oneYearAgo.toISOString();
        endDate = now.toISOString();
    }

    if (!startDate || !endDate) {
        return res.status(400).json({ error: 'Invalid date range. Please provide start and end dates.' });
    }

    try {
        const { data, error } = await supabase
            .from('trading_ledger')
            .select('*')
            .gte('created_at', startDate)
            .lte('created_at', endDate);

        if (error) throw error;

        const totalProfit = data.reduce((acc, curr) => acc + (curr.profit_loss || 0), 0);
        const totalTrades = data.length;
        const wins = data.filter(t => t.is_win).length;
        const strikeRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : 0;

        let grossProfit = 0, grossLoss = 0;
        data.forEach(t => {
            const pnl = t.profit_loss || 0;
            if (pnl > 0) grossProfit += pnl;
            else if (pnl < 0) grossLoss += Math.abs(pnl);
        });
        const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss) : (grossProfit > 0 ? Infinity : 0);

        const sorted = data.slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        let peak = 0, maxDrawdown = 0, cum = 0;
        sorted.forEach(t => {
            cum += (t.profit_loss || 0);
            if (cum > peak) peak = cum;
            const drawdown = peak - cum;
            if (drawdown > maxDrawdown) maxDrawdown = drawdown;
        });
        const drawdownPercent = (peak > 0) ? (maxDrawdown / peak) * 100 : 0;

        res.json({
            totalProfit: totalProfit.toFixed(2),
            strikeRate,
            totalTrades,
            profitFactor: profitFactor.toFixed(2),
            drawdown: drawdownPercent.toFixed(2),
            rawData: data
        });
    } catch (err) {
        console.error('❌ Analytics Error:', err.message);
        res.status(500).json({ error: 'Failed to fetch historical data' });
    }
});

// =====================================================================
//  SSE LOGS ENDPOINT
// =====================================================================
router.get('/logs', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const client = res;
    sseClients.add(client);
    client.write(`data: ${JSON.stringify({ state: getFullState(), logs: state.logs.slice(0, 50) })}\n\n`);
    req.on('close', () => {
        sseClients.delete(client);
        client.end();
    });
});

// =====================================================================
//  CONTROL API
// =====================================================================
router.post('/control', (req, res) => {
    const { action, mode } = req.body;
    if (action === 'start') {
        state.active = true;
        let msg = '🔓 Automation matrix ARMED by user.';
        if (state.locked) {
            msg = `🔓 Automation matrix ARMED (paused until midnight): ${state.lockReason}`;
            addLog(msg);
            return res.json({ success: true, message: msg });
        }
        addLog(msg);
        return res.json({ success: true });
    }
    if (action === 'stop') {
        state.active = false;
        addLog('🔒 Automation matrix DISARMED by user.');
        return res.json({ success: true });
    }
    if (action === 'set_mode') {
        if (!mode || !['demo', 'real'].includes(mode)) {
            return res.status(400).json({ error: 'Invalid mode. Use "demo" or "real".' });
        }
        state.tradingMode = mode;
        state.active = false;
        addLog(`🔄 Switching to ${mode.toUpperCase()} account. Reconnecting...`);
        disconnectDeriv();
        setTimeout(connectDeriv, 1000);
        return res.json({ success: true });
    }
    res.status(400).json({ error: 'Unknown action.' });
});

// =====================================================================
//  MANUAL TRADE
// =====================================================================
router.post('/manual-trade', (req, res) => {
    const { symbol, contractType, duration, durationUnit } = req.body;
    
    if (state.locked || state.tradeInProgress) {
        return res.status(400).json({ error: state.locked ? state.lockReason : 'Trade in progress.' });
    }
    if (!MARKETS[symbol]) return res.status(400).json({ error: 'Invalid symbol.' });
    if (!['CALL', 'PUT'].includes(contractType)) {
        return res.status(400).json({ error: 'Invalid contract type. Use "CALL" or "PUT".' });
    }

    if (state.balance < CONFIG.MIN_STAKE) {
        return res.status(400).json({ error: 'Insufficient funds for minimum stake. Trading paused.' });
    }

    let dur = parseInt(duration) || CONFIG.DURATION;
    let unit = durationUnit || 's';
    if (unit === 't') { if (dur < 1) dur = 1; if (dur > 10) dur = 10; }
    if (unit === 's') { if (dur < 5) dur = 5; if (dur > 600) dur = 600; }
    if (unit === 'm') { if (dur < 1) dur = 1; if (dur > 10) dur = 10; }

    const rawStake = Math.max(CONFIG.MIN_STAKE, state.balance * (CONFIG.RISK_PERCENT / 100));
    state.currentStake = Math.round(Math.min(rawStake, state.balance) * 100) / 100;
    state.tradeInProgress = true;

    state.activeRealTrade = {
        symbol,
        stake: state.currentStake,
        balanceBefore: state.balance,
        contractType,
        barrier: null,
        direction: contractType,
        entryPrice: null,
        executionTime: Date.now(),
        settlementTimeout: null,
        settled: false
    };

    // reqId is defined in ws/client, but we need to import it – better to pass send function and reqId from client
    // We'll use a global variable or export reqId from client. For now, we'll require client and use its reqId
    const { reqId, send: wsSend } = require('../ws/client');
    wsSend({
        proposal: 1,
        amount: state.currentStake,
        basis: 'stake',
        contract_type: contractType,
        currency: state.currency || 'USD',
        duration: dur,
        duration_unit: unit,
        underlying_symbol: symbol,
        req_id: ++reqId
    });

    addLog(`📤 Manual ${contractType} request for ${symbol} (${dur} ${unit === 't' ? 'ticks' : unit === 's' ? 'seconds' : 'minutes'})...`);
    res.json({ success: true, message: 'Proposal requested' });
});

module.exports = router;
