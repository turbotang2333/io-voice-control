import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import test from 'node:test';

test('phone turn gate rejects stale replies, duplicate finals and wrong sessions', () => {
  const out = join(homedir(), '.local', 'state', 'rayneo-paseo', 'test-java');
  mkdirSync(out, { recursive: true });
  execFileSync('javac', ['-encoding', 'UTF-8', '-d', out,
    'android-addon/src/cn/yilu/rayneopaseo/TurnGate.java',
    'android-addon/src/cn/yilu/rayneopaseo/TurnFinalizer.java',
    'android-addon/src/cn/yilu/rayneopaseo/DisplayChunks.java',
    'android-addon/src/cn/yilu/rayneopaseo/ContinuousDraft.java',
    'android-addon/tests/TurnGateTest.java', 'android-addon/tests/ContinuousDraftTest.java'], { stdio: 'pipe' });
  const result = execFileSync('java', ['-cp', out, 'cn.yilu.rayneopaseo.TurnGateTest'], { encoding: 'utf8' });
  assert.match(result, /checks passed/);
  execFileSync('java', ['-cp', out, 'cn.yilu.rayneopaseo.ContinuousDraftTest'], { encoding: 'utf8' });
});
