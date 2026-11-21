import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedInfrastructurePlan } from '../relay/shared-infrastructure.mjs';
import { createSharedHostedUpgradePlan } from '../relay/shared-hosted-upgrade-plan.mjs';
import { prepareSharedUpgradeFiles } from '../relay/shared-hosted-upgrade-files.mjs';
import { DatabaseSync } from 'node:sqlite';
import { acquireSharedUpgradeStartupLock } from '../relay/shared-hosted-upgrade-lock.mjs';

test('systemd blocks an interrupted upgrade and starts after recovery', {
  skip: process.platform !== 'linux' || process.geteuid?.() !== 0 || process.env.RAYNEO_RUN_GUARD_SYSTEMD_TEST !== '1', timeout: 60000,
}, () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/upgrade-guard-systemd');
  mkdirSync(parent, { recursive: true }); const root = mkdtempSync(join(parent, 'fixture-'));
  const local = path => join(root, path.replace(/^\/+/, ''));
  writeFileSync(join(root, '.rayneo-upgrade-test-only'), 'synthetic');
  const key = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64');
  const config = { version: 1, listenHost: '127.0.0.1', listenPort: 28445, databasePath: '/var/lib/rayneo-paseo-shared-hosted/registry.sqlite',
    tlsKeyPath: '/etc/example/key.pem', tlsCertPath: '/etc/example/cert.pem', maxAllocations: 5000,
    shared: { publicBaseUrl: 'https://relay.example.test:24443', relay: { host: 'ssh.example.test', port: 2222, hostKey: key } },
    infrastructure: { publicPort: 24443, sshPort: 2222, suffix: 'relay.example.test', nodePath: '/usr/local/bin/node', listenHost: '127.0.0.1' } };
  const paths = createSharedInfrastructurePlan(config.infrastructure).sourceFiles, current = {}, candidate = {};
  for (const path of paths) {
    const isNew = /\/invite-(store|admin)\.mjs$/.test(path), data = Buffer.from('old:' + path);
    current[path] = isNew ? null : data; candidate[path] = isNew ? Buffer.from('new:' + path) : data;
    if (!isNew) { mkdirSync(dirname(local(path)), { recursive: true }); writeFileSync(local(path), data); }
  }
  candidate['/opt/rayneo-paseo-shared/relay/shared-hosted-runtime.mjs'] = Buffer.from('new-runtime');
  const text = JSON.stringify(config) + '\n', configPath = local('/etc/rayneo-paseo-shared/hosted.json');
  mkdirSync(dirname(configPath), { recursive: true }); writeFileSync(configPath, text);
  mkdirSync(local('/var/lib/rayneo-paseo-shared-hosted'), { recursive: true });
  const lockPath = local('/var/lib/rayneo-paseo-shared-hosted/upgrade-startup-lock.sqlite');
  const db = new DatabaseSync(lockPath); db.exec('CREATE TABLE guard (id INTEGER)'); db.close(); chmodSync(lockPath, 0o600);
  const plan = createSharedHostedUpgradePlan({ currentConfigText: text, currentSources: current, candidateSources: candidate });
  const files = prepareSharedUpgradeFiles({ root, plan });
  const wrapper = join(root, 'startup-check.mjs');
  const guard = pathToFileURL(join(process.cwd(), 'relay/shared-hosted-upgrade-guard.mjs')).href;
  writeFileSync(wrapper, `import {checkUpgradeStartup} from ${JSON.stringify(guard)}; if (!checkUpgradeStartup({root:${JSON.stringify(root)}})) process.exit(3);\n`);
  const run = () => spawnSync('systemd-run', ['--wait', '--collect', '--unit=rayneo-guard-test-' + randomUUID(),
    '-p', `ExecStartPre=/usr/local/bin/node ${wrapper}`, '/usr/bin/true'], { encoding: 'utf8', timeout: 20000 });
  const held = acquireSharedUpgradeStartupLock({ root });
  try { const locked = run(); assert.equal(locked.error, undefined); assert.notEqual(locked.status, 0); }
  finally { held.release(); }
  files.replaceSource(0);
  const blocked = run(); assert.equal(blocked.error, undefined); assert.notEqual(blocked.status, 0);
  files.restore();
  const recovered = run(); assert.equal(recovered.error, undefined); assert.equal(recovered.status, 0, recovered.stderr);
});
