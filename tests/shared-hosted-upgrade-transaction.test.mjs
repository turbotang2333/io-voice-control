import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { executeSharedHostedUpgrade } from '../relay/shared-hosted-upgrade-transaction.mjs';

function fixture(failure) {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/upgrade-transaction');
  mkdirSync(parent, { recursive: true }); const root = mkdtempSync(join(parent, 'fixture-'));
  const file = name => join(root, name);
  for (const [name, data] of [['service', 'old'], ['config', 'old'], ['registry', 'keep-registry'], ['logs', 'keep-logs']]) writeFileSync(file(name), data);
  let running = true, backup, started = false; const calls = [];
  const step = name => { calls.push(name); if (failure === name) throw Error('synthetic failure'); };
  const driver = {
    async preflight() { step('preflight'); },
    async backup() { step('backup'); backup = { service: readFileSync(file('service')), config: readFileSync(file('config')) }; return { verified: true }; },
    async stop() { running = false; step('stop'); },
    async replaceSources() { writeFileSync(file('service'), 'new'); step('replaceSources'); },
    async replaceConfig() { writeFileSync(file('config'), 'new'); step('replaceConfig'); },
    async start() { running = true; started = true; step('start'); },
    async verify() { step('verify'); return failure !== 'verification_false'; },
    async rollback() { step('rollback'); writeFileSync(file('service'), backup.service); writeFileSync(file('config'), backup.config); running = true; },
    async verifyRollback() { step('verifyRollback'); return running && readFileSync(file('service'), 'utf8') === 'old' && readFileSync(file('config'), 'utf8') === 'old'; },
  };
  return { driver, calls, file, state: () => ({ running, started }) };
}

test('a verified upgrade leaves the registry and existing log settings alone', async () => {
  const f = fixture();
  assert.deepEqual(await executeSharedHostedUpgrade({}, f.driver), { upgraded: true });
  assert.equal(readFileSync(f.file('service'), 'utf8'), 'new');
  assert.equal(readFileSync(f.file('config'), 'utf8'), 'new');
  assert.equal(readFileSync(f.file('registry'), 'utf8'), 'keep-registry');
  assert.equal(readFileSync(f.file('logs'), 'utf8'), 'keep-logs');
});

test('a failure after stopping restores both files and restarts the old service', async () => {
  for (const stage of ['stop', 'replaceSources', 'replaceConfig', 'start', 'verify', 'verification_false']) {
    const f = fixture(stage);
    await assert.rejects(executeSharedHostedUpgrade({}, f.driver), { code: 'SHARED_HOSTED_UPGRADE_FAILED' }, stage);
    assert.equal(readFileSync(f.file('service'), 'utf8'), 'old', stage);
    assert.equal(readFileSync(f.file('config'), 'utf8'), 'old', stage);
    assert.equal(readFileSync(f.file('registry'), 'utf8'), 'keep-registry', stage);
    assert.equal(readFileSync(f.file('logs'), 'utf8'), 'keep-logs', stage);
    assert.equal(f.state().running, true, stage);
  }
});

test('backup failure leaves the running service untouched; an unverified rollback is reported as uncertain', async () => {
  const f = fixture('backup');
  await assert.rejects(executeSharedHostedUpgrade({}, f.driver), { code: 'SHARED_HOSTED_UPGRADE_BACKUP_FAILED' });
  assert.ok(!f.calls.includes('stop')); assert.equal(f.state().running, true);
  const g = fixture('replaceSources'); g.driver.verifyRollback = async () => false;
  await assert.rejects(executeSharedHostedUpgrade({}, g.driver), { code: 'SHARED_HOSTED_UPGRADE_UNCERTAIN' });
});
