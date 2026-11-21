import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
test('Mika records a request before submission and recovers without duplicate actions', () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/mika-coordinator');
  mkdirSync(parent, { recursive: true }); const out = mkdtempSync(join(parent, 'run-'));
  execFileSync('javac', ['-encoding', 'UTF-8', '-d', out,
    'android-addon/src/cn/yilu/rayneopaseo/MikaTaskState.java',
    'android-addon/src/cn/yilu/rayneopaseo/MikaTaskCoordinator.java',
    'android-addon/tests/MikaTaskCoordinatorTest.java'], { stdio: 'pipe' });
  assert.match(execFileSync('java', ['-cp', out, 'cn.yilu.rayneopaseo.MikaTaskCoordinatorTest'], { encoding: 'utf8' }), /checks passed/);
});
