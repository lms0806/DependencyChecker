import * as vscode from 'vscode';

/**
 * 확장이 처음 활성화될 때 호출됩니다.
 * 명령 팔레트의 "Dependency Checker: 의존성 검사" 실행 시 활성화됩니다.
 */
export function activate(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand('dependencyChecker.check', () => {
    vscode.window.showInformationMessage('Dependency Checker가 준비되었습니다.');
  });

  context.subscriptions.push(disposable);
}

/** 확장이 비활성화될 때 호출됩니다. */
export function deactivate(): void {
  // 정리할 리소스가 생기면 여기에 추가합니다.
}
