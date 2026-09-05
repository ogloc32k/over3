// services/deriv.js – v15: proposal uses ONLY underlying_symbol
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
    this.isDemo = true;
    this._store = null;
    this._connecting = false;
    this._reconnectTimer = null;
    this._reconnectDelay = 1000;
    this._maxReconnectDelay = 30000;
    this._retryCount = 0;
    this._explicitClose = false;
    this._connectionState = 'disconnected';
    this._connectionReason = 'Deriv connection has not been established.';

    this._lastBuyParams = null;
    this._pendingTrades = {};
    this._pendingRequests = new Set();
  }

  setStore(storeInstance) { this._store = storeInstance; }

  _log(level, message) {
    if (this._store && typeof this._store.addLog === 'function') {
      this._store.addLog(level, message);
    } else {
      const fn = level === 'error' ? console.error : (level === 'warn' ? console.warn : console.log);
      fn(message);
    }
  }

  getConnectionState() { return this._connectionState; }
  isConnected() { return this._connectionState === 'connected' && this.ws?.readyState === WebSocket.OPEN; }

  _setConnectionState(state, reason) {
    this._connectionState = state;
    this._connectionReason = reason || this._connectionReason;
    this._emit('connection_state', {
      state,
      reason: this._connectionReason,
      at: Date.now()
    });
  }

  connect() {
    if (this._connecting) return;
    this._explicitClose = false;
    this._connecting = true;
    this._clearReconnectTimer();
    this._setConnectionState(this._retryCount > 0 ? 'recovering' : 'connecting',
      this._retryCount > 0 ? 'Recovering Deriv connection.' : 'Connecting to Deriv.');
    console.log(`🔵 connect() – isDemo = ${this.isDemo}`);
    this._connectViaOtp()
      .then(() => {
        console.log('✅ Connected to Deriv');
        this._log('info', `🔌 Deriv connection established (${this.isDemo ? 'DEMO' : 'REAL'} account).`);
        this._retryCount = 0;
        this._reconnectDelay = 1000;
      })
      .catch(err => {
        console.error('❌ Deriv connection failed:', err.message);
        this._log('error', `❌ Deriv connection failed: ${err.message}`);
        this._setConnectionState('recovering', `Deriv connection failed: ${err.message}`);
        this._scheduleReconnect();
      })
      .finally(() => {
        this._connecting = false;
      });
  }

  setMode(mode) {
    console.log(`🔵 setMode(${mode})`);
    this._log('info', `🔄 Switching Deriv account to ${mode === 'real' ? 'REAL' : 'DEMO'}.`);
    this.isDemo = (mode === 'real') ? false : true;
    this.activeAccountId = null;

    if (this._store) {
      this._store.updateState({
        tradingMode: this.isDemo ? 'demo' : 'real',
        balance: null
      });
    }

    this._disconnect(true);
    this._setConnectionState('disconnected', `Switching to ${mode === 'real' ? 'REAL' : 'DEMO'} account.`);
    this.accountId = null;
    this.connect();
  }

  requestHistory(symbol, start, end, count) {
    const req = { ticks_history: symbol, adjust_start_time: 1, style: 'ticks', granularity: 1 };
    if (count) req.count = count;
    else { req.start = start || Math.floor(Date.now()/1000)-3600; req.end = end || Math.floor(Date.now()/1000); }
    this.send(req);
  }

  // ----- Trade execution (async) -----
  async buyContract(params) {
    const tradeSymbol = params.symbol;
    if (!tradeSymbol) {
      console.error('❌ Cannot buy contract: symbol is missing from params', params);
      return null;
    }
    if (!this.isConnected()) {
      this._log('warn', '⛔ Trade blocked: Deriv connection is not ready.');
      return null;
    }

    this._lastBuyParams = {
      symbol: tradeSymbol,
      contract_type: params.contractType,
      stake: params.stake || 0,
      duration_ticks: params.duration,
      duration_unit: params.durationUnit || 't',
      bot_name: params.bot_name || 'manual'
    };

    // Step 1 – proposal (ONLY underlying_symbol, no symbol)
    const proposalReq = {
      proposal: 1,
      amount: params.stake,
      basis: 'stake',
      contract_type: params.contractType,
      currency: 'USD',
      duration: params.duration,
      duration_unit: params.durationUnit || 't',
      underlying_symbol: tradeSymbol       // <-- only this
    };

    console.log('📤 Sending proposal:', JSON.stringify(proposalReq));

    try {
      const proposal = await this._sendAndWait('proposal', proposalReq);
      console.log('📥 Proposal response:', JSON.stringify(proposal));

      if (!proposal || !proposal.proposal || !proposal.proposal.id) {
        console.error('❌ Invalid proposal response:', proposal);
        return null;
      }

      const proposalId = proposal.proposal.id;
      const buyReq = { buy: proposalId, price: params.stake };
      console.log('📤 Sending buy:', JSON.stringify(buyReq));

      const buyResult = await this._sendAndWait('buy', buyReq);
      console.log('📥 Buy response:', JSON.stringify(buyResult));

      if (!buyResult || !buyResult.buy || !buyResult.buy.contract_id) {
        console.error('❌ Invalid buy response:', buyResult);
        return null;
      }

      const contractId = buyResult.buy.contract_id;
      this._pendingTrades[contractId] = { ...this._lastBuyParams };
      this._lastBuyParams = null;

      this.send({
        proposal_open_contract: 1,
        contract_id: contractId,
        subscribe: 1
      });

      return contractId;
    } catch (err) {
      console.error('❌ Trade execution error:', err.message);
      this._log('error', `❌ Trade execution error: ${err.message}`);
      return null;
    } finally {
      this._lastBuyParams = null;
    }
  }

  _sendAndWait(msgType, payload) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.off(msgType, handler);
        this._pendingRequests.delete(request);
        fn(value);
      };
      const timeout = setTimeout(() => finish(reject, new Error(`${msgType} timeout`)), 15000);
      const handler = (data) => {
        finish(resolve, data);
      };
      const request = { reject: err => finish(reject, err) };
      this._pendingRequests.add(request);
      this.on(msgType, handler);
      if (!this.send(payload)) {
        finish(reject, new Error(`Deriv disconnected before ${msgType} request`));
      }
    });
  }

  _rejectPending(reason) {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    [...this._pendingRequests].forEach(request => request.reject(error));
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
    this._setConnectionState('connecting', 'Opening authenticated Deriv WebSocket.');
    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      this._setConnectionState('recovering', `Could not open Deriv WebSocket: ${err.message}`);
      this._scheduleReconnect();
      return;
    }
    this.ws.on('open', () => {
      console.log('🔌 WebSocket connected (authenticated)');
      this._log('info', `✅ WebSocket authenticated as ${this.accountId || 'unknown account'}.`);
      this._setConnectionState('connected', 'Deriv WebSocket authenticated.');
      this._emit('authorized', { loginid: this.accountId });
      this._subscribeTicks();
      this.send({ balance: 1, subscribe: 1 });
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
         this._emit('heartbeat', { at: Date.now(), msgType: msg.msg_type || null });
        this._handleMessage(msg);
      } catch (e) {
        console.error('❌ WS parse error:', e);
      }
    });

    this.ws.on('close', (code, reason) => {
      console.log(`⚠️ WS closed (${code}). Reason: ${reason?.toString()}`);
      this._log('warn', `⚠️ Deriv WebSocket closed (${code}); reconnect ${this._explicitClose ? 'not requested' : 'scheduled'}.`);
      this.ws = null;
      this._rejectPending(new Error('Deriv WebSocket closed while a request was pending'));
      if (!this._explicitClose) {
        this._setConnectionState('recovering', 'Deriv WebSocket disconnected; reconnecting.');
        this._scheduleReconnect();
      } else {
        this._setConnectionState('disconnected', 'Deriv WebSocket closed by request.');
      }
      this._explicitClose = false;
    });

    this.ws.on('error', (err) => {
      console.error('❌ WS error:', err.message);
      this._log('error', `❌ Deriv WebSocket error: ${err.message}`);
      this._setConnectionState('recovering', `Deriv WebSocket error: ${err.message}`);
    });
  }

  _disconnect(explicit = false) {
    this._explicitClose = explicit;
    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close();
      } catch (err) {
        this._log('warn', `⚠️ Error closing Deriv WebSocket: ${err.message}`);
      }
    }
    this._rejectPending(new Error('Deriv connection closed'));
    this.ws = null;
    if (explicit) {
      this._clearReconnectTimer();
      this._setConnectionState('disconnected', 'Deriv connection closed by request.');
    }
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._retryCount++;
    const delay = Math.min(this._reconnectDelay * Math.pow(2, this._retryCount - 1), this._maxReconnectDelay);
    console.log(`⏳ Reconnecting in ${delay/1000}s (attempt ${this._retryCount})`);
    this._log('warn', `⏳ Reconnecting to Deriv in ${delay/1000}s (attempt ${this._retryCount}).`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, delay);
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
  }

  _handleMessage(msg) {
    if (msg.error) {
      console.error('Deriv error:', msg.error);
      this._log('error', `❌ Deriv API error: ${msg.error.message || JSON.stringify(msg.error)}`);
      return;
    }

    if (msg.tick) { this._emit('tick', msg.tick); return; }
    if (msg.balance) { this._emit('balance', msg.balance); return; }
    if (msg.proposal) { this._emit('proposal', msg); return; }
    if (msg.buy) { this._emit('buy', msg); return; }

    if (msg.proposal_open_contract) {
      const settlement = msg.proposal_open_contract;
      if (settlement.is_sold === 1) {
        const contractId = settlement.contract_id;
        const pending = contractId ? this._pendingTrades[contractId] : null;
        if (pending) {
          delete this._pendingTrades[contractId];
          this._emit('trade_settled', {
            symbol: pending.symbol,
            contract_type: pending.contract_type,
            stake: pending.stake,
            duration_ticks: pending.duration_ticks,
            duration_unit: pending.duration_unit,
            bot_name: pending.bot_name || 'manual',
            contract_id: contractId,
            entry_price: settlement.entry_spot,
            exit_price: settlement.exit_spot,
            payout: settlement.payout,
            profit: settlement.profit,
            barrier: settlement.barrier,
            date_expiry: settlement.date_expiry,
          });
        }
      }
      return;
    }

    if (msg.history) { this._emit('history', msg.history); return; }

    if (msg.msg_type) {
      switch (msg.msg_type) {
        case 'tick': this._emit('tick', msg.tick); break;
        case 'balance': this._emit('balance', msg.balance); break;
        case 'proposal': this._emit('proposal', msg); break;
        case 'buy': this._emit('buy', msg); break;
        case 'history': this._emit('history', msg.history); break;
      }
    }
  }

  _subscribeTicks() {
    const symbols = ['R_10','R_25','R_50','R_75','R_100','1HZ10V','1HZ25V','1HZ50V','1HZ75V','1HZ100V'];
    symbols.forEach(s => this.send({ ticks: s, subscribe: 1 }));
    console.log('📊 Subscribed to ticks');
  }

  send(data) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(data));
      return true;
    } catch (err) {
      this._log('error', `❌ Deriv send failed: ${err.message}`);
      this._setConnectionState('recovering', `Deriv send failed: ${err.message}`);
      return false;
    }
  }
  on(e, cb) { if (!this.listeners[e]) this.listeners[e] = []; this.listeners[e].push(cb); }
  off(e, cb) { if (!this.listeners[e]) return; this.listeners[e] = this.listeners[e].filter(c => c !== cb); }
  _emit(e, d) {
    (this.listeners[e] || []).slice().forEach(cb => {
      try {
        const result = cb(d);
        if (result && typeof result.catch === 'function') {
          result.catch(err => this._log('error', `❌ Deriv ${e} listener failed: ${err.message}`));
        }
      } catch (err) {
        this._log('error', `❌ Deriv ${e} listener failed: ${err.message}`);
      }
    });
  }
}

const derivClient = new DerivClient();
module.exports = derivClient;
module.exports.DerivClient = DerivClient;
