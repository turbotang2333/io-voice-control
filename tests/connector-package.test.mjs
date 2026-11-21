import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, copyFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildConnectorPackage } from '../distribution/package.mjs';
const integrity = await import('../distribution/integrity.mjs').catch(error => { if (error.code === 'ERR_MODULE_NOT_FOUND') return {}; throw error; });

async function fixture() {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/connector-package');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'fixture-'));
  const source = join(root, 'source');
  const files = {
    'package.json': JSON.stringify({ name: 'rayneo-paseo', version: '0.1.0', type: 'module', dependencies: { dependency: '1.0.0' } }),
    'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { dependency: '1.0.0' } } } }),
    'bridge/server.mjs': 'export const fixture = true;\n',
    'bridge/server.test.mjs': '// excluded test\n',
    'secure-link/run.mjs': '// secure runtime fixture\n',
    'secure-link/setup.mjs': '// secure setup fixture\n',
    'relay/wizard.mjs': '// relay wizard fixture\n',
    'relay/install.mjs': '// relay installer fixture\n',
    'relay/self-hosted-runtime.py': '# isolated runtime fixture\n',
    'scripts/run-daily.ps1': '# fixture\n',
    'distribution/connector.mjs': '// fixture\n',
    'distribution/launch.mjs': '// fixture launcher\n',
    'distribution/PASEO-LICENSE.txt': 'fixture upstream license\n',
    'LICENSE': 'fixture project license\n',
    'THIRD_PARTY_NOTICES.md': 'fixture third-party notices\n',
    'distribution/Setup.cmd': '@echo off\r\n',
    'node_modules/dependency/package.json': '{"name":"dependency","version":"1.0.0"}',
    'node_modules/dependency/LICENSE': 'fixture license\n',
    '.local-secrets/profile.json': 'private sentinel',
    '.local/state/journal.json': 'private sentinel',
    'node_modules/.cache/embeddings.json': 'private sentinel',
    'scripts/prepare-release.mjs': '// personal release helper\n',
  };
  for (const [name, data] of Object.entries(files)) {
    await mkdir(join(source, name, '..'), { recursive: true });
    await writeFile(join(source, name), data);
  }
  const runtime = join(root, 'node.exe'), license = join(root, 'LICENSE');
  await writeFile(runtime, 'synthetic runtime'); await writeFile(license, 'synthetic license');
  return { source, root, runtime, license, output: join(root, 'output') };
}

test('portable package verification rejects changed, extra and escaped files before setup starts', async () => {
  const f = await fixture(); await buildConnectorPackage({ source: f.source, output: f.output, runtime: f.runtime, runtimeLicense: f.license });
  assert.equal((await integrity.verifyConnectorPackage(f.output)).verified, true);
  const file = join(f.output, 'app/bridge/server.mjs'), original = await readFile(file);
  await writeFile(file, 'modified');
  await assert.rejects(integrity.verifyConnectorPackage(f.output), { code: 'PACKAGE_INTEGRITY_FAILED' });
  await writeFile(file, original);
  await writeFile(join(f.output, 'app/unlisted.mjs'), 'unexpected');
  await assert.rejects(integrity.verifyConnectorPackage(f.output), { code: 'PACKAGE_INTEGRITY_FAILED' });
  const clean = await fixture(); await buildConnectorPackage({ source: clean.source, output: clean.output, runtime: clean.runtime, runtimeLicense: clean.license });
  const manifestFile = join(clean.output, 'manifest.json'), manifest = JSON.parse(await readFile(manifestFile));
  manifest.files[0].path = '../outside'; await writeFile(manifestFile, JSON.stringify(manifest));
  await assert.rejects(integrity.verifyConnectorPackage(clean.output), { code: 'PACKAGE_INTEGRITY_FAILED' });
});

