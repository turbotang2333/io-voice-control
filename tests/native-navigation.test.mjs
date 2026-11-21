import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

test('phone navigation epochs are initialized once, atomic with settings, and never reused after restart', t => {
  const source = 'android-addon/src/cn/yilu/rayneopaseo/NavigationSession.java';
  assert.ok(existsSync(source), 'the phone needs a persistent navigation boundary');
  const base = join(homedir(), '.local', 'state', 'rayneo-paseo', 'recent-acceptance-tests');
  mkdirSync(base, { recursive: true });
  const out = mkdtempSync(join(base, 'java-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  execFileSync('javac', ['-encoding', 'UTF-8', '-d', out, source, 'android-addon/tests/NavigationSessionTest.java']);
  assert.match(execFileSync('java', ['-cp', out, 'cn.yilu.rayneopaseo.NavigationSessionTest'], { encoding: 'utf8' }), /checks passed/);
});
