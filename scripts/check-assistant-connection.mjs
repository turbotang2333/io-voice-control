import { readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { X509Certificate } from 'node:crypto';
import { resolveRuntimeConfig } from '../bridge/runtime-config.mjs';
import { validateProfile } from '../experiments/codex-connector/service.mjs';
import { connectorMaintenancePlan } from '../experiments/codex-connector/supervisor.mjs';
import { probeBridgeHealth } from '../bridge/relay-health.mjs';

try {
  const [flag, backend, ...extra] = process.argv.slice(2);
  if (flag !== '--backend' || !['paseo', 'codex'].includes(backend) || extra.length) throw Error('USAGE');
  const root = join(homedir(), '.local-secrets/rayneo-paseo');
  const read = path => {
    if (!isAbsolute(path)) throw Error('CONFIG');
    const bytes = readFileSync(path); if (bytes.length > 16384) throw Error('CONFIG');
    return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  };
  let localUrl, publicUrl, token;
  if (backend === 'paseo') {
    const raw = read(join(root, 'daily.json')), p = resolveRuntimeConfig(raw, { daily: true });
    token = p.token; localUrl = `https://127.0.0.1:${p.port}/healthz`;
    const endpoint = new URL(raw.publicBaseUrl);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw Error('CONFIG');
    publicUrl = endpoint.href.replace(/\/+$/, '') + '/healthz';
  } else {
    const startup = read(join(root, 'shared-runtime/startup.json'));
    const p = validateProfile(read(startup.connectorConfiguration));
    const plan = connectorMaintenancePlan(p, read(startup.wirelessConfiguration), startup.connectorConfiguration);
    localUrl = plan.localHealth; publicUrl = plan.publicHealth; token = p.token;
  }
  const ca = new X509Certificate(readFileSync(join(root, 'local.cer'))).toString();
  const [local, wireless, unauthorized] = await Promise.all([
    probeBridgeHealth({ url: localUrl, token, ca, timeoutMs: 15000 }),
    probeBridgeHealth({ url: publicUrl, token, timeoutMs: 15000 }),
    probeBridgeHealth({ url: localUrl, token: 'synthetic-invalid-token', ca, timeoutMs: 15000 }),
  ]);
  const ready = local === 'ready' && wireless === 'ready' && unauthorized === 'rejected';
  console.log(JSON.stringify({ backend, ready, local, wireless, authorizationGuard: unauthorized === 'rejected',
    modelMessagesSent: 0, configurationChanged: false }));
  if (!ready) process.exitCode = 1;
} catch {
  console.log(JSON.stringify({ ready: false, reason: 'configuration-check-failed', modelMessagesSent: 0, configurationChanged: false }));
  process.exitCode = 1;
}
