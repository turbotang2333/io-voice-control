import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('reader handoff requires its own stop success, runs once and cancels late or rejected replies', () => {
  const source = 'experiments/prompt-display/src/cn/yilu/rayneopaseo/ReaderWakeHandoffGate.java';
  assert.ok(existsSync(source), 'reader stop acknowledgement gate has not been implemented');
  const out = join(homedir(), '.local', 'state', 'rayneo-paseo', 'test-reader-wake-handoff');
  mkdirSync(out, { recursive: true });
  execFileSync('javac', ['-encoding', 'UTF-8', '-d', out, source,
    'experiments/prompt-display/ReaderWakeHandoffGateTest.java'], { stdio: 'pipe' });
  const result = execFileSync('java', ['-cp', out, 'cn.yilu.rayneopaseo.ReaderWakeHandoffGateTest'], { encoding: 'utf8' });
  assert.match(result, /23 reader wake handoff checks passed/);
});
