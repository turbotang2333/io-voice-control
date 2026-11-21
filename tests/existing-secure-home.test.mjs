import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepareExistingSecureHome } from '../distribution/existing-secure-home.mjs';

const key = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64');
function fixture() {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/existing-secure'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'fixture-')), privateDirectory = join(root, 'private');
  mkdirSync(join(privateDirectory, 'shared-runtime'), { recursive: true });
  writeFileSync(join(privateDirectory, 'daily.json'), JSON.stringify({ port: 7468, apiToken: 'a'.repeat(64), extra: 'keep' }));
  writeFileSync(join(privateDirectory, 'shared-runtime/connector.json'), JSON.stringify({ port: 19469, token: 'b'.repeat(64), extra: 'keep' }));
  writeFileSync(join(privateDirectory, 'local.cer'), readFileSync(new URL('./fixtures/connector-public-test.cer', import.meta.url)));
  const prepareKey = path => { writeFileSync(path, 'fixture-private-key'); writeFileSync(path + '.pub', key); };
  return { privateDirectory, prepareKey, protectDirectory: () => {} };
}
test('existing setup creates an isolated secure home without changing old settings or exporting their credentials', async () => {
  const f = fixture(), daily = readFileSync(join(f.privateDirectory, 'daily.json'));
  const result = await prepareExistingSecureHome(f);
  assert.deepEqual(result.enrollment.requestedBackends, ['paseo', 'codex']);
  assert.equal(result.privateDirectory, join(f.privateDirectory, 'secure-existing'));
  assert.deepEqual(readFileSync(join(f.privateDirectory, 'daily.json')), daily);
  assert.ok(!JSON.stringify(result.enrollment).includes('a'.repeat(64)));
  assert.ok(!JSON.stringify(result.enrollment).includes('b'.repeat(64)));
  assert.equal(existsSync(join(f.privateDirectory, 'installation.json')), false);
  const repeat = await prepareExistingSecureHome({ ...f, prepareKey: () => assert.fail('must reuse identity') });
  assert.equal(repeat.enrollment.installationId, result.enrollment.installationId);
});
test('failure while preparing an existing installation never publishes a partial secure home', async () => {
  const f = fixture();
  await assert.rejects(prepareExistingSecureHome({ ...f, prepareKey: () => { throw Error('synthetic failure'); } }), /synthetic failure/);
  assert.equal(existsSync(join(f.privateDirectory, 'secure-existing')), false);
  assert.equal(existsSync(join(f.privateDirectory, 'daily.json')), true);
});
test('Windows can prepare an existing installation using its native SSH key and protected directory', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture(), result = await prepareExistingSecureHome({ privateDirectory: f.privateDirectory });
  const publicKey = execFileSync('ssh-keygen.exe', ['-y', '-f', join(result.privateDirectory, 'relay-key.pem')],
    { encoding: 'utf8', windowsHide: true, stdio: 'pipe', timeout: 30000 }).trim().split(/\s+/).slice(0, 2).join(' ');
  assert.equal(publicKey, result.enrollment.sshPublicKey);
});
