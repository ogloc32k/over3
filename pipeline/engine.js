const { CONFIG } = require('../state/manager');
const { formatMarketPrice } = require('../markets/definitions');

const BUFFER_CAPACITY = 2000;
const BUFFER_CLEANUP_THRESHOLD = 2200;

class MultiMarketPipeline {
    constructor(symbols) {
        this.buffers = {};
        this.rawBuffers = {};       // store raw price strings for last 10 ticks
        this.lastPrices = {};
        this.diffHistory = {};
        this.rsiState = {};
        this.computeDigits = false; // default off (only for Digits tab)
        for (const symbol of symbols) {
            this.buffers[symbol] = [];
            this.rawBuffers[symbol] = [];
            this.lastPrices[symbol] = null;
            this.diffHistory[symbol] = [];
            this.rsiState[symbol] = { avgGain: 0, avgLoss: 0, initialized: false };
        }
    }

    _sma(arr, period) {
        if (arr.length < period) return null;
        const slice = arr.slice(-period);
        return slice.reduce((a,b) => a+b, 0) / period;
    }

    _stdDev(arr, period) {
        if (arr.length < period) return 0;
        const slice = arr.slice(-period);
        const mean = slice.reduce((a,b) => a+b, 0) / period;
        const squaredDiffs = slice.map(x => Math.pow(x - mean, 2));
        return Math.sqrt(squaredDiffs.reduce((a,b) => a+b, 0) / period);
    }

    _rsi(arr, period, symbol) {
        if (arr.length < period + 1) return 50;
        const state = this.rsiState[symbol];
        const slice = arr.slice(-period - 1);

        if (!state.initialized) {
            let gains = 0, losses = 0;
            for (let i = 1; i < slice.length; i++) {
                const diff = slice[i] - slice[i-1];
                if (diff >= 0) gains += diff;
                else losses += Math.abs(diff);
            }
            state.avgGain = gains / period;
            state.avgLoss = losses / period;
            state.initialized = true;
            if (state.avgLoss === 0) return 100;
            const rs = state.avgGain / state.avgLoss;
            return 100 - (100 / (1 + rs));
        }

        const lastPrice = arr[arr.length - 2];
        const currentPrice = arr[arr.length - 1];
        const diff = currentPrice - lastPrice;
        let gain = 0, loss = 0;
        if (diff >= 0) gain = diff;
        else loss = Math.abs(diff);

        const alpha = 1 / period;
        state.avgGain = (state.avgGain * (1 - alpha)) + (gain * alpha);
        state.avgLoss = (state.avgLoss * (1 - alpha)) + (loss * alpha);

        if (state.avgLoss === 0) return 100;
        const rs = state.avgGain / state.avgLoss;
        return 100 - (100 / (1 + rs));
    }

    _bollinger(arr, period, stdDev) {
        const middle = this._sma(arr, period);
        if (middle === null) return { upper: null, lower: null, middle: null };
        const std = this._stdDev(arr, period);
        return {
            upper: middle + (stdDev * std),
            lower: middle - (stdDev * std),
            middle: middle
        };
    }

    _volatility(arr, period) {
        if (arr.length < period) return 0;
        const slice = arr.slice(-period);
        const min = Math.min(...slice);
        const max = Math.max(...slice);
        if (min === 0) return 0;
        return (max - min) / min * 100;
    }

    _findSupportResistance(window) {
        if (window.length < 10) {
            const price = window[window.length - 1];
            return { support: price * 0.98, resistance: price * 1.02 };
        }
        const min = Math.min(...window);
        const max = Math.max(...window);
        return { support: min, resistance: max };
    }

