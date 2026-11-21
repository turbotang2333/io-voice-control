import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

test('phone navigation tolerates a slow mobile handshake and retries only bounded, current metadata requests', () => {
  const source = 'android-addon/src/cn/yilu/rayneopaseo/NavigationTransport.java';
  assert.ok(existsSync(source), 'navigation handshake still has the five-second mobile timeout');
  const out = join(homedir(), '.local/state/rayneo-paseo/test-navigation-transport');
  mkdirSync(out, { recursive: true });
  execFileSync('javac', ['-encoding', 'UTF-8', '-d', out,
    'android-addon/src/cn/yilu/rayneopaseo/BridgeEndpoint.java', source,
    'android-addon/tests/NavigationTransportTest.java'], { stdio: 'pipe' });
  assert.match(execFileSync('java', ['-cp', out, 'cn.yilu.rayneopaseo.NavigationTransportTest'],
    { encoding: 'utf8', timeout: 30000 }), /Navigation transport checks passed/);
});
