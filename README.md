# Dependency Checker

의존성 매니페스트를 읽어 레지스트리의 최신 버전을 보여 주는 VS Code 확장입니다. 지금은 `Cargo.toml`만 지원합니다.

## Cargo.toml

`Cargo.toml`을 열면 `[dependencies]`, `[dev-dependencies]`, `[build-dependencies]`, 타깃별 의존성, `[workspace.dependencies]`의 크레이트를 [crates.io 스파스 인덱스](https://index.crates.io)에서 조회합니다.

버전 뒤에 최신 버전이 표시됩니다.

- `✅ 1.0.229`: 지금 적은 요구 범위가 최신 버전을 포함합니다.
- `❌ 2.0.0`: 최신 버전이 요구 범위 밖에 있습니다. 전구 메뉴에서 그 버전으로 바꿀 수 있습니다.

경로 의존성과 Git 의존성은 건너뜁니다. `workspace = true`는 상위 `Cargo.toml`의 `[workspace.dependencies]`에 적힌 요구 버전으로 비교합니다.

특정 의존성을 빼려면 그 줄 주석에 다음 중 하나를 적습니다.

```toml
serde = "1.0" # dependency-checker: disable-check
```

## 설정

- `dependencyChecker.listPreReleases`: 프리릴리스를 최신 버전으로 봅니다. 기본값은 끄기입니다.
- `dependencyChecker.indexUrl`: 스파스 인덱스 주소입니다. 기본값은 `https://index.crates.io`입니다.

명령 팔레트의 `Dependency Checker: 최신 버전 새로고침`은 캐시를 비우고 열려 있는 `Cargo.toml`을 다시 조회합니다.

## 개발

```bash
npm install
```

이 폴더에서 **F5**를 누르면 확장 개발 호스트가 열립니다. 그 창에서 `Cargo.toml`을 열면 버전 표시가 나타납니다.

| 명령 | 설명 |
| --- | --- |
| `npm run compile` | TypeScript를 `out/`으로 컴파일 |
| `npm run watch` | 파일 변경 시 자동 컴파일 |
| `npm run lint` | ESLint 검사 |
| `npm run test:unit` | 파서와 버전 비교 단위 테스트 |
| `npm test` | 확장 호스트 테스트 |
