import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

test('Mika task states route follow-ups and display changes without repetition', () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/mika-state');
  mkdirSync(parent, { recursive: true });
  const out = mkdtempSync(join(parent, 'run-'));
  execFileSync('javac', ['-encoding', 'UTF-8', '-d', out,
    'android-addon/src/cn/yilu/rayneopaseo/MikaTaskState.java',
    'android-addon/tests/MikaTaskStateTest.java'], { stdio: 'pipe' });
  assert.match(execFileSync('java', ['-cp', out, 'cn.yilu.rayneopaseo.MikaTaskStateTest'], { encoding: 'utf8' }), /checks passed/);
});
