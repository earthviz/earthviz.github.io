import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePeriods, snapTime, stepTime, formatGibsTime, gaiaTileUrl } from '../src/gibs-catalog.js';

const d = s => Date.parse(`${s}T00:00:00Z`);

test('parses daily, monthly and intraday periods', () => {
  const [daily] = parsePeriods(['2012-05-08/2013-05-29/P1D']);
  assert.equal(daily.ms, 86400000);
  const [monthly] = parsePeriods(['2000-01-01/2020-12-01/P1M']);
  assert.equal(monthly.months, 1);
  const [fast] = parsePeriods(['2023-01-01T00:00:00Z/2023-01-02T00:00:00Z/PT10M']);
  assert.ok(fast.intraday);
  assert.equal(fast.ms, 600000);
});

test('steps across ranges and clamps at the ends', () => {
  const periods = parsePeriods(['2020-01-01/2020-01-03/P1D,2020-02-01/2020-02-02/P1D']);
  assert.equal(formatGibsTime(stepTime(d('2020-01-03'), periods, 1)), '2020-02-01');
  assert.equal(formatGibsTime(stepTime(d('2020-02-01'), periods, -1)), '2020-01-03');
  assert.equal(stepTime(d('2020-01-01'), periods, -1), d('2020-01-01'));
});

test('monthly stepping and snapping', () => {
  const periods = parsePeriods(['2020-01-01/2020-12-01/P1M']);
  assert.equal(formatGibsTime(snapTime(d('2020-05-20'), periods)), '2020-05-01');
  assert.equal(formatGibsTime(stepTime(d('2020-05-01'), periods, 1)), '2020-06-01');
});

test('tile URLs include time only for time-bound layers', () => {
  const base = { id: 'X', format: 'image/png', tileMatrixSet: 'GoogleMapsCompatible_Level6' };
  assert.match(gaiaTileUrl({ ...base, periods: parsePeriods(['2020-01-01/2020-01-05/P1D']) }, d('2020-01-02')), /X\/default\/2020-01-02\/GoogleMapsCompatible_Level6\/\{z\}\/\{y\}\/\{x\}\.png$/);
  assert.match(gaiaTileUrl({ ...base, periods: [] }, 0), /X\/default\/GoogleMapsCompatible_Level6\//);
});

import { matchesCategory } from '../src/gibs-catalog.js';
test('category chips match by id/title', () => {
  assert.ok(matchesCategory({ id: 'MODIS_Terra_Cloud_Top_Temp_Day', title: 'Cloud Top' }, 'Clouds'));
  assert.ok(!matchesCategory({ id: 'BlueMarble', title: 'Blue Marble' }, 'Fires'));
  assert.ok(matchesCategory({ id: 'x', title: 'y' }, ''));
});
