import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import test from 'node:test';

test('native input trial holds segments until the explicit command and isolates callbacks', () => {
  const out = join(homedir(), '.local', 'state', 'rayneo-paseo', 'test-native-input');
  mkdirSync(out, { recursive: true });
  execFileSync('javac', ['-encoding', 'UTF-8', '-d', out,
    'android-addon/src/cn/yilu/rayneopaseo/ContinuousDraft.java',
    'android-addon/src/cn/yilu/rayneopaseo/TurnGate.java',
    'android-addon/src/cn/yilu/rayneopaseo/VoiceCommand.java',
    'android-addon/src/cn/yilu/rayneopaseo/InteractionPreferences.java',
    'android-addon/src/cn/yilu/rayneopaseo/ShortcutBindings.java',
    'android-addon/src/cn/yilu/rayneopaseo/NativeInputTrial.java',
    'android-addon/tests/NativeInputTrialTest.java'], { stdio: 'pipe' });
  const result = execFileSync('java', ['-cp', out, 'cn.yilu.rayneopaseo.NativeInputTrialTest'], { encoding: 'utf8' });
  assert.match(result, /checks passed/);
});
