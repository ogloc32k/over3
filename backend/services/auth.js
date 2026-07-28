// backend/services/auth.js
const logger = require('../logger');

/**
 * Wait for the Deriv client to emit 'authorized', then fetch balance.
 * @param {object} derivClient - The Deriv WebSocket client instance
 * @param {object} store - The global store (must have an updateState method)
 * @param {number} timeoutMs - Max wait time in ms (default 15000)
 * @returns {Promise<object>} The authorized account data
 */
function authenticate(derivClient, store, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const onAuthorized = (authData) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      // Now fetch full balance
      derivClient.once('balance', (balanceData) => {
        const balance = balanceData?.balance?.balance ?? null;
        const currency = balanceData?.balance?.currency ?? 'USD';
        const loginid = balanceData?.balance?.loginid ?? '';

        // Update the store
        if (store && typeof store.updateState === 'function') {
          store.updateState({
            balance: balance !== null ? parseFloat(balance) : null,
            currency,
            loginid,
            tradingMode: 'demo' // default; real mode can be set later
          });
        }

        logger.info(`Deriv authenticated: ${loginid} (${currency}) balance=${balance}`);
        resolve({ ...authData, balance, currency, loginid });
      });

      // Request balance
      derivClient.send({ balance: 1 });
    };

    // Listen for the 'authorized' event
    derivClient.on('authorized', onAuthorized);

    // Timeout
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      derivClient.off('authorized', onAuthorized);
      logger.error('Deriv authentication timed out');
      reject(new Error('Authentication timed out'));
    }, timeoutMs);
  });
}

module.exports = authenticate;
