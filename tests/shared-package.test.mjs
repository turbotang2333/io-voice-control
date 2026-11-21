import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeSharedInstallerBundle } from '../relay/shared-package.mjs';
import { execFileSync } from 'node:child_process';

test('a fresh installer bundle contains the shared wizard and all runtime dependencies', () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/shared-package'); mkdirSync(parent, { recursive: true });
  const output = join(mkdtempSync(join(parent, 'fixture-')), 'bundle');
  assert.deepEqual(writeSharedInstallerBundle({ output }), { prepared: true, installed: false });
  for (const file of ['relay/shared-wizard.mjs', 'relay/shared-infrastructure-linux.mjs', 'relay/shared-hosted-linux.mjs',
    'relay/shared-hosted-launch.mjs', 'relay/shared-router.mjs', 'relay/hosted-server.mjs', 'secure-link/config.mjs', 'distribution/hosted-enrollment.mjs',
    'relay/shared-hosted-upgrade-plan.mjs', 'relay/shared-hosted-upgrade-load.mjs', 'relay/shared-hosted-upgrade-files.mjs', 'relay/shared-hosted-upgrade-driver.mjs', 'relay/shared-hosted-upgrade-lock.mjs',
    'relay/shared-hosted-upgrade-transaction.mjs', 'relay/shared-hosted-upgrade-guard.mjs', 'relay/shared-hosted-upgrade-guard-plan.mjs',
    'relay/shared-hosted-guard-install.mjs', 'relay/shared-hosted-guard-linux.mjs', 'relay/shared-hosted-systemd-service.mjs',
    'relay/shared-hosted-upgrade-cli.mjs']) {
    assert.equal(existsSync(join(output, file)), true, file);
    assert.ok(readFileSync(join(output, file)).length > 0);
  }
  assert.match(execFileSync(process.execPath, [join(output, 'relay/shared-wizard.mjs'), '--help'], { encoding: 'utf8' }), /--install/);
  assert.match(execFileSync(process.execPath, [join(output, 'relay/shared-hosted-upgrade-cli.mjs'), '--help'], { encoding: 'utf8' }), /--check/);
  assert.throws(() => writeSharedInstallerBundle({ output }), { code: 'SHARED_BUNDLE_EXISTS' });
});
