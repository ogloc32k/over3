/**
 * Duration utilities — single source of truth for contract duration rules.
 *
 * Deriv's API schema allows duration_unit t/s/m/h/d, but the actual numeric
 * range is per-symbol and only served live via the `contracts_for` call.
 * Until the live ranges are fetched we clamp against Deriv's documented
 * fallbacks for the synthetic/volatility indices:
 *   ticks 1–10 · seconds 15–60 · minutes 1–60
 */
'use strict';

const FALLBACK_RANGES = {
  t: [1, 10],
  s: [15, 60],
  m: [1, 60]
};

const UNIT_LABELS = {
  t: 'ticks',
  s: 'seconds',
  m: 'minutes'
};

function normalizeUnit(unit) {
  return Object.prototype.hasOwnProperty.call(FALLBACK_RANGES, unit) ? unit : 't';
}

/**
 * Resolve the valid [min, max] range for a symbol + unit.
 * `liveRanges` is the per-symbol map fetched from Deriv (contracts_for):
 *   { 'R_100': { t: [1, 10], s: [15, 60], m: [1, 60] }, ... }
 * Falls back to the documented defaults when live data is unavailable.
 */
function rangeFor(liveRanges, symbol, unit) {
  const u = normalizeUnit(unit);
  const live = liveRanges && liveRanges[symbol] && liveRanges[symbol][u];
  if (Array.isArray(live) && live.length === 2 && Number.isFinite(live[0]) && Number.isFinite(live[1])) {
    return { min: live[0], max: live[1], live: true };
  }
  return { min: FALLBACK_RANGES[u][0], max: FALLBACK_RANGES[u][1], live: false };
}

/**
 * Clamp a duration quantity into its valid range.
 * Returns { duration, unit, clamped, min, max, live }.
 */
function clampDuration(duration, unit, liveRanges, symbol) {
  const u = normalizeUnit(unit);
  const { min, max, live } = rangeFor(liveRanges, symbol, u);
  let value = parseInt(duration, 10);
  if (!Number.isFinite(value)) value = min;
  let clamped = false;
  if (value < min) { value = min; clamped = true; }
  if (value > max) { value = max; clamped = true; }
  return { duration: value, unit: u, clamped, min, max, live };
}

/** Human sentence for logs/UI, e.g. "R_100 ticks range 1–10". */
function describeRange(symbol, unit, liveRanges) {
  const { min, max, live } = rangeFor(liveRanges, symbol, unit);
  return `${symbol} ${UNIT_LABELS[normalizeUnit(unit)]} range ${min}–${max}${live ? ' (live)' : ''}`;
}

/**
 * Approximate how many feed ticks a duration spans for a symbol.
 * Deriv synthetic indices tick every 2s (R_* series) or 1s (1HZ series).
 * Used by the virtual filter and the demo simulator to settle
 * seconds/minutes contracts after the right elapsed time.
 */
const TICK_INTERVALS = { standard: 2000, oneSecond: 1000 };
function durationToTicks(duration, unit, symbol) {
  const u = normalizeUnit(unit);
  const qty = parseInt(duration, 10) || 1;
  if (u === 't') return Math.max(1, qty);
  const intervalMs = /^1HZ/.test(symbol) ? TICK_INTERVALS.oneSecond : TICK_INTERVALS.standard;
  const seconds = u === 's' ? qty : qty * 60;
  return Math.max(1, Math.ceil(seconds * 1000 / intervalMs));
}

module.exports = { FALLBACK_RANGES, UNIT_LABELS, normalizeUnit, rangeFor, clampDuration, describeRange, durationToTicks };
