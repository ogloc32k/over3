const WebSocket = require('ws');
// Import 'state' as a mutable object reference (avoid importing primitive values as consts)
const { state, CONFIG, getFullState } = require('../state/manager');
const { broadcastSSE } = require('../sse/broadcaster');

// Inner module scope state & timer handles
let derivWs = null;
let keepAliveLoop = null;
let sseBroadcastLoop = null;
let watchdogTimer = null;
let settlementTimer = null;
let pendingTrade = null;

const subscribedSymbols = new Set();

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

        case 'buy':
            if (data.error) {
                console.error('[TRADE] Purchase Error:', data.error.message);
                state.isTrading = false;
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
                state.lastTick = parseFloat(data.tick.quote);
                state.lastDigit = parseInt(data.tick.quote.toString().slice(-1), 10);
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
 * Initiates a Trade with Math/Account Tracking
 */
function executeTrade({ contractType, amount, symbol, duration, durationUnit }) {
    if (state.isTrading) {
        console.warn('[TRADE] Blocked: A trade is already in progress.');
        return false;
    }

    state.isTrading = true;

    // Estimate duration in seconds for settlement buffer calculation
    let durationSeconds = duration;
    if (durationUnit === 't') {
        durationSeconds = duration * 1; // Approx 1s per tick on Synthetic Indices
    }

    // Capture initial account balance BEFORE trade execution
    pendingTrade = {
        preBalance: state.balance,
        stake: parseFloat(amount),
        durationSeconds: durationSeconds,
        awaitingSettlement: false,
        contractId: null
    };

    console.log(`[TRADE] Initiating ${contractType} | Stake: $${amount} | Pre-Balance: $${state.balance}`);

    // Send Deriv Buy Order
    sendWS({
        buy: 1,
        price: amount,
        parameters: {
            amount: amount,
            basis: 'stake',
            contract_type: contractType,
            currency: state.currency || 'USD',
            duration: duration,
            duration_unit: durationUnit,
            symbol: symbol
        }
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
        state.consecutiveLosses = 0; // Fixed: Mutates state property directly
        state.totalWins = (state.totalWins || 0) + 1;
        console.log(`[SETTLEMENT] WIN! Net Profit: +$${netProfit.toFixed(2)} | Balance: $${currentBalance.toFixed(2)}`);
    } else {
        state.consecutiveLosses = (state.consecutiveLosses || 0) + 1; // Fixed: Mutates state property directly
        state.totalLosses = (state.totalLosses || 0) + 1;
        console.log(`[SETTLEMENT] LOSS! Net Loss: -$${pendingTrade.stake.toFixed(2)} | Consecutive Losses: ${state.consecutiveLosses}`);
    }

    state.totalProfit = (state.totalProfit || 0) + netProfit;
    state.isTrading = false;

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
    sendWS
};
