import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync } from 'node:fs';

test('legacy tokens migrate to authenticated encryption without losing other settings', () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/connection-secrets'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'fixture-'));
  execFileSync('javac', ['-encoding', 'UTF-8', '-d', root,
    'android-addon/src/cn/yilu/rayneopaseo/SecretEnvelope.java', 'android-addon/src/cn/yilu/rayneopaseo/ConnectionSecrets.java', 'android-addon/src/cn/yilu/rayneopaseo/NavigationSession.java',
    'android-addon/tests/ConnectionSecretsTest.java'], { stdio: 'pipe' });
  assert.match(execFileSync('java', ['-cp', root, 'cn.yilu.rayneopaseo.ConnectionSecretsTest'], { encoding: 'utf8' }), /connection secret checks passed/);
});
