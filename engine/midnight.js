// engine/midnight.js
// ============================================================
// Timezone-aware "midnight" math for the daily session reset.
// Midnight here = daily session reset. Configurable IANA timezone
// (BOT_TIMEZONE env or config key); default East Africa Time.
//
// Also hosts resolveRestore(): the pure decision logic used at
// boot to bring the bot back to where it was before a restart.
// ============================================================

// Alex is on East Africa Time (UTC+3, no DST) — VPN egress points at
// India, so never guess the tz from IP; keep this explicit.
const DEFAULT_TZ = 'Africa/Nairobi';

const _dayFmtCache = new Map();
function dayFormatter(tz) {
  if (!_dayFmtCache.has(tz)) {
    _dayFmtCache.set(tz, new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
    }));
  }
  return _dayFmtCache.get(tz);
}

// Wall-calendar key of an instant in a timezone, e.g. "2026-09-12".
// The key changes exactly when the wall clock crosses 00:00.
function dayKey(date, tz = DEFAULT_TZ) {
  return dayFormatter(tz).format(date instanceof Date ? date : new Date(date));
}

// First instant of the NEXT calendar day in the given timezone.
// Binary search over the next 48h for the point where the
// tz wall-date differs from today's wall-date (±1s precision).
// Correct across DST shifts: the wall date only changes at 00:00.
function getNextMidnight(tz = DEFAULT_TZ, now = Date.now()) {
  const fmt = dayFormatter(tz);
  const nowKey = fmt.format(new Date(now));
  let lo = now, hi = now + 48 * 3600 * 1000; // wall date at hi is guaranteed to differ
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2);
    if (fmt.format(new Date(mid)) !== nowKey) hi = mid; else lo = mid;
  }
  return hi;
}

// ------------------------------------------------------------
// BOOT-TIME RESTORE — decide what to do with a saved snapshot
// ------------------------------------------------------------
// Fields worth carrying across restarts; everything else in the
// snapshot (balance, ticks, SSE bandwidth) is session-scoped.
const COUNTER_KEYS = [
  'dailyPnl', 'sessionPnl', 'sessionTradeCount',
  'virtualWinCount', 'virtualLossCount', 'virtualTradeCount', 'virtualLossStreak',
  'executionMode', 'martingaleLevel', 'currentStake', 'martingaleNextStake'
];

function pickCounters(src = {}) {
  const out = {};
  for (const k of COUNTER_KEYS) {
    if (src[k] !== undefined && src[k] !== null) out[k] = src[k];
  }
  return out;
}

// Returns one of:
//   { action: 'none' }                     — nothing to restore
//   { action: 'paused', patch }             — mid TP/SL pause, still waiting for midnight
//   { action: 'resume', patch }             — was running (or midnight passed while
//                                             offline); arm a fresh session
//   { action: 'idle', patch }               — was stopped; restore counters, stay idle
function resolveRestore(rt = {}, now = Date.now(), tz = DEFAULT_TZ) {
  if (!rt || typeof rt !== 'object') return { action: 'none' };

  const counters = pickCounters(rt);
  const newDay   = rt.at && dayKey(rt.at, tz) !== dayKey(now, tz);

  // 1. Paused for the day (TP/SL) and midnight still ahead → resume the pause,
  //    countdown and all. The 1s reset loop re-arms when the moment arrives.
  if (rt.botResetTime && rt.botResetTime > now) {
    return {
      action: 'paused',
      patch: {
        ...counters,
        active: false,
        tradeInProgress: false,
        botResetTime: rt.botResetTime
      }
    };
  }

  // 2. Midnight passed while the server was down, OR the bot was running.
  //    Both start a fresh session. Counters reset when a day boundary
  //    was crossed (offline across midnight), otherwise daily P&L survives.
  const wasMidPause = !!rt.botResetTime;
  if (wasMidPause || rt.active === true) {
    const crossedDay = wasMidPause || newDay;
    return {
      action: 'resume',
      patch: {
        active: true,
        tradeInProgress: false,
        botResetTime: null,
        ...(crossedDay
          ? {
              dailyPnl: 0, sessionPnl: 0, sessionTradeCount: 0,
              virtualWinCount: rt.virtualWinCount || 0,
              virtualLossCount: rt.virtualLossCount || 0,
              virtualTradeCount: rt.virtualTradeCount || 0
            }
          : counters)
      }
    };
  }

  // 3. Bot was idle/stopped → restore counters for continuity, stay idle.
  return { action: 'idle', patch: { ...counters, active: false, tradeInProgress: false, botResetTime: null } };
}

module.exports = { DEFAULT_TZ, dayKey, getNextMidnight, resolveRestore, COUNTER_KEYS };
