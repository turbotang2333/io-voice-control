import { readFileSync } from 'node:fs';
import { createSharedAccountDriver } from './shared-account-driver.mjs';
import { inspectSharedInfrastructure, createSharedInfrastructurePlan } from './shared-infrastructure.mjs';
import { createSharedHostedRuntime } from './shared-hosted-runtime.mjs';
import { validateSshPublicKey } from '../secure-link/config.mjs';

const fail = code => Object.assign(Error(code), { code });

export async function createSharedHostedService({ databasePath, inviteDatabasePath, shared, infrastructure, tls, limits, maxAllocations,
  verifyInfrastructure = () => inspectSharedInfrastructure(infrastructure), driverFactory, readHostKey } = {}) {
  if (typeof verifyInfrastructure !== 'function' || await verifyInfrastructure() !== true) throw fail('SHARED_INFRASTRUCTURE_UNVERIFIED');
  let plan, endpoint, expectedHostKey;
  try {
    plan = createSharedInfrastructurePlan(infrastructure);
    endpoint = new URL(shared.publicBaseUrl);
    expectedHostKey = validateSshPublicKey(shared.relay.hostKey, true);
    if (endpoint.protocol !== 'https:' || endpoint.pathname !== '/' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || endpoint.hostname !== plan.routerConfig.suffix || Number(endpoint.port || 443) !== plan.routerConfig.listenPort
      || shared.relay.port !== infrastructure.sshPort) throw Error();
    const publicKey = (readHostKey ?? (() => readFileSync('/etc/ssh/ssh_host_ed25519_key.pub', 'utf8')))();
    if (validateSshPublicKey(String(publicKey).trim(), true) !== expectedHostKey) throw Error();
  } catch { throw fail('SHARED_HOSTED_CONFIG_INVALID'); }
  const guarded = async () => {
    try {
      if (await verifyInfrastructure() !== true) return false;
      const key = (readHostKey ?? (() => readFileSync('/etc/ssh/ssh_host_ed25519_key.pub', 'utf8')))();
      return validateSshPublicKey(String(key).trim(), true) === expectedHostKey;
    } catch { return false; }
  };
  const driver = driverFactory ? driverFactory({ verifyInfrastructure: guarded })
    : createSharedAccountDriver({ group: 'rayneo-relay', verifyInfrastructure: guarded });
  if (typeof driver?.activate !== 'function' || typeof driver?.inspect !== 'function') throw fail('SHARED_HOSTED_CONFIG_INVALID');
  return createSharedHostedRuntime({ databasePath, inviteDatabasePath, shared, tls, limits, maxAllocations,
    activate: driver.activate, inspect: driver.inspect });
}
