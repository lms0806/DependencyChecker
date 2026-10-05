import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { parseCargoToml } from './parseCargoToml.js';
import { findWorkspaceManifest, resolveInheritedRequirements } from './workspace.js';

test('workspace = true 에 워크스페이스 요구 버전을 연결한다', () => {
  const parsed = parseCargoToml(`
[workspace.dependencies]
serde = "1"
local = { path = "../local" }

[dependencies]
serde = { workspace = true }
local = { workspace = true }
missing = { workspace = true }
`).dependencies;
  const resolved = resolveInheritedRequirements(parsed, parsed);
  const serde = resolved.find(dependency => dependency.name === 'serde' && dependency.section === 'dependencies');
  const local = resolved.find(dependency => dependency.name === 'local' && dependency.section === 'dependencies');
  const missing = resolved.find(dependency => dependency.name === 'missing');

  assert.equal(serde?.kind, 'registry');
  assert.equal(serde?.requirement, '1');
  assert.equal(serde?.inherited, true);
  assert.equal(serde?.anchor.start.line, 6);
  assert.equal(local?.kind, 'path');
  assert.equal(missing?.unresolvedWorkspace, true);
});

test('상위 Cargo.toml에서 워크스페이스 매니페스트를 찾는다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-checker-'));
  const memberDir = path.join(root, 'crates', 'demo');
  fs.mkdirSync(memberDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'Cargo.toml'), '[workspace]\nmembers = ["crates/*"]\n\n[workspace.dependencies]\nserde = "1"\n');
  const memberPath = path.join(memberDir, 'Cargo.toml');
  fs.writeFileSync(memberPath, '[dependencies]\nserde = { workspace = true }\n');

  const found = findWorkspaceManifest(memberPath);
  assert.equal(found && path.resolve(found), path.resolve(path.join(root, 'Cargo.toml')));
});
