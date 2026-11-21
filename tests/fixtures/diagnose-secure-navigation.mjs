// Manual diagnostics: only navigation HTTP status and known error codes are printed.
import https from 'node:https';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadSecureLink } from '../../secure-link/setup.mjs';
import { inspectSecureLink, startSecureLinkService } from '../../secure-link/service.mjs';

if (process.env.RAYNEO_APPROVED_LOCAL_CREDENTIAL_USE !== '1') throw Error('APPROVAL_REQUIRED');
const originalRequest = https.request;
https.request = function(options, ...args) {
  const request = originalRequest.call(this, options, ...args);
  if (options?.path === '/v1/navigation/session') request.on('response', response => {
    const status = response.statusCode; let body = '';
    response.on('data', part => { if (body.length < 2048) body += part.toString('utf8'); });
    response.on('end', () => {
      let code = 'none'; try { const candidate = JSON.parse(body)?.error?.code; if (/^NAVIGATION_[A-Z_]+$/.test(candidate ?? '')) code = candidate; } catch {}
      console.log(JSON.stringify({ event: 'navigation', status, code }));
    });
  });
  return request;
};
const parent = join(homedir(), '.local-secrets');
const name = readdirSync(parent).filter(n => n.startsWith('rayneo-paseo-real-acceptance-'))
  .sort((a, b) => statSync(join(parent, b)).birthtimeMs - statSync(join(parent, a)).birthtimeMs)[0];
if (!name) throw Error('CONFIGURATION_MISSING');
const config = loadSecureLink(join(parent, name)), service = await startSecureLinkService({ configuration: config });
const until = Date.now() + 45000;
while (Date.now() < until) {
  if ((await inspectSecureLink(config, { timeoutMs: 3000 })).pairingReady) { console.log('DIAGNOSTIC_CONNECTION_READY'); break; }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
process.once('SIGINT', async () => { await service.stop(); process.exit(0); });
