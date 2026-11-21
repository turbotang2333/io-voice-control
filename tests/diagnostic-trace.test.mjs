import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

test('temporary phone diagnostics exclude content, expire, stay bounded and never interrupt on storage errors', t => {
  const base = join(homedir(), '.local', 'state', 'rayneo-paseo', 'test-diagnostics');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'run-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const classes = join(root, 'classes'); mkdirSync(classes);
  execFileSync('javac', ['-encoding', 'UTF-8', '-d', classes,
    'android-addon/src/cn/yilu/rayneopaseo/DiagnosticTrace.java', 'android-addon/tests/DiagnosticTraceTest.java']);
  const result = execFileSync('java', ['-cp', classes, 'cn.yilu.rayneopaseo.DiagnosticTraceTest', join(root, 'state')], { encoding: 'utf8' });
  assert.match(result, /checks passed/);
});
