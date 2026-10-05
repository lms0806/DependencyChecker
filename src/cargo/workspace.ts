import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseCargoToml } from './parseCargoToml.js';
import { CargoDependency } from './types.js';

/**
 * 시작 파일부터 부모 디렉터리를 올라가며
 * [workspace] 테이블이 있는 Cargo.toml을 찾습니다.
 */
export function findWorkspaceManifest(startCargoPath: string): string | undefined {
  let dir = path.dirname(path.resolve(startCargoPath));
  const root = path.parse(dir).root;
  while (true) {
    const candidate = path.join(dir, 'Cargo.toml');
    if (fs.existsSync(candidate)) {
      const text = fs.readFileSync(candidate, 'utf8');
      if (parseCargoToml(text).workspaceManifest) {
        return path.resolve(candidate);
      }
    }
    if (dir === root) {
      return undefined;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/**
 * workspace = true 인 의존성에 워크스페이스 정의의 요구 버전을 붙입니다.
 * 장식이 붙는 위치는 멤버 파일의 선언을 유지합니다.
 */
export function resolveInheritedRequirements(
  dependencies: readonly CargoDependency[],
  workspaceDependencies: readonly CargoDependency[],
): CargoDependency[] {
  const definitions = new Map<string, CargoDependency>();
  for (const dependency of workspaceDependencies) {
    if (dependency.section === 'workspace.dependencies') {
      definitions.set(dependency.name, dependency);
    }
  }

  return dependencies.map(dependency => {
    if (dependency.kind !== 'workspace' || dependency.skipped) {
      return dependency;
    }
    const defined = definitions.get(dependency.name);
    if (!defined) {
      return { ...dependency, unresolvedWorkspace: true };
    }
    if (defined.kind === 'registry' && defined.requirement !== undefined) {
      return {
        ...dependency,
        kind: 'registry',
        crateName: defined.crateName,
        requirement: defined.requirement,
        requirementSpan: defined.requirementSpan,
        features: mergeFeatureNames(defined.features, dependency.features),
        defaultFeatures: dependency.defaultFeaturesSpecified ? dependency.defaultFeatures : defined.defaultFeatures,
        defaultFeaturesSpecified: dependency.defaultFeaturesSpecified || defined.defaultFeaturesSpecified,
        inherited: true,
        unresolvedWorkspace: false,
      };
    }
    if (defined.kind === 'git') {
      return { ...dependency, kind: 'git', inherited: true };
    }
    if (defined.kind === 'path') {
      return { ...dependency, kind: 'path', inherited: true };
    }
    return { ...dependency, unresolvedWorkspace: true };
  });
}

function mergeFeatureNames(base: readonly string[], extra: readonly string[]): string[] {
  const names = [...base];
  for (const name of extra) {
    if (!names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}
