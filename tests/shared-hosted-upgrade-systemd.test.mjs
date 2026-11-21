import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import net from 'node:net';
import { createSharedInfrastructurePlan } from '../relay/shared-infrastructure.mjs';
import { createSharedHostedUpgradePlan } from '../relay/shared-hosted-upgrade-plan.mjs';
import { prepareSharedUpgradeFiles } from '../relay/shared-hosted-upgrade-files.mjs';
import { createSharedHostedUpgradeDriver, recoverSharedHostedUpgrade } from '../relay/shared-hosted-upgrade-driver.mjs';
import { createSharedHostedSystemdService } from '../relay/shared-hosted-systemd-service.mjs';
import { executeSharedHostedUpgrade } from '../relay/shared-hosted-upgrade-transaction.mjs';
import { DatabaseSync } from 'node:sqlite';

const enabled = process.platform === 'linux' && process.geteuid?.() === 0 && process.env.RAYNEO_RUN_GUARD_SYSTEMD_TEST === '1';
const run = (name, args) => execFileSync(name, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 25000 });
const freePort = () => new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
const sshkey = n => 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, n)]).toString('base64');

async function fixture(t) {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/upgrade-systemd');
  mkdirSync(parent, { recursive: true }); const root = mkdtempSync(join(parent, 'fixture-'));
  const local = path => join(root, path.replace(/^\/+/, '')); writeFileSync(join(root, '.rayneo-upgrade-test-only'), 'synthetic');
  const port = await freePort(), config = { version: 1, listenHost: '127.0.0.1', listenPort: port,
    databasePath: '/var/lib/rayneo-paseo-shared-hosted/registry.sqlite', tlsKeyPath: '/etc/example/key.pem', tlsCertPath: '/etc/example/cert.pem', maxAllocations: 100,
    shared: { publicBaseUrl: 'https://relay.example.test:24443', relay: { host: 'ssh.example.test', port: 2222, hostKey: sshkey(2) } },
    infrastructure: { publicPort: 24443, sshPort: 2222, suffix: 'relay.example.test', nodePath: '/usr/local/bin/node', listenHost: '127.0.0.1' } };
  const current = {}, candidate = {};
  for (const path of createSharedInfrastructurePlan(config.infrastructure).sourceFiles) {
    const isNew = /\/invite-(store|admin)\.mjs$/.test(path), data = Buffer.from('old:' + path);
    current[path] = isNew ? null : data; candidate[path] = isNew ? Buffer.from('new:' + path) : data;
    if (!isNew) { mkdirSync(dirname(local(path)), { recursive: true }); writeFileSync(local(path), data); }
  }
  candidate['/opt/rayneo-paseo-shared/relay/shared-hosted-runtime.mjs'] = Buffer.from('new-runtime');
  const text = JSON.stringify(config) + '\n', configPath = local('/etc/rayneo-paseo-shared/hosted.json');
  mkdirSync(dirname(configPath), { recursive: true }); writeFileSync(configPath, text);
  mkdirSync(local('/var/lib/rayneo-paseo-shared-hosted'), { recursive: true });
  const lockPath = local('/var/lib/rayneo-paseo-shared-hosted/upgrade-startup-lock.sqlite');
  const lock = new DatabaseSync(lockPath); lock.exec('CREATE TABLE guard (id INTEGER)'); lock.close(); chmodSync(lockPath, 0o600);
  const registry = local('/var/lib/rayneo-paseo-shared-hosted/registry.sqlite'); writeFileSync(registry, 'original-registration');
  const plan = createSharedHostedUpgradePlan({ currentConfigText: text, currentSources: current, candidateSources: candidate });
  const certPath = join(root, 'cert.pem'), keyPath = join(root, 'key.pem');
  run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost', '-keyout', keyPath, '-out', certPath]);
  const cert = readFileSync(certPath), guardScript = join(root, 'guard.mjs'), serverScript = join(root, 'server.mjs');
  const guard = pathToFileURL(join(process.cwd(), 'relay/shared-hosted-upgrade-guard.mjs')).href;
  writeFileSync(guardScript, `import {checkUpgradeStartup} from ${JSON.stringify(guard)}; if (!checkUpgradeStartup({root:${JSON.stringify(root)}})) process.exit(3);\n`);
  writeFileSync(serverScript, `import https from 'node:https'; import {readFileSync} from 'node:fs';\n`
    + `const cfg=JSON.parse(readFileSync(${JSON.stringify(configPath)},'utf8'));\n`
    + `const s=https.createServer({key:readFileSync(${JSON.stringify(keyPath)}),cert:readFileSync(${JSON.stringify(certPath)})},(q,r)=>{r.writeHead(q.method==='POST'?(cfg.inviteDatabasePath?403:503):404);r.end();});\n`
    + `s.listen(cfg.listenPort,'127.0.0.1');process.on('SIGTERM',()=>s.close());\n`);
  const suffix = randomUUID(), unit = `rayneo-upgrade-fixture-${suffix}.service`, anchor = `rayneo-upgrade-anchor-${suffix}.service`;
  t.after(() => { try { run('systemctl', ['stop', anchor, unit]); } catch {} });
  run('systemd-run', ['--unit=' + unit, '-p', `ExecStartPre=/usr/local/bin/node ${guardScript}`, '/usr/local/bin/node', serverScript]);
  run('systemd-run', ['--remain-after-exit', '--unit=' + anchor, '-p', 'Wants=' + unit, '/usr/bin/true']);
  const systemctl = args => run('systemctl', args.map(value => value === 'rayneo-shared-hosted.service' ? unit : value));
  const enrollment = { version: 1, installationId: randomUUID(), requestedBackends: ['paseo'], sshPublicKey: sshkey(1) };
  const base = createSharedHostedSystemdService({ run: systemctl, readCertificate: () => cert,
    reserveEnrollment: () => ({ enrollment, release() {} }), attempts: 30 });
  const service = { ...base, async guardReady() {
    const value = systemctl(['show', 'rayneo-shared-hosted.service', '--property=ExecStartPre', '--value']);
    return value.includes(`argv[]=/usr/local/bin/node ${guardScript} ;`);
  } };
  assert.equal(await service.verifyOld(config), true);
  return { root, local, configPath, text, registry, plan, unit, service };
}

test('real systemd service upgrades and verifies the invitation gate', { skip: !enabled, timeout: 60000 }, async t => {
  const f = await fixture(t), driver = createSharedHostedUpgradeDriver({ root: f.root, service: f.service });
  assert.deepEqual(await executeSharedHostedUpgrade(f.plan, driver), { upgraded: true });
  assert.equal(JSON.parse(readFileSync(f.configPath, 'utf8')).inviteDatabasePath, '/var/lib/rayneo-paseo-shared-hosted/invites.sqlite');
  assert.equal(readFileSync(f.registry, 'utf8'), 'original-registration');
});

test('real systemd blocks a partial upgrade and recovery restores service', { skip: !enabled, timeout: 60000 }, async t => {
  const f = await fixture(t), files = prepareSharedUpgradeFiles({ root: f.root, plan: f.plan });
  await f.service.stop(); files.replaceSource(0);
  await assert.rejects(f.service.start());
  assert.deepEqual(await recoverSharedHostedUpgrade({ root: f.root, service: f.service }), { recovered: true });
  assert.equal(readFileSync(f.configPath, 'utf8'), f.text);
  assert.equal(readFileSync(f.registry, 'utf8'), 'original-registration');
});
