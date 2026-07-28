const WebSocket = require('ws');
const { state, CONFIG, getFullState } = require('../state/manager');
const { broadcastSSE } = require('../api/sse');
const { MARKETS } = require('../markets/definitions');
const MultiMarketPipeline = require('../pipeline/engine');

// ---- Engine instance ----
const engine = new MultiMarketPipeline(Object.keys(MARKETS));

// ---- Module state ----
let derivWs = null;
let keepAliveLoop = null;
let sseBroadcastLoop = null;
let watchdogTimer = null;
let settlementTimer = null;
let pendingTrade = null;
let reqIdCounter = 1;
const subscribedSymbols = new Set();

// ---- Helpers ----
function getNextReqId() {
    return ++reqIdCounter;
}

function sendWS(payload) {
    if (derivWs && derivWs.readyState === WebSocket.OPEN) {
        derivWs.send(JSON.stringify(payload));
    } else {
        console.warn('[WS] Cannot send: socket not open.');
    }
}

// ---- Disconnect & cleanup ----
function disconnectDeriv() {
    state.isConnected = false;
    if (keepAliveLoop) clearInterval(keepAliveLoop);
    if (sseBroadcastLoop) clearInterval(sseBroadcastLoop);
    if (watchdogTimer) clearTimeout(watchdogTimer);
    if (settlementTimer) clearTimeout(settlementTimer);
    if (derivWs) {
        derivWs.removeAllListeners();
        try { derivWs.terminate(); } catch (_) {}
        derivWs = null;
    }
    subscribedSymbols.clear();
    console.log('[WS] Disconnected & cleaned up.');
}

// ---- Connect to Deriv ----
function connectDeriv() {
    disconnectDeriv();
    const appId = CONFIG.APP_ID || 'missing';
    console.log(`[WS] Connecting to Deriv with App ID: ${appId}`);
    const wsUrl = `wss://ws.derivws.com/websockets/v3?app_id=${appId}`;
    derivWs = new WebSocket(wsUrl);

    derivWs.on('open', () => {
        console.log('[WS] Socket open. Authorizing...');
        state.isConnected = true;
        const token = CONFIG.API_TOKEN || 'missing';
        console.log(`[WS] Using token: ${token.slice(0, 4)}...${token.slice(-4)}`);
        sendWS({ authorize: CONFIG.API_TOKEN });

        keepAliveLoop = setInterval(() => sendWS({ ping: 1 }), 30000);
        sseBroadcastLoop = setInterval(() => {
            broadcastSSE({ state: getFullState() });
        }, 3000);
    });

    derivWs.on('message', (raw) => {
        try {
            const data = JSON.parse(raw);
            // Log all messages for debugging (only if not ping)
            if (data.msg_type !== 'ping') {
                console.log(`[WS] Received: ${data.msg_type}`);
            }
            handleMessage(data);
        } catch (err) {
            console.error('[WS] Parse error:', err.message);
        }
    });

    derivWs.on('error', (err) => {
        console.error('[WS] Socket error:', err.message);
    });

    derivWs.on('close', () => {
        console.warn('[WS] Connection closed. Reconnecting in 5s...');
        disconnectDeriv();
        setTimeout(connectDeriv, 5000);
    });
}

// ---- Reset watchdog ----
function resetWatchdog() {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
        console.warn('[WS] No response for 60s. Reconnecting...');
        connectDeriv();
    }, 60000);
}

