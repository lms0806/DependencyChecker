# Dependency Checker

프로젝트 의존성을 검사하는 VS Code 확장입니다.

## 요구 사항

- Node.js 20 이상
- VS Code 1.95 이상

## 개발 시작

```bash
npm install
```

의존성을 설치한 뒤, 이 폴더를 VS Code에서 열고 **F5**(실행 및 디버그: 확장 실행)를 누릅니다. 확장 개발 호스트 창이 열리면 명령 팔레트에서 `Dependency Checker: 의존성 검사`를 실행합니다.

## 스크립트

| 명령 | 설명 |
| --- | --- |
| `npm run compile` | TypeScript를 `out/`으로 컴파일 |
| `npm run watch` | 파일 변경 시 자동 컴파일 |
| `npm run lint` | ESLint 검사 |
| `npm test` | 확장 테스트 실행 |

## 배포

마켓플레이스에 올리기 전에 `package.json`의 `publisher`를 본인 게시자 ID로 바꿉니다.

```bash
npx @vscode/vsce package
```

생성되는 `.vsix` 파일은 VS Code의 "VSIX에서 설치..."로 설치할 수 있습니다.
