const MARKETS = {
    'R_10':  { id: 'R_10',  name: 'Volatility 10 Index' },
    'R_25':  { id: 'R_25',  name: 'Volatility 25 Index' },
    'R_50':  { id: 'R_50',  name: 'Volatility 50 Index' },
    'R_75':  { id: 'R_75',  name: 'Volatility 75 Index' },
    'R_100': { id: 'R_100', name: 'Volatility 100 Index' },
    // 1-Second indices – exact Deriv shortcodes
    '1HZ10V':  { id: '1HZ10V',  name: 'Volatility 10 (1s) Index' },
    '1HZ25V':  { id: '1HZ25V',  name: 'Volatility 25 (1s) Index' },
    '1HZ50V':  { id: '1HZ50V',  name: 'Volatility 50 (1s) Index' },
    '1HZ75V':  { id: '1HZ75V',  name: 'Volatility 75 (1s) Index' },
    '1HZ100V': { id: '1HZ100V', name: 'Volatility 100 (1s) Index' }
};

const MARKET_DECIMALS = {
    'R_10':    2,
    'R_25':    3,
    'R_50':    4,
    'R_75':    4,
    'R_100':   2,
    '1HZ10V':  2,
    '1HZ25V':  2,
    '1HZ50V':  2,
    '1HZ75V':  2,
    '1HZ100V': 2
};

function formatMarketPrice(symbol, rawPrice) {
    const decimals = MARKET_DECIMALS[symbol] || 2;
    return Number(rawPrice).toFixed(decimals);
}

module.exports = { MARKETS, MARKET_DECIMALS, formatMarketPrice };
