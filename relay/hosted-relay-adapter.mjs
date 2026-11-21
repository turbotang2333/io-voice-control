import { createInstallPlan, installRelay, checkInstalledRelay } from './install.mjs';

const fail = code => Object.assign(Error(code), { code });

/** The caller supplies a trusted installation driver; no host is modified by constructing this adapter. */
export function createHostedRelayAdapter({ nodePath, driverFactory } = {}) {
  if (typeof driverFactory !== 'function' || !/^\/[A-Za-z0-9_./-]+$/.test(nodePath ?? '') || nodePath.includes('..')) throw fail('HOSTED_ADAPTER_INVALID');
  const plan = bundle => {
    if (bundle?.invitation?.hosting !== 'project-hosted' || bundle.invitation.version !== 3) throw fail('HOSTED_ADAPTER_INVALID');
    return createInstallPlan(bundle, nodePath);
  };
  const ready = value => value.installed === true && value.serviceActive === true && value.sshConfigured === true;
  return {
    async activate(bundle) {
      const selected = plan(bundle), driver = driverFactory();
      try { await installRelay(selected, driver); }
      catch (error) {
        if (['RELAY_INSTALL_FAILED', 'RELAY_ISOLATION_REQUIRED', 'RELAY_ROOT_REQUIRED', 'RELAY_NODE_UNSUPPORTED'].includes(error.code)) throw fail('HOSTED_ACTIVATION_CLEAN_FAILED');
        throw error;
      }
      return ready(await checkInstalledRelay(selected, driver));
    },
    async inspect(bundle) {
      const selected = plan(bundle), driver = driverFactory();
      return ready(await checkInstalledRelay(selected, driver));
    },
  };
}
