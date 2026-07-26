const sseClients = new Set();
let logId = 1;

function addLog(msg) {
    // Lazy require to break circular dependency
    const { state, getFullState } = require('../state/manager');
    const entry = { id: logId++, time: new Date().toISOString(), message: msg };
    state.logs.unshift(entry);
    if (state.logs.length > 250) state.logs.pop();
    broadcastSSE({ logs: [entry], state: getFullState() });
}

function broadcastSSE(payload) {
    // Lazy require to break circular dependency
    const { state, getFullState } = require('../state/manager');
    if (!payload.state) payload.state = getFullState();
    if (payload.state && !payload.state.marketMetrics) {
        payload.state.marketMetrics = state.marketMetrics || {};
    }
    sseClients.forEach(c => c.write(`data: ${JSON.stringify(payload)}\n\n`));
}

module.exports = { sseClients, addLog, broadcastSSE };
