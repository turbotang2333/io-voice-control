import { timingSafeEqual } from 'node:crypto';
import { navigationHandshake, authorizeNavigationRequest } from '../../bridge/navigation-session.mjs';
import { assistantMessages as outcomes } from '../../bridge/assistant-messages.mjs';
import { handlePairingRequest } from '../../bridge/pairing-http.mjs';

const errors = {
  INVALID_INPUT: '请求格式无效，本次未提交。',
  REQUEST_CONFLICT: '同一请求编号对应不同正文，本次未提交。',
  CODEX_BUSY: outcomes.busy,
  DESKTOP_UNAVAILABLE: outcomes.offline,
  CODEX_DISCONNECTED: outcomes.connectionLost,
  OUTCOME_UNKNOWN: outcomes.previousUnknown,
  EXPERIMENT_FULL: '本轮请求记录已满，请在原客户端核对。',
  STATE_WRITE_FAILED: outcomes.storage,
};

// Same narrow wire contract as the installed glasses add-on, no Paseo dependency.
export function createHandler({ token, gateway, sessions, pairing, isReady = () => true }) {
  const expected = Buffer.from(`Bearer ${token}`);
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid experiment token');
  return async (request, response) => {
    if (await handlePairingRequest(request, response, pairing)) return;
    const reply = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(value));
    };
    const health = request.method === 'GET' && request.url === '/healthz';
    const handshake = sessions && request.method === 'POST' && request.url === '/v1/navigation/session';
    const shortcut = request.method === 'POST' && ['/v1/shortcuts/resolve', '/v1/shortcuts/select'].includes(request.url);
    if (!health && !handshake && !shortcut && (request.method !== 'POST' || request.url !== '/v1/chat/completions')) { reply(404, { error: { code: 'NOT_FOUND' } }); return; }
    const supplied = Buffer.from(request.headers.authorization ?? '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { reply(401, { error: { code: 'UNAUTHORIZED' } }); return; }
    if (health) {
      const ready = isReady();
      reply(ready ? 200 : 503, { ok: ready, status: ready ? 'ready' : 'unavailable', experiment: 'codex-direct' });
      return;
    }
    if (!isReady()) { reply(503, { error: { code: 'CODEX_DISCONNECTED', message: outcomes.offline } }); return; }
    const send = update => { if (!response.destroyed && !response.writableEnded) response.write(JSON.stringify(update) + '\n'); };
    try {
      if (handshake) { reply(200, await navigationHandshake(request, sessions)); return; }
      const assertCurrent = sessions ? authorizeNavigationRequest(request, response, sessions) : undefined;
      let size = 0; const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 65536) { reply(413, { error: { code: 'BODY_TOO_LARGE' } }); return; }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { reply(400, { error: { code: 'INVALID_INPUT', message: errors.INVALID_INPUT } }); return; }
      if (shortcut) {
        if (!assertCurrent) { reply(409, { error: { code: 'NAVIGATION_SESSION_REQUIRED' } }); return; }
        assertCurrent();
        if (!gateway.shortcutsSupported?.()) { reply(409, { error: { code: 'SHORTCUT_UNSUPPORTED' } }); return; }
        if (request.url.endsWith('/resolve')) {
          const target = await gateway.resolveShortcut(body, assertCurrent); assertCurrent();
          reply(200, { target }); return;
        }
        if (!body?.target || typeof body.target !== 'object' || Array.isArray(body.target)) {
          reply(400, { error: { code: 'INVALID_INPUT' } }); return;
        }
        const result = await gateway.submit({ requestId: request.headers['idempotency-key'], text: '快捷切换', shortcut: body.target, assertCurrent });
        reply(200, result); return;
      }
      if (!Array.isArray(body?.messages) || body.messages.length !== 1 || body.messages[0]?.role !== 'user'
          || ![undefined, false, true].includes(body.stream)) throw Object.assign(new Error(), { code: 'INVALID_INPUT' });
      if (body.stream) {
        response.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
        response.flushHeaders();
        send({ type: 'state', state: 'sending' });
      }
      const result = await gateway.submit({ requestId: request.headers['idempotency-key'], text: body.messages[0].content,
        ...(assertCurrent ? { assertCurrent } : {}), onUpdate: body.stream ? send : undefined });
      const text = result.text ?? outcomes[result.status] ?? outcomes.unknown;
      if (body.stream) { send({ type: 'done', status: result.status, text }); response.end(); }
      else reply(200, { id: result.requestId, object: 'chat.completion', codex_status: result.status,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] });
    } catch (error) {
      const navigationError = /^NAVIGATION_/.test(error?.code ?? '');
      const shortcutError = /^SHORTCUT_/.test(error?.code ?? '');
      const text = navigationError ? '导航会话已变化，本次未发送。请重新列出名单。' : errors[error.code] ?? outcomes.unknown;
      if (response.headersSent) { send({ type: 'done', status: 'error', text }); response.end(); }
      else reply(error.code === 'INVALID_INPUT' ? 400 : 409, { error: { code: navigationError || shortcutError || errors[error.code] ? error.code : 'EXPERIMENT_FAILED', message: shortcutError ? '快捷目标未能核对，请检查连接并重新绑定。' : text } });
    }
  };
}
