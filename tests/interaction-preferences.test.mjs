import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

test('phone preferences validate commands, preserve defaults and publish only successfully saved snapshots', () => {
  const out = join(homedir(), '.local/state/rayneo-paseo/test-interaction-preferences');
  mkdirSync(out, { recursive: true });
  execFileSync('javac', ['-encoding', 'UTF-8', '-d', out,
    ...['VoiceCommand', 'InteractionPreferences', 'InteractionSettings'].map(n => `android-addon/src/cn/yilu/rayneopaseo/${n}.java`),
    'android-addon/tests/InteractionPreferencesTest.java']);
  assert.match(execFileSync('java', ['-cp', out, 'cn.yilu.rayneopaseo.InteractionPreferencesTest'], { encoding: 'utf8' }), /checks passed/);
});
