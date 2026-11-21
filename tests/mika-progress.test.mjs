import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

test('Mika progress shows each completed action once and reports ineffective actions', () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/mika-progress');
  mkdirSync(parent, { recursive: true });
  const out = mkdtempSync(join(parent, 'run-'));
  execFileSync('javac', ['-encoding', 'UTF-8', '-d', out,
    'android-addon/src/cn/yilu/rayneopaseo/MikaProgress.java',
    'android-addon/tests/MikaProgressTest.java'], { stdio: 'pipe' });
  assert.match(execFileSync('java', ['-cp', out, 'cn.yilu.rayneopaseo.MikaProgressTest'], { encoding: 'utf8' }), /checks passed/);
});
