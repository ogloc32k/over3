// services/cloudStore.js
// ============================================================
// Cloud KV persistence for bot config & active state.
// Uses the active Supabase client (real in live mode, the
// in-memory fake in demo mode) so state survives container
// restarts / redeploys without a persistent disk.
// Table: bot_store (key text pk, value jsonb)
// ============================================================

let _client = null;

const TABLE = 'bot_store';

module.exports = {
  init(client) { _client = client; },
  get available() { return !!_client; },

  async get(key) {
    if (!_client) return null;
    const { data, error } = await _client.from(TABLE)
      .select('value')
      .eq('key', key)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? data.value : null;
  },

  async set(key, value) {
    if (!_client) return false;
    const { error } = await _client.from(TABLE)
      .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    if (error) throw new Error(error.message);
    return true;
  }
};
