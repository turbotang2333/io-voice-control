import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import test from 'node:test';

test('local answer browsing preserves text, isolates navigation and never consumes ordinary questions', () => {
  const out = join(homedir(), '.local', 'state', 'rayneo-paseo', 'test-answer-browser');
  mkdirSync(out, { recursive: true });
  const src = 'android-addon/src/cn/yilu/rayneopaseo';
  execFileSync('javac', ['-encoding', 'UTF-8', '-d', out,
    ...readdirSync(src).filter(n => /^(VoiceCommand|AnswerBrowser)\.java$/.test(n)).map(n => join(src, n)),
    'android-addon/tests/AnswerBrowserTest.java'], { stdio: 'pipe' });
  const result = execFileSync('java', ['-cp', out, 'cn.yilu.rayneopaseo.AnswerBrowserTest'], { encoding: 'utf8' });
  assert.match(result, /checks passed/);
});
