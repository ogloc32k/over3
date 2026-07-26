/**
 * Momentum Bot – trades CALL/PUT based on RSI and Bollinger breakout.
 */
module.exports = {
    id: 'momentum_v1',
    name: 'Momentum Breakout',
    description: 'Enters CALL when price breaks above upper band and RSI > 50; PUT when breaks below lower band and RSI < 50.',
    allow_reconfigure: true,
    config: {
        min_volatility: 0.3,
        duration_seconds: 15
    },
    evaluate(marketData, config, state) {
        const { symbol, price, volatility, rsi, bbUpper, bbLower, isBreakout, isBreakdown } = marketData;

        if (volatility < config.min_volatility) return null;

        let proposal = null;
        let score = volatility;

        if (isBreakout && bbUpper && price >= bbUpper * 0.999 && rsi >= 50 && rsi <= 85) {
            proposal = {
                contract_type: 'CALL',
                symbol: symbol,
                amount: config.base_stake || 1.0,
                basis: 'stake',
                duration: config.duration_seconds || 15,
                duration_unit: 's',
                score: score
            };
        } else if (isBreakdown && bbLower && price <= bbLower * 1.001 && rsi >= 15 && rsi <= 50) {
            proposal = {
                contract_type: 'PUT',
                symbol: symbol,
                amount: config.base_stake || 1.0,
                basis: 'stake',
                duration: config.duration_seconds || 15,
                duration_unit: 's',
                score: score
            };
        }

        // You can also store per‑bot state (e.g., last trade time) in the `state` object
        if (proposal) {
            // Example: update state
            state.lastSignal = Date.now();
        }
        return proposal;
    }
};
