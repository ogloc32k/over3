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
                // Load default view (24h) when analytics tab opens
                timeframePreset(document.getElementById('p-24h'), '24h');
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
        'R_10': 'Volatility 10 Index',
        'R_25': 'Volatility 25 Index',
        'R_50': 'Volatility 50 Index',
        'R_75': 'Volatility 75 Index',
        'R_100': 'Volatility 100 Index',
        '1HZ10V': 'Volatility 10 (1s) Index',
        '1HZ25V': 'Volatility 25 (1s) Index',
        '1HZ50V': 'Volatility 50 (1s) Index',
        '1HZ75V': 'Volatility 75 (1s) Index',
        '1HZ100V': 'Volatility 100 (1s) Index'
    };

    const MARKET_DECIMALS = {
        'R_10': 2, 'R_25': 3, 'R_50': 4, 'R_75': 4, 'R_100': 2,
        '1HZ10V': 2, '1HZ25V': 2, '1HZ50V': 2, '1HZ75V': 2, '1HZ100V': 2
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
    // SSE CONNECTION (with analytics delta handling)
    // =========================================================================
    const sse = new EventSource('/api/logs');
    sse.onopen = function() { console.log('✅ SSE connected'); };
    sse.onerror = function(err) { console.error('❌ SSE error:', err); };
    sse.onmessage = function(e) {
        try {
            const data = JSON.parse(e.data);
            if (data.event === 'analytics_delta') {
                handleAnalyticsDelta(data.data);
                return;
            }
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

    // ---- Analytics delta handler ----
    let currentAnalyticsData = null;

    function handleAnalyticsDelta(delta) {
        if (!currentAnalyticsData) return;
        const asset = delta.asset || 'Unknown';
        const pnl = delta.pnl || 0;
        const assetMap = {};
        currentAnalyticsData.assetContributions.forEach(a => { assetMap[a.name] = a.pnl; });
        assetMap[asset] = (assetMap[asset] || 0) + pnl;
        currentAnalyticsData.assetContributions = Object.entries(assetMap)
            .map(([name, pnl]) => ({ name, pnl }))
            .sort((a, b) => b.pnl - a.pnl);

        if (currentAnalyticsData.equityData) {
            const lastEquity = currentAnalyticsData.equityData.length > 0 ?
                currentAnalyticsData.equityData[currentAnalyticsData.equityData.length-1].equity : 0;
            const newEquity = lastEquity + pnl;
            currentAnalyticsData.equityData.push({
                timestamp: delta.timestamp || Date.now(),
                equity: newEquity
            });
            if (currentAnalyticsData.equityData.length > 200) {
                currentAnalyticsData.equityData = currentAnalyticsData.equityData.slice(-200);
            }
        }
        currentAnalyticsData.totalProfit += pnl;
        currentAnalyticsData.tradeCount += 1;
        if (pnl > 0) {
            currentAnalyticsData.winCount += 1;
            currentAnalyticsData.grossProfit += pnl;
        } else if (pnl < 0) {
            currentAnalyticsData.lossCount += 1;
            currentAnalyticsData.grossLoss += Math.abs(pnl);
        }

        renderAssetBarChart(currentAnalyticsData.assetContributions);
        renderEquityCurve(currentAnalyticsData.equityData, currentAnalyticsData.startingBalance || 0);
        updateMetrics(currentAnalyticsData);
    }

    // =========================================================================
    // RENDER UI (unchanged)
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
                let breakoutLabel = '⚪ —';
                let breakoutClass = 'badge-range';
                let stepBadgeClass = 'badge-step-scan';
                let rsiVal = '—', rsiClass = '';
                let fastMA = '—', slowMA = '—', vol = '—', diff = '—', diffClass = '';

                if (metric) {
                    priceDisplay = metric.formattedPrice || formatPrice(sym, metric.price);
                    step = metric.step || 0;
                    score = metric.score || 0;

                    const price = metric.price;
                    const sup = metric.support;
                    const res = metric.resistance;
                    if (sup !== null && res !== null) {
                        if (price > res) {
                            breakoutLabel = '🟢 UP';
                            breakoutClass = 'badge-up';
                        } else if (price < sup) {
                            breakoutLabel = '🔴 DOWN';
                            breakoutClass = 'badge-down';
                        } else {
                            breakoutLabel = '⚪ RANGE';
                            breakoutClass = 'badge-range';
                        }
                    } else {
                        breakoutLabel = '⚪ —';
                        breakoutClass = 'badge-range';
                    }

                    if (step === 3) {
                        stepLabel = 'ENTRY';
                        stepClass = 'step-3';
                        stepBadgeClass = 'badge-step-entry';
                    } else if (step === 2) {
                        stepLabel = 'NEAR';
                        stepClass = 'step-2';
                        stepBadgeClass = 'badge-step-trend';
                    } else if (step === 1) {
                        stepLabel = 'LEVEL';
                        stepClass = 'step-1';
                        stepBadgeClass = 'badge-step-level';
                    } else {
                        stepLabel = 'SCAN';
                        stepClass = 'step-0';
                        stepBadgeClass = 'badge-step-scan';
                    }

                    support = metric.support ? Number(metric.support).toFixed(2) : '—';
                    resistance = metric.resistance ? Number(metric.resistance).toFixed(2) : '—';
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
                    <td class="col-status"><span class="${breakoutClass}">${breakoutLabel}</span></td>
                    <td class="col-rsi ${rsiClass}">${rsiVal}</td>
                    <td class="col-ma"><span class="fast">${fastMA}</span></td>
                    <td class="col-ma"><span class="slow">${slowMA}</span></td>
                    <td class="col-vol">${vol}</td>
                    <td class="col-diff ${diffClass}">${diff}</td>
                    <td class="col-step"><span class="${stepBadgeClass}">${stepLabel}</span></td>
                `;
                tbody.appendChild(tr);
            }
        } catch(err) {
            console.error('❌ Error in renderUI:', err);
        }
    }

    renderUI({});

    // =========================================================================
    // SETTINGS (unchanged)
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
    // ANALYTICS – HORIZONTAL BAR CHART & ENHANCED EQUITY CURVE
    // =========================================================================
    let assetBarChart = null;
    let equityChart = null;

    // ---- Custom plugin to display value labels on bars ----
    const barValueLabelPlugin = {
        id: 'barValueLabel',
        afterDraw: function(chart) {
            const ctx = chart.ctx;
            chart.data.datasets.forEach(function(dataset, i) {
                const meta = chart.getDatasetMeta(i);
                if (!meta || !meta.data) return;
                meta.data.forEach(function(element, index) {
                    const value = dataset.data[index];
                    if (value === undefined || value === null) return;
                    const x = element.x;
                    const y = element.y;
                    const text = (value >= 0 ? '+' : '') + '$' + value.toFixed(2);
                    ctx.save();
                    ctx.font = '8px Inter, sans-serif';
                    ctx.textAlign = value >= 0 ? 'left' : 'right';
                    ctx.textBaseline = 'middle';
                    ctx.fillStyle = value >= 0 ? '#10b981' : '#ef4444';
                    // Offset label to the right/left of the bar
                    const offset = value >= 0 ? 6 : -6;
                    ctx.fillText(text, x + offset, y);
                    ctx.restore();
                });
            });
        }
    };

    function renderCharts() {
        const ctxBar = document.getElementById('chart-donut').getContext('2d');
        const ctxLine = document.getElementById('chart-line').getContext('2d');

        // ---- Horizontal Bar Chart ----
        if (assetBarChart) assetBarChart.destroy();
        assetBarChart = new Chart(ctxBar, {
            type: 'bar',
            data: {
                labels: [],
                datasets: [{
                    data: [],
                    backgroundColor: [],
                    borderColor: [],
                    borderWidth: 0,
                    borderRadius: 4,
                }]
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                const value = context.parsed.x;
                                return (value >= 0 ? '+' : '') + '$' + value.toFixed(2);
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        grid: { color: 'rgba(0,0,0,0.05)' },
                        ticks: {
                            callback: function(value) {
                                return (value >= 0 ? '+' : '') + '$' + value.toFixed(2);
                            }
                        }
                    },
                    y: {
                        grid: { display: false },
                        ticks: { font: { size: 9 } },
                        afterFit: function(scale) {
                            scale.width = 120; // Fixed width for asset names
                        }
                    }
                }
            },
            plugins: [barValueLabelPlugin] // Add the plugin
        });

        // ---- Equity Curve ----
        if (equityChart) equityChart.destroy();
        equityChart = new Chart(ctxLine, {
            type: 'line',
            data: {
                datasets: [{
                    label: 'Equity',
                    data: [],
                    borderColor: '#10b981',
                    backgroundColor: 'rgba(16,185,129,0.1)',
                    fill: true,
                    tension: 0.3,
                    pointRadius: 2,
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                const value = context.parsed.y;
                                return 'Balance: $' + value.toFixed(2);
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'time',
                        time: {
                            unit: 'minute',
                            displayFormats: {
                                minute: 'HH:mm',
                                hour: 'HH:mm',
                                day: 'MMM DD',
                                week: 'MMM DD',
                                month: 'MMM YYYY'
                            }
                        },
                        grid: { color: 'rgba(0,0,0,0.05)' },
                        ticks: { font: { size: 7 }, maxTicksLimit: 15 }
                    },
                    y: {
                        grid: { color: 'rgba(0,0,0,0.05)' },
                        ticks: { font: { size: 7 } }
                    }
                }
            }
        });
    }

    function renderAssetBarChart(contributions) {
        if (!assetBarChart) return;
        const labels = contributions.map(a => a.name);
        const values = contributions.map(a => a.pnl);
        const colors = values.map(v => v >= 0 ? '#10b981' : '#ef4444');
        const borderColors = colors.map(c => c);

        assetBarChart.data.labels = labels;
        assetBarChart.data.datasets[0].data = values;
        assetBarChart.data.datasets[0].backgroundColor = colors;
        assetBarChart.data.datasets[0].borderColor = borderColors;
        assetBarChart.update('none');
    }

    function renderEquityCurve(equityData, startingBalance) {
        if (!equityChart) return;

        // If no data or less than 2 points, show empty state
        if (!equityData || equityData.length < 2) {
            // Clear the chart and show a message
            equityChart.data.datasets = [];
            equityChart.update('none');
            const parent = document.getElementById('chart-line').parentElement;
            // Remove any existing empty state div
            const existing = parent.querySelector('.empty-state');
            if (existing) existing.remove();
            const empty = document.createElement('div');
            empty.className = 'empty-state';
            empty.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;color:#787b86;font-size:12px;';
            empty.textContent = 'No trade history found for selected date range';
            parent.appendChild(empty);
            return;
        }

        // Remove empty state if present
        const parent = document.getElementById('chart-line').parentElement;
        const existing = parent.querySelector('.empty-state');
        if (existing) existing.remove();

        const dataPoints = equityData.map(p => ({ x: p.timestamp, y: p.equity }));
        const baseline = startingBalance || 0;

        const lastY = dataPoints[dataPoints.length-1]?.y || baseline;
        const isAbove = lastY >= baseline;
        const lineColor = isAbove ? '#10b981' : '#ef4444';
        const fillColor = isAbove ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)';

        // Find peak and max drawdown
        let peak = baseline;
        let maxDrawdown = 0;
        let peakPoint = null;
        let drawdownPoint = null;
        dataPoints.forEach(p => {
            if (p.y > peak) {
                peak = p.y;
                peakPoint = p;
            }
            const drawdown = peak - p.y;
            if (drawdown > maxDrawdown) {
                maxDrawdown = drawdown;
                drawdownPoint = p;
            }
        });

        const dataset = {
            label: 'Equity',
            data: dataPoints,
            borderColor: lineColor,
            backgroundColor: fillColor,
            fill: true,
            tension: 0.3,
            pointRadius: 2,
            borderWidth: 2,
            pointBackgroundColor: lineColor
        };

        const markers = [];
        if (peakPoint) {
            markers.push({
                label: 'Peak',
                data: [{ x: peakPoint.x, y: peakPoint.y }],
                pointRadius: 6,
                pointBackgroundColor: '#10b981',
                pointBorderColor: '#fff',
                pointBorderWidth: 2,
                showLine: false,
                pointStyle: 'circle'
            });
        }
        if (drawdownPoint) {
            markers.push({
                label: 'Max Drawdown',
                data: [{ x: drawdownPoint.x, y: drawdownPoint.y }],
                pointRadius: 6,
                pointBackgroundColor: '#ef4444',
                pointBorderColor: '#fff',
                pointBorderWidth: 2,
                showLine: false,
                pointStyle: 'circle'
            });
        }

        const baselineData = [
            { x: dataPoints[0].x, y: baseline },
            { x: dataPoints[dataPoints.length-1].x, y: baseline }
        ];
        const baselineDataset = {
            label: 'Start',
            data: baselineData,
            borderColor: 'rgba(100,116,139,0.4)',
            borderDash: [5, 5],
            borderWidth: 1,
            pointRadius: 0,
            fill: false,
            tension: 0
        };

        equityChart.data.datasets = [dataset, baselineDataset, ...markers];
        equityChart.update('none');
    }

    function updateMetrics(data) {
        // ---- Net Profit ----
        const profitEl = document.getElementById('meta-profit');
        profitEl.textContent = `$${data.totalProfit.toFixed(2)}`;
        profitEl.className = 'val ' + (data.totalProfit >= 0 ? 'positive' : 'negative');

        // ---- Strike Rate (Win Rate) ----
        const total = data.tradeCount || 0;
        const wins = data.winCount || 0;
        const strike = total > 0 ? (wins / total) * 100 : 0;
        const strikeEl = document.getElementById('meta-strike');
        strikeEl.innerHTML = `${strike.toFixed(1)}% <small style="display:block;font-size:8px;color:#787b86;font-weight:400;">${total} trades total</small>`;
        strikeEl.className = 'val';

        // ---- Profit Factor ----
        const grossProfit = data.grossProfit || 0;
        const grossLoss = data.grossLoss || 0;
        let pf;
        if (grossLoss === 0) {
            pf = grossProfit > 0 ? '10.0+' : '0.00';
        } else {
            pf = (grossProfit / grossLoss).toFixed(2);
        }
        document.getElementById('meta-pf').textContent = pf;

        // ---- Max Drawdown ----
        const maxDD = data.maxDrawdown || 0;
        const ddEl = document.getElementById('meta-dd');
        ddEl.textContent = `-${maxDD.toFixed(2)}%`;
        ddEl.className = 'val negative';
    }

    window.timeframePreset = async function(btn, mode) {
        if (btn) {
            document.querySelectorAll('.preset-strip .btn-preset').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        }
        if (mode === 'clear') {
            renderAssetBarChart([]);
            renderEquityCurve([], 0);
            // Reset KPI cards
            document.getElementById('meta-profit').textContent = '$0.00';
            document.getElementById('meta-strike').innerHTML = '0.0% <small style="display:block;font-size:8px;color:#787b86;">0 trades total</small>';
            document.getElementById('meta-pf').textContent = '0.00';
            document.getElementById('meta-dd').textContent = '0.0%';
            return;
        }

        try {
            const resp = await fetch(`/api/ledger/aggregated?mode=${mode}`);
            const data = await resp.json();
            currentAnalyticsData = data;
            const startingBalance = data.equityData.length > 0 ? data.equityData[0].equity : 0;
            currentAnalyticsData.startingBalance = startingBalance;

            renderAssetBarChart(data.assetContributions);
            renderEquityCurve(data.equityData, startingBalance);
            updateMetrics(data);
        } catch(err) {
            console.error('Analytics error:', err);
        }
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
