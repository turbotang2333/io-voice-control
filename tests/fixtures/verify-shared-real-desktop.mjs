// Manual acceptance against the owner's real local bridges. Never logs credentials or sends model requests.
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import QRCode from 'qrcode';
import { configureSecureLink, loadSecureLink } from '../../secure-link/setup.mjs';
import { inspectSecureLink, issueSecurePairing, startSecureLinkService } from '../../secure-link/service.mjs';
import { validateHostedResponse } from '../../distribution/hosted-enrollment.mjs';

assert.equal(process.env.RAYNEO_APPROVED_REAL_SERVER_TEST, '1');
assert.equal(process.env.RAYNEO_APPROVED_LOCAL_CREDENTIAL_USE, '1');
const host = process.env.RAYNEO_TEST_HOST, address = process.env.RAYNEO_TEST_ADDRESS;
assert.match(host ?? '', /^[a-z0-9.-]+$/); assert.match(address ?? '', /^(?:\d{1,3}\.){3}\d{1,3}$/);
const home = homedir(), original = join(home, '.local-secrets/rayneo-paseo');
const isolated = join(home, '.local-secrets/rayneo-paseo-real-acceptance-' + randomUUID());
mkdirSync(isolated, { mode: 0o700 });
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
  resolve('distribution/protect-directory.ps1'), '-Directory', isolated], { windowsHide: true, stdio: 'pipe', timeout: 30000 });
const backends = ['paseo', 'codex'].filter(name => existsSync(join(original, name === 'paseo' ? 'daily.json' : 'shared-runtime/connector.json')));
assert.ok(backends.length);
copyFileSync(join(original, 'local.cer'), join(isolated, 'local.cer'));
for (const name of backends) {
  const path = name === 'paseo' ? 'daily.json' : 'shared-runtime/connector.json';
  const input = JSON.parse(readFileSync(join(original, path), 'utf8').replace(/^\uFEFF/, ''));
  const sanitized = name === 'paseo' ? { port: input.port, apiToken: input.apiToken } : { port: input.port, token: input.token };
  if (name === 'codex') mkdirSync(join(isolated, 'shared-runtime'), { mode: 0o700 });
  writeFileSync(join(isolated, path), JSON.stringify(sanitized), { flag: 'wx', mode: 0o600 });
}
const installationId = randomUUID();
writeFileSync(join(isolated, 'installation.json'), JSON.stringify({ version: 1, installationId, backends, phase: 'awaiting-invitation' }), { flag: 'wx', mode: 0o600 });
const keyPath = join(isolated, 'relay-key.pem');
execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath], { windowsHide: true, stdio: 'pipe', timeout: 15000 });
const enrollment = { version: 1, installationId, requestedBackends: backends,
  sshPublicKey: readFileSync(keyPath + '.pub', 'utf8').trim().split(/\s+/).slice(0, 2).join(' ') };
const response = await new Promise((accept, reject) => {
  const body = JSON.stringify(enrollment), req = https.request({ host: address, servername: host, port: 29445, path: '/v1/enroll', method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: 15000 }, res => {
    let data = ''; res.on('data', chunk => { data += chunk; if (data.length > 16384) req.destroy(); });
    res.on('end', () => { try { if (res.statusCode !== 200) throw Error(); accept(JSON.parse(data)); } catch { reject(Error('enrollment failed')); } });
  }); req.on('timeout', () => req.destroy()); req.on('error', reject); req.end(body);
});
const invitation = validateHostedResponse(response, enrollment);
await configureSecureLink({ privateDirectory: isolated, invitation });
const config = loadSecureLink(isolated);
const service = await startSecureLinkService({ configuration: config });
const deadline = Date.now() + 45000;
let status;
do {
  status = await inspectSecureLink(config, { timeoutMs: 3000 });
  if (status.pairingReady) break;
  await new Promise(accept => setTimeout(accept, 1000));
} while (Date.now() < deadline);
if (!status.pairingReady) {
  console.error('REAL_CONNECTION_NOT_READY ' + JSON.stringify({ state: status.state, connections: status.connections }));
  await service.stop(); process.exit(1);
}
const page = http.createServer(async (req, res) => {
  if (req.method !== 'GET' || req.url !== '/') { res.writeHead(404); res.end(); return; }
  try {
    const ticket = await issueSecurePairing(config, service.pairing, '我的电脑');
    const image = await QRCode.toDataURL(ticket.url, { width: 420, margin: 4, errorCorrectionLevel: 'M' });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'" });
    res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>连接我的电脑</title><style>body{font:20px sans-serif;max-width:740px;margin:40px auto;padding:0 20px;line-height:1.7}img{width:420px;max-width:90%}</style><h1>连接我的电脑</h1><p>请在雷鸟 APP 中扫描二维码，确认连接到“我的电脑”。</p><p>二维码短时间有效，过期请刷新本页。</p><img alt="真实连接二维码" src="${image}"></html>`);
  } catch { res.writeHead(503); res.end('Connection not ready'); }
});
await new Promise((accept, reject) => { page.once('error', reject); page.listen(0, '127.0.0.1', accept); });
writeFileSync(process.env.RAYNEO_TEST_READY_FILE, JSON.stringify({ pid: process.pid, port: page.address().port,
  backends: status.connections.filter(c => c.ready).map(c => c.backend) }), { flag: 'wx', mode: 0o600 });
console.log('REAL_CONNECTION_READY');
process.once('SIGINT', async () => { page.close(); await service.stop(); process.exit(0); });
