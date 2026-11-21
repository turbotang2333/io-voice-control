import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createDecipheriv, createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as recovery from '../scripts/phone-recovery.mjs';

test('encrypted settings preserve types and identity, reject corruption, and roll back partial or interrupted restores', () => {
  const out = join(homedir(), '.local', 'state', 'rayneo-paseo', 'test-settings-recovery');
  mkdirSync(out, { recursive: true });
  const names = ['SettingsSnapshot', 'RecoveryArchive', 'RecoveryTransaction', 'ConnectionProfiles', 'BridgeEndpoint',
    'InteractionPreferences', 'ShortcutBindings', 'ShortcutScopes', 'VoiceCommand'];
  execFileSync('javac', ['-encoding', 'UTF-8', '-d', out, ...names.map(name => `android-addon/src/cn/yilu/rayneopaseo/${name}.java`),
    'android-addon/tests/SettingsRecoveryTest.java'], { stdio: 'pipe' });
  assert.match(execFileSync('java', ['-cp', out, 'cn.yilu.rayneopaseo.SettingsRecoveryTest', out], { encoding: 'utf8' }), /settings recovery checks passed/);
  const encrypted = readFileSync(join(out, 'fixture.rpb'));
  const header = Buffer.from('RAYNEO-PASEO-RECOVERY-1\n');
  assert.deepEqual(encrypted.subarray(0, header.length), header);
  const decipher = createDecipheriv('aes-256-gcm', Buffer.alloc(32, 7), encrypted.subarray(header.length, header.length + 12));
  decipher.setAAD(header); decipher.setAuthTag(encrypted.subarray(-16));
  assert.deepEqual(Buffer.concat([decipher.update(encrypted.subarray(header.length + 12, -16)), decipher.final()]), readFileSync(join(out, 'fixture.bin')));
  const plain = recovery.decryptArchive(encrypted, Buffer.alloc(32, 7)), snapshot = recovery.decodeSnapshot(plain);
  assert.equal(snapshot.groups.rayneo_paseo_probe.get('futureFloat').value, 1.25);
  assert.equal(snapshot.groups.rayneo_paseo_probe.get('navigation_epoch').value, 12n);
  assert.equal(recovery.navigationFloor(snapshot, [{ version: 1, owner: snapshot.owner, highestEpoch: 70 },
    { version: 1, owner: 'different-phone', highestEpoch: 1000 }]), 70);
  assert.throws(() => recovery.decodeSnapshot(Buffer.concat([plain, Buffer.from([0])])));
  assert.throws(() => recovery.decryptArchive(encrypted, Buffer.alloc(32, 8)));
  assert.throws(() => recovery.checkedResponse({ ok: true, nonce: 'old' }, 'new'));
  assert.throws(() => recovery.checkedResponse({ ok: false, nonce: 'new', code: 'BUSY' }, 'new'), { code: 'PHONE_HAS_UNFINISHED_TURN' });
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const response = { archive: encrypted.toString('base64'), archiveSha256: hash(encrypted), snapshotSha256: hash(plain),
    preferenceCounts: Object.fromEntries(Object.entries(snapshot.counts).reverse()) };
  assert.equal(typeof recovery.checkedBackup, 'function');
  assert.deepEqual(recovery.checkedBackup(response, Buffer.alloc(32, 7)).snapshot.counts, snapshot.counts);
  assert.throws(() => recovery.checkedBackup({ ...response, snapshotSha256: '0'.repeat(64) }, Buffer.alloc(32, 7)));
});
