import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharedHostedGuardPlan } from '../relay/shared-hosted-upgrade-guard-plan.mjs';
import { installSharedHostedGuard } from '../relay/shared-hosted-guard-install.mjs';

const plan = createSharedHostedGuardPlan({ nodePath: '/usr/bin/node' });
function fixture(failure) {
  const calls = []; let guard = false, dropIn = false, lock = false;
  const step = name => { calls.push(name); if (failure === name) throw Error('synthetic'); };
  const driver = {
    async preflight() { step('preflight'); },
    async createLock() { lock = true; step('createLock'); },
    async createGuard() { guard = true; step('createGuard'); },
    async createDropIn() { dropIn = true; step('createDropIn'); },
    async reload() { step('reload'); },
    async verify() { step('verify'); return failure !== 'verifyFalse'; },
    async rollback() { step('rollback'); guard = false; dropIn = false; lock = false; },
  };
  return { calls, driver, present: () => ({ guard, dropIn, lock }) };
}
test('guard installation requires preflight, complete files and a verified systemd reload', async () => {
  const f = fixture(); assert.deepEqual(await installSharedHostedGuard(plan, f.driver), { installed: true });
  assert.deepEqual(f.calls, ['preflight', 'createLock', 'createGuard', 'createDropIn', 'reload', 'verify']);
  assert.deepEqual(f.present(), { guard: true, dropIn: true, lock: true });
});
test('failed guard installation rolls back the files it created', async () => {
  for (const stage of ['createLock', 'createGuard', 'createDropIn', 'reload', 'verify', 'verifyFalse']) {
    const f = fixture(stage);
    await assert.rejects(installSharedHostedGuard(plan, f.driver), { code: 'SHARED_UPGRADE_GUARD_INSTALL_FAILED' });
    assert.deepEqual(f.present(), { guard: false, dropIn: false, lock: false });
  }
});
test('an unverified guard rollback must be reported as uncertain', async () => {
  const f = fixture('reload'); f.driver.rollback = async () => { throw Error('synthetic'); };
  await assert.rejects(installSharedHostedGuard(plan, f.driver), { code: 'SHARED_UPGRADE_GUARD_INSTALL_UNCERTAIN' });
});
