const fail = code => Object.assign(Error(code), { code });

// Driver creation and all server operations are separate from this sequencing helper.
export async function installSharedHostedGuard(plan, driver) {
  if (!plan || !driver || ['preflight', 'createLock', 'createGuard', 'createDropIn', 'reload', 'verify', 'rollback'].some(name => typeof driver[name] !== 'function')) {
    throw fail('SHARED_UPGRADE_GUARD_INVALID');
  }
  await driver.preflight(plan);
  try {
    await driver.createLock(plan); await driver.createGuard(plan); await driver.createDropIn(plan); await driver.reload(plan);
    if (await driver.verify(plan) !== true) throw Error('guard unverified');
    return { installed: true };
  } catch {
    try { await driver.rollback(plan); } catch { throw fail('SHARED_UPGRADE_GUARD_INSTALL_UNCERTAIN'); }
    throw fail('SHARED_UPGRADE_GUARD_INSTALL_FAILED');
  }
}
