import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { request } from 'node:https';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolveRuntimeConfig } from '../bridge/runtime-config.mjs';

const secretRoot = join(homedir(), '.local-secrets', 'rayneo-paseo');
const config = resolveRuntimeConfig(JSON.parse(readFileSync(join(secretRoot, 'daily.json'), 'utf8')), { daily: true });
const ca = new X509Certificate(readFileSync(join(secretRoot, 'local.cer'))).toString();
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let child;
let lastState = 'unreachable';
const reachable = () => new Promise(resolveCheck => {
  const socket = createConnection({ host: config.host, port: config.port });
  socket.once('connect', () => { socket.destroy(); resolveCheck(true); });
  socket.once('error', () => resolveCheck(false));
  socket.setTimeout(1000, () => { socket.destroy(); resolveCheck(false); });
});
function health(authorized) {
  return new Promise((resolveHealth, reject) => {
    const req = request({ host: config.host, port: config.port, path: '/healthz', ca, timeout: 2000,
      headers: authorized ? { authorization: `Bearer ${config.token}` } : {} }, response => {
      let body = '';
      response.setEncoding('utf8'); response.on('data', value => { body += value; });
      response.on('end', () => { try { resolveHealth({ code: response.statusCode, body: JSON.parse(body) }); } catch { reject(new Error('Invalid health response')); } });
    });
    req.once('timeout', () => req.destroy(new Error('Health timeout'))); req.once('error', reject); req.end();
  });
}
try {
  if (process.argv.includes('--local-start')) {
    if (await reachable()) throw new Error('Candidate port is already occupied; no existing process will be stopped');
    child = spawn(process.execPath, [join(project, 'bridge', 'server.mjs'), '--daily'], { cwd: project, windowsHide: true, stdio: 'ignore' });
    child.once('error', () => {});
  }
  const deadline = Date.now() + 12000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const status = await health(true);
      lastState = status.code === 503 ? 'paseo-reconnecting' : `http-${status.code}`;
      if (status.code === 200 && status.body.ok === true && status.body.status === 'ready') { ready = true; break; }
    } catch (error) {
      if (typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code)) lastState = error.code;
    }
    await sleep(200);
  }
  if (!ready) throw new Error('Candidate did not become ready');
  if ((await health(false)).code !== 401) throw new Error('Authentication guard failed');
  console.log('候选服务通过本机 TLS、Paseo 连接及未授权拒绝检查；只请求健康状态，没有向 Agent 发送消息。');
} catch {
  console.error(`候选健康检查未通过（${lastState}）；未停用原 USB 服务，未发送 Agent 消息。`);
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    await new Promise(resolveStop => { child.once('close', resolveStop); child.kill(); });
  }
}
