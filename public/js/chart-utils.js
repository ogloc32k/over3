// Chart data normalization kept framework-free so it can be tested in Node too.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.QuantCoreChartUtils = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function asTime(value) {
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : null;
  }

  function normalizeEquityData(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .map(point => ({
        timestamp: asTime(point?.timestamp),
        equity: Number(point?.equity)
      }))
      .filter(point => Number.isFinite(point.timestamp) && Number.isFinite(point.equity))
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  function downsampleEquityData(points, maxPoints = 80) {
    const source = normalizeEquityData(points);
    if (source.length <= maxPoints || maxPoints < 3) return source;
    const result = [source[0]];
    const stride = (source.length - 1) / (maxPoints - 1);
    for (let i = 1; i < maxPoints - 1; i++) {
      result.push(source[Math.round(i * stride)]);
    }
    result.push(source[source.length - 1]);
    return result;
  }

  function formatEquityLabel(timestamp, timeframe, index, total, maxLabels = 6) {
    if (!Number.isFinite(timestamp)) return '';
    if (total > maxLabels && index % Math.ceil(total / maxLabels) !== 0 && index !== total - 1) return '';
    const date = new Date(timestamp);
    if (timeframe === '1w' || timeframe === '1m' || timeframe === '1y') {
      return typeof window !== "undefined" && window.fmtTzDay ? window.fmtTzDay(timestamp) : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }
    return typeof window !== "undefined" && window.fmtTzHourMin ? window.fmtTzHourMin(timestamp) : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function getEquityScale(points) {
    const values = normalizeEquityData(points).map(point => point.equity);
    const maxAbs = Math.max(0, ...values.map(value => Math.abs(value)));
    const padding = maxAbs > 0 ? Math.max(maxAbs * 0.15, 0.05) : 1;
    return { min: Math.min(0, -maxAbs - padding), max: Math.max(0, maxAbs + padding) };
  }

  function buildEquityModel(raw, { width = 360, timeframe = '1w' } = {}) {
    const maxPoints = Math.max(12, Math.min(100, Math.floor(width / 4)));
    const points = downsampleEquityData(raw, maxPoints);
    return {
      points,
      labels: points.map((point, index) => formatEquityLabel(point.timestamp, timeframe, index, points.length)),
      scale: getEquityScale(points),
      hasData: points.length > 0,
      isSinglePoint: points.length === 1
    };
  }

  return { normalizeEquityData, downsampleEquityData, formatEquityLabel, getEquityScale, buildEquityModel };
});