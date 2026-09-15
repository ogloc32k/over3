// ============================================================
// Max drawdown against REAL account equity.
// ============================================================
// The drawdown curve tracks TRADING equity: (window-start equity)
// + cumulative P&L. It is continuous by construction, so external
// cash movements can never leak into it.
//
// `balance_after` anchors recorded on settled trades serve two
// purposes:
//   1. Calibrate the window-start equity (the first anchor fixes
//      the level for any legacy rows in front of it).
//   2. Detect cash moved in/out BETWEEN trades (deposits,
//      withdrawals): the mismatch between the expected trading
//      equity and the recorded balance is absorbed as an external
//      movement — never counted as trading P&L or drawdown.
// Without anchors (ledger predates the column) the window is
// seeded from the live account balance minus the window P&L.

function equityDrawdown(trades, opts = {}) {
  const liveBalance = Number(opts.liveBalance) || 0;

  let eq0 = null;     // window-start trading equity, once calibrated
  let eq  = null;     // trading equity after the previous row
  let cum = 0;        // cumulative P&L
  let externalCash = 0; // total external movement detected (reporting only)
  const cums = [];    // cumulative P&L after each row

  for (const t of (trades || [])) {
    const pnl  = Number(t.profit_loss) || 0;
    const rawB = t.balance_after;
    const B    = (rawB === null || rawB === undefined || rawB === '') ? null : Number(rawB);

    cum += pnl;

    if (B !== null && Number.isFinite(B)) {
      const pre = B - pnl;               // implied equity just before this trade
      if (eq === null) {
        // First anchor: retroactively fixes the level of all earlier rows.
        eq0 = pre - (cum - pnl);         // window-start trading equity
      } else {
        // Mismatch vs continuous trading equity = cash moved in/out.
        externalCash += (pre - eq);
      }
      eq = eq0 + cum;
    } else if (eq0 !== null) {
      eq = eq0 + cum;
    }
    cums.push(cum);
  }

  let startEquity;
  if (eq0 === null) {
    // No anchors at all (ledger predates balance_after): seed from
    // the live balance minus the window's total P&L.
    startEquity = Math.max(0, liveBalance - cum);
  } else {
    startEquity = eq0;
  }

  let peak = startEquity, maxAbs = 0, maxPct = 0;
  for (const c of cums) {
    const e = startEquity + c;
    if (e > peak) peak = e;
    const dip = Math.max(0, peak - e);
    if (dip > maxAbs) maxAbs = dip;
    if (peak > 0) {
      const pct = (dip / peak) * 100;
      if (pct > maxPct) maxPct = pct;
    }
  }
  return { maxDrawdownPct: maxPct, maxDrawdownAbs: maxAbs, startEquity, externalCash, anchored: eq0 !== null };
}

module.exports = { equityDrawdown };
