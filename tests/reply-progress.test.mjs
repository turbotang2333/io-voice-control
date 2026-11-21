import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

test('lens status uses real events once per request and never marks search or failed turns complete', () => {
  const out = join(homedir(), '.local/state/rayneo-paseo/test-reply-progress');
  mkdirSync(out, { recursive: true });
  execFileSync('javac', ['-encoding', 'UTF-8', '-d', out,
    'android-addon/src/cn/yilu/rayneopaseo/VoiceCommand.java',
    'android-addon/src/cn/yilu/rayneopaseo/InteractionPreferences.java',
    'android-addon/src/cn/yilu/rayneopaseo/ReplyProgress.java', 'android-addon/tests/ReplyProgressTest.java']);
  assert.match(execFileSync('java', ['-cp', out, 'cn.yilu.rayneopaseo.ReplyProgressTest'], { encoding: 'utf8' }), /checks passed/);
});
