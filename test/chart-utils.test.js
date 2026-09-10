const test = require('node:test');
const assert = require('node:assert/strict');
const charts = require('../public/js/chart-utils');

test('normalizes numeric equity and drops malformed points', () => {
  const result = charts.normalizeEquityData([
    { timestamp: '2026-09-03T00:00:02Z', equity: '2.5' },
    { timestamp: 'bad', equity: 4 },
    { timestamp: '2026-09-03T00:00:01Z', equity: -1 },
    { timestamp: '2026-09-03T00:00:03Z', equity: 'nope' }
  ]);
  assert.deepEqual(result.map(point => point.equity), [-1, 2.5]);
});

test('downsampling keeps endpoints and the trend shape', () => {
  const input = Array.from({ length: 1000 }, (_, i) => ({ timestamp: i, equity: Math.sin(i / 50) }));
  const result = charts.downsampleEquityData(input, 40);
  assert.equal(result.length, 40);
  assert.equal(result[0].timestamp, 0);
  assert.equal(result.at(-1).timestamp, 999);
});

test('equity model controls labels and always includes a zero baseline', () => {
  const model = charts.buildEquityModel(
    Array.from({ length: 200 }, (_, i) => ({ timestamp: `2026-09-03T00:${String(i % 60).padStart(2, '0')}:00Z`, equity: i - 100 })),
    { width: 320, timeframe: '1w' }
  );
  assert.ok(model.points.length < 200);
  assert.ok(model.labels.filter(Boolean).length <= 7);
  assert.ok(model.scale.min < 0 && model.scale.max > 0);
});

test('empty and one-point histories are intentional states', () => {
  assert.equal(charts.buildEquityModel([]).hasData, false);
  const one = charts.buildEquityModel([{ timestamp: 1, equity: 0 }]);
  assert.equal(one.hasData, true);
  assert.equal(one.isSinglePoint, true);
  assert.equal(one.scale.min < 0 && one.scale.max > 0, true);
});