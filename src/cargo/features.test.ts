import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareCrateFeatures } from './features.js';

const features = {
  default: ['std'],
  std: [],
  derive: ['dep:serde_derive'],
  serde_derive: [],
  unstable: [],
  _internal: [],
};

test('default가 켜는 feature는 이미 켠 것으로 보고 나머지를 알려 준다', () => {
  const report = compareCrateFeatures([], true, features);
  assert.deepEqual(report.enabled, ['default', 'std']);
  assert.deepEqual(report.available, ['derive', 'serde_derive', 'unstable', '_internal']);
  assert.deepEqual(report.addedInLatest, []);
});

test('직접 켠 feature와 그것이 켜는 optional 의존성은 빼 준다', () => {
  const report = compareCrateFeatures(['derive'], true, features);
  assert.deepEqual(report.enabled, ['default', 'derive', 'serde_derive', 'std']);
  assert.deepEqual(report.available, ['unstable', '_internal']);
});

test('default-features = false이면 default 묶음도 꺼진 feature다', () => {
  const report = compareCrateFeatures(['derive'], false, features);
  assert.deepEqual(report.enabled, ['derive', 'serde_derive']);
  assert.deepEqual(report.available, ['default', 'std', 'unstable', '_internal']);
});

test('최신 버전에만 있는 feature를 구분한다', () => {
  const latest = { ...features, tracing: [] };
  const report = compareCrateFeatures([], true, features, latest);
  assert.deepEqual(report.addedInLatest, ['tracing']);
});
