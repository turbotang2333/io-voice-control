import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createSharedHostedGuardPlan } from '../relay/shared-hosted-upgrade-guard-plan.mjs';
import { createSharedHostedGuardLinuxDriver } from '../relay/shared-hosted-guard-linux.mjs';
import { installSharedHostedGuard } from '../relay/shared-hosted-guard-install.mjs';
import { createSharedHostedSystemdService } from '../relay/shared-hosted-systemd-service.mjs';

function fixture(failReload = false) {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/guard-install'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'fixture-')), local = path => join(root, path.replace(/^\/+/, ''));
  writeFileSync(join(root, '.rayneo-upgrade-test-only'), 'synthetic');
  const plan = createSharedHostedGuardPlan({ nodePath: '/usr/bin/node' });
  mkdirSync(dirname(local(plan.guardPath)), { recursive: true }); mkdirSync(dirname(local(plan.dropInPath)), { recursive: true });
  mkdirSync(local('/var/lib/rayneo-paseo-shared-hosted'), { recursive: true });
  const logging = join(dirname(local(plan.dropInPath)), 'override.conf'); writeFileSync(logging, 'existing-log-settings');
  let loaded = false;
  const run = args => args.includes('--property=ActiveState') ? 'active'
    : args.includes('--property=NeedDaemonReload') ? (loaded ? 'no' : 'yes')
    : args.includes('--property=ExecStartPre') && loaded ? `{ argv[]=/usr/bin/node ${plan.guardPath} --verify-live ; }` : '';
  const service = createSharedHostedSystemdService({ guardRoot: root, run });
  const reload = () => { if (failReload) throw Error('synthetic reload failure'); loaded = true; };
  const driver = createSharedHostedGuardLinuxDriver({ root, nodePath: '/usr/bin/node', service, reload });
  return { root, local, plan, driver, logging, service };
}

test('guard installer preserves existing log settings and verifies the loaded override', async () => {
  const f = fixture();
  assert.deepEqual(await installSharedHostedGuard(f.plan, f.driver), { installed: true });
  assert.equal(readFileSync(f.logging, 'utf8'), 'existing-log-settings');
  assert.deepEqual(readFileSync(f.local(f.plan.guardPath)), f.plan.guardSource);
  assert.equal(readFileSync(f.local(f.plan.dropInPath), 'utf8'), f.plan.dropIn);
  assert.equal(existsSync(f.local('/var/lib/rayneo-paseo-shared-hosted/upgrade-startup-lock.sqlite')), true);
});

test('guard installer does not overwrite a pre-existing file', async () => {
  const f = fixture(); writeFileSync(f.local(f.plan.guardPath), 'existing');
  await assert.rejects(installSharedHostedGuard(f.plan, f.driver));
  assert.equal(readFileSync(f.local(f.plan.guardPath), 'utf8'), 'existing');
  assert.equal(readFileSync(f.logging, 'utf8'), 'existing-log-settings');
});

test('failed reload removes only newly created guard files', async () => {
  const f = fixture(true);
  await assert.rejects(installSharedHostedGuard(f.plan, f.driver), { code: 'SHARED_UPGRADE_GUARD_INSTALL_UNCERTAIN' });
  assert.equal(existsSync(f.local(f.plan.guardPath)), false);
  assert.equal(existsSync(f.local(f.plan.dropInPath)), false);
  assert.equal(existsSync(f.local('/var/lib/rayneo-paseo-shared-hosted/upgrade-startup-lock.sqlite')), false);
  assert.equal(readFileSync(f.logging, 'utf8'), 'existing-log-settings');
});

test('a rollback is uncertain if the previously running service is no longer active', async () => {
  const f = fixture(); let checks = 0;
  f.service.isActive = async () => ++checks === 1;
  await assert.rejects(installSharedHostedGuard(f.plan, f.driver), { code: 'SHARED_UPGRADE_GUARD_INSTALL_UNCERTAIN' });
  assert.equal(readFileSync(f.logging, 'utf8'), 'existing-log-settings');
});
