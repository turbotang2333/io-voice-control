import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import test from 'node:test';

test('phone selects pinned USB TLS or system HTTPS and rejects ambiguous endpoint settings', () => {
  const out = join(homedir(), '.local', 'state', 'rayneo-paseo', 'test-endpoint');
  mkdirSync(out, { recursive: true });
  execFileSync('javac', ['-encoding', 'UTF-8', '-d', out,
    'android-addon/src/cn/yilu/rayneopaseo/BridgeEndpoint.java', 'android-addon/tests/BridgeEndpointTest.java'], { stdio: 'pipe' });
  assert.match(execFileSync('java', ['-cp', out, 'cn.yilu.rayneopaseo.BridgeEndpointTest'], { encoding: 'utf8' }), /checks passed/);
});
