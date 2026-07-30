// services/deriv.js
const WebSocket = require('ws');

const DERIV_APP_ID = process.env.DERIV_APP_ID;
const DERIV_PAT = process.env.DERIV_PAT;

if (!DERIV_APP_ID || !DERIV_PAT) {
  console.error('❌ DERIV_APP_ID or DERIV_PAT missing');
}

class DerivClient {
  constructor() {
    this.ws = null;
    this.listeners = {};
    this.accountId = null;
    this.activeAccountId = null;
    this.pingInterval = null;
    this.isDemo = true;
    this._store = null;
    this._connecting = false;
    this._reconnectTimer = null;
    this._reconnectDelay = 1000;
    this._maxReconnectDelay = 30000;
    this._retryCount = 0;
    this._explicitClose = false;

    // trade tracking
    this._lastBuyParams = null;
    this._pendingTrades = {};
  }

  setStore(storeInstance) { this._store = storeInstance; }

  connect() {
    if (this._connecting) return;
    this._connecting = true;
    this._clearReconnectTimer();
    console.log(`🔵 connect() – isDemo = ${this.isDemo}`);
    this._connectViaOtp()
      .then(() => {
        console.log('✅ Connected to Deriv');
        this._retryCount = 0;
        this._reconnectDelay = 1000;
      })
      .catch(err => {
        console.error('❌ Deriv connection failed:', err.message);
        this._scheduleReconnect();
      })
      .finally(() => {
        this._connecting = false;
      });
  }

  setMode(mode) {
    console.log(`🔵 setMode(${mode})`);
    this.isDemo = (mode === 'real') ? false : true;
    this.activeAccountId = null;

    if (this._store) {
      this._store.updateState({
        tradingMode: this.isDemo ? 'demo' : 'real',
        balance: null   // clear stale balance during transition
      });
    }

    this._disconnect(true);
    this.accountId = null;
    this.connect();
  }

  requestHistory(symbol, start, end, count) {
    const req = { ticks_history: symbol, adjust_start_time: 1, style: 'ticks', granularity: 1 };
    if (count) req.count = count;
    else { req.start = start || Math.floor(Date.now()/1000)-3600; req.end = end || Math.floor(Date.now()/1000); }
    this.send(req);
  }

  buyContract(params) {
    this._lastBuyParams = {
      symbol: params.symbol,
      contract_type: params.contractType,
      stake: params.stake || 0,
      duration_ticks: params.duration,
      duration_unit: params.durationUnit || 't',
      bot_name: params.bot_name || 'manual'
    };

    this.send({
      buy: params.contractId || 1,
      price: params.stake,
      parameters: {
        amount: params.stake,
        basis: 'stake',
        contract_type: params.contractType,
        currency: 'USD',
        duration: params.duration,
        duration_unit: params.durationUnit || 't',
        symbol: params.symbol
      }
    });
  }

  // ---------- INTERNAL ----------

