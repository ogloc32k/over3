// config.js
const config = {
  derivAppId: process.env.DERIV_APP_ID,
  derivToken: process.env.DERIV_PAT,
  derivRestUrl: 'https://api.deriv.com',         // REST base
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_KEY,
  port: process.env.PORT || 3000
};

console.log('DERIV_APP_ID:', config.derivAppId || '❌ MISSING');
console.log('DERIV_PAT length:', config.derivToken ? config.derivToken.length : '❌ MISSING');

module.exports = config;
