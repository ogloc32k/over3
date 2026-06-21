const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// Create the client with 'realtime: false' to bypass the WebSocket/Node 20 issue.
// This forces the client to use standard HTTP(S) requests.
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  realtime: {
    enabled: false
  }
});

console.log("✅ [DEBUG] Database module loaded and client initialized (REST-only mode).");

/**
 * Non-blocking, fire-and-forget background push.
 */
function saveTradeToCloud(tradeData) {
  const netProfitLoss = tradeData.isWin 
    ? (tradeData.payout - tradeData.stake) 
    : -tradeData.stake;

  supabase
    .from('trading_ledger')
    .insert([{
      contract_id: tradeData.contract_id, // Added this field
      asset: tradeData.asset,
      contract_type: tradeData.contractType,
      stake: tradeData.stake,
      payout: tradeData.isWin ? tradeData.payout : 0,
      profit_loss: netProfitLoss,
      is_win: tradeData.isWin,
      barrier: tradeData.barrier ?? null,
      exit_tick: tradeData.exitTick ?? null
    }])
    .then(({ error }) => {
      if (error) console.error('❌ Cloud Ledger Insert Error:', error.message);
      else console.log(`✅ Cloud Ledger Synced.`);
    })
    .catch(err => console.error('❌ Exception in saveTradeToCloud:', err.message));
}

module.exports = { supabase, saveTradeToCloud };
