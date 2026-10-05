import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Dependency Checker', () => {
  test('확장이 활성화된다', async () => {
    const extension = vscode.extensions.all.find(item => item.id.endsWith('.dependency-checker'));
    assert.ok(extension, '확장을 찾을 수 없습니다.');
    await extension.activate();
    assert.strictEqual(extension.isActive, true);
  });
});
