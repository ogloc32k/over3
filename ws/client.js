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

const engine = new MultiMarketPipeline(Object.keys(MARKETS));

function send(msg) {
    if (derivWs && derivWs.readyState === WebSocket.OPEN) {
        derivWs.send(JSON.stringify(msg));
    }
}

function getNextReqId() {
    return ++reqId;
}

function disconnectDeriv() {
    clearInterval(keepAliveLoop);
    clearTimeout(watchdogTimer);
    if (derivWs) { derivWs.removeAllListeners(); try { derivWs.terminate(); } catch(e) {} derivWs = null; }
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

            // Subscribe to all markets: history + live ticks (single request)
            const allSymbols = Object.keys(MARKETS);
            for (const key of allSymbols) {
                send({
                    ticks_history: key,
                    count: 2000,
                    end: 'latest',
                    subscribe: 1,
                    req_id: getNextReqId()
                });
            }
            addLog(`📡 Subscribed to ${allSymbols.length} markets (history + live ticks).`);

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
            } catch(e) {}
        });

        derivWs.on('close', () => { disconnectDeriv(); setTimeout(connectDeriv, 2000); });
        derivWs.on('error', () => { if (derivWs) derivWs.terminate(); });
    } catch(e) {
        addLog(`Network Exception: ${e.message}.`);
        setTimeout(connectDeriv, 5000);
    }
}

