import { request } from 'node:https';
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { relayArguments } from '../../bridge/supervisor.mjs';
import { resolveRuntimeConfig } from '../../bridge/runtime-config.mjs';

// A reviewable proposal, never a relay launcher or a deployment operation.
export function wirelessProposal(sshHost) {
  return { activation: 'not-authorized-or-started', path: '/rayneo-codex/',
    relayArgs: relayArguments({ sshHost, remotePort: 17469 }, 17469) };
}

function health(port, ca, token) {
  return new Promise(resolveHealth => {
    const req = request({ hostname: '127.0.0.1', port, path: '/healthz', method: 'GET', ca, timeout: 3000,
      headers: token ? { authorization: `Bearer ${token}` } : {} }, response => {
      let body = ''; let size = 0;
      response.setEncoding('utf8');
      response.on('data', chunk => { size += Buffer.byteLength(chunk); if (size > 8192) response.destroy(); else body += chunk; });
      response.once('error', () => resolveHealth({ code: 0 }));
      response.once('aborted', () => resolveHealth({ code: 0 }));
      response.once('end', () => { try { resolveHealth({ code: response.statusCode, body: JSON.parse(body) }); }
        catch { resolveHealth({ code: 0 }); } });
    });
    req.once('timeout', () => req.destroy()); req.once('error', () => resolveHealth({ code: 0 })); req.end();
  });
}

export async function checkWirelessPreparation() {
  const privateRoot = join(homedir(), '.local-secrets', 'rayneo-paseo');
  const stateRoot = join(homedir(), '.local', 'state', 'rayneo-paseo', 'codex-direct');
  const read = (root, name) => JSON.parse(readFileSync(join(root, name), 'utf8').replace(/^\uFEFF/, ''));
  const codex = read(privateRoot, 'codex-direct.json');
  const daily = resolveRuntimeConfig(read(privateRoot, 'daily.json'), { daily: true });
  if (codex.host !== '127.0.0.1' || codex.port !== 17469 || !/^[a-f0-9]{64}$/.test(codex.apiToken)
      || daily.host !== '127.0.0.1' || daily.port === codex.port || daily.token === codex.apiToken) throw new Error('INVALID_ISOLATION');
  const ca = new X509Certificate(readFileSync(join(privateRoot, 'local.cer'))).toString();
  const [c, p, cNone, pNone, cCross, pCross] = await Promise.all([
    health(codex.port, ca, codex.apiToken), health(daily.port, ca, daily.token),
    health(codex.port, ca), health(daily.port, ca),
    health(codex.port, ca, daily.token), health(daily.port, ca, codex.apiToken),
  ]);
  const state = read(stateRoot, 'desktop-navigation-state.json');
  const lock = read(stateRoot, 'process.lock');
  const run = read(stateRoot, 'phone-run.json');
  const checks = {
    codexTlsHealthy: c.code === 200 && c.body?.ok === true && c.body?.experiment === 'codex-direct',
    paseoTlsHealthy: p.code === 200 && p.body?.ok === true && p.body?.status === 'ready',
    unauthenticatedDenied: cNone.code === 401 && pNone.code === 401,
    crossModeTokenDenied: cCross.code === 401 && pCross.code === 401,
    serviceIdentityConsistent: lock.backend === 'desktop-tools' && run.backend === lock.backend && run.pid === lock.pid,
    selectionSaved: typeof state.selection?.projectId === 'string' && typeof state.selection?.threadId === 'string',
    noUncertainRequest: Array.isArray(state.requests) && !state.requests.some(r => r.status === 'unknown'),
    requestCapacityAvailable: Array.isArray(state.requests) && state.requests.length < 256,
  };
  return { checkedAt: new Date().toISOString(), checks, readyForNetworkReview: Object.values(checks).every(Boolean),
    publicRouteChanged: false, relayStarted: false, phoneChanged: false, modelMessageSent: false,
    wirelessAcceptance: 'pending' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 2) throw new Error('NO_MUTATION_FLAGS_SUPPORTED');
    const result = await checkWirelessPreparation();
    console.log(JSON.stringify(result, null, 2));
    if (!result.readyForNetworkReview) process.exitCode = 1;
  } catch {
    console.error('Codex 无线准备检查未通过；未改手机、服务或网络，未发送对话消息。');
    process.exitCode = 1;
  }
}
