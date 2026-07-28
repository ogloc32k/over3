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

        const focusBar = document.getElementById('focusBar');
        if (tabId === 'analytics' || tabId === 'digits') {
            focusBar.style.display = 'none';
        } else {
            focusBar.style.display = 'flex';
        }

        const body = document.body;
        body.classList.remove('analytics-active', 'dashboard-active');
        if (tabId === 'analytics') {
            body.classList.add('analytics-active');
            sidebar.classList.add('collapsed');
            toggleFixed.textContent = '▶';
        } else if (tabId === 'dashboard') {
            body.classList.add('dashboard-active');
        }

        if (tabId === 'analytics') {
            setTimeout(() => {
                renderCharts();
                timeframePreset(document.getElementById('p-session'), 'session');
                // Update analytics stats when tab opens
                updateAnalyticsStats();
            }, 100);
        }
        if (tabId === 'digits') {
            setTimeout(() => {
                renderDigitsTab();
            }, 100);
        }
        if (tabId === 'settings') { loadConfig(); }
        if (tabId === 'logs') { scrollLogsToBottom(); }
    };

    // =========================================================================
    // TOGGLE DATE PICKER
    // =========================================================================
    window.toggleDatePicker = function() {
        const group = document.getElementById('datePickerGroup');
        group.style.display = group.style.display === 'none' ? 'flex' : 'none';
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
        if (raw === undefined || raw === null) return '—';
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
        document.querySelectorAll('.asset-chip').forEach(el => el.classList.remove('active'));
        const chip = document.querySelector(`.asset-chip[data-symbol="${sym}"]`);
        if (chip) chip.classList.add('active');
        // Also update digits tab if visible
        if (document.getElementById('tab-digits').classList.contains('active')) {
            renderDigitsTab();
        }
        // Update analytics stats if visible
        if (document.getElementById('tab-analytics').classList.contains('active')) {
            updateAnalyticsStats();
        }
    };

    function getAssetLabel(name, isMobile) {
        if (!isMobile) return name;
        const shortMap = {
            'Volatility 10 Index': 'V10',
            'Volatility 25 Index': 'V25',
            'Volatility 50 Index': 'V50',
            'Volatility 75 Index': 'V75',
            'Volatility 100 Index': 'V100',
            'Volatility 10 (1s) Index': 'V10 (1s)',
            'Volatility 25 (1s) Index': 'V25 (1s)',
            'Volatility 50 (1s) Index': 'V50 (1s)',
            'Volatility 75 (1s) Index': 'V75 (1s)',
            'Volatility 100 (1s) Index': 'V100 (1s)'
        };
        return shortMap[name] || name;
    }

    // =========================================================================
    // UPDATE ANALYTICS STATS (S/R & Rise/Fall)
    // =========================================================================
    function updateAnalyticsStats() {
        const metric = globalState?.marketMetrics?.[currentFocus] || null;
        const supportEl = document.getElementById('stat-support');
        const resistanceEl = document.getElementById('stat-resistance');
        const riseEl = document.getElementById('stat-rise');
        const fallEl = document.getElementById('stat-fall');

        if (!supportEl || !resistanceEl || !riseEl || !fallEl) return;

        if (!metric) {
            supportEl.textContent = '--%';
            resistanceEl.textContent = '--%';
            riseEl.textContent = '--%';
            fallEl.textContent = '--%';
            return;
        }

        const supportPct = metric.supportPct !== undefined ? Math.round(metric.supportPct) : null;
        const resistancePct = metric.resistancePct !== undefined ? Math.round(metric.resistancePct) : null;
        const risePct = metric.risePct !== undefined ? Math.round(metric.risePct) : null;
        const fallPct = metric.fallPct !== undefined ? Math.round(metric.fallPct) : null;

        supportEl.textContent = supportPct !== null ? supportPct + '%' : '--%';
        resistanceEl.textContent = resistancePct !== null ? resistancePct + '%' : '--%';
        riseEl.textContent = risePct !== null ? risePct + '%' : '--%';
        fallEl.textContent = fallPct !== null ? fallPct + '%' : '--%';
    }

    // =========================================================================
    // DIGITS TAB RENDER
    // =========================================================================
    function renderDigitsTab() {
        const activeMetric = globalState?.marketMetrics?.[currentFocus] || null;
        if (!activeMetric) return;

        // Update asset chips
        const chipsContainer = document.getElementById('digitsAssetChips');
        if (chipsContainer) {
            chipsContainer.innerHTML = '';
            const symbols = Object.keys(MARKETS_CFG);
            symbols.forEach(sym => {
                const chip = document.createElement('button');
                chip.className = 'digits-chip' + (sym === currentFocus ? ' active' : '');
                chip.textContent = getAssetLabel(MARKETS_CFG[sym], true);
                chip.onclick = () => window.setFocusMarket(sym);
                chipsContainer.appendChild(chip);
            });
        }

        // Digit Matrix
        const matrix = activeMetric.digitMatrix || [];
        const tbody = document.getElementById('digitsTableBody');
        if (tbody) {
            tbody.innerHTML = '';
            matrix.forEach(row => {
                const tr = document.createElement('tr');
                const overPct = row.over || 0;
                const underPct = row.under || 0;
                const matchesPct = row.matches || 0;
                const differsPct = row.differs || 0;
                tr.innerHTML = `
                    <td><strong>${row.digit}</strong></td>
                    <td class="${overPct > 70 ? 'high' : (overPct < 30 ? 'low' : '')}">${overPct.toFixed(1)}%</td>
                    <td class="${underPct > 70 ? 'high' : (underPct < 30 ? 'low' : '')}">${underPct.toFixed(1)}%</td>
                    <td class="${matchesPct > 70 ? 'high' : (matchesPct < 30 ? 'low' : '')}">${matchesPct.toFixed(1)}%</td>
                    <td class="${differsPct > 70 ? 'high' : (differsPct < 30 ? 'low' : '')}">${differsPct.toFixed(1)}%</td>
                `;
                tbody.appendChild(tr);
            });
        }
    }

    // =========================================================================
    // CONTROL FUNCTIONS
    // =========================================================================
    window.sendControl = function(action) {
        fetch('/api/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) })
            .then(res => res.json())
            .then(data => {
                if (data.error) alert('Error: ' + data.error);
                else if (data.message) console.log(data.message);
            })
            .catch(err => console.error('Control error:', err));
    };

    window.swapEnvironment = function() {
        const targetMode = serverMode === 'demo' ? 'real' : 'demo';
        fetch('/api/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'set_mode', mode: targetMode }) })
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
            body: JSON.stringify({ symbol: currentFocus, contractType: type, duration: duration, durationUnit: unit, price: price })
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
                // Update analytics stats if analytics tab is active
                if (document.getElementById('tab-analytics').classList.contains('active')) {
                    updateAnalyticsStats();
                }
                if (document.getElementById('tab-digits').classList.contains('active')) {
                    renderDigitsTab();
                }
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
        renderEquityCurve(currentAnalyticsData.equityData, currentAnalyticsData.startingBalance || 0, currentAnalyticsData.timeframe || 'session');
        updateMetrics(currentAnalyticsData);
    }

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
            const priceDisplay = focusMetric?.formattedPrice || formatPrice(currentFocus, focusMetric?.price) || '—';
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

            // ---- Data table ----
            const tbody = document.getElementById('tableBody');
            if (!tbody) return;
            tbody.innerHTML = '';
            let bestScore = -Infinity, bestSym = null;
            for (const sym in MARKETS_CFG) {
                const m = marketMetrics[sym] || null;
                if (m && m.score > bestScore) { bestScore = m.score; bestSym = sym; }
            }
            for (const sym in MARKETS_CFG) {
                const metric = marketMetrics[sym] || null;
                const isActive = sym === currentFocus;
                let priceDisplay = '—', step = 0, stepLabel = 'SCAN', stepClass = 'step-0';
                let support = '—', resistance = '—';
                let breakoutLabel = '⚪ RANGE';
                let breakoutClass = 'badge-range';
                let rsiVal = '—', rsiClass = '';
                let vol = '—';
                let squeezeDisplay = '—';
                let squeezeClass = '';
                let trendHtml = '';
                let digit = '—';

                if (metric) {
                    priceDisplay = metric.formattedPrice || formatPrice(sym, metric.price) || '—';
                    step = metric.step || 0;

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
                        }
                    }

                    if (step === 3) { stepLabel = 'ENTRY'; stepClass = 'step-3'; }
                    else if (step === 2) { stepLabel = 'NEAR'; stepClass = 'step-2'; }
                    else if (step === 1) { stepLabel = 'LEVEL'; stepClass = 'step-1'; }
                    else { stepLabel = 'SCAN'; stepClass = 'step-0'; }

                    support = metric.support ? Number(metric.support).toFixed(2) : '—';
                    resistance = metric.resistance ? Number(metric.resistance).toFixed(2) : '—';
                    rsiVal = metric.rsi !== undefined ? Number(metric.rsi).toFixed(1) : '—';
                    if (metric.rsi !== undefined && metric.rsi > 70) rsiClass = 'overbought';
                    else if (metric.rsi !== undefined && metric.rsi < 30) rsiClass = 'oversold';
                    vol = metric.volatility !== undefined ? Number(metric.volatility).toFixed(2) + '%' : '—';

                    if (metric.bandwidth !== null && metric.bandwidth !== undefined) {
                        squeezeDisplay = metric.bandwidth.toFixed(2) + '%';
                        if (metric.bandwidth < 2.0) {
                            squeezeClass = 'badge-squeeze';
                        }
                    }

                    if (metric.tickDirections && metric.tickDirections.length > 0) {
                        const dirs = metric.tickDirections.slice(-5);
                        trendHtml = dirs.map(d => {
                            if (d > 0) return '<span class="tick-up">▲</span>';
                            else if (d < 0) return '<span class="tick-down">▼</span>';
                            else return '<span class="tick-flat">—</span>';
                        }).join('');
                    } else {
                        trendHtml = '—';
                    }

                    digit = metric.lastDigit !== undefined && metric.lastDigit !== null ? metric.lastDigit : '—';
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
                    <td class="col-bb-squeeze"><span class="${squeezeClass}">${squeezeDisplay}</span></td>
                    <td class="col-trend">${trendHtml}</td>
                    <td class="col-digit">${digit}</td>
                    <td class="col-vol">${vol}</td>
                    <td class="col-step"><span class="step-badge ${stepClass}">${stepLabel}</span></td>
                `;
                tbody.appendChild(tr);
            }

            // ---- Mobile view ----
            renderMobileView(state);

        } catch(err) {
            console.error('❌ Error in renderUI:', err);
        }
    }

    // ---- Mobile Market View ----
    function renderMobileView(state) {
        try {
            const safeState = state || {};
            const marketMetrics = safeState.marketMetrics || {};
            const symbols = Object.keys(MARKETS_CFG);
            const carousel = document.getElementById('assetCarousel');
            if (carousel) {
                carousel.innerHTML = '';
                symbols.forEach(sym => {
                    const chip = document.createElement('div');
                    chip.className = 'asset-chip' + (sym === currentFocus ? ' active' : '');
                    chip.dataset.symbol = sym;
                    const shortName = getAssetLabel(MARKETS_CFG[sym], true);
                    chip.textContent = shortName;
                    chip.onclick = () => window.setFocusMarket(sym);
                    carousel.appendChild(chip);
                });
            }

            const metric = marketMetrics[currentFocus] || null;
            if (!metric) {
                document.getElementById('mobile-asset-name').textContent = MARKETS_CFG[currentFocus] || '—';
                document.getElementById('mobile-asset-price').textContent = '—';
                document.getElementById('mobile-support').textContent = '—';
                document.getElementById('mobile-resistance').textContent = '—';
                document.getElementById('mobile-breakout').textContent = '—';
                document.getElementById('mobile-rsi-value').textContent = '—';
                document.getElementById('mobile-volatility').textContent = '—';
                document.getElementById('mobile-tick-digits').innerHTML = '<span class="tick-digit">—</span>';
                document.getElementById('mobile-rsi-gauge').querySelector('.rsi-fill').style.width = '50%';
                return;
            }

            const price = metric.price;
            const formattedPrice = metric.formattedPrice || formatPrice(currentFocus, price) || '—';
            const support = metric.support ? Number(metric.support).toFixed(2) : '—';
            const resistance = metric.resistance ? Number(metric.resistance).toFixed(2) : '—';
            const rsi = metric.rsi !== undefined ? Number(metric.rsi).toFixed(1) : '—';
            const vol = metric.volatility !== undefined ? Number(metric.volatility).toFixed(2) + '%' : '—';
            const breakout = metric.isBreakout ? '🚀 UP' : (metric.isBreakdown ? '📉 DOWN' : '—');
            const breakoutClass = metric.isBreakout ? 'breakout' : (metric.isBreakdown ? 'breakdown' : '');

            const lastPrices = metric.lastPrices || [];
            let change = 0;
            let changeClass = '';
            if (lastPrices.length >= 2) {
                const prev = lastPrices[lastPrices.length - 2];
                const curr = lastPrices[lastPrices.length - 1];
                if (prev !== undefined && curr !== undefined) {
                    change = curr - prev;
                    changeClass = change > 0 ? 'up' : (change < 0 ? 'down' : '');
                }
            }
            const changeDisplay = change !== 0 ? (change > 0 ? '+' : '') + change.toFixed(2) : '—';

            document.getElementById('mobile-asset-name').textContent = MARKETS_CFG[currentFocus] || '—';
            document.getElementById('mobile-asset-price').textContent = formattedPrice;
            const changeEl = document.getElementById('mobile-asset-change');
            changeEl.textContent = changeDisplay;
            changeEl.className = 'asset-change ' + changeClass;

            document.getElementById('mobile-support').textContent = support;
            document.getElementById('mobile-resistance').textContent = resistance;
            const breakoutEl = document.getElementById('mobile-breakout');
            breakoutEl.textContent = breakout;
            breakoutEl.className = 'value ' + breakoutClass;

            document.getElementById('mobile-rsi-value').textContent = rsi;
            const rsiFill = document.getElementById('mobile-rsi-gauge').querySelector('.rsi-fill');
            if (rsiFill) {
                const rsiNum = parseFloat(rsi);
                if (!isNaN(rsiNum)) {
                    rsiFill.style.width = Math.min(100, Math.max(0, rsiNum)) + '%';
                } else {
                    rsiFill.style.width = '50%';
                }
            }

            document.getElementById('mobile-volatility').textContent = vol;

            const digitsContainer = document.getElementById('mobile-tick-digits');
            if (digitsContainer) {
                if (lastPrices.length > 0) {
                    const lastTicks = lastPrices.slice(-10);
                    let html = '';
                    let prev = null;
                    lastTicks.forEach((val) => {
                        const num = Number(val);
                        const cls = (prev !== null) ? (num > prev ? 'up' : (num < prev ? 'down' : '')) : '';
                        html += `<span class="tick-digit ${cls}">${num.toFixed(2)}</span>`;
                        prev = num;
                    });
                    digitsContainer.innerHTML = html;
                } else {
                    digitsContainer.innerHTML = '<span class="tick-digit">—</span>';
                }
            }
        } catch(err) {
            console.error('❌ Error in renderMobileView:', err);
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
        try {
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
    // ANALYTICS CHARTS
    // =========================================================================
    let assetBarChart = null;
    let equityChartInstance = null;

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
                    const offset = value >= 0 ? 6 : -6;
                    ctx.fillText(text, x + offset, y);
                    ctx.restore();
                });
            });
        }
    };

    function renderCharts() {
        const isMobile = window.innerWidth < 768;
        const ctxBar = document.getElementById('chart-donut')?.getContext('2d');
        const ctxLine = document.getElementById('chart-line')?.getContext('2d');
        if (!ctxBar || !ctxLine) return;

        if (assetBarChart) assetBarChart.destroy();
        assetBarChart = new Chart(ctxBar, {
            type: 'bar',
            data: { labels: [], datasets: [{ data: [], backgroundColor: [], borderColor: [], borderWidth: 0, borderRadius: 4 }] },
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
                        grid: { display: isMobile ? false : true },
                        ticks: {
                            display: isMobile ? false : true,
                            callback: function(value) {
                                return (value >= 0 ? '+' : '') + '$' + value.toFixed(2);
                            }
                        }
                    },
                    y: {
                        grid: { display: false },
                        ticks: { font: { size: isMobile ? 8 : 9 }, color: '#d1d5db' },
                        afterFit: function(scale) {
                            if (window.innerWidth < 768) scale.width = 70;
                            else scale.width = 120;
                        }
                    }
                }
            },
            plugins: [barValueLabelPlugin]
        });

        if (equityChartInstance) { equityChartInstance.destroy(); equityChartInstance = null; }
        equityChartInstance = new Chart(ctxLine, {
            type: 'line',
            data: {
                datasets: [{
                    label: 'Equity',
                    data: [],
                    borderColor: '#10b981',
                    backgroundColor: 'rgba(16,185,129,0.1)',
                    fill: true,
                    tension: 0.3,
                    pointRadius: 0,
                    pointHoverRadius: 5,
                    pointHitRadius: 10,
                    borderWidth: 2,
                    pointBackgroundColor: '#10b981'
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
                                return 'Balance: ' + (value >= 0 ? '+$' : '-$') + Math.abs(value).toFixed(2);
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'category',
                        grid: { display: false },
                        ticks: {
                            font: { size: 7 },
                            maxTicksLimit: window.innerWidth < 768 ? 5 : 20,
                            maxRotation: 0,
                            autoSkip: true,
                            color: '#9ca3af'
                        }
                    },
                    y: {
                        grid: { color: 'rgba(0,0,0,0.05)' },
                        ticks: {
                            font: { size: 7 },
                            color: '#9ca3af',
                            callback: function(value) {
                                return (value >= 0 ? '+' : '-') + '$' + Math.abs(value).toFixed(2);
                            }
                        }
                    }
                }
            }
        });
    }

    function renderAssetBarChart(contributions) {
        if (!assetBarChart) return;
        try {
            const isMobile = window.innerWidth < 768;
            const labels = contributions.map(a => getAssetLabel(a.name, isMobile));
            const values = contributions.map(a => a.pnl);
            const colors = values.map(v => v >= 0 ? '#10b981' : '#ef4444');
            const maxAbs = values.reduce((max, v) => Math.max(max, Math.abs(v)), 0);
            const buffer = maxAbs * 0.15;
            const suggestedMax = maxAbs + buffer;
            const suggestedMin = -suggestedMax;

            assetBarChart.data.labels = labels;
            assetBarChart.data.datasets[0].data = values;
            assetBarChart.data.datasets[0].backgroundColor = colors;
            assetBarChart.data.datasets[0].borderColor = colors;

            assetBarChart.options.scales.x = {
                grid: { display: isMobile ? false : true, color: 'rgba(0,0,0,0.05)' },
                ticks: {
                    display: isMobile ? false : true,
                    callback: function(value) {
                        return (value >= 0 ? '+' : '') + '$' + value.toFixed(2);
                    }
                },
                suggestedMin: suggestedMin,
                suggestedMax: suggestedMax
            };
            assetBarChart.update('none');
        } catch(e) { console.error('renderAssetBarChart error:', e); }
    }

    function formatEquityLabel(timestamp, timeframe) {
        const date = new Date(timestamp);
        if (timeframe === '24h' || timeframe === 'hour' || timeframe === 'session') {
            const hours = String(date.getHours()).padStart(2, '0');
            const minutes = String(date.getMinutes()).padStart(2, '0');
            return hours + ':' + minutes;
        } else {
            return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
        }
    }

    function showChartEmptyState(containerId, message) {
        const container = document.getElementById(containerId);
        if (!container) return;
        let empty = container.parentElement?.querySelector('.chart-empty-state');
        if (!empty) {
            empty = document.createElement('div');
            empty.className = 'chart-empty-state';
            empty.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-secondary);font-size:13px;text-align:center;padding:20px;';
            container.parentElement.style.position = 'relative';
            container.parentElement.appendChild(empty);
        }
        empty.textContent = message || 'No trade history recorded for this period';
        container.style.display = 'none';
    }

    function hideChartEmptyState(containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.style.display = 'block';
        const parent = container.parentElement;
        if (parent) {
            const empty = parent.querySelector('.chart-empty-state');
            if (empty) empty.remove();
        }
    }

    function renderEquityCurve(equityData, startingBalance, timeframe) {
        if (!equityChartInstance) return;
        try {
            if (!equityData || equityData.length < 2) {
                showChartEmptyState('chart-line', 'No trade history recorded for this period');
                equityChartInstance.data.labels = [];
                equityChartInstance.data.datasets[0].data = [];
                equityChartInstance.update('none');
                return;
            }
            hideChartEmptyState('chart-line');

            const labels = equityData.map(point => formatEquityLabel(point.timestamp, timeframe));
            const values = equityData.map(point => point.equity);
            const baseline = startingBalance || 0;
            const lastValue = values.length > 0 ? values[values.length-1] : baseline;
            const isAbove = lastValue >= baseline;
            const lineColor = isAbove ? '#10b981' : '#ef4444';
            const fillColor = isAbove ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)';

            equityChartInstance.data.labels = labels;
            equityChartInstance.data.datasets[0].data = values;
            equityChartInstance.data.datasets[0].borderColor = lineColor;
            equityChartInstance.data.datasets[0].backgroundColor = fillColor;
            equityChartInstance.data.datasets[0].pointBackgroundColor = lineColor;

            const baselineData = [baseline, baseline];
            equityChartInstance.data.datasets[1] = {
                label: 'Start',
                data: baselineData,
                borderColor: 'rgba(100,116,139,0.4)',
                borderDash: [5, 5],
                borderWidth: 1,
                pointRadius: 0,
                fill: false,
                tension: 0
            };

            while (equityChartInstance.data.datasets.length > 2) {
                equityChartInstance.data.datasets.pop();
            }
            equityChartInstance.update('none');
        } catch(e) { console.error('renderEquityCurve error:', e); }
    }

    function updateMetrics(data) {
        try {
            const profitEl = document.getElementById('meta-profit');
            if (profitEl) {
                profitEl.textContent = `$${data.totalProfit.toFixed(2)}`;
                profitEl.className = 'val ' + (data.totalProfit >= 0 ? 'positive' : 'negative');
            }

            const total = data.tradeCount || 0;
            const wins = data.winCount || 0;
            const strike = total > 0 ? (wins / total) * 100 : 0;
            const strikeEl = document.getElementById('meta-strike');
            if (strikeEl) {
                strikeEl.innerHTML = `${strike.toFixed(1)}% <small style="display:block;font-size:8px;color:#787b86;font-weight:400;">${total} trades total</small>`;
                strikeEl.className = 'val';
            }

            const grossProfit = data.grossProfit || 0;
            const grossLoss = data.grossLoss || 0;
            let pf;
            if (grossLoss === 0) {
                pf = grossProfit > 0 ? '10.0+' : '0.00';
            } else {
                pf = (grossProfit / grossLoss).toFixed(2);
            }
            const pfEl = document.getElementById('meta-pf');
            if (pfEl) pfEl.textContent = pf;

            const maxDD = data.maxDrawdown || 0;
            const ddEl = document.getElementById('meta-dd');
            if (ddEl) {
                ddEl.textContent = `-${maxDD.toFixed(2)}%`;
                ddEl.className = 'val negative';
            }

            const losses = data.lossCount || 0;
            const avgWin = wins > 0 ? grossProfit / wins : 0;
            const avgLoss = losses > 0 ? grossLoss / losses : 0;
            const avgEl = document.getElementById('meta-avg-win-loss');
            if (avgEl) avgEl.textContent = `$${avgWin.toFixed(2)} / $${avgLoss.toFixed(2)}`;

            const maxConsecEl = document.getElementById('meta-max-consec');
            if (maxConsecEl) maxConsecEl.textContent = `W:${wins} / L:${losses}`;

            const avgDurEl = document.getElementById('meta-avg-duration');
            if (avgDurEl) avgDurEl.textContent = `${total > 0 ? (data.totalDuration || 0) / total : 0}s`;

            const wonLostEl = document.getElementById('meta-won-lost');
            if (wonLostEl) wonLostEl.textContent = `${wins} / ${losses}`;
        } catch(e) { console.error('updateMetrics error:', e); }
    }

    function updateDatePickersForPreset(mode) {
        const now = new Date();
        const startEl = document.getElementById('date-start');
        const endEl = document.getElementById('date-end');
        if (!startEl || !endEl) return;
        let startDate, endDate;
        switch (mode) {
            case '24h': startDate = new Date(now.getTime() - 24*60*60*1000); endDate = now; break;
            case 'week': startDate = new Date(now.getTime() - 7*24*60*60*1000); endDate = now; break;
            case 'month': startDate = new Date(now.getTime() - 30*24*60*60*1000); endDate = now; break;
            case 'year': startDate = new Date(now.getTime() - 365*24*60*60*1000); endDate = now; break;
            default: return;
        }
        const formatDate = (d) => d.toISOString().split('T')[0];
        startEl.value = formatDate(startDate);
        endEl.value = formatDate(endDate);
    }

    window.timeframePreset = async function(btn, mode) {
        if (btn) {
            document.querySelectorAll('.preset-strip .btn-preset').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        }
        if (mode === 'clear') {
            renderAssetBarChart([]);
            renderEquityCurve([], 0);
            document.getElementById('meta-profit').textContent = '$0.00';
            document.getElementById('meta-strike').innerHTML = '0.0% <small style="display:block;font-size:8px;color:#787b86;">0 trades total</small>';
            document.getElementById('meta-pf').textContent = '0.00';
            document.getElementById('meta-dd').textContent = '0.0%';
            document.getElementById('meta-avg-win-loss').textContent = '$0.00 / $0.00';
            document.getElementById('meta-max-consec').textContent = 'W:0 / L:0';
            document.getElementById('meta-avg-duration').textContent = '0s';
            document.getElementById('meta-won-lost').textContent = '0 / 0';
            return;
        }

        updateDatePickersForPreset(mode);

        try {
            const resp = await fetch(`/api/ledger/aggregated?mode=${mode}`);
            const data = await resp.json();
            currentAnalyticsData = data;
            currentAnalyticsData.timeframe = mode;
            const startingBalance = data.equityData.length > 0 ? data.equityData[0].equity : 0;
            currentAnalyticsData.startingBalance = startingBalance;

            renderAssetBarChart(data.assetContributions);
            renderEquityCurve(data.equityData, startingBalance, mode);
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
