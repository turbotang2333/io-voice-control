import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, delimiter } from 'node:path';
import QRCode from 'qrcode';
import { ensureZxing } from '../scripts/prepare-android-deps.mjs';

test('phone decodes the desktop QR and atomically applies only verified backend settings', async () => {
  const out = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/pairing-phone'); mkdirSync(out, { recursive: true });
  const jar = await ensureZxing();
  const uri = 'https://example.test/trial/paseo/pair#rayneo_pair=' + 'x'.repeat(43);
  await QRCode.toFile(join(out, 'desktop-qr.png'), uri, { width: 420, margin: 4, errorCorrectionLevel: 'M' });
  execFileSync('javac', ['-encoding', 'UTF-8', '-cp', jar, '-d', out,
    ...['BridgeEndpoint', 'ConnectionProfiles', 'InteractionPreferences', 'VoiceCommand', 'PairingCode', 'PairingData'].map(n => `android-addon/src/cn/yilu/rayneopaseo/${n}.java`),
    'android-addon/tests/PairingTest.java'], { stdio: 'pipe' });
  const result = execFileSync('java', ['-cp', out + delimiter + jar, 'cn.yilu.rayneopaseo.PairingTest', join(out, 'desktop-qr.png')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(result, /pairing checks passed/);
});
