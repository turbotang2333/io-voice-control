import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
test('local Mika transport reaches only the phone loopback with authentication', () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/mika-local-http');
  mkdirSync(parent, { recursive: true }); const out = mkdtempSync(join(parent, 'run-'));
  execFileSync('javac', ['-encoding', 'UTF-8', '-d', out,
    'android-addon/src/cn/yilu/rayneopaseo/MikaHttp.java',
    'android-addon/src/cn/yilu/rayneopaseo/MikaLocalHttp.java',
    'android-addon/tests/MikaLocalHttpTest.java'], { stdio: 'pipe' });
  assert.match(execFileSync('java', ['-cp', out, 'cn.yilu.rayneopaseo.MikaLocalHttpTest'], { encoding: 'utf8' }), /checks passed/);
});
