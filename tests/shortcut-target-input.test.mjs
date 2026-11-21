import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

test('manual Codex ID binding is explicit and cannot silently fall back to current or previous targets', () => {
  const out = join(homedir(), '.local/state/rayneo-paseo/test-shortcut-target-input'); mkdirSync(out, { recursive: true });
  execFileSync('javac', ['-encoding', 'UTF-8', '-d', out,
    'android-addon/src/cn/yilu/rayneopaseo/ShortcutTargetInput.java', 'android-addon/tests/ShortcutTargetInputTest.java'], { stdio: 'pipe', windowsHide: true });
  assert.match(execFileSync('java', ['-cp', out, 'cn.yilu.rayneopaseo.ShortcutTargetInputTest'], { encoding: 'utf8', windowsHide: true }), /checks passed/);
});
