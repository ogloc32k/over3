const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');                    // <-- Add this
require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// Create client with explicit WebSocket transport
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  realtime: {
    transport: ws,                          // <-- Provide ws package
    enabled: false                          // Keep it disabled (optional)
  }
});

console.log("✅ [DEBUG] Database module loaded (REST-only mode with ws transport).");

function saveTradeToCloud(tradeData) {
  const netProfitLoss = tradeData.isWin 
    ? (tradeData.payout - tradeData.stake) 
    : -tradeData.stake;

  supabase
    .from('trading_ledger')
    .insert([{
      contract_id: tradeData.contract_id,
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
