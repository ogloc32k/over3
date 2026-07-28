const sseClients = new Set();
let logId = 1;

function addLog(msg) {
    const { state, getFullState } = require('../state/manager');
    const entry = { id: logId++, time: new Date().toISOString(), message: msg };
    
    state.logs.unshift(entry);
    if (state.logs.length > 250) state.logs.pop(); // Keep memory footprint light
    
    broadcastSSE({ logs: [entry], state: getFullState() });
}

function broadcastSSE(payload) {
    const { state, getFullState } = require('../state/manager');
    
    if (!payload.state) {
        payload.state = getFullState();
    }
    
    // Ensure market metrics (vital for digit analysis) are attached
    if (payload.state && !payload.state.marketMetrics) {
        payload.state.marketMetrics = state.marketMetrics || {};
    }
    
    // PERFORMANCE FIX: Stringify once, not per-client. 
    // This prevents CPU spiking during high-frequency tick streams.
    const dataString = `data: ${JSON.stringify(payload)}\n\n`;
    
    sseClients.forEach(client => client.write(dataString));
}

module.exports = { sseClients, addLog, broadcastSSE };
