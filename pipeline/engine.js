const { CONFIG } = require('../state/manager');
const { formatMarketPrice } = require('../markets/definitions');

const BUFFER_CAPACITY = 2000;
const BUFFER_CLEANUP_THRESHOLD = 2200;

class MultiMarketPipeline {
    constructor(symbols) {
        this.buffers = {};
        this.lastPrices = {};
        this.prevDiffs = {};   // store previous MA diff per symbol
        for (const symbol of symbols) {
            this.buffers[symbol] = [];
            this.lastPrices[symbol] = null;
            this.prevDiffs[symbol] = 0;
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

    _rsi(arr, period) {
        if (arr.length < period + 1) return 50;
        const slice = arr.slice(-period - 1);
        let gains = 0, losses = 0;
        for (let i = 1; i < slice.length; i++) {
            const diff = slice[i] - slice[i-1];
            if (diff >= 0) gains += diff;
            else losses += Math.abs(diff);
        }
        const avgGain = gains / period;
        const avgLoss = losses / period;
        if (avgLoss === 0) return 100;
        const rs = avgGain / avgLoss;
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
        const lookback = Math.min(50, window.length);
        if (lookback < 10) {
            const price = window[window.length - 1];
            return { support: price * 0.98, resistance: price * 1.02 };
        }
        const recent = window.slice(-lookback);
        const min = Math.min(...recent);
        const max = Math.max(...recent);
        return { support: min, resistance: max };
    }

    feed(symbol, price) {
        const buf = this.buffers[symbol];
        buf.push(price);

        if (buf.length > BUFFER_CLEANUP_THRESHOLD) {
            this.buffers[symbol] = buf.slice(-BUFFER_CAPACITY);
        }

        this.lastPrices[symbol] = price;

        const analysisWindow = Math.min(CONFIG.ANALYSIS_WINDOW, buf.length);
        if (analysisWindow < 50) {
            const result = {
                symbol, price,
                formattedPrice: formatMarketPrice(symbol, price),
                risePct: 0, fallPct: 0,
                rsi: 50,
                bbUpper: null, bbLower: null, bbMiddle: null,
                support: null, resistance: null,
                fastMA: null, slowMA: null,
                isBreakout: false, isBreakdown: false,
                step: 0, score: 0,
                volatility: 0,
                lastPrices: buf.slice(-5),
                conditions: { breakout: false, rsi: false, bollinger: false, volatility: false, ma: false },
                // New fields for strategy
                maDiff: 0,
                maDiffExpanding: false,
                maDiffPrevious: 0
            };
            this.prevDiffs[symbol] = 0;
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
        const rsi = this._rsi(buf, CONFIG.RSI_PERIOD);
        const sr = this._findSupportResistance(window);

        // ---- Compute MA diff and expansion ----
        let maDiff = 0;
        let maDiffExpanding = false;
        let maDiffPrevious = this.prevDiffs[symbol] || 0;
        if (fastMA !== null && slowMA !== null) {
            maDiff = ((fastMA - slowMA) / price) * 100; // percentage
            // Expansion: current diff is more positive (or more negative) than previous
            if (Math.abs(maDiff) > Math.abs(maDiffPrevious)) {
                maDiffExpanding = true;
            }
        }
        this.prevDiffs[symbol] = maDiff;

        const isBreakout = sr.resistance ? price > sr.resistance * 1.001 : false;
        const isBreakdown = sr.support ? price < sr.support * 0.999 : false;

        // ---- Legacy conditions (kept for backward compatibility) ----
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
            formattedPrice: formatMarketPrice(symbol, price),
            risePct, fallPct,
            rsi,
            bbUpper: bb.upper, bbLower: bb.lower, bbMiddle: bb.middle,
            fastMA, slowMA,
            support: sr.support, resistance: sr.resistance,
            isBreakout, isBreakdown,
            step, score,
            volatility: vol,
            lastPrices: buf.slice(-5),
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
                maValue: fastMA !== null && slowMA !== null ? ((fastMA - slowMA) / price * 100) : 0
            },
            callReady, putReady,
            // New strategy fields
            maDiff: maDiff,
            maDiffExpanding: maDiffExpanding,
            maDiffPrevious: maDiffPrevious
        };

        return result;
    }
}

module.exports = MultiMarketPipeline;
