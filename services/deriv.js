// services/deriv.js
const WebSocket = require('ws');

// Load env vars directly – no config file needed
const DERIV_APP_ID = process.env.DERIV_APP_ID;
const DERIV_PAT = process.env.DERIV_PAT;

if (!DERIV_APP_ID || !DERIV_PAT) {
  console.error('❌ DERIV_APP_ID or DERIV_PAT missing in environment');
}

class DerivClient {
  constructor() {
    this.ws = null;
    this.listeners = {};
    this.accountId = null;
    this.pingInterval = null;
    this.isDemo = true;
    this._store = null;
    this._connecting = false;
  }

  setStore(storeInstance) { this._store = storeInstance; }

  connect() {
    if (this._connecting) return;
    this._connecting = true;
    console.log(`🔵 connect() – isDemo = ${this.isDemo}`);
    this._connectViaOtp()
      .then(() => console.log('✅ Connected to Deriv'))
      .catch(err => {
        console.error('❌ Deriv connection failed:', err.message);
      })
      .finally(() => {
        this._connecting = false;
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          setTimeout(() => this.connect(), 5000);
        }
      });
  }

  setMode(mode) {
    console.log(`🔵 setMode(${mode})`);
    this.isDemo = (mode === 'real') ? false : true;
    if (this._store) {
      this._store.updateState({ tradingMode: this.isDemo ? 'demo' : 'real' });
    }
    this._disconnect();
    this.accountId = null;
    this.connect();
  }

  _disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    clearInterval(this.pingInterval);
  }

  async _connectViaOtp() {
    if (!this.accountId) {
      const accounts = await this._fetchAccounts();
      const target = accounts.find(a => a.is_virtual === this.isDemo)
                     || accounts.find(a => a.is_virtual === true);
      if (!target) throw new Error('No accounts available');
      this.accountId = target.loginid;

      // ✅ Instant balance from account list
      this._emit('balance', {
        balance: target.balance,
        currency: target.currency || 'USD',
        loginid: target.loginid
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
      is_virtual: (acc.account_type === 'demo') || acc.is_virtual,
      balance: acc.balance,
      currency: acc.currency,
    }));
  }

  _openWebSocket(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.ws.on('open', () => {
      console.log('🔌 WebSocket connected (authenticated)');
      this.pingInterval = setInterval(() => this.send({ ping: 1 }), 30000);
      this._emit('authorized', { loginid: this.accountId });
      this.send({ balance: 1, subscribe: 1 });
      this._subscribeTicks();
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        console.log('📩 WS msg keys:', Object.keys(msg).join(', '));
        this._handleMessage(msg);
      } catch (e) {
        console.error('❌ WS parse error:', e);
      }
    });

    this.ws.on('close', (code, reason) => {
      console.log(`⚠️ WS closed (${code}). Reason: ${reason?.toString()}`);
      clearInterval(this.pingInterval);
      this.ws = null;
      if (!this._connecting) setTimeout(() => this.connect(), 5000);
    });

    this.ws.on('error', (err) => console.error('❌ WS error:', err.message));
  }

  _handleMessage(msg) {
    if (msg.error) return console.error('Deriv error:', msg.error);

    if (msg.balance) { this._emit('balance', msg.balance); return; }
    if (msg.tick) { this._emit('tick', msg.tick); return; }
    if (msg.proposal_open_contract) { this._emit('contract_result', msg.proposal_open_contract); return; }
    if (msg.buy) { this._emit('buy_result', msg.buy); return; }
    if (msg.history) { this._emit('history', msg.history); return; }

    if (msg.msg_type) {
      switch (msg.msg_type) {
        case 'balance': this._emit('balance', msg.balance); break;
        case 'tick': this._emit('tick', msg.tick); break;
        case 'proposal_open_contract': this._emit('contract_result', msg.proposal_open_contract); break;
        case 'buy': this._emit('buy_result', msg.buy); break;
        case 'history': this._emit('history', msg.history); break;
      }
    }
  }

  _subscribeTicks() {
    const symbols = ['R_10','R_25','R_50','R_75','R_100','1HZ10V','1HZ25V','1HZ50V','1HZ75V','1HZ100V'];
    symbols.forEach(s => this.send({ ticks: s, subscribe: 1 }));
    console.log('📊 Subscribed to ticks');
  }

  requestHistory(symbol, start, end, count) {
    const req = { ticks_history: symbol, adjust_start_time: 1, style: 'ticks', granularity: 1 };
    if (count) req.count = count;
    else { req.start = start || Math.floor(Date.now()/1000)-3600; req.end = end || Math.floor(Date.now()/1000); }
    this.send(req);
  }

  buyContract(params) {
    this.send({
      buy: params.contractId || 1, price: params.stake,
      parameters: {
        amount: params.stake, basis: 'stake', contract_type: params.contractType,
        currency: 'USD', duration: params.duration, duration_unit: params.durationUnit || 't', symbol: params.symbol
      }
    });
  }

  send(data) { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(data)); }
  on(e, cb) { if (!this.listeners[e]) this.listeners[e] = []; this.listeners[e].push(cb); }
  off(e, cb) { if (!this.listeners[e]) return; this.listeners[e] = this.listeners[e].filter(c => c !== cb); }
  _emit(e, d) { (this.listeners[e] || []).forEach(cb => cb(d)); }
}

module.exports = new DerivClient();
