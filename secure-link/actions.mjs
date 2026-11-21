import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { isIP } from 'node:net';
import QRCode from 'qrcode';
import { createPairingStore } from '../bridge/pairing.mjs';
import { addCodexBackend, configureSecureLink, loadSecureLink, restoreInterruptedSelfHostedIp } from './setup.mjs';
import { changeIpCommand } from './change-ip.mjs';
import { inspectSecureLink, issueSecurePairing } from './service.mjs';
import { createLocalConnectionStarter } from './local-backends.mjs';

const fail = code => Object.assign(Error(code), { code });

/** Frontend integration surface. No private token, PFX or password is returned to a browser. */
export function createSecureLinkActions({ codeRoot, privateDirectory = join(homedir(), '.local-secrets/rayneo-paseo'),
  stateDirectory = join(homedir(), '.local/state/rayneo-paseo'), startLocalConnections, spawnChild = spawn, desktop, prepareDesktopAdapter } = {}) {
  if (![codeRoot, privateDirectory, stateDirectory].every(value => isAbsolute(value ?? ''))) throw fail('SECURE_CONFIGURATION_INVALID');
  const load = () => loadSecureLink(privateDirectory);
  desktop ??= () => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', join(codeRoot, 'distribution/desktop-state.ps1')], { windowsHide: true, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }));
  prepareDesktopAdapter ??= async output => {
    const compiler = join(process.env.SystemRoot ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    execFileSync(compiler, ['/nologo', '/optimize+', '/target:exe', '/out:' + output, join(codeRoot, 'experiments/codex-shared/DesktopProxy.cs')],
      { windowsHide: true, stdio: 'pipe', timeout: 30000 });
  };
  startLocalConnections ??= createLocalConnectionStarter({ codeRoot, privateDirectory }).start;
  let connectPending, gatewayChild;
  function launchGateway() {
    if (gatewayChild) return Promise.resolve();
    const child = spawnChild(process.execPath, [join(codeRoot, 'secure-link/run.mjs'), 'start', '--private-directory', privateDirectory,
      '--state-directory', stateDirectory], { cwd: codeRoot, detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    gatewayChild = child;
    const clear = () => { if (gatewayChild === child) gatewayChild = undefined; };
    child.once('exit', clear);
    return new Promise((accept, reject) => {
      child.once('error', () => { clear(); reject(fail('SECURE_START_FAILED')); });
      child.once('spawn', () => { child.unref(); accept(); });
    });
  }
  return {
    configure: invitation => configureSecureLink({ privateDirectory, invitation }),
    async changeIp({ ip } = {}) {
      const current = load().invitation, oldIp = new URL(current.publicBaseUrl).hostname;
      if (current.hosting !== 'self-hosted' || isIP(oldIp) !== 4 || current.relay.host !== oldIp || isIP(ip) !== 4 || ip === oldIp || ip.startsWith('127.') || ip === '0.0.0.0') throw fail('SECURE_IP_UPDATE_INVALID');
      if (gatewayChild) {
        const child = gatewayChild;
        await new Promise((resolveStop, rejectStop) => {
          const timer = setTimeout(() => rejectStop(fail('SECURE_STOP_FAILED')), 10000);
          child.once('exit', () => { clearTimeout(timer); resolveStop(); });
          try { child.send('stop-secure-link', error => { if (error) { clearTimeout(timer); rejectStop(fail('SECURE_STOP_FAILED')); } }); }
          catch { clearTimeout(timer); rejectStop(fail('SECURE_STOP_FAILED')); }
        });
      }
      return changeIpCommand(['--ip', ip, '--private-directory', privateDirectory, '--state-directory', stateDirectory]);
    },
    restoreIp({ backupId } = {}) {
      if (!/^[a-f0-9]{64}$/.test(backupId ?? '')) throw fail('SECURE_IP_RECOVERY_INVALID');
      return restoreInterruptedSelfHostedIp({ privateDirectory, stateDirectory, backupDirectory: join(privateDirectory, '.secure-previous-' + backupId) });
    },
    async status() {
      try {
        let marker = false;
        try { lstatSync(join(privateDirectory, 'secure-link-enabled.json')); marker = true; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        try { lstatSync(join(privateDirectory, 'secure-link')); }
        catch (error) {
          if (error.code === 'ENOENT' && !marker) return { version: 1, phase: 'unconfigured', encryption: 'unverified',
            connections: [], pairingReady: false, modelMessagesSent: 0 };
          throw error;
        }
        const config = load(), status = await inspectSecureLink(config);
        const pairing = createPairingStore({ directory: join(config.directory, 'pairing') });
        const host = new URL(config.invitation.publicBaseUrl).hostname;
        return { ...status, pairingState: pairing.status().kind,
          ipChangeAvailable: config.invitation.hosting === 'self-hosted' && isIP(host) === 4 && config.invitation.relay.host === host };
      } catch (error) {
        let ipRecoveryOptions = [];
        try {
          if (!existsSync(join(privateDirectory, 'secure-link')) && existsSync(join(privateDirectory, 'secure-link-enabled.json'))) {
            ipRecoveryOptions = readdirSync(privateDirectory).filter(name => /^\.secure-previous-[a-f0-9]{64}$/.test(name))
              .filter(name => { const stat = lstatSync(join(privateDirectory, name)); return stat.isDirectory() && !stat.isSymbolicLink(); })
              .map(name => ({ id: name.slice('.secure-previous-'.length), modified: lstatSync(join(privateDirectory, name)).mtime.toISOString() }))
              .sort((a, b) => b.modified.localeCompare(a.modified));
          }
        } catch { /* An unreadable private directory is never offered for recovery. */ }
        return { version: 1, phase: 'configuration_error', encryption: 'unverified', connections: [], pairingReady: false,
          code: /^SECURE_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'SECURE_CONFIGURATION_INVALID', ipRecoveryOptions, modelMessagesSent: 0 };
      }
    },
    connect(options = {}) {
      let config = load();
      return connectPending ??= (async () => {
        if (options.enableCodex && !config.backends.codex) {
          const current = await desktop();
          if (!current.installed || !isAbsolute(current.native ?? '')) throw fail('CODEX_NOT_INSTALLED');
          await addCodexBackend({ privateDirectory, executable: current.native, prepareDesktopAdapter, independentCodex: true });
          config = load();
          const local = await startLocalConnections(config);
          await launchGateway();
          return { starting: true, backends: Object.keys(config.backends), localConnectionsStarted: local.started,
            blocked: local.blocked, existingDesktopStopped: false, modelMessagesSent: 0 };
        }
        const local = await startLocalConnections(config);
        await launchGateway();
        return { starting: true, backends: Object.keys(config.backends), localConnectionsStarted: local.started,
          blocked: local.blocked, existingDesktopStopped: false, modelMessagesSent: 0 };
      })().finally(() => { connectPending = undefined; });
    },
    async pair() {
      const config = load(), store = createPairingStore({ directory: join(config.directory, 'pairing') });
      const ticket = await issueSecurePairing(config, store);
      return { image: await QRCode.toDataURL(ticket.url, { width: 420, margin: 4, errorCorrectionLevel: 'M' }), expiresAt: ticket.expiresAt,
        transport: 'tls-passthrough-v1', encryption: 'verified' };
    },
  };
}
