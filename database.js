// database.js (excerpt)
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function saveTradeToCloud(trade) {
  const { 
    contract_id, 
    asset, 
    contractType, 
    stake, 
    payout, 
    isWin, 
    barrier, 
    exitTick, 
    entry_price, 
    exit_price, 
    duration_ticks 
  } = trade;

  const profit_loss = isWin ? (payout - stake) : (payout - stake); // same

  const { data, error } = await supabase
    .from('trading_ledger')
    .insert([
      {
        contract_id,
        asset,
        contract_type: contractType,
        stake,
        payout,
        is_win: isWin,
        profit_loss,
        barrier: barrier || null,
        exit_tick: exitTick || null,
        entry_price: entry_price || null,
        exit_price: exit_price || null,
        duration_ticks: duration_ticks || null,
        created_at: new Date().toISOString()
      }
    ]);

  if (error) {
    console.error('❌ Failed to save trade:', error);
  } else {
    console.log('✅ Trade saved to cloud:', contract_id);
  }
  return { data, error };
}

module.exports = { supabase, saveTradeToCloud };
