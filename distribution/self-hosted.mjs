import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createUnixRelayBundle } from '../relay/unix-provision.mjs';
import { writeRelayBundle } from '../relay/wizard.mjs';
import { validateSecureInvitation, validateSshPublicKey, validHostname } from '../secure-link/config.mjs';
import { decodePairingInformation, requestBootstrap } from '../relay/self-hosted-bootstrap.mjs';
import { createServerInstallCommand } from './self-hosted-command.mjs';

const fail = code => Object.assign(Error(code), { code });
export function createSelfHostedActions({ stateDirectory, legacy, secure, prepareExisting, bootstrapRequest = requestBootstrap,
  createIdentity, makeInstallCommand = createServerInstallCommand, bootstrapPort = 2222, pollIntervalMs = 2000, now = Date.now } = {}) {
  if (!isAbsolute(stateDirectory ?? '') || !legacy || !secure) throw fail('SELF_HOSTED_INVALID');
  const base = join(stateDirectory, 'self-hosted-bundles');
  let automatic, pendingPreparation, pendingHost;
  createIdentity ??= async host => {
    mkdirSync(stateDirectory, { recursive: true });
    const directory = mkdtempSync(join(stateDirectory, 'bootstrap-identity-'));
    const passphrase = randomBytes(32).toString('hex');
    try {
      const script = name => fileURLToPath(new URL('./' + name, import.meta.url));
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script('protect-directory.ps1'), '-Directory', directory], { windowsHide: true, stdio: 'pipe', timeout: 30000 });
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script('certificate.ps1'), '-Directory', directory, '-Hostname', host],
        { env: { ...process.env, RAYNEO_INSTALL_PFX_PASSWORD: passphrase }, windowsHide: true, stdio: 'pipe', timeout: 30000 });
      return { cert: readFileSync(join(directory, 'local.cer')), pfx: readFileSync(join(directory, 'server.p12')), passphrase };
    } finally { rmSync(directory, { recursive: true }); }
  };
  const unconfigured = async () => { if ((await secure.status()).phase !== 'unconfigured') throw fail('SECURE_CONFIGURATION_EXISTS'); };
  const computerEnrollment = async () => {
    const status = await legacy.status();
    if (status.phase === 'existing') {
      if (typeof prepareExisting !== 'function') throw fail('SELF_HOSTED_INVALID');
      return (await prepareExisting()).enrollment;
    }
    if (['new', 'incomplete'].includes(status.phase)) await legacy.prepare();
    return legacy.enrollment();
  };
  return {
    async selfHostedCommand({ host } = {}) {
      await unconfigured();
      if (!(validHostname(host) || isIP(host) === 4 && !host.startsWith('127.') && host !== '0.0.0.0')) throw fail('SELF_HOSTED_INVALID');
      if (pendingPreparation) { if (pendingHost !== host) throw fail('SELF_HOSTED_BUSY'); return pendingPreparation; }
      if (automatic?.state === 'waiting' && now() < automatic.expiresAt) {
        if (automatic.host !== host) throw fail('SELF_HOSTED_BUSY');
        return { command: automatic.command };
      }
      if (automatic?.state === 'waiting' && automatic.inFlight) throw fail('SELF_HOSTED_BUSY');
      pendingHost = host;
      pendingPreparation = (async () => {
      const enrollment = await computerEnrollment();
      const identity = await createIdentity(host), secret = randomBytes(32).toString('base64url'), expiresAt = now() + 900000;
      const { createPairingInformation } = await import('../relay/self-hosted-bootstrap.mjs');
      const info = createPairingInformation({ host, port: bootstrapPort, cert: identity.cert, secret });
      const command = makeInstallCommand({ host, pfx: identity.pfx.toString('base64'), cert: identity.cert.toString('base64'), passphrase: identity.passphrase, secret, expiresAt });
      const session = automatic = { state: 'waiting', host, command, expiresAt };
      const poll = async () => {
        if (automatic !== session || session.state !== 'waiting') return;
        if (now() >= expiresAt) { session.state = 'expired'; session.command = undefined; return; }
        let received = false;
        session.inFlight = true;
        try {
          const response = await bootstrapRequest({ info, enrollment, timeoutMs: 120000, onAuthenticated: () => { session.installing = true; } });
          received = true;
          if (automatic !== session) return;
          const invitation = validateSecureInvitation(response, enrollment.installationId);
          if (invitation.hosting !== 'self-hosted' || invitation.version !== 3 || invitation.relay.host !== host || invitation.relay.port !== bootstrapPort
            || new URL(invitation.publicBaseUrl).hostname !== host || invitation.relay.user !== 'rnp_' + enrollment.installationId.replaceAll('-', '').slice(0, 20)
            || invitation.backends.length !== enrollment.requestedBackends.length || invitation.backends.some(name => !enrollment.requestedBackends.includes(name))) throw fail('SELF_HOSTED_INVALID');
          await unconfigured();
          await secure.configure(invitation);
          session.command = undefined;
          try { await secure.connect(); session.state = 'connected'; } catch { session.state = 'configured'; }
        } catch (error) {
          if (automatic === session && session.state === 'waiting') {
            if (received || session.installing || error?.code === 'SELF_HOSTED_BOOTSTRAP_RESPONSE') { session.state = 'failed'; session.command = undefined; }
            else { const timer = setTimeout(poll, pollIntervalMs); timer.unref?.(); }
          }
        } finally { session.inFlight = false; }
      };
      void poll();
      return { command };
      })();
      try { return await pendingPreparation; } finally { pendingPreparation = undefined; pendingHost = undefined; }
    },
    selfHostedProgress() { return { state: automatic?.state === 'waiting' && automatic.installing ? 'installing' : automatic?.state ?? 'idle' }; },
    async pairSelfHosted({ pairingInfo } = {}) {
      await unconfigured();
      const info = decodePairingInformation(pairingInfo), enrollment = await computerEnrollment();
      const response = await bootstrapRequest({ info, enrollment });
      let invitation;
      try {
        invitation = validateSecureInvitation(response, enrollment.installationId);
        if (invitation.hosting !== 'self-hosted' || invitation.version !== 3 || invitation.relay.host !== info.host
          || invitation.relay.port !== info.port || new URL(invitation.publicBaseUrl).hostname !== info.host
          || invitation.relay.user !== 'rnp_' + enrollment.installationId.replaceAll('-', '').slice(0, 20)
          || invitation.backends.length !== enrollment.requestedBackends.length
          || invitation.backends.some(name => !enrollment.requestedBackends.includes(name))) throw Error();
      } catch { throw fail('SELF_HOSTED_INVALID'); }
      await unconfigured();
      await secure.configure(invitation);
      try { return await secure.connect(); } catch { return { configured: true, starting: false }; }
    },
    async prepareSelfHosted({ ip, hostKey, publicPort = 443, sshPort = 2222 } = {}) {
      await unconfigured();
      if (!(validHostname(ip) || isIP(ip) === 4 && !ip.startsWith('127.') && ip !== '0.0.0.0') || !Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535
        || !Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535 || publicPort === sshPort) throw fail('SELF_HOSTED_INVALID');
      try { hostKey = validateSshPublicKey(hostKey, true); } catch { throw fail('SELF_HOSTED_INVALID'); }
      const enrollment = await computerEnrollment();
      const bundle = createUnixRelayBundle({ enrollment, hosting: 'self-hosted', publicBaseUrl: `https://${ip}${publicPort === 443 ? '' : ':' + publicPort}`,
        relay: { host: ip, port: sshPort, user: 'rnp_' + enrollment.installationId.replaceAll('-', '').slice(0, 20), hostKey } });
      mkdirSync(base, { recursive: true, mode: 0o700 });
      if (lstatSync(base).isSymbolicLink()) throw fail('SELF_HOSTED_INVALID');
      const bundleId = randomBytes(16).toString('hex'), directory = join(base, bundleId);
      writeRelayBundle({ output: directory, bundle });
      return { bundleId, directory, publicPort, sshPort, serverChanged: false };
    },
    async finishSelfHosted({ bundleId } = {}) {
      await unconfigured();
      if (!/^[a-f0-9]{32}$/.test(bundleId ?? '')) throw fail('SELF_HOSTED_INVALID');
      const directory = join(base, bundleId), stat = lstatSync(directory), path = join(directory, 'invitation.json'), file = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory() || file.isSymbolicLink() || !file.isFile() || file.size > 16384) throw fail('SELF_HOSTED_INVALID');
      const invitation = JSON.parse(readFileSync(path, 'utf8'));
      if (invitation.hosting !== 'self-hosted') throw fail('SELF_HOSTED_INVALID');
      await secure.configure(invitation);
      try { return await secure.connect(); } catch { return { configured: true, starting: false }; }
    },
    async changeSelfHostedIp({ ip } = {}) {
      const status = await secure.status();
      if (status.phase !== 'configured' || status.hosting !== 'self-hosted') throw fail('SELF_HOSTED_INVALID');
      await secure.changeIp({ ip });
      try { await secure.connect(); return { starting: true, pairingRequired: true }; }
      catch { return { starting: false, pairingRequired: true }; }
    },
    async restoreSelfHostedIp({ backupId } = {}) {
      const status = await secure.status();
      if (status.phase !== 'configuration_error' || !status.ipRecoveryOptions?.some(item => item.id === backupId)) throw fail('SECURE_IP_RECOVERY_INVALID');
      return secure.restoreIp({ backupId });
    },
  };
}
