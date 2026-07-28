const { CONFIG } = require('../state/manager');
const { formatMarketPrice, extractLastDigit } = require('../markets/definitions');

const BUFFER_CAPACITY = 2000;
const BUFFER_CLEANUP_THRESHOLD = 2200;

class MultiMarketPipeline {
    constructor(symbols) {
        this.buffers = {};
        this.rawBuffers = {};
        this.lastPrices = {};
        this.diffHistory = {};
        this.rsiState = {};
        this.computeDigits = false;

        for (const symbol of symbols) {
            this.buffers[symbol] = [];
            this.rawBuffers[symbol] = [];
            this.lastPrices[symbol] = null;
            this.diffHistory[symbol] = [];
            this.rsiState[symbol] = { avgGain: 0, avgLoss: 0, initialized: false };
        }
    }

    // ---------- Mathematical Helpers ----------
    _sma(arr, period) {
        if (arr.length < period) return null;
        let sum = 0;
        for (let i = arr.length - period; i < arr.length; i++) sum += arr[i];
        return sum / period;
    }

    _stdDev(arr, period, mean) {
        if (arr.length < period || mean === null) return 0;
        let sumSq = 0;
        for (let i = arr.length - period; i < arr.length; i++) {
            sumSq += Math.pow(arr[i] - mean, 2);
        }
        return Math.sqrt(sumSq / period);
    }

    _rsi(arr, period, symbol) {
        if (arr.length < period + 1) return 50;
        const state = this.rsiState[symbol];

        if (!state.initialized) {
            let gains = 0, losses = 0;
            const startIdx = arr.length - period - 1;
            for (let i = startIdx + 1; i < arr.length; i++) {
                const diff = arr[i] - arr[i - 1];
                if (diff >= 0) gains += diff;
                else losses += Math.abs(diff);
            }
            state.avgGain = gains / period;
            state.avgLoss = losses / period;
            state.initialized = true;
        } else {
            const diff = arr[arr.length - 1] - arr[arr.length - 2];
            const gain = diff >= 0 ? diff : 0;
            const loss = diff < 0 ? Math.abs(diff) : 0;

            const alpha = 1 / period;
            state.avgGain = (state.avgGain * (1 - alpha)) + (gain * alpha);
            state.avgLoss = (state.avgLoss * (1 - alpha)) + (loss * alpha);
        }

        if (state.avgLoss === 0) return 100;
        const rs = state.avgGain / state.avgLoss;
        return 100 - (100 / (1 + rs));
    }

    _bollinger(arr, period, stdDevMultiplier) {
        const middle = this._sma(arr, period);
        if (middle === null) return { upper: null, lower: null, middle: null };
        const std = this._stdDev(arr, period, middle);
        return {
            upper: middle + (stdDevMultiplier * std),
            lower: middle - (stdDevMultiplier * std),
            middle
        };
    }

    _volatility(arr, period) {
        if (arr.length < period) return 0;
        let min = Infinity, max = -Infinity;
        for (let i = arr.length - period; i < arr.length; i++) {
            const val = arr[i];
            if (val < min) min = val;
            if (val > max) max = val;
        }
        return min === 0 ? 0 : ((max - min) / min) * 100;
    }

    _findSupportResistance(window) {
        if (window.length < 10) {
            const price = window[window.length - 1];
            return { support: price * 0.98, resistance: price * 1.02 };
        }
        let min = Infinity, max = -Infinity;
        for (let i = 0; i < window.length; i++) {
            const val = window[i];
            if (val < min) min = val;
            if (val > max) max = val;
        }
        return { support: min, resistance: max };
    }

    // ---------- High-Performance Digit Statistics ($O(N)$ Single Pass) ----------
    getDigitStats(symbol) {
        const buf = this.buffers[symbol];
        if (!buf || buf.length === 0) return null;

        const total = buf.length;
        const counts = new Array(10).fill(0);

        // Pass 1: Tally counts ($O(N)$)
        for (let i = 0; i < total; i++) {
            const digit = extractLastDigit(symbol, buf[i]);
            counts[digit]++;
        }

        const matches = new Array(10);
        const differs = new Array(10);
        const over = new Array(10);
        const under = new Array(10);

        // Cumulative counts for fast probability lookup
        let cumulativeUnder = 0;
        for (let d = 0; d <= 9; d++) {
            under[d] = ((cumulativeUnder / total) * 100).toFixed(1) + '%';
            cumulativeUnder += counts[d];

            const matchPct = (counts[d] / total) * 100;
            matches[d] = matchPct.toFixed(1) + '%';
            differs[d] = (100 - matchPct).toFixed(1) + '%';
        }

        let cumulativeOver = 0;
        for (let d = 9; d >= 0; d--) {
            over[d] = ((cumulativeOver / total) * 100).toFixed(1) + '%';
            cumulativeOver += counts[d];
        }

        return { over, under, matches, differs };
    }

