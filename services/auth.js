// services/auth.js
// ============================================================
// Password gate for the dashboard. Activated only when
// DASHBOARD_PASSWORD is set (local/demo mode stays open).
// Cookie: HMAC token derived from the password — changing the
// password invalidates every existing session instantly.
// ============================================================
const crypto = require('crypto');

const COOKIE_NAME = 'qct_auth';

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a), 'hex');
  const bb = Buffer.from(String(b), 'hex');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function createGate(password) {
  const pwHash = sha256(password);
  // Token = HMAC(key: password-hash, msg: fixed label). Same password → same token.
  const token = crypto.createHmac('sha256', pwHash).update('qct-auth-v1').digest('hex');

  return {
    COOKIE_NAME,
    token,
    check(pw) { return pw !== undefined && pw !== null && safeEqualHex(sha256(pw), pwHash); },
    validCookie(value) { return value === token; }
  };
}

module.exports = { createGate, COOKIE_NAME };
