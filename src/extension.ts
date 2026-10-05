import * as vscode from 'vscode';
import { CargoTomlChecker } from './cargo/cargoChecker.js';

/**
 * 확장이 활성화될 때 호출됩니다.
 * 지금은 Cargo.toml만 검사하고, 다른 매니페스트는 같은 방식으로 추가합니다.
 */
export function activate(context: vscode.ExtensionContext): void {
  const cargoChecker = new CargoTomlChecker();
  cargoChecker.register(context);
}

/** 확장이 비활성화될 때 호출됩니다. */
export function deactivate(): void {
  // 구독은 ExtensionContext가 해제합니다.
}
