const express = require('express');
const router = express.Router();
const { CONFIG, state, getFullState, saveState, syncDailyPnlFromDB, checkDailyLimits } = require('../state/manager');
const { saveConfig } = require('../config/defaults');
const { addLog, broadcastSSE, sseClients } = require('./sse');
const { supabase } = require('../database');
const { MARKETS } = require('../markets/definitions');
const { disconnectDeriv, connectDeriv, send, getNextReqId } = require('../ws/client');

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
//  AGGREGATED ANALYTICS (lightweight)
// =====================================================================
router.get('/ledger/aggregated', async (req, res) => {
    try {
        const { mode } = req.query;
        const now = new Date();
        let startDate;

        switch (mode) {
            case '24h':
                startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
                break;
            case 'week':
                startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                break;
            case 'month':
                startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
                break;
            case 'year':
                startDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
                break;
            case 'session':
                // Session: use state.sessionPnl without DB query
                return res.json({
                    assetContributions: [],
                    equityData: [{ timestamp: Date.now(), equity: state.sessionPnl || 0 }],
                    totalProfit: state.sessionPnl || 0,
                    tradeCount: 0
                });
            default:
                // Default to 24h
                startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        }

        const { data, error } = await supabase
            .from('trading_ledger')
            .select('*')
            .gte('created_at', startDate.toISOString())
            .order('created_at', { ascending: true });

        if (error) throw error;

        // ---- Asset contribution (horizontal bar chart) ----
        const assetMap = {};
        data.forEach(t => {
            const asset = t.asset || 'Unknown';
            assetMap[asset] = (assetMap[asset] || 0) + (t.profit_loss || 0);
        });
        const assetContributions = Object.entries(assetMap)
            .map(([name, pnl]) => ({ name, pnl }))
            .sort((a, b) => b.pnl - a.pnl);

        // ---- Time‑bucketed equity ----
        const bucketSize = mode === '24h' ? 15 * 60 * 1000 :  // 15 min
                           mode === 'week' ? 60 * 60 * 1000 : // 1 hour
                           mode === 'month' ? 24 * 60 * 60 * 1000 : // 1 day
                           24 * 60 * 60 * 1000;

        const buckets = [];
        let currentBucketStart = startDate.getTime();
        const endTime = now.getTime();
        let cum = 0;
        let idx = 0;

        while (currentBucketStart < endTime) {
            const bucketEnd = Math.min(currentBucketStart + bucketSize, endTime);
            let equityAtEnd = cum;
            while (idx < data.length && new Date(data[idx].created_at).getTime() <= bucketEnd) {
                equityAtEnd += data[idx].profit_loss || 0;
                idx++;
            }
            buckets.push({
                timestamp: currentBucketStart + bucketSize / 2,
                equity: equityAtEnd
            });
            cum = equityAtEnd;
            currentBucketStart = bucketEnd;
        }

        // Ensure at least two points
        if (buckets.length < 2) {
            const firstEquity = data.length > 0 ? data.reduce((s, t) => s + (t.profit_loss || 0), 0) : 0;
            buckets.push({ timestamp: startDate.getTime(), equity: 0 });
            buckets.push({ timestamp: endTime, equity: firstEquity });
        }

        res.json({
            assetContributions,
            equityData: buckets,
            totalProfit: data.reduce((s, t) => s + (t.profit_loss || 0), 0),
            tradeCount: data.length
        });

    } catch (err) {
        console.error('Aggregated analytics error:', err);
        res.status(500).json({ error: err.message });
    }
});

