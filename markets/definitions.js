/**
 * Single source of truth for Deriv Volatility Markets & Precision Rules
 */
const MARKETS = Object.freeze({
    'R_10':    { id: 'R_10',    name: 'Volatility 10 Index',       decimals: 3 },
    'R_25':    { id: 'R_25',    name: 'Volatility 25 Index',       decimals: 3 },
    'R_50':    { id: 'R_50',    name: 'Volatility 50 Index',       decimals: 4 },
    'R_75':    { id: 'R_75',    name: 'Volatility 75 Index',       decimals: 4 },
    'R_100':   { id: 'R_100',   name: 'Volatility 100 Index',      decimals: 2 },
    
    // 1-Second Indices
    '1HZ10V':  { id: '1HZ10V',  name: 'Volatility 10 (1s) Index',  decimals: 2 },
    '1HZ25V':  { id: '1HZ25V',  name: 'Volatility 25 (1s) Index',  decimals: 2 },
    '1HZ50V':  { id: '1HZ50V',  name: 'Volatility 50 (1s) Index',  decimals: 2 },
    '1HZ75V':  { id: '1HZ75V',  name: 'Volatility 75 (1s) Index',  decimals: 2 },
    '1HZ100V': { id: '1HZ100V', name: 'Volatility 100 (1s) Index', decimals: 2 }
});

/**
 * Returns decimal precision for a given symbol
 */
function getMarketDecimals(symbol) {
    return MARKETS[symbol]?.decimals ?? 2;
}

/**
 * Formats raw numeric price string to exact market precision
 */
function formatMarketPrice(symbol, rawPrice) {
    if (rawPrice === undefined || rawPrice === null || isNaN(rawPrice)) {
        return '0.00';
    }
    const decimals = getMarketDecimals(symbol);
    return Number(rawPrice).toFixed(decimals);
}

/**
 * Safely extracts the last digit of a tick price
 */
function extractLastDigit(symbol, rawPrice) {
    const formatted = formatMarketPrice(symbol, rawPrice);
    const lastChar = formatted.slice(-1);
    const digit = parseInt(lastChar, 10);
    return isNaN(digit) ? 0 : digit;
}

module.exports = { 
    MARKETS, 
    getMarketDecimals, 
    formatMarketPrice,
    extractLastDigit 
};
