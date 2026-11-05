import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GIBS_START_DATE,
  HLS_L30_LAYER,
  HLS_S30_LAYER,
  clampDay,
  dayToIso,
  gibsAncestor,
  gibsTileUrl,
  hlsTileUrl,
  isoToDay,
  previousUtcDate,
} from '../src/spacetime.js';

test('spacetime dates round-trip without local timezone drift', () => {
  for (const date of [GIBS_START_DATE, '2024-02-29', '2026-11-04']) {
    assert.equal(dayToIso(isoToDay(date)), date);
  }
  assert.equal(previousUtcDate(new Date('2026-11-05T00:30:00Z')), '2026-11-04');
});

test('timeline days clamp to the selected range', () => {
  const start = isoToDay('2024-01-01');
  const end = isoToDay('2024-12-31');
  assert.equal(clampDay(isoToDay('2023-01-01'), start, end), start);
  assert.equal(clampDay(isoToDay('2025-01-01'), start, end), end);
});

test('GIBS tiles use the NASA Web Mercator daily imagery route', () => {
  assert.equal(
    gibsTileUrl('2024-06-15', 5, 9, 12),
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/2024-06-15/GoogleMapsCompatible_Level9/5/12/9.jpg',
  );
});

test('HLS tiles use NASA Level 12 Landsat and Sentinel routes', () => {
  assert.equal(
    hlsTileUrl(HLS_L30_LAYER, '2023-01-31', 12, 3626, 1617),
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/HLS_L30_Nadir_BRDF_Adjusted_Reflectance/default/2023-01-31/GoogleMapsCompatible_Level12/12/1617/3626.png',
  );
  assert.equal(
    hlsTileUrl(HLS_S30_LAYER, '2023-01-31', 10, 906, 404),
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/HLS_S30_Nadir_BRDF_Adjusted_Reflectance/default/2023-01-31/GoogleMapsCompatible_Level12/10/404/906.png',
  );
});

test('deep terrain tiles reuse the matching maximum-resolution GIBS ancestor', () => {
  assert.deepEqual(gibsAncestor(9, 301, 205), {
    z: 9, x: 301, y: 205, scale: 1, childX: 0, childY: 0,
  });
  assert.deepEqual(gibsAncestor(13, 4827, 3291), {
    z: 9, x: 301, y: 205, scale: 16, childX: 11, childY: 11,
  });
  assert.deepEqual(gibsAncestor(14, 14505, 6471, 12), {
    z: 12, x: 3626, y: 1617, scale: 4, childX: 1, childY: 3,
  });
});

test('daily tile URLs are pinned to the requested date only', () => {
  const url = gibsTileUrl('2024-06-15', 3, 2, 1);
  assert.ok(url.includes('/2024-06-15/'));
  assert.ok(!url.includes('2024-06-14') && !url.includes('2024-06-16'));
});