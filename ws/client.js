const WebSocket = require('ws');
// Import 'state' as a mutable object reference (avoid importing primitive values as consts)
const { state, CONFIG, getFullState } = require('../state/manager');
const { broadcastSSE } = require('../api/sse');   // <-- FIXED: correct path

// Inner module scope state & timer handles
let derivWs = null;
let keepAliveLoop = null;
let sseBroadcastLoop = null;
let watchdogTimer = null;
let settlementTimer = null;
let pendingTrade = null;
let reqIdCounter = 1;

const subscribedSymbols = new Set();

/**
 * Generates a unique request ID for WebSocket calls
 */
function getNextReqId() {
    return reqIdCounter++;
}

/**
 * Cleanly disconnects WebSocket and wipes all active intervals/timeouts
 * to prevent memory leaks and duplicate broadcasts.
 */
function disconnectDeriv() {
    state.isConnected = false;

    if (keepAliveLoop) {
        clearInterval(keepAliveLoop);
        keepAliveLoop = null;
    }
    if (sseBroadcastLoop) {
        clearInterval(sseBroadcastLoop);
        sseBroadcastLoop = null;
    }
    if (watchdogTimer) {
        clearTimeout(watchdogTimer);
        watchdogTimer = null;
    }
    if (settlementTimer) {
        clearTimeout(settlementTimer);
        settlementTimer = null;
    }

    if (derivWs) {
        derivWs.removeAllListeners();
        try {
            derivWs.terminate();
        } catch (err) {
            console.error('[WS] Error terminating socket:', err.message);
        }
        derivWs = null;
    }

    subscribedSymbols.clear();
    console.log('[WS] Disconnected & cleaned up resources.');
}

/**
 * Initializes Deriv WebSocket Connection
 */
function connectDeriv() {
    // Force clean prior connections
    disconnectDeriv();

    const wsUrl = `wss://ws.derivws.com/websockets/v3?app_id=${CONFIG.APP_ID}`;
    console.log(`[WS] Connecting to Deriv...`);
    derivWs = new WebSocket(wsUrl);

    derivWs.on('open', () => {
        console.log('[WS] Connected. Authorizing...');
        state.isConnected = true;

        // Send Authorization
        sendWS({ authorize: CONFIG.API_TOKEN });

        // Start Ping / Keepalive loop (every 30 seconds)
        keepAliveLoop = setInterval(() => {
            sendWS({ ping: 1 });
        }, 30000);

        // Track single SSE broadcast loop (prevents duplicate intervals on reconnect)
        sseBroadcastLoop = setInterval(() => {
            broadcastSSE({ state: getFullState() });
        }, 3000);
    });

    derivWs.on('message', (raw) => {
        try {
            const data = JSON.parse(raw);
            handleIncomingMessage(data);
        } catch (err) {
            console.error('[WS] Failed to parse message:', err.message);
        }
    });

    derivWs.on('error', (err) => {
        console.error('[WS] Socket error:', err.message);
    });

    derivWs.on('close', () => {
        console.warn('[WS] Connection closed. Attempting reconnect in 5s...');
        disconnectDeriv();
        setTimeout(connectDeriv, 5000);
    });
}

/**
 * Helper to safely send JSON via WebSocket
 */
function sendWS(payload) {
    if (derivWs && derivWs.readyState === WebSocket.OPEN) {
        derivWs.send(JSON.stringify(payload));
    } else {
        console.warn('[WS] Cannot send payload - socket not open.');
    }
}

/**
 * Primary Message Handler
 */
function handleIncomingMessage(data) {
    const msgType = data.msg_type;

    // Reset connection watchdog timer on any valid response
    resetWatchdog();

    switch (msgType) {
        case 'authorize':
            if (data.error) {
                console.error('[WS] Authorization failed:', data.error.message);
                return;
            }
            console.log(`[WS] Authorized as ${data.authorize.email}`);
            state.balance = parseFloat(data.authorize.balance);
            state.currency = data.authorize.currency;

            // Subscribe to real-time account balance updates
            sendWS({ balance: 1, subscribe: 1 });
            break;

        case 'balance':
            if (data.balance) {
                const updatedBalance = parseFloat(data.balance.balance);
                state.balance = updatedBalance;

                // If a trade settlement is awaiting balance verification
                if (pendingTrade && pendingTrade.awaitingSettlement) {
                    verifyTradeSettlement(updatedBalance);
                }
            }
            break;

        case 'proposal':
            if (data.error) {
                console.error('[WS] Proposal Error:', data.error.message);
                state.tradeInProgress = false;
                state.activeRealTrade = null;
                return;
            }

            // Route manual trades triggered from routes.js
            if (state.tradeInProgress && state.activeRealTrade && !state.activeRealTrade.contractId) {
                const proposalId = data.proposal.id;
                console.log(`[TRADE] Proposal received for manual trade. Executing buy ID: ${proposalId}...`);
                
                sendWS({
                    buy: proposalId,
                    price: state.activeRealTrade.stake
                });

                // Calculate duration seconds for the settlement timer buffer
                let durationSecs = state.activeRealTrade.duration;
                if (state.activeRealTrade.durationUnit === 't') durationSecs = state.activeRealTrade.duration * 1.5;
                if (state.activeRealTrade.durationUnit === 'm') durationSecs = state.activeRealTrade.duration * 60;

                pendingTrade = {
                    preBalance: state.balance,
                    stake: state.activeRealTrade.stake,
                    durationSeconds: durationSecs,
                    awaitingSettlement: false,
                    contractId: null
                };
            }
            break;

        case 'buy':
            if (data.error) {
                console.error('[TRADE] Purchase Error:', data.error.message);
                state.isTrading = false;
                state.tradeInProgress = false;
                state.activeRealTrade = null;
                pendingTrade = null;
                return;
            }

            console.log(`[TRADE] Executed contract ID: ${data.buy.contract_id}`);
            
            // Record pre-trade state for math-based settlement
            if (pendingTrade) {
                pendingTrade.contractId = data.buy.contract_id;
                pendingTrade.buyPrice = parseFloat(data.buy.buy_price);
                scheduleMathSettlement(pendingTrade.durationSeconds);
            }
            break;

        case 'tick':
            if (data.tick) {
                const quote = parseFloat(data.tick.quote);
                
                // Safely extract the last digit. 
                // Note: Consider using data.tick.pip_size to format the string strictly if trailing zeros are ever dropped.
                const digitString = data.tick.quote.toString();
                const digit = parseInt(digitString.slice(-1), 10);

                state.lastTick = quote;
                state.lastDigit = digit;
                
                // Rolling history for automated digit analysis
                if (!state.digitHistory) state.digitHistory = [];
                state.digitHistory.push(digit);
                
                // Keep the last 100 ticks in memory for bot statistical math
                if (state.digitHistory.length > 100) {
                    state.digitHistory.shift();
                }
            }
            break;

        case 'ping':
            // Keepalive ACK
            break;

        default:
            if (data.error) {
                console.error(`[WS] Error (${msgType}):`, data.error.message);
            }
            break;
    }
}