    // ---- feed() now accepts rawPrice ----
    feed(symbol, price, rawPrice) {
        const buf = this.buffers[symbol];
        buf.push(price);

        // Store raw price strings (keep last 10)
        const rawBuf = this.rawBuffers[symbol];
        rawBuf.push(rawPrice);
        if (rawBuf.length > 10) rawBuf.shift();

        if (buf.length > BUFFER_CLEANUP_THRESHOLD) {
            this.buffers[symbol] = buf.slice(-BUFFER_CAPACITY);
        }

        this.lastPrices[symbol] = price;

        const analysisWindow = Math.min(CONFIG.ANALYSIS_WINDOW, buf.length);
        if (analysisWindow < 50) {
            const result = {
                symbol, price,
                rawPrice: rawPrice,
                rawPrices: rawBuf.slice(), // copy
                formattedPrice: formatMarketPrice(symbol, price),
                risePct: 0, fallPct: 0,
                supportPct: 50, resistancePct: 50,
                rsi: 50,
                bbUpper: null, bbLower: null, bbMiddle: null,
                bandwidth: null,
                support: null, resistance: null,
                isBreakout: false, isBreakdown: false,
                step: 0, score: 0,
                volatility: 0,
                lastPrices: buf.slice(-5),
                tickDirections: [],
                lastDigit: null,
                digitMatrix: null,
                conditions: { breakout: false, rsi: false, bollinger: false, volatility: false, ma: false },
                maDiff: 0,
                maDiffExpanding: false,
                maDiffTwoTicksAgo: 0,
                maDiffExpanding2Tick: false
            };
            return result;
        }

        const window = buf.slice(-analysisWindow);
        let rises = 0, falls = 0;
        for (let i = 1; i < window.length; i++) {
            if (window[i] > window[i-1]) rises++;
            else if (window[i] < window[i-1]) falls++;
        }
        const risePct = (rises / window.length) * 100;
        const fallPct = (falls / window.length) * 100;

        const fastMA = this._sma(buf, 8);
        const slowMA = this._sma(buf, 21);
        const vol = this._volatility(buf, 20);
        const bb = this._bollinger(buf, CONFIG.BOLLINGER_PERIOD, CONFIG.BOLLINGER_STD);
        const rsi = this._rsi(buf, CONFIG.RSI_PERIOD, symbol);
        const sr = this._findSupportResistance(window);

        // ---- Bandwidth ----
        let bandwidth = null;
        if (bb.middle !== null && bb.middle !== 0) {
            bandwidth = ((bb.upper - bb.lower) / bb.middle) * 100;
        }

        // ---- S/R Position % ----
        let supportPct = 50;
        let resistancePct = 50;
        if (sr.support !== null && sr.resistance !== null && sr.resistance !== sr.support) {
            supportPct = ((price - sr.support) / (sr.resistance - sr.support)) * 100;
            supportPct = Math.min(100, Math.max(0, supportPct));
            resistancePct = 100 - supportPct;
        }

        // ---- MA diff (internal) ----
        let maDiff = 0;
        if (fastMA !== null && slowMA !== null) {
            maDiff = ((fastMA - slowMA) / price) * 100;
        }
        const history = this.diffHistory[symbol] || [];
        history.push(maDiff);
        if (history.length > 3) history.shift();
        this.diffHistory[symbol] = history;

        let maDiffTwoTicksAgo = 0;
        let maDiffExpanding2Tick = false;
        if (history.length >= 3) {
            const twoTicksAgo = history[history.length - 3];
            maDiffTwoTicksAgo = twoTicksAgo;
            if (Math.abs(maDiff) > Math.abs(twoTicksAgo)) {
                maDiffExpanding2Tick = true;
            }
        }

        let maDiffExpanding = false;
        if (history.length >= 2) {
            const prev = history[history.length - 2];
            if (Math.abs(maDiff) > Math.abs(prev)) {
                maDiffExpanding = true;
            }
        }

        // ---- Tick directions (last 5) ----
        const lastPrices = buf.slice(-6);
        const tickDirections = [];
        if (lastPrices.length >= 2) {
            for (let i = 1; i < lastPrices.length; i++) {
                const diff = lastPrices[i] - lastPrices[i-1];
                if (diff > 0) tickDirections.push(1);
                else if (diff < 0) tickDirections.push(-1);
                else tickDirections.push(0);
            }
            while (tickDirections.length > 5) tickDirections.shift();
        }

        // ---- Last digit from raw string ----
        const lastDigit = rawPrice ? parseInt(rawPrice[rawPrice.length - 1]) : null;

        // ---- Digit Matrix (only if enabled) ----
        let digitMatrix = null;
        if (this.computeDigits) {
            const digitCounts = Array(10).fill(0);
            window.forEach(p => {
                const str = p.toString();
                const d = parseInt(str[str.length - 1]);
                if (!isNaN(d)) digitCounts[d]++;
            });
            const totalTicks = window.length;
            digitMatrix = [];
            for (let d = 0; d <= 9; d++) {
                const matches = (digitCounts[d] / totalTicks) * 100;
                const differs = 100 - matches;
                let overCount = 0, underCount = 0;
                window.forEach(p => {
                    const str = p.toString();
                    const digit = parseInt(str[str.length - 1]);
                    if (!isNaN(digit)) {
                        if (digit > d) overCount++;
                        else if (digit < d) underCount++;
                    }
                });
                const overPct = (overCount / totalTicks) * 100;
                const underPct = (underCount / totalTicks) * 100;
                digitMatrix.push({
                    digit: d,
                    matches: matches,
                    differs: differs,
                    over: overPct,
                    under: underPct
                });
            }
        }

        // ---- Breakout conditions ----
        const isBreakout = sr.resistance ? price > sr.resistance * 1.001 : false;
        const isBreakdown = sr.support ? price < sr.support * 0.999 : false;

        const condBreakout = isBreakout;
        const condRSI = rsi >= 50 && rsi <= 85;
        const condBollinger = bb.upper !== null && price >= bb.upper * 0.999;
        const condVolatility = vol >= CONFIG.MIN_VOLATILITY_PERCENT;

        const condBreakdown = isBreakdown;
        const condRSIPut = rsi >= 15 && rsi <= 50;
        const condBollingerPut = bb.lower !== null && price <= bb.lower * 1.001;
        const condVolatilityPut = vol >= CONFIG.MIN_VOLATILITY_PERCENT;

        const callReady = condBreakout && condRSI && condBollinger && condVolatility;
        const putReady = condBreakdown && condRSIPut && condBollingerPut && condVolatilityPut;

        let step = 0, score = 0;
        if (callReady || putReady) {
            step = 3;
            score = vol;
        } else if ((condBreakout || condBreakdown) && (condRSI || condRSIPut) && (condBollinger || condBollingerPut)) {
            step = 2;
            score = vol * 0.5;
        } else if (sr.support || sr.resistance) {
            step = 1;
            score = vol * 0.3;
        }

        const result = {
            symbol, price,
            rawPrice: rawPrice,
            rawPrices: rawBuf.slice(), // copy last 10 raw strings
            formattedPrice: formatMarketPrice(symbol, price),
            risePct, fallPct,
            supportPct, resistancePct,
            rsi,
            bbUpper: bb.upper,
            bbLower: bb.lower,
            bbMiddle: bb.middle,
            bandwidth: bandwidth,
            support: sr.support,
            resistance: sr.resistance,
            isBreakout, isBreakdown,
            step, score,
            volatility: vol,
            lastPrices: buf.slice(-5),
            tickDirections: tickDirections,
            lastDigit: lastDigit,
            digitMatrix: digitMatrix,
            conditions: {
                breakout: condBreakout || condBreakdown,
                rsi: condRSI || condRSIPut,
                bollinger: condBollinger || condBollingerPut,
                volatility: condVolatility || condVolatilityPut,
                ma: true
            },
            condValues: {
                rsiValue: rsi,
                volValue: vol,
                maValue: maDiff
            },
            callReady, putReady,
            maDiff: maDiff,
            maDiffExpanding: maDiffExpanding,
            maDiffTwoTicksAgo: maDiffTwoTicksAgo,
            maDiffExpanding2Tick: maDiffExpanding2Tick
        };

        return result;
    }
}

module.exports = MultiMarketPipeline;
