import semver from 'semver';

const USER_AGENT = 'dependency-checker/0.0.1 (VS Code extension)';
const SUCCESS_TTL_MS = 10 * 60 * 1000;
const FAILURE_TTL_MS = 30 * 1000;

export type CrateLookup =
  | { type: 'ok'; versions: string[] }
  | { type: 'notFound' }
  | { type: 'error'; message: string };

interface CacheEntry {
  expires: number;
  value: CrateLookup;
}

class RequestLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise(resolve => {
      this.queue.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<CrateLookup>>();
const limiter = new RequestLimiter(8);

/** 크레이트 이름을 스파스 인덱스 경로로 바꿉니다. */
export function sparseIndexPath(crateName: string): string {
  const name = crateName.toLowerCase();
  switch (name.length) {
    case 1:
      return `1/${name}`;
    case 2:
      return `2/${name}`;
    case 3:
      return `3/${name[0]}/${name}`;
    default:
      return `${name.slice(0, 2)}/${name.slice(2, 4)}/${name}`;
  }
}

export function crateIndexUrl(indexUrl: string, crateName: string): string {
  const base = indexUrl.replace(/\/+$/, '');
  return `${base}/${sparseIndexPath(crateName)}`;
}

/** 인덱스 본문에서 yank 되지 않은 버전을 읽습니다. */
export function parseCrateIndex(body: string): string[] {
  const versions: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: { vers?: unknown; yanked?: unknown };
    try {
      parsed = JSON.parse(trimmed) as { vers?: unknown; yanked?: unknown };
    } catch {
      continue;
    }
    if (typeof parsed.vers !== 'string' || parsed.yanked === true) {
      continue;
    }
    if (!semver.valid(parsed.vers)) {
      continue;
    }
    versions.push(parsed.vers);
  }
  return versions;
}

export function getCachedCrate(name: string, indexUrl: string): CrateLookup | undefined {
  const key = cacheKey(indexUrl, name);
  const cached = cache.get(key);
  if (!cached) {
    return undefined;
  }
  if (cached.expires <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return cached.value;
}

export function clearCrateCache(): void {
  cache.clear();
}

/** 크레이트의 발표된 버전 목록을 가져옵니다. 같은 이름은 진행 중인 요청을 재사용합니다. */
export function lookupCrate(name: string, indexUrl: string): Promise<CrateLookup> {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return Promise.resolve({ type: 'notFound' });
  }
  const key = cacheKey(indexUrl, name);
  const cached = getCachedCrate(name, indexUrl);
  if (cached) {
    return Promise.resolve(cached);
  }
  const pending = inflight.get(key);
  if (pending) {
    return pending;
  }

  const promise = limiter.run(() => fetchCrateVersions(name, indexUrl)).then(value => {
    cache.set(key, { expires: Date.now() + ttlFor(value), value });
    inflight.delete(key);
    return value;
  }).catch((error: unknown) => {
    const value: CrateLookup = {
      type: 'error',
      message: error instanceof Error ? error.message : '버전 정보를 가져오지 못했습니다.',
    };
    cache.set(key, { expires: Date.now() + FAILURE_TTL_MS, value });
    inflight.delete(key);
    return value;
  });
  inflight.set(key, promise);
  return promise;
}

async function fetchCrateVersions(name: string, indexUrl: string): Promise<CrateLookup> {
  const response = await fetch(crateIndexUrl(indexUrl, name), {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/plain',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (response.status === 404 || response.status === 410) {
    return { type: 'notFound' };
  }
  if (!response.ok) {
    return { type: 'error', message: `인덱스 응답 ${response.status}` };
  }
  const versions = parseCrateIndex(await response.text());
  if (versions.length === 0) {
    return { type: 'notFound' };
  }
  return { type: 'ok', versions };
}

function cacheKey(indexUrl: string, name: string): string {
  return `${indexUrl.replace(/\/+$/, '')}\n${name.toLowerCase()}`;
}

function ttlFor(value: CrateLookup): number {
  return value.type === 'ok' ? SUCCESS_TTL_MS : FAILURE_TTL_MS;
}
