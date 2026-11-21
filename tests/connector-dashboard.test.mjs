import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createDashboardHandler } from '../distribution/dashboard.mjs';
import { readFileSync } from 'node:fs';
import QRCode from 'qrcode';

test('the Android download link and its local QR code use the same stable releases page', async () => {
  const url = 'https://github.com/turbotang2333/io-voice-control/releases';
  let origin;
  const server = createServer(createDashboardHandler({ actions: {}, getOrigin: () => origin }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await (await fetch(origin)).text();
    assert.match(page, new RegExp(`href="${url}"`));
    assert.match(page, /src="\/android-download-qr\.png"/);
    const qr = await fetch(origin + '/android-download-qr.png');
    assert.equal(qr.status, 200);
    assert.equal(qr.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await qr.arrayBuffer()), await QRCode.toBuffer(url, { width: 320, margin: 4 }));
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('the trial page retains automatic connection and offers an optional self-hosted setup', () => {
  const page = readFileSync(new URL('../distribution/ui/index.html', import.meta.url), 'utf8');
  assert.match(page, /使用自己的服务器/);
  assert.doesNotMatch(page, /下载接入申请|导入接入文件/);
  assert.match(page, /确认并连接/);
});

test('self-hosted actions reject foreign origins and accept the local page', async () => {
  let writes = 0, origin;
  const server = createServer(createDashboardHandler({ actions: { prepareSelfHosted: async () => { writes++; return { prepared: true }; } }, getOrigin: () => origin }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const post = source => fetch(origin + '/api/self-hosted-prepare', { method: 'POST', headers: { origin: source, 'content-type': 'application/json' }, body: '{}' });
    assert.equal((await post('https://foreign.example')).status, 403);
    assert.equal(writes, 0);
    assert.equal((await post(origin)).status, 200);
    assert.equal(writes, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('manual refresh requests a fresh status without invoking connection actions', async () => {
  const calls = [], actions = { status: async force => { calls.push(force); return { phase: 'new' }; }, connect: () => assert.fail('must not connect') };
  let origin; const server = createServer(createDashboardHandler({ actions, getOrigin: () => origin }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(origin + '/api/status')).status, 200);
    assert.equal((await fetch(origin + '/api/status?refresh=1')).status, 200);
    assert.deepEqual(calls, [false, true]);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('local installer rejects foreign origins and hosts before any configuration or connection action', async () => {
  let writes = 0;
  const actions = { status: async () => ({ phase: 'new', available: ['paseo'] }), prepare: async () => { writes++; return { prepared: true }; } };
  let origin;
  const server = createServer(createDashboardHandler({ actions, getOrigin: () => origin }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  const post = headers => fetch(origin + '/api/prepare', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{"backends":["paseo"]}' });
  try {
    assert.equal((await post({ origin: 'https://foreign.example' })).status, 403);
    assert.equal((await post({})).status, 403);
    assert.equal(writes, 0);
    assert.equal((await post({ origin })).status, 200); assert.equal(writes, 1);
    assert.equal((await fetch(origin + '/api/status')).status, 200);
    const foreignHost = await new Promise((resolve, reject) => {
      const request = httpRequest(origin + '/api/status', { headers: { host: 'foreign.example' } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
      request.on('error', reject); request.end();
    });
    assert.equal(foreignHost, 403);
    const page = await fetch(origin + '/'); assert.equal(page.status, 200); assert.match(await page.text(), /眼镜连接器/);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
