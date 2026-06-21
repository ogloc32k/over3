const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

// --- DEBUGGER: Verify Environment Variables ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

console.log("🔍 [DEBUG] Starting Database Initialization...");
console.log(`🔍 [DEBUG] SUPABASE_URL: ${SUPABASE_URL ? 'PRESENT' : 'MISSING'}`);
console.log(`🔍 [DEBUG] SUPABASE_KEY: ${SUPABASE_KEY ? 'PRESENT' : 'MISSING'}`);

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ [DEBUG] FATAL: Credentials missing!');
}

// --- Initialize with transport ---
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  realtime: {
    transport: WebSocket,
  },
});

// --- DEBUGGER: Verify Configuration ---
if (supabase.realtime && supabase.realtime.transport) {
    console.log("✅ [DEBUG] Realtime transport successfully configured.");
} else {
    console.error("❌ [DEBUG] FATAL: Realtime transport FAILED to configure.");
}

/**
 * Non-blocking, fire-and-forget background push.
 */
function saveTradeToCloud(tradeData) {
  console.log("🔍 [DEBUG] Attempting to save trade to cloud...");
  
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
        console.error('❌ [DEBUG] Cloud Ledger Insert Error:', error.message);
      } else {
        console.log(`✅ [DEBUG] Cloud Ledger Synced successfully.`);
      }
    })
    .catch(err => {
      console.error('❌ [DEBUG] Exception in saveTradeToCloud:', err.message);
    });
}

module.exports = { supabase, saveTradeToCloud };
