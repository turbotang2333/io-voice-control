import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedRelayBundle } from './shared-configuration.mjs';
import { createSharedInfrastructurePlan } from './shared-infrastructure.mjs';
import { createSharedHostedService } from './shared-hosted-service.mjs';

const fail = () => { throw Object.assign(Error('SHARED_HOSTED_LAUNCH_INVALID'), { code: 'SHARED_HOSTED_LAUNCH_INVALID' }); };
const localPath = value => typeof value === 'string' && posix.isAbsolute(value) && posix.normalize(value) === value && !/[\0\r\n]/.test(value);
const key = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64');
const sample = { version: 1, installationId: '00000000-0000-0000-0000-000000000001', requestedBackends: ['paseo'], sshPublicKey: key };

export function validateSharedHostedLaunchConfig(config) {
  try {
    if (!config || typeof config !== 'object' || Array.isArray(config)
      || Object.keys(config).some(name => !['version', 'listenHost', 'listenPort', 'databasePath', 'inviteDatabasePath', 'tlsKeyPath', 'tlsCertPath', 'maxAllocations', 'shared', 'infrastructure'].includes(name))
      || config.version !== 1 || !['127.0.0.1', '0.0.0.0'].includes(config.listenHost)
      || !Number.isInteger(config.listenPort) || config.listenPort < 1024 || config.listenPort > 65535
      || config.databasePath !== '/var/lib/rayneo-paseo-shared-hosted/registry.sqlite'
      || config.inviteDatabasePath !== '/var/lib/rayneo-paseo-shared-hosted/invites.sqlite'
      || ![config.tlsKeyPath, config.tlsCertPath].every(localPath)
      || !Number.isInteger(config.maxAllocations) || config.maxAllocations < 1 || config.maxAllocations > 1000000
      || !config.infrastructure || Object.keys(config.infrastructure).some(name => !['publicPort', 'sshPort', 'suffix', 'nodePath', 'listenHost'].includes(name))
      || !config.shared || Object.keys(config.shared).some(name => !['publicBaseUrl', 'relay'].includes(name))
      || !config.shared.relay || Object.keys(config.shared.relay).some(name => !['host', 'port', 'hostKey'].includes(name))) fail();
    const plan = createSharedInfrastructurePlan(config.infrastructure);
    createSharedRelayBundle({ enrollment: sample, hosting: 'project-hosted', shared: config.shared });
    const endpoint = new URL(config.shared.publicBaseUrl);
    if (endpoint.origin !== config.shared.publicBaseUrl || endpoint.hostname !== plan.routerConfig.suffix
      || Number(endpoint.port || 443) !== plan.routerConfig.listenPort || config.shared.relay.port !== config.infrastructure.sshPort
      || [config.infrastructure.publicPort, config.infrastructure.sshPort].includes(config.listenPort)) fail();
    return structuredClone(config);
  } catch { fail(); }
}

export function createSharedHostedLaunchPlan(value) {
  const config = validateSharedHostedLaunchConfig(value);
  const serviceUnit = `[Unit]\nDescription=RayNeo shared hosted enrollment\nAfter=rayneo-shared-ssh.service rayneo-shared-router.service\nRequires=rayneo-shared-ssh.service rayneo-shared-router.service\n\n[Service]\nType=simple\nNoNewPrivileges=yes\nPrivateTmp=yes\nPrivateDevices=yes\nUMask=0077\nExecStart=${config.infrastructure.nodePath} /opt/rayneo-paseo-shared/relay/shared-hosted-launch.mjs --config /etc/rayneo-paseo-shared/hosted.json\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=multi-user.target\n`;
  return { configFile: JSON.stringify(config) + '\n', serviceUnit };
}

export async function installSharedHostedService(config, driver) {
  const plan = createSharedHostedLaunchPlan(config);
  if (!driver || ['preflight', 'createFiles', 'verify', 'start', 'check', 'rollback'].some(name => typeof driver[name] !== 'function')) fail();
  await driver.preflight(plan);
  try {
    await driver.createFiles(plan); await driver.verify(plan); await driver.start(plan);
    if (await driver.check(plan) !== true) throw Error('hosted service unverified');
    return { installed: true, encryption: 'unverified' };
  } catch {
    try { await driver.rollback(plan); } catch { throw Object.assign(Error('SHARED_HOSTED_INSTALL_UNCERTAIN'), { code: 'SHARED_HOSTED_INSTALL_UNCERTAIN' }); }
    throw Object.assign(Error('SHARED_HOSTED_INSTALL_FAILED'), { code: 'SHARED_HOSTED_INSTALL_FAILED' });
  }
}

function safeParents(path) {
  let parent = posix.dirname(path);
  while (true) {
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) fail();
    if (parent === '/') break;
    parent = posix.dirname(parent);
  }
}
function readSafe(path, { privateFile = false, link = false, limit = 65536 } = {}) {
  safeParents(path);
  const actual = link ? realpathSync(path) : path; safeParents(actual);
  const stat = lstatSync(actual);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & (privateFile ? 0o077 : 0o022)) || stat.size > limit) fail();
  return readFileSync(actual);
}
export const loadSharedHostedTls = config => ({ key: readSafe(config.tlsKeyPath, { privateFile: true, link: true }), cert: readSafe(config.tlsCertPath, { link: true }) });

async function main(args) {
  if (args.length !== 2 || args[0] !== '--config' || args[1] !== '/etc/rayneo-paseo-shared/hosted.json'
    || process.platform !== 'linux' || process.geteuid?.() !== 0) fail();
  const config = validateSharedHostedLaunchConfig(JSON.parse(readSafe(args[1], { privateFile: true, limit: 16384 }).toString('utf8')));
  const service = await createSharedHostedService({ ...config, tls: loadSharedHostedTls(config) });
  try { await new Promise((resolve, reject) => service.server.once('error', reject).listen(config.listenPort, config.listenHost, resolve)); }
  catch (error) { await service.close(); throw error; }
  process.stdout.write('SHARED_HOSTED_READY\n');
  const refresh = setInterval(() => { try { service.server.setSecureContext(loadSharedHostedTls(config)); } catch { process.stderr.write('SHARED_HOSTED_TLS_RELOAD_FAILED\n'); } }, 900000);
  refresh.unref(); let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    if (stopping) return; stopping = true; clearInterval(refresh);
    service.close().catch(() => { process.exitCode = 1; });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => { process.stderr.write('SHARED_HOSTED_LAUNCH_FAILED\n'); process.exitCode = 1; });
}