/**
 * Initiates a Trade with Math/Account Tracking (Usually called by Automated Bot)
 */
function executeTrade({ contractType, amount, symbol, duration, durationUnit, barrier }) {
    if (state.isTrading) {
        console.warn('[TRADE] Blocked: A trade is already in progress.');
        return false;
    }

    state.isTrading = true;

    // Estimate duration in seconds for settlement buffer calculation
    let durationSeconds = duration;
    if (durationUnit === 't') {
        durationSeconds = duration * 1.5; // Buffered slightly for tick variance
    }

    // Capture initial account balance BEFORE trade execution
    pendingTrade = {
        preBalance: state.balance,
        stake: parseFloat(amount),
        durationSeconds: durationSeconds,
        awaitingSettlement: false,
        contractId: null
    };

    const barrierLog = barrier !== undefined ? ` | Barrier: ${barrier}` : '';
    console.log(`[TRADE] Initiating ${contractType}${barrierLog} | Stake: $${amount} | Pre-Balance: $${state.balance}`);

    // Construct parameters payload
    const parameters = {
        amount: amount,
        basis: 'stake',
        contract_type: contractType,
        currency: state.currency || 'USD',
        duration: duration,
        duration_unit: durationUnit,
        underlying_symbol: symbol
    };

    // Inject barrier if defined (crucial for digit matches, differs, over, under)
    if (barrier !== undefined && barrier !== null) {
        parameters.barrier = barrier.toString();
    }

    // Send Deriv Buy Order directly via parameters
    sendWS({
        buy: 1,
        price: amount,
        parameters: parameters
    });

    return true;
}

/**
 * Schedules the Math-based Settlement Timer
 */
function scheduleMathSettlement(durationSeconds) {
    if (settlementTimer) clearTimeout(settlementTimer);

    // Wait for contract duration + 2.5 second network buffer
    const delayMs = Math.max((durationSeconds + 2.5) * 1000, 3000);

    settlementTimer = setTimeout(() => {
        if (pendingTrade) {
            pendingTrade.awaitingSettlement = true;
            // Force fetch latest balance to trigger calculation
            sendWS({ balance: 1 });
        }
    }, delayMs);
}

/**
 * Mathematical Settlement Calculation Logic
 */
function verifyTradeSettlement(currentBalance) {
    if (!pendingTrade) return;

    const preBal = pendingTrade.preBalance;
    const netProfit = currentBalance - preBal;

    // Clear timeout handle
    if (settlementTimer) {
        clearTimeout(settlementTimer);
        settlementTimer = null;
    }

    // Pure math check: Win if balance strictly increased relative to pre-trade balance
    const isWin = netProfit > 0;

    if (isWin) {
        state.consecutiveLosses = 0; 
        state.totalWins = (state.totalWins || 0) + 1;
        console.log(`[SETTLEMENT] WIN! Net Profit: +$${netProfit.toFixed(2)} | Balance: $${currentBalance.toFixed(2)}`);
    } else {
        state.consecutiveLosses = (state.consecutiveLosses || 0) + 1; 
        state.totalLosses = (state.totalLosses || 0) + 1;
        console.log(`[SETTLEMENT] LOSS! Net Loss: -$${pendingTrade.stake.toFixed(2)} | Consecutive Losses: ${state.consecutiveLosses}`);
    }

    state.totalProfit = (state.totalProfit || 0) + netProfit;
    state.isTrading = false;
    
    // Clear manual trade states if they were set
    state.tradeInProgress = false;
    state.activeRealTrade = null;

    // Reset pending trade
    pendingTrade = null;

    // Immediate SSE state broadcast update
    broadcastSSE({ state: getFullState() });
}

/**
 * Watchdog reset to prevent dead WebSocket connections
 */
function resetWatchdog() {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
        console.warn('[WS] No response from server for 60s. Reconnecting...');
        connectDeriv();
    }, 60000);
}

module.exports = {
    connectDeriv,
    disconnectDeriv,
    executeTrade,
    sendWS,
    send: sendWS, // Alias for routes.js compatibility
    getNextReqId
};