// =====================================================================
//  MESSAGE HANDLER
// =====================================================================
function handleMessage(msg) {
    if (msg.error) {
        addLog(`API Error: ${msg.error.message}`);
        state.tradeInProgress = false;
        state.activeRealTrade = null;
        state.pendingSettlement = false;
        if (state.activeRealTrade && state.activeRealTrade.settlementTimeout) {
            clearTimeout(state.activeRealTrade.settlementTimeout);
        }
        return;
    }

    if (msg.msg_type === 'proposal') {
        if (msg.error) {
            addLog(`❌ Proposal Error: ${msg.error.message}`);
            state.tradeInProgress = false;
            state.activeRealTrade = null;
            state.pendingSettlement = false;
            if (state.activeRealTrade && state.activeRealTrade.settlementTimeout) {
                clearTimeout(state.activeRealTrade.settlementTimeout);
            }
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
        prices.forEach(p => engine.feed(symbol, p));
        addLog(`✅ History synchronized for ${symbol}`);
        // Live ticks will come automatically because we set subscribe: 1
        return;
    }

    if (msg.msg_type === 'tick') {
        try {
            const symbol = msg.tick.symbol;
            const price = parseFloat(msg.tick.quote);
            processLiveFeed(symbol, price);
        } catch (err) {
            addLog(`❌ Tick handler error: ${err.message}`);
            console.error('Tick error:', err);
        }
        return;
    }

    if (msg.msg_type === 'buy') {
        if (state.activeRealTrade) {
            const contractId = msg.buy.contract_id;
            state.activeRealTrade.contractId = contractId;
            state.activeRealTrade.entryPrice = msg.buy.price;
            state.activeRealTrade.executionTime = Date.now();

            addLog(`💰 Trade Executed: Contract ID ${contractId} at price ${msg.buy.price}`);

            // Subscribe to contract updates
            send({
                proposal_open_contract: 1,
                contract_id: contractId,
                subscribe: 1,
                req_id: getNextReqId()
            });

            // Safety fallback timeout
            const durationMs = CONFIG.DURATION * 1000;
            const bufferMs = 15000;
            state.activeRealTrade.settlementTimeout = setTimeout(() => {
                if (state.activeRealTrade && !state.activeRealTrade.settled) {
                    addLog(`⚠️ Contract ${contractId} not settled via subscription. Falling back to balance check.`);
                    state.pendingSettlement = true;
                    send({ balance: 1, req_id: getNextReqId() });
                }
            }, durationMs + bufferMs);
        }
        return;
    }

    // ---- Contract lifecycle updates ----
    if (msg.msg_type === 'proposal_open_contract') {
        const contract = msg.proposal_open_contract;
        if (!state.activeRealTrade || state.activeRealTrade.contractId !== contract.id) return;
        if (state.activeRealTrade.settled) return;

        // ---- Log entry price once ----
        if (contract.entry_spot && !state.activeRealTrade.entryLogged) {
            state.activeRealTrade.entryLogged = true;
            const entryPrice = contract.entry_spot;
            state.activeRealTrade.entryPrice = entryPrice;
            addLog(`📌 Entry Price locked at: ${entryPrice} (${state.activeRealTrade.symbol})`);
            broadcastSSE({ state: getFullState() });
        }

        // ---- Check if contract is sold (finished) ----
        if (contract.is_sold === 1) {
            state.activeRealTrade.settled = true;
            clearTimeout(state.activeRealTrade.settlementTimeout);

            const profit = contract.profit || (contract.sell_price - contract.buy_price);
            const isWin = profit >= 0;
            const exitPrice = contract.sell_price || contract.buy_price;

            state.sessionPnl += profit;
            state.dailyPnl += profit;
            if (isWin) {
                consecutiveLosses = 0;
            } else {
                consecutiveLosses++;
                if (consecutiveLosses >= CONFIG.MAX_CONSECUTIVE_LOSSES) {
                    state.lossCooldownUntil = Date.now() + CONFIG.LOSS_COOLDOWN_MS;
                    addLog(`⏳ ${CONFIG.MAX_CONSECUTIVE_LOSSES} consecutive losses. Cooldown for ${CONFIG.LOSS_COOLDOWN_MS/60000} minutes.`);
                }
            }

            const grossPayout = isWin ? (state.activeRealTrade.stake + profit) : 0;
            saveTradeToCloud({
                contract_id: contract.id,
                asset: MARKETS[state.activeRealTrade.symbol]?.name || state.activeRealTrade.symbol,
                contractType: state.activeRealTrade.contractType,
                stake: state.activeRealTrade.stake,
                payout: grossPayout,
                isWin: isWin,
                barrier: null,
                exitTick: null,
                entry_price: state.activeRealTrade.entryPrice,
                exit_price: exitPrice,
                duration_seconds: CONFIG.DURATION,
                duration_ticks: null
            });

            addLog(`[Trade Finished] ${state.activeRealTrade.symbol} | ${state.activeRealTrade.contractType} | ${isWin ? '🟢 WIN (+$' : '🔴 LOSS (-$'}${Math.abs(profit).toFixed(2)}) | Session: $${state.sessionPnl.toFixed(2)} | Daily: $${state.dailyPnl.toFixed(2)}`);

            state.tradeInProgress = false;
            state.activeRealTrade = null;
            state.pendingSettlement = false;
            state.cooldownTicksLeft = CONFIG.COOLDOWN_TICKS;

            const rawStake = Math.max(CONFIG.MIN_STAKE, state.balance * (CONFIG.RISK_PERCENT / 100));
            state.currentStake = Math.round(Math.min(rawStake, state.balance) * 100) / 100;

            // Unsubscribe from this contract
            send({ forget: contract.id, req_id: getNextReqId() });

            (async () => {
                const limitHit = await syncDailyPnlFromDB();
                if (limitHit && state.lockReason) addLog(state.lockReason);
                saveState();
                broadcastSSE({ state: getFullState() });
            })();
        }
    }
}

// =====================================================================
//  PROCESS LIVE FEED
// =====================================================================
function processLiveFeed(symbol, price) {
    if (!MARKETS[symbol]) return;

    if (state.tradeInProgress && state.activeRealTrade && state.activeRealTrade.executionTime) {
        const elapsedSeconds = (Date.now() - state.activeRealTrade.executionTime) / 1000;
        if (elapsedSeconds > 120) {
            addLog(`⚠️ WARNING: Trade stuck for ${elapsedSeconds.toFixed(1)}s. Force resetting.`);
            if (state.activeRealTrade.settlementTimeout) {
                clearTimeout(state.activeRealTrade.settlementTimeout);
            }
            state.tradeInProgress = false;
            state.activeRealTrade = null;
            state.pendingSettlement = false;
            send({ balance: 1, req_id: getNextReqId() });
            saveState();
            broadcastSSE({ state: getFullState() });
            return;
        }
    }

    if (state.pendingSettlement) {
        broadcastSSE({ state: getFullState() });
        return;
    }

    const metric = engine.feed(symbol, price);
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
    if (now - state.lastTriggerTime < CONFIG.MIN_TRIGGER_INTERVAL) {
        broadcastSSE({ state: getFullState() });
        return;
    }

    if (state.balance < CONFIG.MIN_STAKE) {
        state.locked = true;
        state.lockReason = '⚠️ Insufficient funds for minimum stake. Trading paused.';
        addLog(state.lockReason);
        broadcastSSE({ state: getFullState() });
        return;
    }

    let bestCandidate = null;
    let bestScore = -Infinity;

    for (const sym in MARKETS) {
        const m = state.marketMetrics[sym];
        if (!m) continue;
        const signal = checkStrategy(sym, m);
        if (signal && signal.score > bestScore) {
            bestScore = signal.score;
            bestCandidate = { symbol: sym, ...signal };
        }
    }

    if (bestCandidate) {
        const { symbol, direction } = bestCandidate;
        state.tradeInProgress = true;
        const rawStake = Math.max(CONFIG.MIN_STAKE, state.balance * (CONFIG.RISK_PERCENT / 100));
        state.currentStake = Math.round(Math.min(rawStake, state.balance) * 100) / 100;

        const metric = state.marketMetrics[symbol];
        addLog(`🔥 Signal: ${symbol} | ${direction} | RSI: ${metric.rsi.toFixed(1)} | Vol: ${metric.volatility.toFixed(2)}%`);

        let duration = CONFIG.DURATION;
        let unit = 's';
        if (duration <= 10) {
            unit = 't';
        } else {
            unit = 's';
        }

        state.activeRealTrade = {
            symbol,
            stake: state.currentStake,
            balanceBefore: state.balance,
            contractType: direction,
            barrier: null,
            direction: direction,
            entryPrice: null,
            executionTime: Date.now(),
            settlementTimeout: null,
            settled: false,
            entryLogged: false
        };

        state.lastTriggerTime = now;
        addLog(`📤 Requesting ${direction} proposal for ${symbol} (${duration} ${unit === 't' ? 'ticks' : 'seconds'})...`);
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
    }
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
