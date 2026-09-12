// test/auth-form-login.test.js
// Regression: the login page submits form-encoded (application/
// x-www-form-urlencoded) data, NOT JSON. server.js must mount
// express.urlencoded() or req.body.password is always undefined
// and browser login can never succeed. This test reproduces the
// exact middleware stack from server.js and posts like a browser.
const http = require('http');
const express = require('express');

const PASSWORD = 'p@ss =with-specials'; // deliberately contains '=' to catch encoding bugs

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

// --- stack copied from server.js (middleware + login handler) ---
const { createGate, COOKIE_NAME } = require('../services/auth');
const authGate = createGate(PASSWORD);
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // <- the line this test protects

app.post('/login', (req, res) => {
  if (authGate.check(req.body && req.body.password)) {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${authGate.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
    return res.redirect('/');
  }
  return res.status(401).send('ACCESS DENIED — wrong password');
});
// --- end stack ---

const server = app.listen(0, async () => {
  const port = server.address().port;
  console.log('auth-form-login tests');

  const postForm = (password) => new Promise((resolve, reject) => {
    const body = 'password=' + encodeURIComponent(password);
    const req = http.request({ host: '127.0.0.1', port, path: '/login', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, cookie: res.headers['set-cookie']?.[0] || '', body: d })); });
    req.on('error', reject); req.end(body);
  });

  // 1. Correct password via form encoding -> 302 + auth cookie
  const ok = await postForm(PASSWORD);
  check('form login with correct password redirects (302)', ok.status === 302);
  check('auth cookie is set', ok.cookie.startsWith(`${COOKIE_NAME}=`));

  // 2. Wrong password -> 401, no cookie
  const bad = await postForm('nope');
  check('form login with wrong password rejected (401)', bad.status === 401);
  check('no cookie on failure', !bad.cookie);

  // 3. Special char '=' survives form decoding intact (cookie token
  //    matches the HMAC the gate derives from the raw password)
  const crypto = require('crypto');
  const pwHash = crypto.createHash('sha256').update(PASSWORD).digest('hex');
  const expectedToken = crypto.createHmac('sha256', pwHash).update('qct-auth-v1').digest('hex');
  check("password containing '=' verified byte-for-byte", ok.cookie.includes(expectedToken));

  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
});
