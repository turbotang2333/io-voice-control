// Local manual acceptance page; the separate gateway owns the active connection.
import http from 'node:http';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { loadSecureLink } from '../../secure-link/setup.mjs';
import { issueSecurePairing } from '../../secure-link/service.mjs';
import { createPairingStore } from '../../bridge/pairing.mjs';
if (process.env.RAYNEO_APPROVED_LOCAL_CREDENTIAL_USE !== '1') throw Error('APPROVAL_REQUIRED');
const parent = join(homedir(), '.local-secrets');
const name = readdirSync(parent).filter(n => n.startsWith('rayneo-paseo-real-acceptance-'))
  .sort((a, b) => statSync(join(parent, b)).birthtimeMs - statSync(join(parent, a)).birthtimeMs)[0];
const config = loadSecureLink(join(parent, name));
const store = createPairingStore({ directory: join(config.directory, 'pairing') });
const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' || req.url !== '/') { res.writeHead(404); res.end(); return; }
  try {
    const ticket = await issueSecurePairing(config, store, '我的电脑');
    const image = await QRCode.toDataURL(ticket.url, { width: 420, margin: 4, errorCorrectionLevel: 'M' });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'" });
    res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>连接我的电脑</title><style>body{font:20px sans-serif;max-width:740px;margin:40px auto;padding:0 20px;line-height:1.7}img{width:420px;max-width:90%}</style><h1>连接我的电脑</h1><p>用雷鸟 APP 扫码并确认连接。二维码短时间有效，过期请刷新本页。</p><img alt="真实连接二维码" src="${image}"></html>`);
  } catch { res.writeHead(503); res.end('Connection not ready'); }
});
await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
writeFileSync(process.env.RAYNEO_TEST_READY_FILE, JSON.stringify({ pid: process.pid, port: server.address().port }), { flag: 'wx', mode: 0o600 });
