export interface CrateFeatureReport {
  /** 현재 받을 버전에서 이미 켜지는 features */
  enabled: string[];
  /** 현재 받을 버전에 있지만 아직 켜지 않은 features */
  available: string[];
  /** 최신 버전에만 새로 있는 features */
  addedInLatest: string[];
}

/**
 * 선언한 features와 인덱스 feature 정의를 비교합니다.
 * default-features가 켜져 있으면 default가 재귀적으로 활성화됩니다.
 */
export function compareCrateFeatures(
  declared: readonly string[],
  defaultFeatures: boolean,
  resolved: Readonly<Record<string, readonly string[]>>,
  latest?: Readonly<Record<string, readonly string[]>>,
): CrateFeatureReport {
  const enabled = enabledFeatureNames(declared, defaultFeatures, resolved);
  const available = Object.keys(resolved).filter(name => !enabled.has(name));
  const addedInLatest = latest
    ? Object.keys(latest).filter(name => !(name in resolved))
    : [];
  return {
    enabled: sortFeatures([...enabled]),
    available: sortFeatures(available),
    addedInLatest: sortFeatures(addedInLatest),
  };
}

function enabledFeatureNames(
  declared: readonly string[],
  defaultFeatures: boolean,
  featureMap: Readonly<Record<string, readonly string[]>>,
): Set<string> {
  const enabled = new Set<string>();
  const visit = (name: string): void => {
    if (enabled.has(name) || !(name in featureMap)) {
      return;
    }
    enabled.add(name);
    for (const token of featureMap[name] ?? []) {
      const local = localFeatureName(token);
      if (local) {
        visit(local);
      }
    }
  };
  if (defaultFeatures) {
    visit('default');
  }
  for (const name of declared) {
    visit(name);
  }
  return enabled;
}

/** 이 크레이트 자신의 feature 이름만 남깁니다. 의존성 feature(foo/bar)는 제외합니다. */
function localFeatureName(token: string): string | undefined {
  let name = token;
  if (name.startsWith('dep:')) {
    name = name.slice('dep:'.length);
  }
  if (!name || name.includes('/')) {
    return undefined;
  }
  return name.endsWith('?') ? name.slice(0, -1) : name;
}

function sortFeatures(names: readonly string[]): string[] {
  return [...names].sort((left, right) => {
    const byRank = featureRank(left) - featureRank(right);
    if (byRank !== 0) {
      return byRank;
    }
    return left.localeCompare(right);
  });
}

function featureRank(name: string): number {
  if (name === 'default') {
    return 0;
  }
  if (name.startsWith('_')) {
    return 2;
  }
  return 1;
}
