import { timingSafeEqual } from 'node:crypto';
import { navigationHandshake, authorizeNavigationRequest } from './navigation-session.mjs';
import { assistantMessages as messages } from './assistant-messages.mjs';
import { handlePairingRequest } from './pairing-http.mjs';


export function createRequestHandler({ token, gateway, sessions, pairing, isReady = () => true }) {
  if (typeof token !== 'string' || !token) throw new Error('Bridge token is required');
  const expected = Buffer.from(`Bearer ${token}`);
  return async (request, response) => {
    if (await handlePairingRequest(request, response, pairing)) return;
    const reply = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(value));
    };
    const health = request.method === 'GET' && request.url === '/healthz';
    const handshake = sessions && request.method === 'POST' && request.url === '/v1/navigation/session';
    const shortcut = request.method === 'POST' && ['/v1/shortcuts/resolve', '/v1/shortcuts/select'].includes(request.url);
    if (!health && !handshake && !shortcut && (request.method !== 'POST' || request.url !== '/v1/chat/completions')) {
      reply(404, { error: { code: 'NOT_FOUND' } }); return;
    }
    const supplied = Buffer.from(request.headers.authorization ?? '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      reply(401, { error: { code: 'UNAUTHORIZED' } }); return;
    }
    const ready = isReady();
    if (health) { reply(ready ? 200 : 503, { ok: ready, status: ready ? 'ready' : 'reconnecting' }); return; }
    if (!ready) {
      reply(503, { error: { code: 'PASEO_OFFLINE', message: messages.offline } }); return;
    }
    try {
      if (handshake) { reply(200, await navigationHandshake(request, sessions)); return; }
      const assertCurrent = sessions ? authorizeNavigationRequest(request, response, sessions) : undefined;
      let size = 0;
      const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 65536) { reply(413, { error: { code: 'BODY_TOO_LARGE' } }); return; }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reply(400, { error: { code: 'INVALID_JSON' } }); return; }
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
      if (!Array.isArray(body?.messages) || body.messages.length !== 1 || body.messages[0]?.role !== 'user' || ![true, false, undefined].includes(body.stream)) {
        reply(400, { error: { code: 'INVALID_INPUT' } }); return;
      }
      const streaming = body.stream === true;
      const send = item => { if (!response.writableEnded && !response.destroyed) response.write(`${JSON.stringify(item)}\n`); };
      if (streaming) {
        response.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        response.flushHeaders();
        send({ type: 'state', state: 'sending' });
      }
      const result = await gateway.submit({ requestId: request.headers['idempotency-key'], text: body.messages[0].content,
        ...(assertCurrent ? { assertCurrent } : {}),
        ...(streaming ? { onUpdate: send } : {}) });
      const answer = result.text ?? messages[result.status] ?? messages.unknown;
      if (streaming) { send({ type: 'done', status: result.status, text: answer }); response.end(); return; }
      reply(200, { id: result.requestId, object: 'chat.completion', paseo_status: result.status, choices: [{
        index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop',
      }] });
    } catch (error) {
      const navigationError = /^NAVIGATION_/.test(error?.code ?? '');
      const known = navigationError || /^SHORTCUT_/.test(error?.code ?? '') || ['INVALID_INPUT', 'REQUEST_CONFLICT', 'AGENT_BUSY', 'AGENT_TARGET_IN_USE', 'AGENT_TRACKING_UNAVAILABLE', 'WRONG_WORKSPACE', 'AGENT_NEEDS_PERMISSION', 'AGENT_NOT_FOUND', 'SESSION_FULL', 'STATE_WRITE_FAILED'].includes(error?.code);
      if (response.headersSent) {
        if (!response.writableEnded) response.end(`${JSON.stringify({ type: 'done', status: 'error', text: known ? error.message : messages.unknown })}\n`);
        return;
      }
      reply(known ? (error.code === 'INVALID_INPUT' ? 400 : 409) : 502, { error: {
        code: known ? error.code : 'BRIDGE_FAILED',
        message: known ? error.message : messages.unknown,
      } });
    }
  };
}
