// config.js
const config = {
  derivAppId: process.env.DERIV_APP_ID,
  derivToken: process.env.DERIV_PAT,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_KEY,
  port: process.env.PORT || 3000
};

// Quick validation (won't crash, but logs warnings if missing)
if (!config.derivAppId) console.warn('⚠️ DERIV_APP_ID not set');
if (!config.derivToken) console.warn('⚠️ DERIV_PAT not set');
if (!config.supabaseUrl) console.warn('⚠️ SUPABASE_URL not set');
if (!config.supabaseKey) console.warn('⚠️ SUPABASE_KEY not set');

module.exports = config;
