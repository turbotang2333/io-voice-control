import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareReleaseSigning, inspectReleaseSigning } from '../scripts/prepare-release-signing.mjs';

async function fixture() {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/release-signing');
  await mkdir(parent, { recursive: true });
  return join(await mkdtemp(join(parent, 'fixture-')), 'signing');
}

test('release signing creates a long-lived key once and reuses it without replacement', async () => {
  const directory = await fixture();
  const first = await prepareReleaseSigning({ directory });
  assert.equal((await inspectReleaseSigning({ directory })).expiresAt, first.expiresAt);
  const before = await readFile(join(directory, 'signing.p12'));
  assert.equal(first.created, true);
  assert.ok(Date.parse(first.expiresAt) > Date.now() + 25 * 365 * 86400000);
  const again = await prepareReleaseSigning({ directory });
  assert.equal(again.created, false);
  assert.deepEqual(await readFile(join(directory, 'signing.p12')), before);
  assert.deepEqual((await readdir(directory)).sort(), ['settings.json', 'signing.p12']);
});

test('an incomplete or unexpected signing directory is never overwritten', async () => {
  const directory = await fixture();
  await mkdir(directory); await writeFile(join(directory, 'keep'), 'existing');
  await assert.rejects(prepareReleaseSigning({ directory }), error => ['RELEASE_SIGNING_INCOMPLETE', 'RELEASE_SIGNING_UNSAFE'].includes(error.code));
  assert.equal(await readFile(join(directory, 'keep'), 'utf8'), 'existing');
});

test('checking signing readiness never creates a key', async () => {
  const directory = await fixture();
  await assert.rejects(inspectReleaseSigning({ directory }), { code: 'RELEASE_SIGNING_INCOMPLETE' });
  await assert.rejects(readFile(join(directory, 'signing.p12')), { code: 'ENOENT' });
});

test('a release build requires an explicitly selected original APK', { skip: process.platform !== 'win32' }, async () => {
  const home = await fixture(); await mkdir(home);
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(process.cwd(), 'scripts/build-android.ps1'),
    '-ReleaseSigning'], { env: { ...process.env, USERPROFILE: home }, encoding: 'utf8', windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /Release build requires an explicitly selected original APK/);
  await assert.rejects(readFile(join(home, '.local-secrets/rayneo-paseo/release-signing/signing.p12')), { code: 'ENOENT' });
});

test('a release build stops before processing an APK when its release key is missing', { skip: process.platform !== 'win32' }, async () => {
  const home = await fixture(); await mkdir(home);
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(process.cwd(), 'scripts/build-android.ps1'),
    '-ReleaseSigning', '-InputApk', join(home, 'missing.apk')], { env: { ...process.env, USERPROFILE: home }, encoding: 'utf8', windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /Release signing is not ready/);
  await assert.rejects(readFile(join(home, '.local-secrets/rayneo-paseo/release-signing/signing.p12')), { code: 'ENOENT' });
});
