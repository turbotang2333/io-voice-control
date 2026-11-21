import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import test from 'node:test';

test('phone switches independent connection profiles without losing legacy credentials or accepting an unsafe switch', () => {
  const out = join(homedir(), '.local', 'state', 'rayneo-paseo', 'test-connection-profiles');
  mkdirSync(out, { recursive: true });
  execFileSync('javac', ['-encoding', 'UTF-8', '-d', out,
    'android-addon/src/cn/yilu/rayneopaseo/BridgeEndpoint.java',
    'android-addon/src/cn/yilu/rayneopaseo/ConnectionProfiles.java',
    'android-addon/src/cn/yilu/rayneopaseo/ContinuousDraft.java',
    'android-addon/src/cn/yilu/rayneopaseo/NativeInputTrial.java',
    'android-addon/src/cn/yilu/rayneopaseo/ShortcutBindings.java',
    'android-addon/src/cn/yilu/rayneopaseo/InteractionPreferences.java',
    'android-addon/src/cn/yilu/rayneopaseo/TurnGate.java',
    'android-addon/src/cn/yilu/rayneopaseo/VoiceCommand.java',
    'android-addon/tests/ConnectionProfilesTest.java'], { stdio: 'pipe' });
  assert.match(execFileSync('java', ['-cp', out, 'cn.yilu.rayneopaseo.ConnectionProfilesTest'], { encoding: 'utf8' }), /checks passed/);
});
