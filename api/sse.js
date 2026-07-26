const { getFullState } = require('../state/manager');

const sseClients = new Set();
let logId = 1;

function addLog(msg) {
    const entry = { id: logId++, time: new Date().toISOString(), message: msg };
    // we need to access state.logs – we'll require state from manager
    const { state } = require('../state/manager');
    state.logs.unshift(entry);
    if (state.logs.length > 250) state.logs.pop();
    broadcastSSE({ logs: [entry], state: getFullState() });
}

function broadcastSSE(payload) {
    if (!payload.state) payload.state = getFullState();
    if (payload.state && !payload.state.marketMetrics) {
        const { state } = require('../state/manager');
        payload.state.marketMetrics = state.marketMetrics || {};
    }
    sseClients.forEach(c => c.write(`data: ${JSON.stringify(payload)}\n\n`));
}

module.exports = { sseClients, addLog, broadcastSSE };
