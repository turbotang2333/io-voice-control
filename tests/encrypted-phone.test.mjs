import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

test('phone preserves the scanned desktop identity across pairing, persistence and manual settings edits', () => {
  const out = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/encrypted-phone'); mkdirSync(out, { recursive: true });
  execFileSync('javac', ['-encoding', 'UTF-8', '-d', out,
    ...['BridgeEndpoint', 'ConnectionProfiles', 'InteractionPreferences', 'VoiceCommand', 'PairingCode', 'PairingData'].map(n => `android-addon/src/cn/yilu/rayneopaseo/${n}.java`),
    'android-addon/tests/EncryptedPairingTest.java'], { stdio: 'pipe' });
  assert.match(execFileSync('java', ['-cp', out, 'cn.yilu.rayneopaseo.EncryptedPairingTest'], { encoding: 'utf8', stdio: 'pipe' }), /encrypted pairing checks passed/);
});
