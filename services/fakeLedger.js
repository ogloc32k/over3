// services/fakeLedger.js
// ============================================================
// In-memory replacement for the Supabase client (fake-data mode).
// Implements the small slice of the query-builder API the server uses:
//   from(t).select().eq().gte().lte().order()  → { data, error }
//   from(t).insert(record)                     → { error }
// Trades are seeded with ~1 year of history so Analytics is alive
// on first load. Persists nothing — reset on restart by design.
// ============================================================

const LEDGER = [];

const SEED_SYMBOLS = ['R_10','R_25','R_50','R_75','R_100','1HZ10V','1HZ25V','1HZ50V','1HZ75V','1HZ100V'];
const SEED_STAKES = [0.35, 0.35, 0.5, 1, 2, 0.35, 0.35];

function seedLedger() {
  LEDGER.length = 0;
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  // ~300 trades over the last ~120 days, ~55% win rate, realistic payout.
  for (let i = 0; i < 300; i++) {
    const stake = SEED_STAKES[Math.floor(Math.random() * SEED_STAKES.length)];
    const win = Math.random() < 0.55;
    const createdAt = new Date(now - Math.random() * 120 * day - Math.random() * day);
    LEDGER.push({
      id: `seed-${i}`,
      asset: SEED_SYMBOLS[Math.floor(Math.random() * SEED_SYMBOLS.length)],
      contract_type: Math.random() < 0.5 ? 'CALL' : 'PUT',
      stake,
      payout: win ? Number((stake * 1.952).toFixed(2)) : 0,
      profit_loss: win ? Number((stake * 0.952).toFixed(2)) : -stake,
      is_win: win,
      barrier: null,
      exit_tick: null,
      entry_price: null,
      exit_price: null,
      duration_ticks: 70,
      bot_name: 'sniper-bot',
      account: 'demo',
      created_at: createdAt.toISOString()
    });
  }
  LEDGER.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}
seedLedger();

function makeQuery(rows) {
  const state = { rows };
  const q = {
    eq(field, value)      { state.rows = state.rows.filter(r => r[field] === value); return q; },
    gte(field, value)     { const v = new Date(value).getTime() || value; state.rows = state.rows.filter(r => new Date(r[field]).getTime() >= v); return q; },
    lte(field, value)     { const v = new Date(value).getTime() || value; state.rows = state.rows.filter(r => new Date(r[field]).getTime() <= v); return q; },
    order(field, opts)    { state.rows = [...state.rows].sort((a, b) => {
                             const av = a[field], bv = b[field];
                             const cmp = av < bv ? -1 : av > bv ? 1 : 0;
                             return (opts && opts.ascending === false) ? -cmp : cmp;
                           }); return q; },
    then(resolve, reject) {
      return Promise.resolve({ data: state.rows.map(r => ({ ...r })), error: null }).then(resolve, reject);
    }
  };
  return q;
}

const fakeSupabase = {
  __FAKE__: true,
  from(table) {
    if (table !== 'trading_ledger') {
      return { select: () => makeQuery([]), insert: async () => ({ error: null }) };
    }
    return {
      select() { return makeQuery(LEDGER); },
      insert(record) {
        const row = Array.isArray(record) ? record[0] : record;
        if (row && !row.created_at) row.created_at = new Date().toISOString();
        if (row && !row.id) row.id = `t-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        LEDGER.push({ ...row });
        return Promise.resolve({ error: null });
      }
    };
  }
};

module.exports = fakeSupabase;
