// services/supabase.js
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('[SUPABASE] ❌ Missing SUPABASE_URL or SUPABASE_KEY environment variables');
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Connection test (fire‑and‑forget)
(async () => {
  try {
    // Simple query to verify connectivity
    const { data, error } = await supabase.from('trading_ledger').select('id', { count: 'exact', head: true });
    if (error) throw error;
    console.log('[SUPABASE] ✅ Connected to database successfully');
  } catch (err) {
    console.error('[SUPABASE] ❌ Connection error:', err.message);
  }
})();

module.exports = supabase;
