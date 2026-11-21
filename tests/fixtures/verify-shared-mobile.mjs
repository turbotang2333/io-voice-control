// Manual mobile acceptance, using only disposable identities and a synthetic backend.
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { tlsFixture, listen } from '../helpers/tls-fixture.mjs';
import { validateHostedResponse } from '../../distribution/hosted-enrollment.mjs';
import { createDesktopGateway } from '../../secure-link/gateway.mjs';
import { createPairingStore } from '../../bridge/pairing.mjs';

assert.equal(process.env.RAYNEO_APPROVED_REAL_SERVER_TEST, '1');
const host = process.env.RAYNEO_TEST_HOST, address = process.env.RAYNEO_TEST_ADDRESS;
assert.match(host ?? '', /^[a-z0-9.-]+$/); assert.match(address ?? '', /^(?:\d{1,3}\.){3}\d{1,3}$/);
const id = randomUUID(), hostname = `${id}.relay.${host}`;
const identity = tlsFixture('shared-mobile-acceptance', { extraDnsNames: [hostname] });
const sshKey = join(identity.directory, 'test-ssh-key');
execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', sshKey], { stdio: 'pipe', timeout: 15000 });
const enrollment = { version: 1, installationId: id, requestedBackends: ['paseo'],
  sshPublicKey: readFileSync(sshKey + '.pub', 'utf8').trim().split(/\s+/).slice(0, 2).join(' ') };
const post = body => new Promise((resolve, reject) => {
  const text = JSON.stringify(body), req = https.request({ host: address, servername: host, port: 29445, path: '/v1/enroll', method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }, timeout: 15000 }, res => {
    const parts = []; res.on('data', b => parts.push(b)); res.on('end', () => {
      if (res.statusCode !== 200) return reject(Error('enrollment status ' + res.statusCode));
      try { resolve(JSON.parse(Buffer.concat(parts))); } catch (error) { reject(error); }
    });
  }); req.on('timeout', () => req.destroy(Error('enrollment timeout'))); req.on('error', reject); req.end(text);
});
const invitation = validateHostedResponse(await post(enrollment), enrollment);
assert.equal(invitation.publicBaseUrl, `https://${hostname}:29443`);
const knownHosts = join(identity.directory, 'known_hosts');
writeFileSync(knownHosts, 'rayneo-test ' + invitation.relay.hostKey + '\n', { flag: 'wx', mode: 0o600 });
const token = randomBytes(32).toString('hex'), upstreamToken = randomBytes(32).toString('hex');
const backend = https.createServer(identity, (req, res) => {
  if (req.method !== 'GET' || req.url !== '/healthz' || req.headers.authorization !== 'Bearer ' + upstreamToken) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"status":"ready"}');
});
const backendPort = await listen(backend);
const store = createPairingStore({ directory: join(identity.directory, 'pairing'), ttlMs: 300000 });
const gateway = createDesktopGateway({ identity, hostname, pairing: store,
  backends: { paseo: { port: backendPort, ca: identity.cert, token, upstreamToken } } });
const gatewayPort = await listen(gateway);
const ssh = spawn('ssh', ['-N', '-i', sshKey, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ExitOnForwardFailure=yes',
  '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'HostKeyAlias=rayneo-test', '-p', '29444',
  '-R', `/tunnel/relay.sock:127.0.0.1:${gatewayPort}`, `${invitation.relay.user}@${address}`], { stdio: ['ignore', 'ignore', 'ignore'] });
const check = () => new Promise((resolve, reject) => {
  const req = https.get({ host: address, servername: hostname, port: 29443, ca: identity.cert, path: '/paseo/healthz',
    headers: { host: `${hostname}:29443`, authorization: 'Bearer ' + token }, timeout: 4000 }, res => {
    let body = ''; res.on('data', b => body += b); res.on('end', () => resolve(res.statusCode === 200 && JSON.parse(body).status === 'ready'));
  }); req.on('timeout', () => req.destroy()); req.on('error', reject);
});
const deadline = Date.now() + 20000;
while (true) {
  if (ssh.exitCode !== null) throw Error('test tunnel exited');
  try { if (await check()) break; } catch {}
  if (Date.now() > deadline) throw Error('test tunnel not ready');
  await new Promise(resolve => setTimeout(resolve, 300));
}
const base = `${invitation.publicBaseUrl}/paseo`;
const page = http.createServer(async (req, res) => {
  if (req.url !== '/' || req.method !== 'GET') { res.writeHead(404); res.end(); return; }
  try {
    const ticket = store.issue({ computerLabel: '仅测试，请勿确认保存', publicBaseUrl: base, certificateSha256: identity.certificateSha256,
      profiles: { paseo: { endpoint: base, port: 7468, token } } });
    const image = await QRCode.toDataURL(ticket.url, { width: 420, margin: 4, errorCorrectionLevel: 'M' });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'" });
    res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>手机网络测试</title><style>body{font:20px sans-serif;max-width:740px;margin:40px auto;padding:0 20px;line-height:1.7}img{width:420px;max-width:90%}strong{color:#b42318}</style><h1>手机网络测试</h1><p>请关闭手机 Wi-Fi，打开雷鸟 APP 中的扫码配对，扫描下方二维码。</p><p><strong>出现确认页面后请选择取消，不要确认配对。</strong>这只是测试连接，不会使用你的真实对话。二维码 5 分钟有效，过期请刷新本页。</p><img alt="手机测试二维码" src="${image}"></html>`);
  } catch { res.writeHead(500); res.end('Test page unavailable'); }
});
const pagePort = await listen(page);
writeFileSync(process.env.RAYNEO_TEST_READY_FILE, JSON.stringify({ pid: process.pid, port: pagePort }), { mode: 0o600 });
ssh.once('exit', () => process.exit(1));
setTimeout(() => { ssh.kill(); process.exit(0); }, 30 * 60 * 1000).unref();
