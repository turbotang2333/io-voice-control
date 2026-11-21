/** Optional onboarding route. Its proof cannot authenticate or submit an assistant task. */
export async function handlePairingRequest(request, response, store) {
  if (!store) return false;
  const reply = (status, body, type = 'application/json; charset=utf-8') => {
    response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store',
      'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'" });
    response.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  if (request.method === 'GET' && request.url === '/pair') {
    reply(200, '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>眼镜助手配对</title><body><h1>请在雷鸟 APP 中扫码配对</h1><p>打开“助手设置”，选择“扫码配对”，再扫描电脑上的二维码。</p><p>过期后请在电脑重新生成二维码。</p></body></html>', 'text/html; charset=utf-8');
    return true;
  }
  if (request.url !== '/v1/pairing/claim') return false;
  if (request.method !== 'POST') { reply(405, { error: { code: 'METHOD_NOT_ALLOWED' } }); return true; }
  // A native scanner has no browser Origin. Keep cross-site forms and scripts outside the pairing flow.
  if (request.headers.origin) { reply(403, { error: { code: 'PAIRING_ORIGIN_REJECTED' } }); return true; }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) { reply(415, { error: { code: 'PAIRING_JSON_REQUIRED' } }); return true; }
  const chunks = []; let bytes = 0;
  const timer = setTimeout(() => {
    if (!response.writableEnded) {
      response.writeHead(408, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' });
      response.end('{"error":{"code":"PAIRING_BODY_TIMEOUT"}}', () => request.destroy());
    }
  }, 5000);
  try {
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 2048) { reply(413, { error: { code: 'PAIRING_BODY_TOO_LARGE' } }); return true; }
      chunks.push(chunk);
    }
    if (response.writableEnded) return true;
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reply(400, { error: { code: 'PAIRING_INVALID_INPUT' } }); return true; }
    if (!body || body.version !== 1 || Object.keys(body).some(k => !['version', 'code'].includes(k))) {
      reply(400, { error: { code: 'PAIRING_INVALID_INPUT' } }); return true;
    }
    try { reply(200, store.claim(body.code)); }
    catch (error) { reply(error.code === 'PAIRING_UNAVAILABLE' ? 401 : 503, { error: { code: error.code === 'PAIRING_UNAVAILABLE' ? 'PAIRING_UNAVAILABLE' : 'PAIRING_UNAVAILABLE_NOW' } }); }
  } catch { if (!response.writableEnded) reply(400, { error: { code: 'PAIRING_INVALID_INPUT' } }); }
  finally { clearTimeout(timer); }
  return true;
}
