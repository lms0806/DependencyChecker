/** 소스 위치. VS Code의 문자 오프셋(UTF-16)과 같습니다. */
export interface TextPoint {
  line: number;
  character: number;
}

/** 반열린 구간 [start, end)입니다. */
export interface TextSpan {
  start: TextPoint;
  end: TextPoint;
}

export type DependencySection =
  | 'dependencies'
  | 'dev-dependencies'
  | 'build-dependencies'
  | 'workspace.dependencies';

export type DependencyKind = 'registry' | 'path' | 'git' | 'workspace';

/** Cargo.toml에서 읽은 의존성 한 건입니다. */
export interface CargoDependency {
  /** 매니페스트에 적힌 키 이름 */
  name: string;
  /** crates.io에 조회할 크레이트 이름. package 키가 있으면 그 값입니다. */
  crateName: string;
  requirement?: string;
  /** 따옴표 안의 요구 버전 문자열 범위. 퀵 픽스가 이 구간만 바꿉니다. */
  requirementSpan?: TextSpan;
  /** 인라인 장식을 붙일 빈 범위 */
  anchor: TextSpan;
  /** 호버와 퀵 픽스가 반응할 전체 범위 */
  span: TextSpan;
  kind: DependencyKind;
  section: DependencySection;
  skipped: boolean;
  /** features 배열에 직접 적은 이름 */
  features: string[];
  /** default-features 값. 생략하면 true입니다. */
  defaultFeatures: boolean;
  /** 이 선언에 default-features 키를 직접 적었는지 */
  defaultFeaturesSpecified: boolean;
  /** 요구 버전을 워크스페이스 정의에서 가져온 경우 */
  inherited?: boolean;
  /** workspace = true 이지만 정의를 찾지 못한 경우 */
  unresolvedWorkspace?: boolean;
}

export interface CargoParseResult {
  dependencies: CargoDependency[];
  /** [workspace] 또는 [workspace.*] 테이블이 있으면 true */
  workspaceManifest: boolean;
}
