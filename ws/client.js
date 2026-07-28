const WebSocket = require('ws');
const { state, CONFIG, consecutiveLosses, checkStrategy, syncDailyPnlFromDB, getFullState, saveState, checkDailyLimits } = require('../state/manager');
const { addLog, broadcastSSE } = require('../api/sse');
const { MARKETS, formatMarketPrice } = require('../markets/definitions');
const { saveTradeToCloud } = require('../database');
const MultiMarketPipeline = require('../pipeline/engine');

let derivWs = null;
let reqId = 0;
let keepAliveLoop = null;
let watchdogTimer = null;
let settlementTimer = null;

// ---- Deduplication Set ----
const subscribedSymbols = new Set();

const engine = new MultiMarketPipeline(Object.keys(MARKETS));

// ---- Protected send ----
function send(msg) {
    if (derivWs && derivWs.readyState === WebSocket.OPEN) {
        derivWs.send(JSON.stringify(msg));
    } else {
        console.warn(`⚠️ Cannot send: WebSocket not open (readyState=${derivWs ? derivWs.readyState : 'null'})`);
    }
}

function getNextReqId() {
    return ++reqId;
}

function disconnectDeriv() {
    clearInterval(keepAliveLoop);
    clearTimeout(watchdogTimer);
    clearTimeout(settlementTimer);
    if (derivWs) { derivWs.removeAllListeners(); try { derivWs.terminate(); } catch(e) {} derivWs = null; }
    subscribedSymbols.clear();
}