test('portable package includes only runtime code and dependencies, with hashes and no personal state', async () => {
  const f = await fixture();
  const receipt = await buildConnectorPackage({ source: f.source, output: f.output, runtime: f.runtime, runtimeLicense: f.license });
  assert.equal(receipt.version, '0.2.0-trial.1');
  const manifest = JSON.parse(await readFile(join(f.output, 'manifest.json'), 'utf8'));
  const names = manifest.files.map(f => f.path);
  for (const name of ['runtime/node.exe', 'runtime/LICENSE', 'app/bridge/server.mjs', 'app/secure-link/run.mjs', 'app/secure-link/setup.mjs', 'app/relay/wizard.mjs', 'app/relay/install.mjs', 'app/relay/self-hosted-runtime.py', 'app/scripts/run-daily.ps1', 'app/node_modules/dependency/LICENSE', 'app/distribution/connector.mjs', 'Setup.cmd']) assert.ok(names.includes(name), name);
  assert.ok(names.every(n => !/local-secrets|journal|\.cache|\.test\.|prepare-release/.test(n)));
  assert.ok(manifest.files.every(f => /^[a-f0-9]{64}$/.test(f.sha256) && f.bytes >= 0));
  assert.equal(await readFile(join(f.output, 'app/distribution/PASEO-LICENSE.txt'), 'utf8'), 'fixture upstream license\n');
  assert.equal(await readFile(join(f.output, 'app/LICENSE'), 'utf8'), 'fixture project license\n');
  assert.equal(await readFile(join(f.output, 'app/THIRD_PARTY_NOTICES.md'), 'utf8'), 'fixture third-party notices\n');
  assert.ok(names.includes('app/LICENSE') && names.includes('app/THIRD_PARTY_NOTICES.md'));
  assert.equal(receipt.personalConfigurationIncluded, false);
  assert.equal(receipt.modelMessagesSent, 0);
});

test('a connector package rejects missing project licensing documents', async () => {
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    const f = await fixture();
    await unlink(join(f.source, name));
    await assert.rejects(buildConnectorPackage({ source: f.source, output: f.output, runtime: f.runtime, runtimeLicense: f.license }),
      { code: 'PACKAGE_PROJECT_LICENSE_MISSING' });
  }
});

test('a connector package cannot be built without the Paseo license', async () => {
  const f = await fixture();
  await unlink(join(f.source, 'distribution/PASEO-LICENSE.txt'));
  await assert.rejects(buildConnectorPackage({ source: f.source, output: f.output, runtime: f.runtime, runtimeLicense: f.license }),
    { code: 'PACKAGE_PASEO_LICENSE_MISSING' });
});

test('existing output is preserved and dependency links cannot escape into private folders', async () => {
  const f = await fixture();
  await mkdir(f.output); await writeFile(join(f.output, 'keep'), 'keep');
  await assert.rejects(buildConnectorPackage({ source: f.source, output: f.output, runtime: f.runtime, runtimeLicense: f.license }), { code: 'PACKAGE_OUTPUT_EXISTS' });
  assert.equal(await readFile(join(f.output, 'keep'), 'utf8'), 'keep');
  const privateDir = join(f.root, 'private'); await mkdir(privateDir); await writeFile(join(privateDir, 'credential'), 'private sentinel');
  await symlink(privateDir, join(f.source, 'node_modules', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(buildConnectorPackage({ source: f.source, output: join(f.root, 'rejected'), runtime: f.runtime, runtimeLicense: f.license }), { code: 'PACKAGE_LINK_REJECTED' });
});

test('source dependency fingerprint and runtime license are required before any packaging', async () => {
  const f = await fixture();
  await writeFile(join(f.source, 'package-lock.json'), JSON.stringify({ packages: { '': { dependencies: { dependency: 'different' } } } }));
  await assert.rejects(buildConnectorPackage({ source: f.source, output: f.output, runtime: f.runtime, runtimeLicense: f.license }), { code: 'PACKAGE_LOCK_MISMATCH' });
});

test('portable package includes and verifies the optional desktop tray launcher', async () => {
  const f = await fixture(), tray = join(f.root, 'tray.exe');
  await writeFile(tray, Buffer.from('MZsynthetic-tray'));
  await buildConnectorPackage({ source: f.source, output: f.output, runtime: f.runtime, runtimeLicense: f.license, trayExecutable: tray });
  const manifest = JSON.parse(await readFile(join(f.output, 'manifest.json'), 'utf8'));
  assert.ok(manifest.files.some(entry => entry.path === '眼镜连接器.exe'));
  assert.equal((await integrity.verifyConnectorPackage(f.output)).verified, true);
  await writeFile(join(f.output, '眼镜连接器.exe'), 'tampered');
  await assert.rejects(integrity.verifyConnectorPackage(f.output), { code: 'PACKAGE_INTEGRITY_FAILED' });
});

test('a Windows package compiles its own tray launcher when the source includes it', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture();
  await copyFile(new URL('../distribution/Tray.cs', import.meta.url), join(f.source, 'distribution/Tray.cs'));
  await buildConnectorPackage({ source: f.source, output: f.output, runtime: f.runtime, runtimeLicense: f.license });
  const tray = await readFile(join(f.output, '眼镜连接器.exe'));
  assert.equal(tray.subarray(0, 2).toString(), 'MZ');
  assert.equal((await integrity.verifyConnectorPackage(f.output)).verified, true);
});
