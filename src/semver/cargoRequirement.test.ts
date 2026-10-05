import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeRequirement, requirementAllows } from './cargoRequirement.js';

test('연산자가 없는 Cargo 버전은 캐럿 범위다', () => {
  assert.equal(requirementAllows('1.2.3', '1.9.0'), true);
  assert.equal(requirementAllows('1.2.3', '2.0.0'), false);
  assert.equal(requirementAllows('1.2', '1.9.0'), true);
  assert.equal(requirementAllows('1', '1.9.0'), true);
  assert.equal(requirementAllows('1', '2.0.0'), false);
});

test('0.x 캐럿은 마이너 버전이 바뀌면 벗어난다', () => {
  assert.equal(requirementAllows('0.2.3', '0.2.9'), true);
  assert.equal(requirementAllows('0.2.3', '0.3.0'), false);
  assert.equal(requirementAllows('0.0.3', '0.0.3'), true);
  assert.equal(requirementAllows('0.0.3', '0.0.4'), false);
});

test('명시적 연산자, 와일드카드, 복합 범위를 해석한다', () => {
  assert.equal(requirementAllows('=1.2.3', '1.2.3'), true);
  assert.equal(requirementAllows('=1.2.3', '1.2.4'), false);
  assert.equal(requirementAllows('~1.2.3', '1.2.9'), true);
  assert.equal(requirementAllows('~1.2.3', '1.3.0'), false);
  assert.equal(requirementAllows('1.2.*', '1.2.9'), true);
  assert.equal(requirementAllows('1.2.*', '1.3.0'), false);
  assert.equal(requirementAllows('>= 1.0, < 1.5', '1.4.9'), true);
  assert.equal(requirementAllows('>= 1.0, < 1.5', '1.5.0'), false);
  assert.equal(requirementAllows('*', '3.1.0'), true);
});

test('최신 버전이 범위 안이면 최신이고, 밖이면 업데이트 가능으로 판단한다', () => {
  const versions = ['1.0.0', '1.2.0', '2.0.0', '2.1.0-rc.1'];
  const compatible = judgeRequirement('1.0', versions, false);
  assert.equal(compatible.status, 'updateAvailable');
  assert.equal(compatible.latest, '2.0.0');
  assert.equal(compatible.latestInRange, '1.2.0');

  const current = judgeRequirement('2', versions, false);
  assert.equal(current.status, 'upToDate');
  assert.equal(current.latest, '2.0.0');
});

test('프리릴리스는 설정이 꺼져 있으면 최신 버전에서 제외한다', () => {
  const versions = ['1.0.0', '1.1.0-rc.1'];
  assert.equal(judgeRequirement('1', versions, false).latest, '1.0.0');
  assert.equal(judgeRequirement('1', versions, true).latest, '1.1.0-rc.1');
  assert.equal(judgeRequirement('1', versions, true).status, 'upToDate');
});
