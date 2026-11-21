import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharedInfrastructurePlan, inspectSharedInfrastructure, installSharedInfrastructure } from '../relay/shared-infrastructure.mjs';
import { validateSharedRouterConfig, createSharedRouterService } from '../relay/shared-router-launch.mjs';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

test('shared infrastructure uses two fixed listeners and an unprivileged router', () => {
  const plan = createSharedInfrastructurePlan({ publicPort: 24443, sshPort: 2222, suffix: 'relay.example.test', nodePath: '/usr/bin/node' });
  assert.equal(plan.routerConfig.listenPort, 24443);
  assert.equal(plan.routerConfig.suffix, 'relay.example.test');
  assert.match(plan.sshdConfig, /^Port 2222$/m);
  assert.match(plan.routerUnit, /^User=rayneo-router$/m);
  assert.match(plan.routerUnit, /^Group=rayneo-relay$/m);
  assert.match(plan.routerUnit, /^NoNewPrivileges=yes$/m);
  assert.match(plan.sshUnit, /^ExecStart=\/usr\/sbin\/sshd -D -e -f /m);
  for (const bad of [
    { publicPort: 2222 }, { sshPort: 0 }, { suffix: 'localhost' }, { nodePath: '/usr/bin/node\nExecStart=/bin/sh' },
  ]) assert.throws(() => createSharedInfrastructurePlan({ publicPort: 24443, sshPort: 2222, suffix: 'relay.example.test', nodePath: '/usr/bin/node', ...bad }));
});

test('account activation can trust infrastructure only while files and running services match', async () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/shared-infrastructure'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'fixture-'));
  const options = { publicPort: 24443, sshPort: 2222, suffix: 'relay.example.test', nodePath: '/usr/bin/node' };
  const plan = createSharedInfrastructurePlan(options);
  for (const [path, content] of Object.entries(plan.files)) {
    const full = join(root, path); mkdirSync(join(full, '..'), { recursive: true }); writeFileSync(full, content);
  }
  for (const path of plan.sourceFiles) { const full = join(root, path); mkdirSync(join(full, '..'), { recursive: true }); writeFileSync(full, 'fixture'); }
  mkdirSync(join(root, 'var/lib/rayneo-shared'), { recursive: true });
  let changed = false;
  const run = (command, args) => {
    if (command === 'getent' && args[0] === 'group') return 'rayneo-relay:x:1234:';
    if (command === 'getent' && args[0] === 'passwd') return 'rayneo-router:x:1235:1234::/nonexistent:/usr/sbin/nologin';
    if (command === 'id') return '1234';
    if (command === 'systemctl' && args[0] === 'is-active') return '';
    if (command === 'systemctl' && args.includes('--property=FragmentPath')) return `/etc/systemd/system/${args.at(-1)}`;
    if (command === 'systemctl' && args.includes('--property=NeedDaemonReload')) return changed ? 'yes' : 'no';
    if (command === 'sshd') return '';
    throw Error('unexpected command');
  };
  assert.equal(await inspectSharedInfrastructure(options, { root, strictOwners: false, run }), true);
  changed = true;
  assert.equal(await inspectSharedInfrastructure(options, { root, strictOwners: false, run }), false);
  changed = false;
  writeFileSync(join(root, '/etc/rayneo-paseo-shared/sshd_config'), plan.sshdConfig + 'PermitRootLogin yes\n');
  assert.equal(await inspectSharedInfrastructure(options, { root, strictOwners: false, run }), false);
});

test('router launcher accepts only a fixed suffix and a bounded listener configuration', () => {
  const valid = { version: 1, listenHost: '127.0.0.1', listenPort: 24443, suffix: 'relay.example.test' };
  assert.deepEqual(validateSharedRouterConfig(valid), valid);
  const server = createSharedRouterService(valid);
  assert.equal(server.listening, false);
  for (const bad of [{ version: 2 }, { listenHost: '8.8.8.8' }, { listenPort: 0 }, { suffix: 'invalid' }, { extra: true }]) {
    assert.throws(() => validateSharedRouterConfig({ ...valid, ...bad }));
  }
});

test('installation performs read-only checks first and reports uncertain cleanup', async () => {
  const options = { publicPort: 24443, sshPort: 2222, suffix: 'relay.example.test', nodePath: '/usr/bin/node' };
  const calls = [];
  const driver = Object.fromEntries(['preflight', 'createFiles', 'createAccounts', 'verify', 'start', 'check', 'rollback']
    .map(name => [name, async () => { calls.push(name); if (name === 'check') return true; }]));
  assert.deepEqual(await installSharedInfrastructure(options, driver), { installed: true, encryption: 'unverified' });
  assert.deepEqual(calls, ['preflight', 'createFiles', 'createAccounts', 'verify', 'start', 'check']);
  calls.length = 0;
  driver.start = async () => { calls.push('start'); throw Error('start failed'); };
  driver.rollback = async () => { calls.push('rollback'); throw Error('could not stop'); };
  await assert.rejects(installSharedInfrastructure(options, driver), { code: 'SHARED_INSTALL_UNCERTAIN' });
  assert.ok(calls.includes('rollback'));
  calls.length = 0;
  driver.preflight = async () => { calls.push('preflight'); throw Error('already exists'); };
  await assert.rejects(installSharedInfrastructure(options, driver));
  assert.deepEqual(calls, ['preflight']);
});
