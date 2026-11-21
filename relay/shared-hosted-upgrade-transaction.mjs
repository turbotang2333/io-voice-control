const fail = code => Object.assign(Error(code), { code });

// The driver must provide durable, verified backups and check file preconditions.
// This module does not implement a real server driver or perform installation by itself.
export async function executeSharedHostedUpgrade(plan, driver) {
  const methods = ['preflight', 'backup', 'stop', 'replaceSources', 'replaceConfig', 'start', 'verify', 'rollback', 'verifyRollback'];
  if (!plan || typeof plan !== 'object' || !driver || methods.some(name => typeof driver[name] !== 'function')) throw fail('SHARED_HOSTED_UPGRADE_INVALID');
  try { await driver.preflight(plan); } catch { throw fail('SHARED_HOSTED_UPGRADE_PREFLIGHT_FAILED'); }
  let backup;
  try {
    backup = await driver.backup(plan);
    if (!backup || backup.verified !== true) throw Error('unverified backup');
  } catch { throw fail('SHARED_HOSTED_UPGRADE_BACKUP_FAILED'); }
  try {
    // Once a stop is attempted its outcome may be uncertain, so always restore on failure.
    await driver.stop(plan, backup);
    await driver.replaceSources(plan, backup);
    await driver.replaceConfig(plan, backup);
    await driver.start(plan, backup);
    if (await driver.verify(plan, backup) !== true) throw Error('unverified upgrade');
    return { upgraded: true };
  } catch {
    try {
      await driver.rollback(plan, backup);
      if (await driver.verifyRollback(plan, backup) !== true) throw Error('unverified rollback');
    } catch { throw fail('SHARED_HOSTED_UPGRADE_UNCERTAIN'); }
    throw fail('SHARED_HOSTED_UPGRADE_FAILED');
  }
}
