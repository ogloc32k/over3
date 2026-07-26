const MARKETS = {
    'R_10':  { id: 'R_10',  name: 'Volatility 10 Index' },
    'R_25':  { id: 'R_25',  name: 'Volatility 25 Index' },
    'R_50':  { id: 'R_50',  name: 'Volatility 50 Index' },
    'R_75':  { id: 'R_75',  name: 'Volatility 75 Index' },
    'R_100': { id: 'R_100', name: 'Volatility 100 Index' }
};

const MARKET_DECIMALS = {
    'R_10':  2,
    'R_25':  3,
    'R_50':  4,
    'R_75':  4,
    'R_100': 2
};

function formatMarketPrice(symbol, rawPrice) {
    const decimals = MARKET_DECIMALS[symbol] || 2;
    return Number(rawPrice).toFixed(decimals);
}

module.exports = { MARKETS, MARKET_DECIMALS, formatMarketPrice };
