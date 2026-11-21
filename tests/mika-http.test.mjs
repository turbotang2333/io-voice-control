import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
test('Mika HTTP uses HTTPS, bearer authentication and reports uncertain writes', () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/mika-http');
  mkdirSync(parent, { recursive: true });
  const out = mkdtempSync(join(parent, 'run-'));
  execFileSync('javac', ['-encoding', 'UTF-8', '-d', out,
    'android-addon/src/cn/yilu/rayneopaseo/MikaHttp.java', 'android-addon/tests/MikaHttpTest.java'], { stdio: 'pipe' });
  assert.match(execFileSync('java', ['-cp', out, 'cn.yilu.rayneopaseo.MikaHttpTest'], { encoding: 'utf8' }), /checks passed/);
});
