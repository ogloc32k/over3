const { createClient } = require('@supabase/supabase-js');

// No more secrets in your code! Node.js pulls these from the server environment.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// Fail-safe check: If you forget to set the variables, the server warns you immediately
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ CRITICAL ERROR: Database credentials are missing from environment variables!');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/**
 * Non-blocking, fire-and-forget background push to the cloud database server.
 */
function saveTradeToCloud(tradeData) {
  const netProfitLoss = tradeData.isWin 
    ? (tradeData.payout - tradeData.stake) 
    : -tradeData.stake;

  supabase
    .from('trading_ledger')
    .insert([{
      asset: tradeData.asset,
      contract_type: tradeData.contractType,
      stake: tradeData.stake,
      payout: tradeData.isWin ? tradeData.payout : 0,
      profit_loss: netProfitLoss,
      is_win: tradeData.isWin,
      barrier: tradeData.barrier !== undefined ? tradeData.barrier : null,
      exit_tick: tradeData.exitTick !== undefined ? tradeData.exitTick : null
    }])
    .then(({ error }) => {
      if (error) {
        console.error('⚠️ Cloud Ledger Link Error:', error.message);
      } else {
        console.log(`✅ Cloud Ledger Synced | Net Margin: $${netProfitLoss.toFixed(2)}`);
      }
    })
    .catch(err => {
      console.error('⚠️ Network Exception on Ledger Channel:', err.message);
    });
}

module.exports = { saveTradeToCloud };