    // ---------- Main Feed Method ----------
    feed(symbol, price, rawPrice) {
        const buf = this.buffers[symbol];
        buf.push(price);

        const rawBuf = this.rawBuffers[symbol];
        if (rawPrice !== undefined) {
            rawBuf.push(rawPrice);
            if (rawBuf.length > 10) rawBuf.shift();
        }

        // Buffer memory maintenance
        if (buf.length > BUFFER_CLEANUP_THRESHOLD) {
            this.buffers[symbol] = buf.slice(-BUFFER_CAPACITY);
        }

        this.lastPrices[symbol] = price;

        const analysisWindow = Math.min(CONFIG.ANALYSIS_WINDOW, buf.length);
        
        // Warmup check
        if (analysisWindow < 50) {
            return {
                symbol, price,
                rawPrice,
                rawPrices: rawBuf.slice(),
                formattedPrice: formatMarketPrice(symbol, price),
                risePct: 0, fallPct: 0,
                rsi: 50, volatility: 0,
                lastDigit: rawPrice ? parseInt(rawPrice.slice(-1), 10) : extractLastDigit(symbol, price),
                digitStats: this.computeDigits ? this.getDigitStats(symbol) : null
            };
        }

        const window = buf.slice(-analysisWindow);
        
        // Price direction counts
        let rises = 0, falls = 0;
        for (let i = 1; i < window.length; i++) {
            if (window[i] > window[i - 1]) rises++;
            else if (window[i] < window[i - 1]) falls++;
        }
        const risePct = (rises / window.length) * 100;
        const fallPct = (falls / window.length) * 100;

        // Indicators
        const fastMA = this._sma(buf, 8);
        const slowMA = this._sma(buf, 21);
        const vol = this._volatility(buf, 20);
        const bb = this._bollinger(buf, CONFIG.BOLLINGER_PERIOD, CONFIG.BOLLINGER_STD);
        const rsi = this._rsi(buf, CONFIG.RSI_PERIOD, symbol);
        const sr = this._findSupportResistance(window);

        let bandwidth = null;
        if (bb.middle) bandwidth = ((bb.upper - bb.lower) / bb.middle) * 100;

        let maDiff = 0;
        if (fastMA !== null && slowMA !== null) maDiff = ((fastMA - slowMA) / price) * 100;

        const history = this.diffHistory[symbol] || [];
        history.push(maDiff);
        if (history.length > 3) history.shift();
        this.diffHistory[symbol] = history;

        const maDiffExpanding = history.length >= 2 && Math.abs(maDiff) > Math.abs(history[history.length - 2]);

        // Last digit extraction (prefer raw string over float)
        const lastDigit = rawPrice ? parseInt(rawPrice.slice(-1), 10) : extractLastDigit(symbol, price);

        // Digit Matrix calculation ($O(N)$ pass)
        let digitMatrix = null;
        let digitStats = null;
        if (this.computeDigits) {
            digitStats = this.getDigitStats(symbol);
            
            const counts = new Array(10).fill(0);
            for (let i = 0; i < window.length; i++) {
                counts[extractLastDigit(symbol, window[i])]++;
            }

            digitMatrix = [];
            const totalTicks = window.length;
            let cumulativeUnder = 0;

            for (let d = 0; d <= 9; d++) {
                const matches = (counts[d] / totalTicks) * 100;
                const differs = 100 - matches;
                const underPct = (cumulativeUnder / totalTicks) * 100;
                cumulativeUnder += counts[d];

                digitMatrix.push({ digit: d, matches, differs, under: underPct, over: 0 });
            }

            let cumulativeOver = 0;
            for (let d = 9; d >= 0; d--) {
                digitMatrix[d].over = (cumulativeOver / totalTicks) * 100;
                cumulativeOver += counts[d];
            }
        }

        // Trading Signals
        const isBreakout = sr.resistance ? price > sr.resistance * 1.001 : false;
        const isBreakdown = sr.support ? price < sr.support * 0.999 : false;

        const condRSI = rsi >= 50 && rsi <= 85;
        const condBollinger = bb.upper !== null && price >= bb.upper * 0.999;
        const condVolatility = vol >= CONFIG.MIN_VOLATILITY_PERCENT;
        const condMA = maDiffExpanding && Math.abs(maDiff) >= (CONFIG.MA_DIFF_THRESHOLD || 0.08);

        const callReady = isBreakout && condRSI && condBollinger && condVolatility && condMA;
        const putReady = isBreakdown && (rsi >= 15 && rsi <= 50) && (bb.lower !== null && price <= bb.lower * 1.001) && condVolatility && condMA;

        return {
            symbol, price,
            rawPrice,
            rawPrices: rawBuf.slice(),
            formattedPrice: formatMarketPrice(symbol, price),
            risePct, fallPct,
            rsi, volatility: vol,
            bbUpper: bb.upper, bbLower: bb.lower, bbMiddle: bb.middle, bandwidth,
            support: sr.support, resistance: sr.resistance,
            isBreakout, isBreakdown,
            lastDigit, digitMatrix, digitStats,
            callReady, putReady,
            maDiff, maDiffExpanding,
            conditions: {
                breakout: isBreakout || isBreakdown,
                rsi: condRSI,
                bollinger: condBollinger,
                volatility: condVolatility,
                ma: condMA
            }
        };
    }
}

module.exports = MultiMarketPipeline;
