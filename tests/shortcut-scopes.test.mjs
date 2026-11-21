import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
test('phone isolates shortcut targets by backend and requires matching advertised capabilities', () => {
  const out = join(homedir(), '.local/state/rayneo-paseo/test-shortcut-scopes'); mkdirSync(out, { recursive: true });
  execFileSync('javac', ['-encoding', 'UTF-8', '-d', out,
    ...['VoiceCommand', 'InteractionPreferences', 'ShortcutBindings', 'ShortcutScopes', 'BackendCapabilities']
      .map(n => `android-addon/src/cn/yilu/rayneopaseo/${n}.java`), 'android-addon/tests/ShortcutScopesTest.java'], { stdio: 'pipe', windowsHide: true });
  assert.match(execFileSync('java', ['-cp', out, 'cn.yilu.rayneopaseo.ShortcutScopesTest'], { encoding: 'utf8', windowsHide: true }), /checks passed/);
});
