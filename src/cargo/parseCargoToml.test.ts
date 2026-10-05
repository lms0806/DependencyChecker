import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCargoToml } from './parseCargoToml.js';

const sample = `
[package]
name = "demo"
version = "0.1.0"
description = """
여러 줄 설명
"""
keywords = ["demo", "parser"]

[[bin]]
name = "demo"
path = "src/main.rs"

[dependencies]
serde = "1.0"
serde_json = { version = "1.0.1", features = ["std"] }
renamed = { package = "image", version = "0.24" }
local = { path = "../local" }
remote = { git = "https://github.com/example/remote" }
checked_out = { git = "https://github.com/example/remote", version = "0.1.0" }
bytes = "1.4.0" # crates: disable-check
literal = "1 # crates: disable-check"
tokio = { version = "1", features = ["full"] }
quoted = "1.2.3" # dependency-checker: disable-check

[dev-dependencies]
tempfile = "3"

[build-dependencies]
cc = "1.0"

[target.'cfg(unix)'.dependencies]
libc = "0.2"

[dependencies.tracing]
version = "0.1"
features = ["std"]

[workspace]
members = ["crates/*"]

[workspace.dependencies]
shared = { version = "0.3", features = ["derive"] }
`;

test('패키지 메타데이터가 의존성으로 잡히지 않는다', () => {
  const names = parseCargoToml(sample).dependencies.map(dependency => dependency.name);
  assert.equal(names.includes('demo'), false);
  assert.equal(names.includes('version'), false);
  assert.equal(names.includes('keywords'), false);
});

test('문자열, 인라인 테이블, 별칭, 경로, git 의존성을 구분한다', () => {
  const dependencies = parseCargoToml(sample).dependencies;
  const byName = new Map(dependencies.map(dependency => [dependency.name, dependency]));

  assert.equal(byName.get('serde')?.requirement, '1.0');
  assert.equal(byName.get('serde')?.kind, 'registry');
  assert.equal(byName.get('serde')?.section, 'dependencies');

  assert.equal(byName.get('serde_json')?.requirement, '1.0.1');
  assert.equal(byName.get('renamed')?.crateName, 'image');
  assert.equal(byName.get('renamed')?.requirement, '0.24');

  assert.equal(byName.get('local')?.kind, 'path');
  assert.equal(byName.get('remote')?.kind, 'git');
  assert.equal(byName.get('checked_out')?.kind, 'registry');
  assert.equal(byName.get('checked_out')?.requirement, '0.1.0');
});

test('검사 제외 주석은 문자열 안의 문구와 구분한다', () => {
  const dependencies = parseCargoToml(sample).dependencies;
  const byName = new Map(dependencies.map(dependency => [dependency.name, dependency]));
  assert.equal(byName.get('bytes')?.skipped, true);
  assert.equal(byName.get('quoted')?.skipped, true);
  assert.equal(byName.get('literal')?.skipped, false);
  assert.equal(byName.get('literal')?.requirement, '1 # crates: disable-check');
});

test('개발, 빌드, 타깃, 테이블, 워크스페이스 의존성을 읽는다', () => {
  const result = parseCargoToml(sample);
  const dependencies = result.dependencies;
  assert.equal(result.workspaceManifest, true);
  assert.equal(dependencies.find(dependency => dependency.name === 'tempfile')?.section, 'dev-dependencies');
  assert.equal(dependencies.find(dependency => dependency.name === 'cc')?.section, 'build-dependencies');
  assert.equal(dependencies.find(dependency => dependency.name === 'libc')?.requirement, '0.2');
  assert.equal(dependencies.find(dependency => dependency.name === 'tracing')?.requirement, '0.1');
  assert.equal(dependencies.find(dependency => dependency.name === 'shared')?.section, 'workspace.dependencies');
  assert.equal(dependencies.find(dependency => dependency.name === 'shared')?.requirement, '0.3');
});

test('요구 버전 문자열의 위치는 따옴표 안이고 장식은 닫는 따옴표 뒤다', () => {
  const text = '[dependencies]\nserde = "1.0" # keep\n';
  const dependency = parseCargoToml(text).dependencies[0];
  const line = 'serde = "1.0" # keep';
  assert.ok(dependency);
  assert.equal(dependency.requirementSpan?.start.line, 1);
  assert.equal(dependency.requirementSpan?.start.character, line.indexOf('1.0'));
  assert.equal(dependency.requirementSpan?.end.character, line.indexOf('1.0') + 3);
  assert.equal(dependency.anchor.start.character, line.indexOf('"1.0"') + '"1.0"'.length);
  assert.equal(dependency.anchor.start.character, dependency.anchor.end.character);
});

test('여러 줄 인라인 테이블은 닫는 중괄호 뒤에 장식을 둔다', () => {
  const text = [
    '[dependencies]',
    'tokio = {',
    '  version = "1.36",',
    '  features = ["macros", "rt-multi-thread"],',
    '}',
  ].join('\n');
  const dependency = parseCargoToml(text).dependencies[0];
  assert.equal(dependency?.requirement, '1.36');
  assert.equal(dependency?.anchor.start.line, 4);
  assert.equal(dependency?.anchor.start.character, 1);
});

test('CRLF 문서에서도 줄 번호를 유지한다', () => {
  const dependency = parseCargoToml('[dependencies]\r\nserde = "1"\r\n').dependencies[0];
  assert.equal(dependency?.requirement, '1');
  assert.equal(dependency?.anchor.start.line, 1);
});

test('점 표기 키는 한 의존성으로 합친다', () => {
  const text = [
    '[dependencies]',
    'serde.version = "1.0"',
    'serde.features = ["derive"]',
    'renamed.package = "image"',
    'renamed.version = "0.24"',
  ].join('\n');
  const dependencies = parseCargoToml(text).dependencies;
  assert.equal(dependencies.length, 2);
  assert.equal(dependencies[0]?.requirement, '1.0');
  assert.equal(dependencies[1]?.crateName, 'image');
  assert.equal(dependencies[1]?.requirement, '0.24');
});

test('workspace = true 는 워크스페이스 의존성으로 표시한다', () => {
  const text = '[dependencies]\nserde = { workspace = true, features = ["derive"] }\n';
  const dependency = parseCargoToml(text).dependencies[0];
  assert.equal(dependency?.kind, 'workspace');
  assert.equal(dependency?.name, 'serde');
});
