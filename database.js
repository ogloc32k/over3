const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');  // This will now work because we added it

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

// Important: pass the WebSocket constructor to the Realtime client
const supabase = createClient(supabaseUrl, supabaseKey, {
  realtime: {
    transport: WebSocket
  }
});

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

  const profit_loss = isWin ? (payout - stake) : (payout - stake);

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