async function connectDeriv() {
    disconnectDeriv();
    const appId = (process.env.DERIV_APP_ID || '').trim();
    const token = (process.env.DERIV_PAT || '').trim();
    if (!appId || !token) { addLog('System Configuration Halt: Credentials missing.'); return; }

    try {
        const accRes = await fetch('https://api.derivws.com/trading/v1/options/accounts', {
            method: 'GET', headers: { 'Authorization': `Bearer ${token}`, 'Deriv-App-ID': appId, 'Content-Type': 'application/json' }
        });
        if (!accRes.ok) throw new Error('Authentication Denied.');

        const data = await accRes.json();
        const accList = Array.isArray(data.data) ? data.data : [data.data];
        const targetAccount = accList.find(a => a.account_type === state.tradingMode);
        if (!targetAccount) throw new Error(`Target profile missing: ${state.tradingMode}`);

        state.balance = parseFloat(targetAccount.balance);
        state.currency = targetAccount.currency || 'USD';

        if (state.dailyStartBalance === null) state.dailyStartBalance = state.balance;

        const limitHit = await syncDailyPnlFromDB();
        if (limitHit && state.lockReason) addLog(state.lockReason);
        broadcastSSE({ state: getFullState() });

        const otpRes = await fetch(`https://api.derivws.com/trading/v1/options/accounts/${targetAccount.account_id}/otp`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Deriv-App-ID': appId, 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        if (!otpRes.ok) throw new Error('Security allocation failure.');

        const otpData = await otpRes.json();
        derivWs = new WebSocket(otpData.data.url);

        derivWs.on('open', () => {
            addLog(`🌐 Connected. Balance: $${state.balance.toFixed(2)} | Session: $${state.sessionPnl.toFixed(2)}`);
            send({ balance: 1, subscribe: 1, req_id: getNextReqId() });

            // ---- Subscribe only once per symbol ----
            const allSymbols = Object.keys(MARKETS);
            for (const key of allSymbols) {
                if (!subscribedSymbols.has(key)) {
                    send({ ticks_history: key, count: 2000, end: 'latest', subscribe: 1, req_id: getNextReqId() });
                    subscribedSymbols.add(key);
                }
            }
            addLog(`📡 Subscribed to ${allSymbols.length} markets (single stream).`);

            setInterval(() => { broadcastSSE({ state: getFullState() }); }, 3000);

            keepAliveLoop = setInterval(() => {
                send({ ping: 1 });
                watchdogTimer = setTimeout(() => { if (derivWs) derivWs.terminate(); }, 3000);
            }, 15000);
        });

        derivWs.on('message', raw => {
            try {
                const msg = JSON.parse(raw);
                if (msg.msg_type === 'ping') { clearTimeout(watchdogTimer); return; }
                handleMessage(msg);
            } catch(e) {
                console.error('Message handler error:', e);
                addLog(`❌ WebSocket message error: ${e.message}`);
            }
        });

        derivWs.on('close', () => { disconnectDeriv(); setTimeout(connectDeriv, 2000); });
        derivWs.on('error', (err) => { console.error('WebSocket error:', err); if (derivWs) derivWs.terminate(); });
    } catch(e) {
        addLog(`Network Exception: ${e.message}.`);
        setTimeout(connectDeriv, 5000);
    }
}

function handleMessage(msg) {
    if (msg.error) {
        addLog(`API Error: ${msg.error.message}`);
        state.tradeInProgress = false;
        state.activeRealTrade = null;
        state.pendingSettlement = false;
        clearTimeout(settlementTimer);
        return;
    }

    if (msg.msg_type === 'proposal') {
        if (msg.error) {
            addLog(`❌ Proposal Error: ${msg.error.message}`);
            state.tradeInProgress = false;
            state.activeRealTrade = null;
            state.pendingSettlement = false;
            clearTimeout(settlementTimer);
        } else {
            send({ buy: msg.proposal.id, price: msg.proposal.ask_price, req_id: getNextReqId() });
            addLog(`✅ Proposal confirmed: ${msg.proposal.ask_price}. Executing buy...`);
        }
        return;
    }

    if (msg.msg_type === 'balance') {
        state.balance = parseFloat(msg.balance.balance);
        if (state.dailyPnl !== undefined) {
            state.dailyStartBalance = state.balance - state.dailyPnl;
        }
        broadcastSSE({ state: getFullState() });
        return;
    }

    if (msg.msg_type === 'history') {
        const symbol = msg.echo_req.ticks_history;
        const prices = msg.history.prices.map(p => parseFloat(p));
        // We don't have raw prices for history, but we can store only numbers.
        // For digits, we'll rely on the raw price from live ticks.
        prices.forEach(p => engine.feed(symbol, p, p.toString())); // pass raw as string
        addLog(`✅ History synchronized for ${symbol}`);
        return;
    }

    if (msg.msg_type === 'tick') {
        try {
            const symbol = msg.tick.symbol;
            const price = parseFloat(msg.tick.quote);
            const rawPrice = msg.tick.quote; // raw string from Deriv
            processLiveFeed(symbol, price, rawPrice);
        } catch (err) {
            addLog(`❌ Tick handler error: ${err.message}`);
            console.error('Tick error:', err);
        }
        return;
    }

    if (msg.msg_type === 'buy') {
        if (state.activeRealTrade) {
            const contractId = msg.buy.contract_id;
            const entryPrice = msg.buy.buy_price || msg.buy.price || 'Market Price';
            state.activeRealTrade.contractId = contractId;
            state.activeRealTrade.entryPrice = entryPrice;
            state.activeRealTrade.executionTime = Date.now();

            addLog(`💰 Trade Executed: Contract ID ${contractId} at price ${entryPrice}`);

            state.tradeInProgress = true;

            const symbol = state.activeRealTrade.symbol;
            const duration = state.activeRealTrade.duration || CONFIG.DURATION;
            const stake = state.activeRealTrade.stake;

            const isOneSecondIndex = symbol.includes('1HZ');
            const msPerTick = isOneSecondIndex ? 1000 : 2000;
            const bufferMs = 3000;
            const settlementDelayMs = (duration * msPerTick) + bufferMs;

            addLog(`⏳ ${symbol} | ${duration} ticks | ${isOneSecondIndex ? '1s' : '2s'} per tick | waiting ${(settlementDelayMs/1000).toFixed(1)}s`);

            clearTimeout(settlementTimer);

            settlementTimer = setTimeout(() => {
                try {
                    const postBal = state.balance;
                    const preBal = state.activeRealTrade.balanceBefore;
                    const stake = state.activeRealTrade.stake;

                    if (isNaN(postBal) || isNaN(preBal) || isNaN(stake)) {
                        throw new Error(`Invalid numbers: postBal=${postBal}, preBal=${preBal}, stake=${stake}`);
                    }

                    const netProfit = postBal - preBal;
                    const isWin = netProfit > 0;
                    const symbol = state.activeRealTrade.symbol;

                    state.sessionPnl += netProfit;
                    state.dailyPnl += netProfit;

                    if (isWin) {
                        consecutiveLosses = 0;
                    } else {
                        consecutiveLosses++;
                        if (consecutiveLosses >= CONFIG.MAX_CONSECUTIVE_LOSSES) {
                            state.lossCooldownUntil = Date.now() + CONFIG.LOSS_COOLDOWN_MS;
                            addLog(`⏳ ${CONFIG.MAX_CONSECUTIVE_LOSSES} consecutive losses. Cooldown for ${CONFIG.LOSS_COOLDOWN_MS/60000} minutes.`);
                        }
                    }

                    const grossPayout = isWin ? (stake + netProfit) : 0;
                    if (state.activeRealTrade) {
                        saveTradeToCloud({
                            contract_id: state.activeRealTrade.contractId || null,
                            asset: MARKETS[state.activeRealTrade.symbol]?.name || state.activeRealTrade.symbol,
                            contractType: state.activeRealTrade.contractType,
                            stake: stake,
                            payout: grossPayout,
                            isWin: isWin,
                            barrier: null,
                            exitTick: null,
                            entry_price: state.activeRealTrade.entryPrice,
                            exit_price: null,
                            duration_seconds: state.activeRealTrade.durationUnit === 's' ? state.activeRealTrade.duration : 0,
                            duration_ticks: state.activeRealTrade.durationUnit === 't' ? state.activeRealTrade.duration : 0
                        });
                    }

                    const outcomeLabel = isWin ? `🟢 WIN (+$${netProfit.toFixed(2)})` : `🔴 LOSS (-$${Math.abs(netProfit).toFixed(2)})`;
                    addLog(`[Trade Finished] ${state.activeRealTrade.symbol} | ${state.activeRealTrade.contractType} | ${outcomeLabel} | Session: $${state.sessionPnl.toFixed(2)} | Daily: $${state.dailyPnl.toFixed(2)}`);

                    // Broadcast analytics delta
                    broadcastSSE({
                        event: 'analytics_delta',
                        data: {
                            asset: symbol,
                            pnl: netProfit,
                            newBalance: state.balance,
                            timestamp: Date.now()
                        }
                    });

                } catch (error) {
                    console.error('[Trade Check Error]', error.message);
                    addLog(`⚠️ Trade check error: ${error.message}`);
                } finally {
                    state.tradeInProgress = false;
                    state.activeRealTrade = null;
                    state.pendingSettlement = false;
                    state.cooldownTicksLeft = CONFIG.COOLDOWN_TICKS;

                    const rawStake = Math.max(CONFIG.MIN_STAKE, state.balance * (CONFIG.RISK_PERCENT / 100));
                    state.currentStake = Math.round(Math.min(rawStake, state.balance) * 100) / 100;

                    (async () => {
                        const limitHit = await syncDailyPnlFromDB();
                        if (limitHit && state.lockReason) addLog(state.lockReason);
                        saveState();
                        broadcastSSE({ state: getFullState() });
                    })();

                    settlementTimer = null;
                    console.log('[System] Trade lock released. Ready for next trade.');
                }
            }, settlementDelayMs);
        }
        return;
    }
}

// ---- Sniper Entry (unchanged) ----
const maDiffHistory = {};
const symbols = Object.keys(MARKETS);
symbols.forEach(sym => { maDiffHistory[sym] = [0, 0, 0]; });

function evaluateSniperEntry(symbol, metric) {
    if (!metric) return 'IDLE';
    const { rsi, volatility, maDiff } = metric;
    if (state.locked || state.dailyLimitReached) return 'IDLE (LOCKED)';
    const now = Date.now();
    if (now - state.lastTradeTimestamp < CONFIG.MIN_TRIGGER_INTERVAL) return 'IDLE (COOLDOWN)';
    if (volatility < CONFIG.MIN_VOLATILITY_PERCENT) return 'IDLE (LOW VOL)';

    if (!maDiffHistory[symbol]) maDiffHistory[symbol] = [0, 0, 0];
    const history = maDiffHistory[symbol];
    history.shift();
    history.push(maDiff);

    const isBullishExpansion = (history[2] > history[1]) && (history[1] > history[0]) && (history[2] >= CONFIG.MA_DIFF_THRESHOLD);
    const isBearishExpansion = (history[2] < history[1]) && (history[1] < history[0]) && (history[2] <= -CONFIG.MA_DIFF_THRESHOLD);

    if (isBullishExpansion && rsi >= 60 && rsi <= 67) {
        state.lastTradeTimestamp = now;
        return 'CALL';
    }
    if (isBearishExpansion && rsi >= 33 && rsi <= 40) {
        state.lastTradeTimestamp = now;
        return 'PUT';
    }
    return 'IDLE';
}

// ---- processLiveFeed now accepts rawPrice ----
function processLiveFeed(symbol, price, rawPrice) {
    const metric = engine.feed(symbol, price, rawPrice);
    if (!metric) return;
    state.marketMetrics[symbol] = metric;

    if (state.cooldownTicksLeft > 0) state.cooldownTicksLeft--;

    if (!state.active || state.locked || state.tradeInProgress || state.cooldownTicksLeft > 0) {
        broadcastSSE({ state: getFullState() });
        return;
    }

    const now = Date.now();
    if (now < state.lossCooldownUntil) {
        broadcastSSE({ state: getFullState() });
        return;
    }

    const signal = evaluateSniperEntry(symbol, metric);
    if (signal === 'IDLE' || signal.startsWith('IDLE')) {
        broadcastSSE({ state: getFullState() });
        return;
    }

    const direction = signal;
    state.tradeInProgress = true;
    const rawStake = Math.max(CONFIG.MIN_STAKE, state.balance * (CONFIG.RISK_PERCENT / 100));
    state.currentStake = Math.round(Math.min(rawStake, state.balance) * 100) / 100;

    addLog(`🔥 Sniper Signal: ${symbol} | ${direction} | RSI: ${metric.rsi.toFixed(1)} | Vol: ${metric.volatility.toFixed(2)}% | MA Diff: ${metric.maDiff.toFixed(3)}%`);

    const duration = CONFIG.DURATION;
    const unit = 't';

    state.activeRealTrade = {
        symbol,
        stake: state.currentStake,
        balanceBefore: state.balance,
        contractType: direction,
        duration: duration,
        durationUnit: unit,
        barrier: null,
        direction: direction,
        entryPrice: null,
        executionTime: Date.now(),
        settled: false,
        entryLogged: false,
        contractId: null
    };

    state.lastTriggerTime = now;
    addLog(`📤 Requesting ${direction} proposal for ${symbol} (${duration} ticks)...`);
    send({
        proposal: 1,
        amount: state.currentStake,
        basis: 'stake',
        contract_type: direction,
        currency: state.currency || 'USD',
        duration: duration,
        duration_unit: unit,
        underlying_symbol: symbol,
        req_id: getNextReqId()
    });

    broadcastSSE({ state: getFullState() });
}

module.exports = {
    derivWs,
    reqId,
    send,
    getNextReqId,
    disconnectDeriv,
    connectDeriv,
    engine,
    handleMessage
};