// =====================================================================
//  ANALYTICS API (legacy, kept for compatibility)
// =====================================================================
router.get('/ledger/analytics', async (req, res) => {
    try {
        const { start, end, mode } = req.query;
        const now = new Date();

        let startDate, endDate;

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

        if (mode === 'hour') {
            startDate = new Date(now.getTime() - 60 * 60 * 1000);
            endDate = now;
        } else if (mode === '24h') {
            startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            endDate = now;
        } else if (mode === 'week' || mode === '1w') {
            startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            endDate = now;
        } else if (mode === 'month' || mode === '1m') {
            startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            endDate = now;
        } else if (mode === '6months' || mode === '6m') {
            startDate = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
            endDate = now;
        } else if (mode === '1year' || mode === '1y') {
            startDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
            endDate = now;
        } else if (start && end) {
            startDate = new Date(start);
            endDate = new Date(end);
            if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
                return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
            }
        } else {
            startDate = null;
            endDate = null;
        }

        let query = supabase
            .from('trading_ledger')
            .select('*');

        if (startDate && endDate) {
            const startISO = startDate.toISOString();
            const endISO = endDate.toISOString();
            query = query.gte('created_at', startISO).lte('created_at', endISO);
        }

        const { data, error } = await query.order('created_at', { ascending: true });

        if (error) {
            console.error('❌ Supabase query error:', error.message);
            return res.status(500).json({ error: 'Database query failed: ' + error.message });
        }

        const totalTrades = data.length;
        let totalProfit = 0;
        let wins = 0;
        let grossProfit = 0;
        let grossLoss = 0;
        let cum = 0;
        let peak = 0;
        let maxDrawdown = 0;

        data.forEach(t => {
            const pnl = t.profit_loss || 0;
            totalProfit += pnl;
            if (pnl > 0) {
                wins++;
                grossProfit += pnl;
            } else if (pnl < 0) {
                grossLoss += Math.abs(pnl);
            }
            cum += pnl;
            if (cum > peak) peak = cum;
            const drawdown = peak - cum;
            if (drawdown > maxDrawdown) maxDrawdown = drawdown;
        });

        const strikeRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : 0;
        const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss) : (grossProfit > 0 ? Infinity : 0);
        const drawdownPercent = (peak > 0) ? (maxDrawdown / peak) * 100 : 0;

        res.json({
            totalProfit: parseFloat(totalProfit.toFixed(2)),
            strikeRate: parseFloat(strikeRate),
            totalTrades,
            profitFactor: profitFactor === Infinity ? 'Infinity' : parseFloat(profitFactor.toFixed(2)),
            drawdown: parseFloat(drawdownPercent.toFixed(2)),
            rawData: data
        });

    } catch (err) {
        console.error('❌ Analytics error:', err);
        res.status(500).json({ error: 'Internal server error: ' + err.message });
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
router.post('/manual-trade', async (req, res) => {
    try {
        const { symbol, contractType, duration, durationUnit, price } = req.body;

        if (!symbol || !MARKETS[symbol]) {
            return res.status(400).json({ error: 'Invalid or missing symbol.' });
        }
        if (!['CALL', 'PUT'].includes(contractType)) {
            return res.status(400).json({ error: 'Invalid contract type. Use "CALL" or "PUT".' });
        }

        if (state.locked) {
            return res.status(400).json({ error: state.lockReason || 'System is locked.' });
        }
        if (state.tradeInProgress) {
            return res.status(400).json({ error: 'Another trade is already in progress.' });
        }
        if (state.balance < CONFIG.MIN_STAKE) {
            return res.status(400).json({ error: 'Insufficient funds for minimum stake.' });
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
            duration: dur,
            durationUnit: unit,
            barrier: null,
            direction: contractType,
            entryPrice: null,
            executionTime: Date.now(),
            settled: false,
            entryLogged: false,
            contractId: null
        };

        send({
            proposal: 1,
            amount: state.currentStake,
            basis: 'stake',
            contract_type: contractType,
            currency: state.currency || 'USD',
            duration: dur,
            duration_unit: unit,
            underlying_symbol: symbol,
            req_id: getNextReqId()
        });

        addLog(`📤 Manual ${contractType} request for ${symbol} (${dur} ${unit === 't' ? 'ticks' : unit === 's' ? 'seconds' : 'minutes'})...`);

        return res.json({ success: true, message: 'Proposal requested.' });
    } catch (err) {
        console.error('Manual trade error:', err);
        state.tradeInProgress = false;
        state.activeRealTrade = null;
        return res.status(500).json({ error: 'Internal server error: ' + err.message });
    }
});

module.exports = router;
