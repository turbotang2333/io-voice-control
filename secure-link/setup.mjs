import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createSecureContext } from 'node:tls';
import { isIP } from 'node:net';
import { acquireSupervisorLock } from '../bridge/supervisor.mjs';
import { validateSecureInvitation } from './config.mjs';

const fail = code => Object.assign(Error(code), { code });
const secret = () => randomBytes(32).toString('hex');
const matchesAddress = (certificate, hostname) => isIP(hostname) ? certificate.checkIP(hostname) : certificate.checkHost(hostname);
const script = name => fileURLToPath(new URL('../distribution/' + name, import.meta.url));
function read(path, limit = 65536) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw fail('SECURE_CONFIGURATION_INVALID');
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}
function powershell(path, args, env = process.env) {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path, ...args],
    { env, windowsHide: true, stdio: 'pipe', timeout: 30000 });
}
function platformCertificate({ directory, hostname, password }) {
  if (process.platform !== 'win32') throw fail('SECURE_PLATFORM_UNSUPPORTED');
  try { powershell(script('certificate.ps1'), ['-Directory', directory, '-Hostname', hostname], { ...process.env, RAYNEO_INSTALL_PFX_PASSWORD: password }); }
  catch { throw fail('SECURE_CERTIFICATE_PREPARATION_FAILED'); }
}
function rootPath(privateDirectory) {
  if (!isAbsolute(privateDirectory ?? '') || /[\r\n\0"]/.test(privateDirectory)
    || lstatSync(privateDirectory).isSymbolicLink() || !lstatSync(privateDirectory).isDirectory()) throw fail('SECURE_CONFIGURATION_INVALID');
  return join(privateDirectory, 'secure-link');
}
function makeSshConfig(privateDirectory, target, invitation, sshHost) {
  const quote = value => '"' + value.replaceAll('\\', '/') + '"';
  return `Host ${sshHost}\n  HostName ${invitation.relay.host}\n  Port ${invitation.relay.port}\n  User ${invitation.relay.user}\n  IdentityFile ${quote(join(privateDirectory, 'relay-key.pem'))}\n  IdentitiesOnly yes\n  HostKeyAlias rayneo-secure-relay\n  UserKnownHostsFile ${quote(join(target, 'known-hosts'))}\n  StrictHostKeyChecking yes\n  BatchMode yes\n`;
}
function publicResult(config, reused = false) {
  return { configured: true, reused, hosting: config.invitation.hosting, transport: 'tls-passthrough-v1',
    publicBaseUrl: config.invitation.publicBaseUrl, certificateSha256: config.certificateSha256,
    encryption: 'unverified', serverChanged: false, modelMessagesSent: 0 };
}
function markConfigured(privateDirectory) {
  const path = join(privateDirectory, 'secure-link-enabled.json');
  if (existsSync(path)) {
    const value = read(path);
    if (value.version !== 1) throw fail('SECURE_CONFIGURATION_INVALID');
    return;
  }
  try { writeFileSync(path, JSON.stringify({ version: 1 }) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch { throw fail('SECURE_CONFIGURATION_INVALID'); }
}

export async function configureSecureLink({ privateDirectory, invitation, generateCertificate = platformCertificate } = {}) {
  const target = rootPath(privateDirectory), installation = read(join(privateDirectory, 'installation.json'));
  const safe = validateSecureInvitation(invitation, installation.installationId);
  if (safe.backends.some(key => !installation.backends?.includes(key))) throw fail('SECURE_INVITATION_INVALID');
  const invitationHash = createHash('sha256').update(JSON.stringify(safe)).digest('hex');
  if (existsSync(target)) {
    const loaded = loadSecureLink(privateDirectory);
    if (loaded.invitationHash !== invitationHash) throw fail('SECURE_CONFIGURATION_EXISTS');
    markConfigured(privateDirectory);
    return publicResult(loaded, true);
  }
  const staging = mkdtempSync(join(privateDirectory, '.secure-'));
  try {
    if (process.platform === 'win32') powershell(script('protect-directory.ps1'), ['-Directory', staging]);
    const password = secret(), hostname = new URL(safe.publicBaseUrl).hostname;
    await generateCertificate({ directory: staging, hostname, password });
    const cert = new X509Certificate(readFileSync(join(staging, 'local.cer')));
    if (!matchesAddress(cert, hostname) || Date.parse(cert.validTo) <= Date.now() || Date.parse(cert.validFrom) > Date.now()) throw fail('SECURE_IDENTITY_INVALID');
    createSecureContext({ pfx: readFileSync(join(staging, 'server.p12')), passphrase: password, minVersion: 'TLSv1.3' });
    const backends = {}, profiles = {};
    for (const backend of safe.backends) {
      const source = read(join(privateDirectory, backend === 'paseo' ? 'daily.json' : 'shared-runtime/connector.json'));
      const upstreamToken = backend === 'paseo' ? source.apiToken : source.token;
      if (!Number.isInteger(source.port) || source.port < 1024 || source.port > 65535 || !/^[a-f0-9]{64}$/.test(upstreamToken ?? '')) throw fail('SECURE_BACKENDS_INVALID');
      const token = secret();
      backends[backend] = { port: source.port, token, upstreamToken,
        ...(backend === 'codex' && !source.sharedConnection ? { mode: 'independent' } : {}) };
      profiles[backend] = { endpoint: safe.publicBaseUrl + '/' + backend, port: source.port, token };
    }
    const sshHost = 'rayneo-secure-' + safe.installationId;
    const sshConfig = makeSshConfig(privateDirectory, target, safe, sshHost);
    writeFileSync(join(staging, 'ssh-config'), sshConfig, { flag: 'wx', mode: 0o600 });
    writeFileSync(join(staging, 'known-hosts'), 'rayneo-secure-relay ' + safe.relay.hostKey + '\n', { flag: 'wx', mode: 0o600 });
    const config = { version: 1, invitation: safe, invitationHash, certificateSha256: createHash('sha256').update(cert.raw).digest('hex'),
      passphrase: password, backends, profiles, sshHost };
    writeFileSync(join(staging, 'config.json'), JSON.stringify(config) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(staging, target);
    markConfigured(privateDirectory);
    return publicResult(config);
  } finally {
    if (existsSync(staging) && !lstatSync(staging).isSymbolicLink() && resolve(staging).startsWith(resolve(privateDirectory) + sep)) rmSync(staging, { recursive: true });
  }
}

/** Rotate a personal relay's IP identity while retaining the previous private configuration. */
export async function changeSelfHostedIp({ privateDirectory, stateDirectory, invitation, generateCertificate = platformCertificate } = {}) {
  if (!isAbsolute(stateDirectory ?? '')) throw fail('SECURE_CONFIGURATION_INVALID');
  const target = rootPath(privateDirectory);
  let release;
  try { release = acquireSupervisorLock(join(stateDirectory, 'secure-link', 'supervisor.lock')); }
  catch { throw fail('SECURE_SERVICE_RUNNING'); }
  try {
    const current = loadSecureLink(privateDirectory), old = current.invitation;
    const next = validateSecureInvitation(invitation, old.installationId);
    const oldAddress = new URL(old.publicBaseUrl), newAddress = new URL(next.publicBaseUrl);
    const expected = { ...old, publicBaseUrl: next.publicBaseUrl, relay: { ...old.relay, host: next.relay.host } };
    if (old.hosting !== 'self-hosted' || next.hosting !== 'self-hosted' || isIP(oldAddress.hostname) !== 4
      || isIP(newAddress.hostname) !== 4 || oldAddress.hostname !== old.relay.host || newAddress.hostname !== next.relay.host
      || oldAddress.hostname === newAddress.hostname || oldAddress.port !== newAddress.port
      || JSON.stringify(next) !== JSON.stringify(expected)) throw fail('SECURE_IP_UPDATE_INVALID');
    const staging = mkdtempSync(join(privateDirectory, '.secure-update-'));
    if (process.platform === 'win32') powershell(script('protect-directory.ps1'), ['-Directory', staging]);
    const password = secret();
    await generateCertificate({ directory: staging, hostname: newAddress.hostname, password });
    const cert = new X509Certificate(readFileSync(join(staging, 'local.cer')));
    if (!cert.checkIP(newAddress.hostname) || Date.parse(cert.validTo) <= Date.now() || Date.parse(cert.validFrom) > Date.now()) throw fail('SECURE_IDENTITY_INVALID');
    createSecureContext({ pfx: readFileSync(join(staging, 'server.p12')), passphrase: password, minVersion: 'TLSv1.3' });
    const saved = read(join(target, 'config.json'));
    for (const [backend, value] of Object.entries(saved.backends)) {
      value.token = secret();
      saved.profiles[backend] = { ...saved.profiles[backend], endpoint: next.publicBaseUrl + '/' + backend, token: value.token };
    }
    saved.invitation = next;
    saved.invitationHash = createHash('sha256').update(JSON.stringify(next)).digest('hex');
    saved.certificateSha256 = createHash('sha256').update(cert.raw).digest('hex');
    saved.passphrase = password;
    if (saved.sshHost !== 'rayneo-secure-' + old.installationId || readFileSync(join(target, 'known-hosts'), 'utf8') !== 'rayneo-secure-relay ' + old.relay.hostKey + '\n') throw fail('SECURE_CONFIGURATION_INVALID');
    writeFileSync(join(staging, 'ssh-config'), makeSshConfig(privateDirectory, target, next, saved.sshHost), { flag: 'wx', mode: 0o600 });
    writeFileSync(join(staging, 'known-hosts'), 'rayneo-secure-relay ' + next.relay.hostKey + '\n', { flag: 'wx', mode: 0o600 });
    writeFileSync(join(staging, 'config.json'), JSON.stringify(saved) + '\n', { flag: 'wx', mode: 0o600 });
    const backupDirectory = join(privateDirectory, '.secure-previous-' + secret());
    renameSync(target, backupDirectory);
    try { renameSync(staging, target); }
    catch (error) { try { renameSync(backupDirectory, target); } catch { throw fail('SECURE_IP_RECOVERY_REQUIRED'); } throw error; }
    return { configured: true, pairingRequired: true, encryption: 'unverified', backupDirectory, serverChanged: false };
  } finally { release(); }
}

/** Restore only a retained previous identity when no active configuration exists. */
export function restoreInterruptedSelfHostedIp({ privateDirectory, stateDirectory, backupDirectory } = {}) {
  const target = rootPath(privateDirectory);
  if (!isAbsolute(stateDirectory ?? '') || !isAbsolute(backupDirectory ?? '')
    || !/^\.secure-previous-[a-f0-9]{64}$/.test(backupDirectory.split(/[\\/]/).at(-1))
    || resolve(backupDirectory, '..') !== resolve(privateDirectory)) throw fail('SECURE_IP_RECOVERY_INVALID');
  let release;
  try { release = acquireSupervisorLock(join(stateDirectory, 'secure-link', 'supervisor.lock')); }
  catch { throw fail('SECURE_SERVICE_RUNNING'); }
  try {
    if (existsSync(target) || lstatSync(backupDirectory).isSymbolicLink() || !lstatSync(backupDirectory).isDirectory()) throw fail('SECURE_IP_RECOVERY_INVALID');
    renameSync(backupDirectory, target);
    try {
      const config = loadSecureLink(privateDirectory);
      if (config.hosting !== 'self-hosted' || isIP(new URL(config.invitation.publicBaseUrl).hostname) !== 4) throw fail('SECURE_IP_RECOVERY_INVALID');
    } catch (error) { try { renameSync(target, backupDirectory); } catch { throw fail('SECURE_IP_RECOVERY_REQUIRED'); } throw error; }
    return { restored: true, encryption: 'unverified', serverChanged: false };
  } finally { release(); }
}

/** Add a local Codex route without rotating the existing computer identity or Paseo credentials. */
export async function addCodexBackend({ privateDirectory, executable, prepareDesktopAdapter, independentCodex = false } = {}) {
  const current = loadSecureLink(privateDirectory);
  if (current.backends.codex) return { added: false };
  if (!isAbsolute(executable ?? '') || (!independentCodex && typeof prepareDesktopAdapter !== 'function')) throw fail('SECURE_BACKENDS_INVALID');
  const shared = join(privateDirectory, 'shared-runtime');
  if (existsSync(shared)) throw fail('SECURE_BACKENDS_INVALID');
  const local = read(join(privateDirectory, 'local-test.json'));
  if (!/^[a-f0-9]{64}$/.test(local.password ?? '')) throw fail('SECURE_CONFIGURATION_INVALID');
  const staging = mkdtempSync(join(privateDirectory, '.codex-'));
  try {
    const connection = { endpoint: 'ws://127.0.0.1:19569/rpc', tokenFile: join(shared, 'capability.token') };
    const connectorConfiguration = join(shared, 'connector.json'), desktopConfiguration = join(shared, 'desktop.json');
    const token = secret(), upstreamToken = secret(), port = 19469;
    if (!independentCodex) {
      writeFileSync(join(staging, 'capability.token'), secret(), { flag: 'wx', mode: 0o600 });
      await prepareDesktopAdapter(join(staging, 'rayneo-desktop-proxy.exe'));
      writeFileSync(join(staging, 'desktop.json'), JSON.stringify({ executable, connection }), { flag: 'wx', mode: 0o600 });
      writeFileSync(join(staging, 'startup.json'), JSON.stringify({ version: 1, adapter: join(shared, 'rayneo-desktop-proxy.exe'),
        desktopConfiguration, connectorConfiguration, wirelessConfiguration: join(shared, 'connector-wireless.json') }), { flag: 'wx', mode: 0o600 });
    }
    writeFileSync(join(staging, 'connector.json'), JSON.stringify({ host: '127.0.0.1', port, token: upstreamToken,
      pfxPath: join(privateDirectory, 'server.p12'), password: local.password, navigation: true, creation: true,
      ...(!independentCodex ? { executable, sharedConnection: connection } : {}) }), { flag: 'wx', mode: 0o600 });
    const configPath = join(current.directory, 'config.json'), config = read(configPath);
    if (config.backends.codex || config.profiles.codex) throw fail('SECURE_CONFIGURATION_EXISTS');
    config.backends.codex = { port, token, upstreamToken, ...(independentCodex ? { mode: 'independent' } : {}) };
    config.profiles.codex = { endpoint: current.invitation.publicBaseUrl + '/codex', port, token };
    const temporary = join(current.directory, '.config-' + secret() + '.tmp');
    writeFileSync(temporary, JSON.stringify(config) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(staging, shared);
    try { renameSync(temporary, configPath); }
    catch (error) {
      try { renameSync(shared, staging); } catch { /* Keep the incomplete directory for diagnosis. */ }
      try { unlinkSync(temporary); } catch { /* Keep the incomplete file for diagnosis. */ }
      throw fail('SECURE_CONFIGURATION_INVALID');
    }
    return { added: true };
  } finally {
    if (existsSync(staging) && !lstatSync(staging).isSymbolicLink() && resolve(staging).startsWith(resolve(privateDirectory) + sep)) rmSync(staging, { recursive: true });
  }
}

export function loadSecureLink(privateDirectory) {
  const directory = rootPath(privateDirectory);
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw fail('SECURE_CONFIGURATION_INVALID');
  const config = read(join(directory, 'config.json'));
  if (config.version !== 1 || !/^[a-f0-9]{64}$/.test(config.certificateSha256 ?? '') || !/^[a-f0-9]{64}$/.test(config.passphrase ?? '')) throw fail('SECURE_CONFIGURATION_INVALID');
  const invitation = validateSecureInvitation(config.invitation);
  const cert = new X509Certificate(readFileSync(join(directory, 'local.cer')));
  if (createHash('sha256').update(cert.raw).digest('hex') !== config.certificateSha256
    || !matchesAddress(cert, new URL(invitation.publicBaseUrl).hostname) || Date.parse(cert.validTo) <= Date.now()) throw fail('SECURE_IDENTITY_INVALID');
  if (!config.backends || !config.profiles || Object.keys(config.backends).some(key => !['paseo', 'codex'].includes(key))
    || Object.keys(config.profiles).some(key => !config.backends[key]) || invitation.backends.some(key => !config.backends[key])
    || Object.keys(config.backends).some(key => {
    const backend = config.backends[key], profile = config.profiles[key];
    return !backend || !profile || (backend.mode !== undefined && (key !== 'codex' || backend.mode !== 'independent'))
      || !Number.isInteger(backend.port) || backend.port < 1024 || backend.port > 65535
      || !/^[a-f0-9]{64}$/.test(backend.token ?? '') || !/^[a-f0-9]{64}$/.test(backend.upstreamToken ?? '')
      || profile.endpoint !== invitation.publicBaseUrl + '/' + key || profile.port !== backend.port || profile.token !== backend.token;
  })) throw fail('SECURE_CONFIGURATION_INVALID');
  const identity = { pfx: readFileSync(join(directory, 'server.p12')), passphrase: config.passphrase, cert: cert.toString(), certificateSha256: config.certificateSha256 };
  createSecureContext({ pfx: identity.pfx, passphrase: identity.passphrase, minVersion: 'TLSv1.3' });
  const ca = new X509Certificate(readFileSync(join(privateDirectory, 'local.cer'))).toString();
  return { ...config, hosting: invitation.hosting, directory, identity,
    backends: Object.fromEntries(Object.entries(config.backends).map(([key, value]) => [key, { ...value, ca }])) };
}
