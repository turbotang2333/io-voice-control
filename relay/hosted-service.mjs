import { fileURLToPath } from 'node:url';
import { createLinuxInstallDriver } from './install.mjs';
import { createHostedRelayAdapter } from './hosted-relay-adapter.mjs';
import { createHostedRuntime } from './hosted-runtime.mjs';

/** Construct only: the operator explicitly chooses whether and where to listen. */
export async function createHostedService({ databasePath, slots, tls, limits, nodePath = process.execPath,
  serverSource = fileURLToPath(new URL('./server.mjs', import.meta.url)), driverFactory } = {}) {
  const makeDriver = driverFactory ?? (() => createLinuxInstallDriver({ serverSource }));
  const adapter = createHostedRelayAdapter({ nodePath, driverFactory: makeDriver });
  return createHostedRuntime({ databasePath, slots, tls, limits, activate: adapter.activate, inspect: adapter.inspect });
}
