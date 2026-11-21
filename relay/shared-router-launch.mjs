import { lstatSync, readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedRelay } from './shared-router.mjs';
import { createSharedRouteConnector, sharedHostname } from './shared-configuration.mjs';

const fail = () => { throw Object.assign(Error('SHARED_ROUTER_CONFIG_INVALID'), { code: 'SHARED_ROUTER_CONFIG_INVALID' }); };

export function validateSharedRouterConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || Object.keys(config).some(key => !['version', 'listenHost', 'listenPort', 'suffix'].includes(key))
    || config.version !== 1 || !['127.0.0.1', '0.0.0.0'].includes(config.listenHost)
    || !Number.isInteger(config.listenPort) || config.listenPort < 1 || config.listenPort > 65535) fail();
  sharedHostname('00000000-0000-0000-0000-000000000000', config.suffix);
  return { version: 1, listenHost: config.listenHost, listenPort: config.listenPort, suffix: config.suffix };
}

export function createSharedRouterService(config) {
  const safe = validateSharedRouterConfig(config);
  return createSharedRelay({ connectRoute: createSharedRouteConnector({ suffix: safe.suffix }) });
}

function readConfiguration(path) {
  if (path !== '/etc/rayneo-paseo-shared/router.json' || process.platform !== 'linux') fail();
  let parent = posix.dirname(path);
  while (true) {
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) fail();
    if (parent === '/') break;
    parent = posix.dirname(parent);
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) || stat.size > 4096) fail();
  return validateSharedRouterConfig(JSON.parse(readFileSync(path, 'utf8')));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--config') fail();
    const config = readConfiguration(process.argv[3]), server = createSharedRouterService(config);
    server.on('error', () => { process.stderr.write('SHARED_ROUTER_LISTEN_FAILED\n'); process.exitCode = 1; });
    server.listen(config.listenPort, config.listenHost, () => process.stdout.write('SHARED_ROUTER_READY\n'));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.closeAllConnections(); server.close(); });
  } catch { process.stderr.write('SHARED_ROUTER_CONFIG_INVALID\n'); process.exitCode = 1; }
}