  async _connectViaOtp() {
    if (!this.accountId) {
      const accounts = await this._fetchAccounts();
      const target = accounts.find(a => a.is_virtual === this.isDemo)
                     || accounts.find(a => a.is_virtual === true);
      if (!target) throw new Error('No accounts available');

      this.accountId = target.loginid;
      this.activeAccountId = target.loginid;

      // ✅ Emit balance immediately (fixes the “---” balance)
      this._emit('balance', {
        balance: target.balance,
        currency: target.currency || 'USD',
        loginid: target.loginid,
        isDemo: this.isDemo
      });
      console.log(`🔑 Account: ${this.accountId} balance=${target.balance}`);
    }

    const otpUrl = `https://api.derivws.com/trading/v1/options/accounts/${this.accountId}/otp`;
    const otpResp = await fetch(otpUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DERIV_PAT}`,
        'Deriv-App-ID': DERIV_APP_ID,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    });

    const otpText = await otpResp.text();
    if (!otpResp.ok || otpText.startsWith('<!DOCTYPE')) throw new Error(`OTP failed: ${otpResp.status}`);
    const data = JSON.parse(otpText);
    if (data.errors) throw new Error('OTP API error: ' + JSON.stringify(data.errors));

    const wsUrl = data.data?.url || data.websocket_url;
    if (!wsUrl) throw new Error('No WebSocket URL');
    this._openWebSocket(wsUrl);
  }

  async _fetchAccounts() {
    const url = 'https://api.derivws.com/trading/v1/options/accounts';
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${DERIV_PAT}`, 'Deriv-App-ID': DERIV_APP_ID }
    });
    const text = await resp.text();
    if (!resp.ok || text.startsWith('<!DOCTYPE')) throw new Error(`Accounts failed: ${resp.status}`);
    const json = JSON.parse(text);
    if (json.errors) throw new Error('Accounts error: ' + JSON.stringify(json.errors));
    const raw = json.data || json.accounts;
    if (!Array.isArray(raw) || raw.length === 0) throw new Error('No accounts');
    return raw.map(acc => ({
      loginid: acc.account_id || acc.loginid,
      is_virtual: !!(acc.account_type === 'demo' || acc.is_virtual),
      balance: acc.balance,
      currency: acc.currency,
    }));
  }

  _openWebSocket(wsUrl) {
    this._disconnect(false);
    this.ws = new WebSocket(wsUrl);
    this.ws.on('open', () => {
      console.log('🔌 WebSocket connected (authenticated)');
      this.pingInterval = setInterval(() => this.send({ ping: 1 }), 30000);
      this._emit('authorized', { loginid: this.accountId });
      this._subscribeTicks();
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        this._handleMessage(msg);
      } catch (e) {
        console.error('❌ WS parse error:', e);
      }
    });

    this.ws.on('close', (code, reason) => {
      console.log(`⚠️ WS closed (${code}). Reason: ${reason?.toString()}`);
      clearInterval(this.pingInterval);
      this.ws = null;
      if (!this._explicitClose) {
        this._scheduleReconnect();
      }
      this._explicitClose = false;
    });

    this.ws.on('error', (err) => console.error('❌ WS error:', err.message));
  }

  _disconnect(explicit = false) {
    this._explicitClose = explicit;
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    clearInterval(this.pingInterval);
    if (explicit) this._clearReconnectTimer();
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._retryCount++;
    const delay = Math.min(this._reconnectDelay * Math.pow(2, this._retryCount - 1), this._maxReconnectDelay);
    console.log(`⏳ Reconnecting in ${delay/1000}s (attempt ${this._retryCount})`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, delay);
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  _handleMessage(msg) {
    if (msg.error) {
      console.error('Deriv error:', msg.error);
      return;
    }

    if (msg.ping) {
      this.send({ pong: 1 });
      return;
    }

    if (msg.balance) { this._emit('balance', msg.balance); return; }
    if (msg.tick) { this._emit('tick', msg.tick); return; }
    if (msg.proposal_open_contract) {
      this._emit('contract_result', msg.proposal_open_contract);
      return;
    }
    if (msg.buy) { this._emit('buy_result', msg.buy); return; }
    if (msg.history) { this._emit('history', msg.history); return; }

    if (msg.msg_type) {
      switch (msg.msg_type) {
        case 'balance': this._emit('balance', msg.balance); break;
        case 'tick': this._emit('tick', msg.tick); break;
        case 'proposal_open_contract': this._emit('contract_result', msg.proposal_open_contract); break;
        case 'buy': this._emit('buy_result', msg.buy); break;
        case 'history': this._emit('history', msg.history); break;
        case 'ping': this.send({ pong: 1 }); break;
      }
    }
  }

  _subscribeTicks() {
    const symbols = ['R_10','R_25','R_50','R_75','R_100','1HZ10V','1HZ25V','1HZ50V','1HZ75V','1HZ100V'];
    symbols.forEach(s => this.send({ ticks: s, subscribe: 1 }));
    console.log('📊 Subscribed to ticks');
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(data));
  }
  on(e, cb) { if (!this.listeners[e]) this.listeners[e] = []; this.listeners[e].push(cb); }
  off(e, cb) { if (!this.listeners[e]) return; this.listeners[e] = this.listeners[e].filter(c => c !== cb); }
  _emit(e, d) { (this.listeners[e] || []).forEach(cb => cb(d)); }
}

module.exports = new DerivClient();
