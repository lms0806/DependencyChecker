import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crateIndexUrl, parseCrateIndex, sparseIndexPath } from './sparseIndex.js';

test('크레이트 이름 길이에 따라 스파스 인덱스 경로를 만든다', () => {
  assert.equal(sparseIndexPath('a'), '1/a');
  assert.equal(sparseIndexPath('ab'), '2/ab');
  assert.equal(sparseIndexPath('abc'), '3/a/abc');
  assert.equal(sparseIndexPath('serde'), 'se/rd/serde');
  assert.equal(sparseIndexPath('Serde_JSON'), 'se/rd/serde_json');
  assert.equal(
    crateIndexUrl('https://index.crates.io/', 'serde'),
    'https://index.crates.io/se/rd/serde',
  );
});

test('yank 된 버전과 깨진 줄은 제외한다', () => {
  const body = [
    '{"name":"demo","vers":"1.0.0","yanked":true}',
    '{"name":"demo","vers":"1.1.0","yanked":false}',
    '{"name":"demo","vers":"1.2.0-rc.1","yanked":false}',
    'not-json',
    '',
  ].join('\n');
  assert.deepEqual(parseCrateIndex(body), ['1.1.0', '1.2.0-rc.1']);
});
