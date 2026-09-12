// test/midnight.test.js
// Timezone-aware midnight math + boot-restore decision logic.
const { DEFAULT_TZ, dayKey, getNextMidnight, resolveRestore } = require('../engine/midnight');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name} ${extra}`); }
}

console.log('midnight / daily-reset tests');

// --- getNextMidnight: Asia/Kolkata (IST = UTC+5:30) ---
const NOW = new Date('2026-09-12T10:00:00Z').getTime(); // 3:30 PM IST
const istMid = getNextMidnight('Asia/Kolkata', NOW);
check('IST next midnight is in the future', istMid > NOW);
check('IST next midnight within 24h', istMid - NOW <= 24 * 3600 * 1000);
const istWall = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(istMid));
check('IST midnight lands at 00:00 wall time', istWall.startsWith('00:00'), `got ${istWall}`);
const istUTC = new Date(istMid).toISOString();
check('IST midnight = 18:30 UTC (next day)', /T18:30:00/.test(istUTC), `got ${istUTC}`);

// The OLD EAT helper returned 21:00 UTC = 02:30 IST — must not happen anymore
check('IST midnight is NOT 02:30 IST (EAT bug)', !/T21:00:00/.test(istUTC));

// --- getNextMidnight: UTC ---
const utcMid = getNextMidnight('UTC', NOW);
check('UTC midnight = 00:00 UTC next day', new Date(utcMid).toISOString().startsWith('2026-09-13T00:00'), new Date(utcMid).toISOString());

// --- precision: within 1 second of true midnight ---
check('IST midnight within 1s precision', Math.abs((istMid % 60000)) < 1500 || (istMid % 60000) > 58500, String(istMid % 60000));

// --- dayKey ---
check('dayKey: same instant, different tz date (UTC vs Pacific at 01:00 UTC)',
  dayKey(new Date('2026-09-12T01:00:00Z'), 'UTC') !== dayKey(new Date('2026-09-12T01:00:00Z'), 'America/Los_Angeles'));

// --- resolveRestore: no snapshot ---
check('resolveRestore: no snapshot → none', resolveRestore(null, NOW).action === 'none');

// --- paused mid-day, midnight ahead → stay paused ---
const future = NOW + 3 * 3600 * 1000;
const pausedRes = resolveRestore({ at: NOW, active: false, botResetTime: future, dailyPnl: 1.5, sessionPnl: 1.5, sessionTradeCount: 4, lifecycleReason: 'Take-profit reached' }, NOW + 60 * 1000);
check('paused: action paused', pausedRes.action === 'paused');
check('paused: keeps countdown target', pausedRes.patch.botResetTime === future);
check('paused: keeps dailyPnl', pausedRes.patch.dailyPnl === 1.5);
check('paused: inactive', pausedRes.patch.active === false);

// --- midnight passed while offline mid-pause → fresh session ---
const staleRes = resolveRestore({ at: NOW, active: false, botResetTime: future, dailyPnl: 2, sessionTradeCount: 5 }, future + 3600 * 1000);
check('stale pause: action resume', staleRes.action === 'resume');
check('stale pause: dailyPnl reset for new session', staleRes.patch.dailyPnl === 0);
check('stale pause: bot active again', staleRes.patch.active === true);
check('stale pause: botResetTime cleared', staleRes.patch.botResetTime === null);

// --- was running, same day (quick redeploy) → resume, keep dailyPnl ---
const runRes = resolveRestore({ at: NOW, active: true, dailyPnl: 3.2, sessionTradeCount: 7, martingaleLevel: 2 }, NOW + 30 * 1000);
check('running restart: action resume', runRes.action === 'resume');
check('running restart: keeps same-day dailyPnl', runRes.patch.dailyPnl === 3.2, JSON.stringify(runRes.patch));

// --- was running, down across midnight → resume with fresh day ---
const dayAgo = NOW - 26 * 3600 * 1000;
const crossRes = resolveRestore({ at: dayAgo, active: true, dailyPnl: 5 }, NOW);
check('crossed-midnight restart: dailyPnl reset', crossRes.patch.dailyPnl === 0);
check('crossed-midnight restart: action resume', crossRes.action === 'resume');

// --- was idle → restore counters, stay idle ---
const idleRes = resolveRestore({ at: NOW, active: false, dailyPnl: 1.1, botResetTime: null }, NOW);
check('idle: action idle', idleRes.action === 'idle');
check('idle: stays inactive', idleRes.patch.active === false);

// --- virtual counters survive the day-crossing reset ---
const vcRes = resolveRestore({ at: dayAgo, active: true, botResetTime: future, virtualWinCount: 9, virtualLossCount: 4, virtualTradeCount: 13 }, future + 1000);
check('virtual counters preserved across session reset', vcRes.patch.virtualTradeCount === 13 && vcRes.patch.virtualWinCount === 9);


// --- DEFAULT timezone is East Africa Time (Africa/Nairobi, UTC+3) ---
const eatMid = getNextMidnight(undefined, NOW); // default tz
const eatUTC = new Date(eatMid).toISOString();
check('DEFAULT tz is Africa/Nairobi (00:00 EAT = 21:00 UTC)', /T21:00:00/.test(eatUTC), 'got ' + eatUTC);
check('DEFAULT tz midnight in the future', eatMid > NOW);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
