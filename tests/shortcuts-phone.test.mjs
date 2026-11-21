import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import test from 'node:test';

test('phone shortcut storage, exact matching, conflict checks and draft snapshots fail closed', () => {
  const out = join(homedir(), '.local/state/rayneo-paseo/test-shortcuts-phone');
  mkdirSync(out, { recursive: true });
  execFileSync('javac', ['-encoding', 'UTF-8', '-d', out,
    ...['VoiceCommand', 'InteractionPreferences', 'InteractionSettings', 'ContinuousDraft', 'TurnGate',
      'ShortcutBindings', 'ShortcutSettings', 'NativeInputTrial'].map(n => `android-addon/src/cn/yilu/rayneopaseo/${n}.java`),
    'android-addon/tests/ShortcutBindingsTest.java'], { stdio: 'pipe', windowsHide: true });
  assert.match(execFileSync('java', ['-cp', out, 'cn.yilu.rayneopaseo.ShortcutBindingsTest'], { encoding: 'utf8' }), /checks passed/);
});