// ---- Main message handler ----
function handleMessage(data) {
    resetWatchdog();

    switch (data.msg_type) {
        case 'authorize':
            if (data.error) {
                console.error('[WS] Auth failed:', data.error.message);
                return;
            }
            console.log(`[WS] Authorized as ${data.authorize.email}`);
            state.balance = parseFloat(data.authorize.balance);
            state.currency = data.authorize.currency;

            // Subscribe to balance updates
            sendWS({ balance: 1, subscribe: 1 });

            // ---- Subscribe to tick streams for all markets ----
            const allSymbols = Object.keys(MARKETS);
            console.log(`[WS] Subscribing to ${allSymbols.length} markets...`);
            for (const symbol of allSymbols) {
                if (!subscribedSymbols.has(symbol)) {
                    sendWS({ ticks_history: symbol, count: 2000, end: 'latest', subscribe: 1 });
                    subscribedSymbols.add(symbol);
                }
            }
            console.log(`[WS] Subscribed to ${subscribedSymbols.size} markets.`);
            break;

        case 'balance':
            if (data.balance) {
                const newBal = parseFloat(data.balance.balance);
                state.balance = newBal;
                console.log(`[WS] Balance updated: $${newBal.toFixed(2)}`);
                if (pendingTrade && pendingTrade.awaitingSettlement) {
                    verifyTradeSettlement(newBal);
                }
            }
            break;

        case 'tick':
            if (data.tick) {
                const symbol = data.tick.symbol;
                const price = parseFloat(data.tick.quote);
                console.log(`[TICK] ${symbol} @ ${price}`);
                // Feed the engine and update market metrics
                const metric = engine.feed(symbol, price);
                if (metric) {
                    state.marketMetrics[symbol] = metric;
                } else {
                    console.warn(`[TICK] engine.feed returned null for ${symbol}`);
                }
                // Broadcast state update on each tick (throttled by interval anyway)
            }
            break;

        case 'proposal':
            if (data.error) {
                console.error('[WS] Proposal error:', data.error.message);
                state.tradeInProgress = false;
                state.activeRealTrade = null;
                return;
            }
            // Manual trade flow (from routes)
            if (state.tradeInProgress && state.activeRealTrade && !state.activeRealTrade.contractId) {
                const proposalId = data.proposal.id;
                console.log(`[TRADE] Executing buy for proposal ${proposalId}`);
                sendWS({ buy: proposalId, price: state.activeRealTrade.stake });

                let durSecs = state.activeRealTrade.duration;
                if (state.activeRealTrade.durationUnit === 't') durSecs *= 1.5;
                if (state.activeRealTrade.durationUnit === 'm') durSecs *= 60;
                pendingTrade = {
                    preBalance: state.balance,
                    stake: state.activeRealTrade.stake,
                    durationSeconds: durSecs,
                    awaitingSettlement: false,
                    contractId: null
                };
            }
            break;

        case 'buy':
            if (data.error) {
                console.error('[TRADE] Buy error:', data.error.message);
                state.isTrading = false;
                state.tradeInProgress = false;
                state.activeRealTrade = null;
                pendingTrade = null;
                return;
            }
            console.log(`[TRADE] Contract ${data.buy.contract_id} executed.`);
            if (pendingTrade) {
                pendingTrade.contractId = data.buy.contract_id;
                pendingTrade.buyPrice = parseFloat(data.buy.buy_price);
                scheduleMathSettlement(pendingTrade.durationSeconds);
            }
            break;

        case 'ping':
            // ignore
            break;

        default:
            if (data.error) {
                console.error(`[WS] Error (${data.msg_type}):`, data.error.message);
            }
            break;
    }
}

// ---- Schedule math-based settlement ----
function scheduleMathSettlement(durationSeconds) {
    if (settlementTimer) clearTimeout(settlementTimer);
    const delayMs = Math.max((durationSeconds + 2.5) * 1000, 3000);
    settlementTimer = setTimeout(() => {
        if (pendingTrade) {
            pendingTrade.awaitingSettlement = true;
            sendWS({ balance: 1 });
        }
    }, delayMs);
}

// ---- Verify trade settlement via balance diff ----
function verifyTradeSettlement(currentBalance) {
    if (!pendingTrade) return;
    const netProfit = currentBalance - pendingTrade.preBalance;

    if (settlementTimer) {
        clearTimeout(settlementTimer);
        settlementTimer = null;
    }

    const isWin = netProfit > 0;
    state.consecutiveLosses = isWin ? 0 : (state.consecutiveLosses || 0) + 1;
    state.totalWins = (state.totalWins || 0) + (isWin ? 1 : 0);
    state.totalLosses = (state.totalLosses || 0) + (isWin ? 0 : 1);
    state.totalProfit = (state.totalProfit || 0) + netProfit;

    console.log(`[SETTLEMENT] ${isWin ? 'WIN' : 'LOSS'} | Net: $${netProfit.toFixed(2)}`);

    state.isTrading = false;
    state.tradeInProgress = false;
    state.activeRealTrade = null;
    pendingTrade = null;

    broadcastSSE({ state: getFullState() });
}

// ---- Execute a trade (called by bot or manual) ----
function executeTrade({ contractType, amount, symbol, duration, durationUnit, barrier }) {
    if (state.isTrading) {
        console.warn('[TRADE] Already in progress.');
        return false;
    }

    state.isTrading = true;

    let durationSeconds = duration;
    if (durationUnit === 't') durationSeconds = duration * 1.5;
    pendingTrade = {
        preBalance: state.balance,
        stake: parseFloat(amount),
        durationSeconds: durationSeconds,
        awaitingSettlement: false,
        contractId: null
    };

    const params = {
        amount: amount,
        basis: 'stake',
        contract_type: contractType,
        currency: state.currency || 'USD',
        duration: duration,
        duration_unit: durationUnit,
        underlying_symbol: symbol
    };
    if (barrier !== undefined && barrier !== null) {
        params.barrier = barrier.toString();
    }

    sendWS({ buy: 1, price: amount, parameters: params });
    return true;
}

// ---- Exports ----
module.exports = {
    connectDeriv,
    disconnectDeriv,
    executeTrade,
    sendWS,
    send: sendWS,
    getNextReqId,
};
