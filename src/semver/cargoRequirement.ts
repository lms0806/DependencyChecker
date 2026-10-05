import semver from 'semver';

export interface VersionJudgement {
  status: 'upToDate' | 'updateAvailable' | 'unparsed' | 'notFound';
  latest?: string;
  /** 요구 범위를 만족하는 버전 중 가장 높은 버전 */
  latestInRange?: string;
}

/**
 * Cargo 요구 버전을 node-semver 범위로 바꿉니다.
 * 연산자가 없는 버전은 Cargo와 같이 캐럿(^) 범위입니다.
 */
export function toNodeRange(requirement: string): string | undefined {
  const converted: string[] = [];
  for (const part of requirement.split(',')) {
    if (!part.trim()) {
      continue;
    }
    const next = convertPart(part);
    if (!next) {
      return undefined;
    }
    converted.push(next);
  }
  if (converted.length === 0) {
    return undefined;
  }
  const range = converted.join(' ');
  return semver.validRange(range) ? range : undefined;
}

/** 요구 버전이 version을 허용하는지 확인합니다. */
export function requirementAllows(requirement: string, version: string): boolean {
  const range = toNodeRange(requirement);
  if (!range || !semver.valid(version)) {
    return false;
  }
  return semver.satisfies(version, range, {
    includePrerelease: requirement.includes('-'),
  });
}

/**
 * 인덱스 버전 목록과 요구 버전을 비교합니다.
 * listPreReleases가 아니면 프리릴리스는 최신 버전 후보에서 빠집니다.
 */
export function judgeRequirement(
  requirement: string | undefined,
  versions: readonly string[],
  listPreReleases: boolean,
): VersionJudgement {
  const candidates = listPreReleases
    ? [...versions]
    : versions.filter(version => semver.prerelease(version) === null);
  const latest = maxVersion(candidates);
  if (!latest) {
    return { status: 'notFound' };
  }
  const range = requirement ? toNodeRange(requirement) : undefined;
  if (!requirement?.trim() || !range) {
    return { status: 'unparsed', latest };
  }
  const includePrerelease = listPreReleases || requirement.includes('-');
  const inRange = candidates.filter(version => semver.satisfies(version, range, { includePrerelease }));
  const latestInRange = maxVersion(inRange);
  if (semver.satisfies(latest, range, { includePrerelease })) {
    return { status: 'upToDate', latest, latestInRange };
  }
  return { status: 'updateAvailable', latest, latestInRange };
}

function convertPart(part: string): string | undefined {
  const compact = part.trim();
  if (compact === '*' || compact === 'x' || compact === 'X') {
    return '*';
  }

  const operator = compact.match(/^(>=|<=|>|<|\^|~|=+)\s*([\s\S]+)$/);
  if (operator) {
    const operatorToken = operator[1] === '==' ? '=' : operator[1];
    const version = operator[2].replace(/\s+/g, '');
    if (!version) {
      return undefined;
    }
    const normalized = `${operatorToken}${version}`;
    return semver.validRange(normalized) ? normalized : undefined;
  }

  const bare = compact.replace(/\s+/g, '');
  if (bare.includes('*') || bare.includes('x') || bare.includes('X')) {
    return semver.validRange(bare) ? bare : undefined;
  }
  const caret = `^${bare}`;
  return semver.validRange(caret) ? caret : undefined;
}

function maxVersion(versions: readonly string[]): string | undefined {
  const valid = versions.filter(version => semver.valid(version));
  if (valid.length === 0) {
    return undefined;
  }
  return [...valid].sort(semver.rcompare)[0];
}
