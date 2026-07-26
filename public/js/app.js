// =========================================================================
// Wait for DOM to be ready
// =========================================================================
document.addEventListener('DOMContentLoaded', function() {

    // =========================================================================
    // THEME TOGGLE
    // =========================================================================
    const themeToggle = document.getElementById('themeToggle');
    const currentTheme = localStorage.getItem('theme') || 'dark';
    document.body.classList.toggle('light', currentTheme === 'light');
    themeToggle.textContent = currentTheme === 'light' ? '☀️' : '🌙';

    themeToggle.addEventListener('click', function toggleTheme() {
        const isLight = document.body.classList.toggle('light');
        const theme = isLight ? 'light' : 'dark';
        localStorage.setItem('theme', theme);
        themeToggle.textContent = isLight ? '☀️' : '🌙';
    });

    // =========================================================================
    // SIDEBAR TOGGLE
    // =========================================================================
    const sidebar = document.getElementById('appSidebar');
    const toggleFixed = document.getElementById('sidebarToggleFixed');

    toggleFixed.addEventListener('click', function toggleSidebar() {
        sidebar.classList.toggle('collapsed');
        toggleFixed.textContent = sidebar.classList.contains('collapsed') ? '▶' : '◀';
    });
    toggleFixed.textContent = sidebar.classList.contains('collapsed') ? '▶' : '◀';

    // =========================================================================
    // TAB SWITCHING
    // =========================================================================
    window.switchTab = function(tabId) {
        document.querySelectorAll('.tab-pages').forEach(p => p.classList.remove('active'));
        const target = document.getElementById('tab-' + tabId);
        if (target) target.classList.add('active');

        document.querySelectorAll('.header-tabs .tab-btn').forEach(b => b.classList.remove('active'));
        const headerBtn = document.querySelector(`.header-tabs .tab-btn[data-tab="${tabId}"]`);
        if (headerBtn) headerBtn.classList.add('active');

        document.querySelectorAll('.tab-bar .tab-item').forEach(b => b.classList.remove('active'));
        const barBtn = document.querySelector(`.tab-bar .tab-item[data-tab="${tabId}"]`);
        if (barBtn) barBtn.classList.add('active');

        if (tabId === 'analytics') {
            setTimeout(() => {
                renderCharts();
                timeframePreset(document.getElementById('p-session'), 'session');
            }, 100);
        }
        if (tabId === 'settings') { loadConfig(); }
        if (tabId === 'logs') { scrollLogsToBottom(); }
    };

    // =========================================================================
    // CLOCK UPDATE
    // =========================================================================
    function updateClock() {
        try {
            const now = new Date();
            const timeStr = now.toLocaleTimeString('en-US', { timeZone: 'Africa/Nairobi', hour12: false });
            document.getElementById('clock-display').textContent = timeStr;
        } catch(e) { /* ignore */ }
    }
    setInterval(updateClock, 1000);
    updateClock();

    // =========================================================================
    // MARKETS & DECIMAL FORMATTING
    // =========================================================================
    const MARKETS_CFG = {
        // Standard
        'R_10': 'Volatility 10 Index',
        'R_25': 'Volatility 25 Index',
        'R_50': 'Volatility 50 Index',
        'R_75': 'Volatility 75 Index',
        'R_100': 'Volatility 100 Index',
        // 1-Second
        '1HZ10V': 'Volatility 10 (1s) Index',
        '1HZ25V': 'Volatility 25 (1s) Index',
        '1HZ50V': 'Volatility 50 (1s) Index',
        '1HZ75V': 'Volatility 75 (1s) Index',
        '1HZ100V': 'Volatility 100 (1s) Index'
    };

    const MARKET_DECIMALS = {
        'R_10': 2,
        'R_25': 3,
        'R_50': 4,
        'R_75': 4,
        'R_100': 2,
        '1HZ10V': 2,
        '1HZ25V': 2,
        '1HZ50V': 2,
        '1HZ75V': 2,
        '1HZ100V': 2
    };

    function formatPrice(symbol, raw) {
        const dec = MARKET_DECIMALS[symbol] || 2;
        return Number(raw).toFixed(dec);
    }

    let currentFocus = 'R_75';
    let serverMode = 'demo';
    let globalState = null;
    window.currentMarketPrices = {};

    window.setFocusMarket = function(sym) {
        currentFocus = sym;
        if (globalState) renderUI(globalState);
    };

    // =========================================================================
    // CONTROL FUNCTIONS
    // =========================================================================
    window.sendControl = function(action) {
        fetch('/api/control', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action })
        })
        .then(res => res.json())
        .then(data => {
            if (data.error) alert('Error: ' + data.error);
            else if (data.message) console.log(data.message);
        })
        .catch(err => console.error('Control error:', err));
    };

    window.swapEnvironment = function() {
        const targetMode = serverMode === 'demo' ? 'real' : 'demo';
        fetch('/api/control', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'set_mode', mode: targetMode })
        })
        .then(res => res.json())
        .then(data => {
            if (data.error) alert('Error: ' + data.error);
        })
        .catch(err => console.error('Swap error:', err));
    };

    // ---- Fixed manual trade with robust error handling ----
    window.fireManual = function(type) {
        const duration = parseInt(document.getElementById('manual-duration').value) || 7;
        const unit = document.getElementById('manual-unit').value;
        const price = window.currentMarketPrices[currentFocus];
        if (price === undefined || price === null) {
            alert('No price data available for ' + currentFocus + '. Please wait for ticks.');
            return;
        }

        fetch('/api/manual-trade', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                symbol: currentFocus,
                contractType: type,
                duration: duration,
                durationUnit: unit,
                price: price
            })
        })
        .then(async (response) => {
            const text = await response.text();
            if (!response.ok) {
                let errMsg;
                try {
                    const errData = JSON.parse(text);
                    errMsg = errData.error || 'Server error';
                } catch (e) {
                    errMsg = `Server responded with ${response.status}: ${text.slice(0, 100)}`;
                }
                throw new Error(errMsg);
            }
            const data = JSON.parse(text);
            if (data.error) {
                alert('Manual trade failed: ' + data.error);
            } else {
                console.log('Manual trade request sent:', data.message);
            }
        })
        .catch(err => {
            alert('Network error: ' + err.message);
            console.error('Manual trade fetch error:', err);
        });
    };

    window.clearLogs = function() {
        document.getElementById('log-stream').innerHTML = '';
    };

    function scrollLogsToBottom() {
        const el = document.getElementById('log-stream');
        if (el) el.scrollTop = el.scrollHeight;
    }

    // =========================================================================
    // SSE CONNECTION
    // =========================================================================
    const sse = new EventSource('/api/logs');
    sse.onopen = function() { console.log('✅ SSE connected'); };
    sse.onerror = function(err) { console.error('❌ SSE error:', err); };
    sse.onmessage = function(e) {
        try {
            const data = JSON.parse(e.data);
            if (data.state) {
                globalState = data.state;
                if (data.state.marketMetrics) {
                    for (const sym in data.state.marketMetrics) {
                        const metric = data.state.marketMetrics[sym];
                        if (metric && metric.price !== undefined) {
                            window.currentMarketPrices[sym] = metric.price;
                        }
                    }
                }
                renderUI(data.state);
            }
            if (data.logs && data.logs.length > 0) {
                const box = document.getElementById('log-stream');
                data.logs.forEach(log => {
                    const r = document.createElement('div');
                    r.className = 'log-entry';
                    r.innerHTML = `<span class="ts">[${new Date(log.time).toLocaleTimeString()}]</span><span class="msg">${log.message}</span>`;
                    box.appendChild(r);
                });
                while (box.children.length > 200) box.removeChild(box.firstChild);
                box.scrollTop = box.scrollHeight;
            }
        } catch(err) {
            console.error('❌ Error parsing SSE:', err);
        }
    };

    // =========================================================================
    // RENDER UI
    // =========================================================================
    function renderUI(state) {
        try {
            const safeState = state || {};
            const tradingMode = safeState.tradingMode || 'demo';
            const balance = safeState.balance || null;
            const sessionPnl = safeState.sessionPnl || 0;
            const dailyPnl = safeState.dailyPnl || 0;
            const currentStake = safeState.currentStake || 0.35;
            const locked = safeState.locked || false;
            const active = safeState.active || false;
            const lastTriggerTime = safeState.lastTriggerTime || 0;
            const tradeInProgress = safeState.tradeInProgress || false;
            const marketMetrics = safeState.marketMetrics || {};

            serverMode = tradingMode;

            // Header status
            const header = document.getElementById('header-status');
            const now = Date.now();
            if (locked) {
                if (active) { header.textContent = '● PAUSED'; header.className = 'header-status paused'; }
                else { header.textContent = '● LOCKED'; header.className = 'header-status off'; }
            } else if (active) {
                const remaining = Math.max(0, Math.ceil((lastTriggerTime + 30000 - now) / 1000));
                let cooldownText = remaining > 0 ? `⏳${remaining}s` : '';
                let lockText = tradeInProgress ? '🔒' : '';
                header.innerHTML = `● ARMED ${cooldownText ? `<span class="cooldown">${cooldownText}</span>` : ''} ${lockText ? `<span class="lock">${lockText}</span>` : ''}`;
                header.className = 'header-status on';
            } else {
                header.textContent = '● IDLE';
                header.className = 'header-status';
            }

            // Sidebar metrics
            document.getElementById('m-profile').textContent = tradingMode.toUpperCase();
            document.getElementById('m-balance').textContent = balance !== null ? `$${Number(balance).toFixed(2)}` : '---';
            const sessVal = Number(sessionPnl);
            const sessEl = document.getElementById('m-session');
            sessEl.textContent = `$${sessVal.toFixed(2)}`;
            sessEl.className = 'val ' + (sessVal >= 0 ? 'green' : 'red');
            const dailyVal = Number(dailyPnl);
            const dailyEl = document.getElementById('m-daily');
            dailyEl.textContent = `$${dailyVal.toFixed(2)}`;
            dailyEl.className = 'val ' + (dailyVal >= 0 ? 'green' : 'red');
            document.getElementById('m-stake').textContent = `$${Number(currentStake).toFixed(2)}`;

            // Focus bar
            const focusMetric = marketMetrics[currentFocus] || null;
            document.getElementById('f-name').textContent = MARKETS_CFG[currentFocus] || 'Volatility 75 Index';
            const priceDisplay = focusMetric
                ? (focusMetric.formattedPrice || formatPrice(currentFocus, focusMetric.price))
                : '—';
            document.getElementById('f-price').textContent = priceDisplay;
            const srEl = document.getElementById('f-sr');
            if (focusMetric) {
                const s = focusMetric.support ? Number(focusMetric.support).toFixed(2) : '—';
                const r = focusMetric.resistance ? Number(focusMetric.resistance).toFixed(2) : '—';
                srEl.innerHTML = `<span class="s">S: ${s}</span> <span class="r">R: ${r}</span>`;
                const badge = document.getElementById('f-breakout-badge');
                if (focusMetric.isBreakout) { badge.textContent = '🚀 BREAKOUT'; badge.className = 'badge breakout'; }
                else if (focusMetric.isBreakdown) { badge.textContent = '📉 BREAKDOWN'; badge.className = 'badge breakdown'; }
                else { badge.textContent = 'IDLE'; badge.className = 'badge idle'; }
                document.getElementById('f-rsi').textContent = `RSI: ${focusMetric.rsi !== undefined ? Number(focusMetric.rsi).toFixed(1) : '—'}`;
                document.getElementById('f-vol').textContent = `Vol: ${focusMetric.volatility !== undefined ? Number(focusMetric.volatility).toFixed(2) + '%' : '—'}`;
            } else {
                srEl.innerHTML = '<span class="s">S: —</span> <span class="r">R: —</span>';
                document.getElementById('f-breakout-badge').textContent = 'IDLE';
                document.getElementById('f-breakout-badge').className = 'badge idle';
                document.getElementById('f-rsi').textContent = 'RSI: —';
                document.getElementById('f-vol').textContent = 'Vol: —';
            }

            // Data table
            const tbody = document.getElementById('tableBody');
            tbody.innerHTML = '';
            let bestScore = -Infinity, bestSym = null;
            for (const sym in MARKETS_CFG) {
                const m = marketMetrics[sym] || null;
                if (m && m.score > bestScore) { bestScore = m.score; bestSym = sym; }
            }
            for (const sym in MARKETS_CFG) {
                const metric = marketMetrics[sym] || null;
                const isActive = sym === currentFocus;
                let priceDisplay = '—', step = 0, stepLabel = 'SCAN', stepClass = 'step-0', score = 0;
                let support = '—', resistance = '—';
                let breakoutIcon = '⚪', breakoutText = '';
                let rsiVal = '—', rsiClass = '';
                let fastMA = '—', slowMA = '—', vol = '—', diff = '—', diffClass = '';
                if (metric) {
                    priceDisplay = metric.formattedPrice || formatPrice(sym, metric.price);
                    step = metric.step || 0;
                    score = metric.score || 0;
                    if (step === 3) { stepLabel = 'ENTRY'; stepClass = 'step-3'; }
                    else if (step === 2) { stepLabel = 'NEAR'; stepClass = 'step-2'; }
                    else if (step === 1) { stepLabel = 'LEVEL'; stepClass = 'step-1'; }
                    else { stepLabel = 'SCAN'; stepClass = 'step-0'; }
                    support = metric.support ? Number(metric.support).toFixed(2) : '—';
                    resistance = metric.resistance ? Number(metric.resistance).toFixed(2) : '—';
                    if (metric.isBreakout) { breakoutIcon = '✅'; breakoutText = 'Breakout'; }
                    else if (metric.isBreakdown) { breakoutIcon = '❌'; breakoutText = 'Breakdown'; }
                    else { breakoutIcon = '⚪'; breakoutText = '—'; }
                    rsiVal = metric.rsi !== undefined ? Number(metric.rsi).toFixed(1) : '—';
                    if (metric.rsi !== undefined && metric.rsi > 70) rsiClass = 'overbought';
                    else if (metric.rsi !== undefined && metric.rsi < 30) rsiClass = 'oversold';
                    fastMA = metric.fastMA !== undefined && metric.fastMA !== null ? Number(metric.fastMA).toFixed(2) : '—';
                    slowMA = metric.slowMA !== undefined && metric.slowMA !== null ? Number(metric.slowMA).toFixed(2) : '—';
                    vol = metric.volatility !== undefined ? Number(metric.volatility).toFixed(2) + '%' : '—';
                    if (metric.fastMA !== null && metric.slowMA !== null) {
                        const d = ((metric.fastMA - metric.slowMA) / metric.price * 100);
                        diff = d.toFixed(2) + '%';
                        diffClass = d >= 0 ? 'positive' : 'negative';
                    } else { diff = '—'; diffClass = ''; }
                }
                const tr = document.createElement('tr');
                tr.className = `${isActive ? 'active' : ''} ${stepClass}`;
                tr.onclick = () => window.setFocusMarket(sym);
                tr.innerHTML = `
                    <td class="col-asset">${MARKETS_CFG[sym]}</td>
                    <td class="col-price">${priceDisplay}</td>
                    <td class="col-sr"><span class="s">${support}</span> / <span class="r">${resistance}</span></td>
                    <td class="col-status"><span class="icon">${breakoutIcon}</span> ${breakoutText}</td>
                    <td class="col-rsi ${rsiClass}">${rsiVal}</td>
                    <td class="col-ma"><span class="fast">${fastMA}</span></td>
                    <td class="col-ma"><span class="slow">${slowMA}</span></td>
                    <td class="col-vol">${vol}</td>
                    <td class="col-diff ${diffClass}">${diff}</td>
                    <td class="col-step"><span class="step-badge ${stepClass}">${stepLabel}</span></td>
                `;
                tbody.appendChild(tr);
            }
        } catch(err) {
            console.error('❌ Error in renderUI:', err);
        }
    }

    renderUI({});

    // =========================================================================
    // SETTINGS
    // =========================================================================
    window.loadConfig = async function() {
        try {
            const resp = await fetch('/api/config');
            const config = await resp.json();
            const map = {
                'ANALYSIS_WINDOW': 'ANALYSIS_WINDOW',
                'BOLLINGER_PERIOD': 'BOLLINGER_PERIOD',
                'BOLLINGER_STD': 'BOLLINGER_STD',
                'RSI_PERIOD': 'RSI_PERIOD',
                'OVERSOLD_THRESHOLD': 'OVERSOLD_THRESHOLD',
                'OVERBOUGHT_THRESHOLD': 'OVERBOUGHT_THRESHOLD',
                'MIN_VOLATILITY_PERCENT': 'MIN_VOLATILITY_PERCENT',
                'DURATION_SECONDS': 'DURATION_SECONDS',
                'MAX_CONSECUTIVE_LOSSES': 'MAX_CONSECUTIVE_LOSSES',
                'RISK_PERCENT': 'RISK_PERCENT',
                'TP_PERCENT': 'TP_PERCENT',
                'SL_PERCENT': 'SL_PERCENT',
                'MIN_STAKE': 'MIN_STAKE',
                'COOLDOWN_TICKS': 'COOLDOWN_TICKS'
            };
            for (const [id, key] of Object.entries(map)) {
                const el = document.getElementById('config-' + id);
                if (el && config[key] !== undefined) el.value = config[key];
            }
            const msFields = {
                'MIN_TRIGGER_INTERVAL': 1000,
                'LOSS_COOLDOWN_MS': 60000,
                'SETTLEMENT_TIMEOUT_MS': 1000,
                'PNL_SYNC_INTERVAL_MS': 1000
            };
            for (const [id, divisor] of Object.entries(msFields)) {
                const secondsId = id.replace('_MS', '_SECONDS');
                const el = document.getElementById('config-' + secondsId);
                if (el && config[id] !== undefined) {
                    el.value = config[id] / divisor;
                }
            }
            document.getElementById('settings-status').textContent = 'Config loaded.';
        } catch(err) {
            document.getElementById('settings-status').textContent = 'Error loading config.';
            console.error(err);
        }
    };

    window.saveSettings = async function() {
        const config = {};
        const direct = [
            'ANALYSIS_WINDOW', 'BOLLINGER_PERIOD', 'BOLLINGER_STD', 'RSI_PERIOD',
            'OVERSOLD_THRESHOLD', 'OVERBOUGHT_THRESHOLD', 'MIN_VOLATILITY_PERCENT',
            'DURATION_SECONDS', 'MAX_CONSECUTIVE_LOSSES',
            'RISK_PERCENT', 'TP_PERCENT', 'SL_PERCENT', 'MIN_STAKE',
            'COOLDOWN_TICKS'
        ];
        for (const id of direct) {
            const el = document.getElementById('config-' + id);
            if (el) {
                const val = parseFloat(el.value);
                if (!isNaN(val)) config[id] = val;
            }
        }
        const secondsToMs = {
            'MIN_TRIGGER_INTERVAL_SECONDS': 'MIN_TRIGGER_INTERVAL',
            'LOSS_COOLDOWN_MINUTES': 'LOSS_COOLDOWN_MS',
            'SETTLEMENT_TIMEOUT_SECONDS': 'SETTLEMENT_TIMEOUT_MS',
            'PNL_SYNC_INTERVAL_SECONDS': 'PNL_SYNC_INTERVAL_MS'
        };
        for (const [secondsId, msId] of Object.entries(secondsToMs)) {
            const el = document.getElementById('config-' + secondsId);
            if (el) {
                const val = parseFloat(el.value);
                if (!isNaN(val)) {
                    let multiplier = 1000;
                    if (secondsId === 'LOSS_COOLDOWN_MINUTES') multiplier = 60000;
                    config[msId] = val * multiplier;
                }
            }
        }
        try {
            const resp = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            });
            const result = await resp.json();
            if (result.success) {
                document.getElementById('settings-status').textContent = '✅ Settings applied!';
            } else {
                document.getElementById('settings-status').textContent = '❌ Error: ' + result.error;
            }
        } catch(err) {
            document.getElementById('settings-status').textContent = '❌ Network error.';
            console.error(err);
        }
    };

    // =========================================================================
    // ANALYTICS
    // =========================================================================
    let charts = {};
    window.renderCharts = function() {
        if (charts.donut) return;
        const dark = '#787b86', grid = '#2a2f3d';
        const ctxDonut = document.getElementById('chart-donut').getContext('2d');
        charts.donut = new Chart(ctxDonut, {
            type: 'doughnut',
            data: {
                labels: ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'],
                datasets: [{
                    data: [0,0,0,0,0],
                    backgroundColor: ['#3b82f6','#f59e0b','#787b86','#10b981','#ef4444'],
                    borderColor: '#131722',
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '65%',
                plugins: { legend: { display: false } }
            }
        });
        const ctxLine = document.getElementById('chart-line').getContext('2d');
        charts.line = new Chart(ctxLine, {
            type: 'line',
            data: { labels: [], datasets: [{ label: 'P&L', data: [0], borderColor: '#10b981', backgroundColor: 'transparent', borderWidth: 3, pointRadius: 2, tension: 0.3 }] },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: { grid: { color: grid }, ticks: { color: dark, font: { size: 7 } }, title: { display: true, text: 'Trade Sequence', color: dark, font: { size: 7 } } },
                    y: { grid: { color: grid }, ticks: { color: dark, font: { size: 7 } }, title: { display: true, text: 'Cumulative P&L ($)', color: dark, font: { size: 7 } } }
                },
                plugins: { legend: { display: false } }
            }
        });
    };

    function computeRawData(rawData) {
        let wins=0, losses=0, grossProfit=0, grossLoss=0;
        const assetMap={};
        const sorted = rawData.slice().sort((a,b) => new Date(a.created_at) - new Date(b.created_at));
        const equity=[]; let cum=0;
        sorted.forEach(t => {
            const pnl = t.profit_loss || 0;
            cum += pnl; equity.push(cum);
            if (pnl > 0) { wins++; grossProfit += pnl; } else if (pnl < 0) { losses++; grossLoss += Math.abs(pnl); }
            const asset = t.asset || 'Unknown';
            assetMap[asset] = (assetMap[asset] || 0) + pnl;
        });
        const assetLabels = ['Volatility 10 Index','Volatility 25 Index','Volatility 50 Index','Volatility 75 Index','Volatility 100 Index'];
        const assetData = assetLabels.map(name => assetMap[name] || 0);
        if (equity.length === 0) equity.push(0);
        const pf = grossLoss > 0 ? (grossProfit / grossLoss) : (grossProfit > 0 ? Infinity : 0);
        const total = wins + losses;
        const sr = total > 0 ? (wins / total) * 100 : 0;
        return { wins, losses, pf, sr, assetData, equity };
    }

    function updateUI(metrics, chartData) {
        const profitVal = parseFloat(metrics.profit.replace(/[$,]/g, ''));
        const profitEl = document.getElementById('meta-profit');
        profitEl.textContent = metrics.profit;
        profitEl.className = 'val ' + (profitVal >= 0 ? 'positive' : 'negative');

        document.getElementById('meta-pf').textContent = metrics.pf;
        document.getElementById('meta-strike').textContent = metrics.strike;
        const ddVal = parseFloat(metrics.drawdown.replace(/[%,]/g, ''));
        const ddEl = document.getElementById('meta-dd');
        ddEl.textContent = metrics.drawdown;
        ddEl.className = 'val ' + (ddVal > 0 ? 'negative' : '');

        if (charts.donut) {
            charts.donut.data.datasets[0].data = chartData.assets;
            charts.donut.update('none');
        }
        if (charts.line) {
            const eq = chartData.equity;
            const lastEquity = eq.length > 0 ? eq[eq.length-1] : 0;
            const startEquity = eq.length > 0 ? eq[0] : 0;
            const color = lastEquity >= startEquity ? '#10b981' : '#ef4444';
            charts.line.data.labels = eq.map((_,i) => `T${i+1}`);
            charts.line.data.datasets[0].data = eq;
            charts.line.data.datasets[0].borderColor = color;
            charts.line.update('none');
        }
    }

    window.timeframePreset = async function(btn, mode) {
        if (btn) {
            document.querySelectorAll('.preset-strip .btn-preset').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        }
        if (mode === 'clear') {
            updateUI({ profit: '$0.00', pf: 'N/A', strike: '0.0%', drawdown: '0.00%' }, { assets: [0,0,0,0,0], equity: [0] });
            return;
        }
        try {
            const resp = await fetch(`/api/ledger/analytics?mode=${mode}`);
            const data = await resp.json();
            let assets, equity, pf, strike, dd;
            if (mode === 'session') {
                assets = [0,0,0,0,0];
                equity = [data.totalProfit || 0];
                pf = 'N/A';
                strike = data.strikeRate || '0.0%';
                dd = '0.0%';
            } else {
                const raw = data.rawData || [];
                const comp = computeRawData(raw);
                assets = comp.assetData;
                equity = comp.equity;
                pf = data.profitFactor || '0.00';
                strike = data.strikeRate + '%';
                dd = data.drawdown + '%';
            }
            updateUI({
                profit: `$${parseFloat(data.totalProfit).toFixed(2)}`,
                pf: pf,
                strike: strike,
                drawdown: dd
            }, { assets, equity });
        } catch(err) { console.error('Analytics error:', err); }
    };

    window.applyDateFilter = async function() {
        const start = document.getElementById('date-start').value;
        const end = document.getElementById('date-end').value;
        try {
            const resp = await fetch(`/api/ledger/analytics?start=${start}&end=${end}`);
            const data = await resp.json();
            const raw = data.rawData || [];
            const comp = computeRawData(raw);
            const pf = data.profitFactor || '0.00';
            const strike = data.strikeRate + '%';
            const dd = data.drawdown + '%';
            updateUI({
                profit: `$${parseFloat(data.totalProfit).toFixed(2)}`,
                pf: pf,
                strike: strike,
                drawdown: dd
            }, { assets: comp.assetData, equity: comp.equity });
        } catch(err) { console.error('Filter error:', err); }
    };

    // =========================================================================
    // INIT
    // =========================================================================
    document.querySelectorAll('.tab-pages').forEach(p => p.classList.remove('active'));
    document.getElementById('tab-dashboard').classList.add('active');
    document.querySelectorAll('.header-tabs .tab-btn').forEach(b => b.classList.remove('active'));
    const defaultHeaderBtn = document.querySelector('.header-tabs .tab-btn[data-tab="dashboard"]');
    if (defaultHeaderBtn) defaultHeaderBtn.classList.add('active');
    document.querySelectorAll('.tab-bar .tab-item').forEach(b => b.classList.remove('active'));
    const defaultBarBtn = document.querySelector('.tab-bar .tab-item[data-tab="dashboard"]');
    if (defaultBarBtn) defaultBarBtn.classList.add('active');

    console.log('🚀 QUANTCORE Terminal v6.0 loaded');
});
