import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = code => Object.assign(new Error(code), { code });

// Experimental transport only. Does not launch Codex, select a conversation,
// supply an executor identity, reconnect, or retry any protocol message.
export async function runStdioProxy({ input, output, endpoint, token,
  maxFrameBytes = 8 * 1024 * 1024, handshakeTimeoutMs = 10000 } = {}) {
  let url;
  try { url = new URL(endpoint); } catch { throw fail('INVALID_SHARED_CONNECTION'); }
  if (url.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash
      || typeof token !== 'string' || !/^[A-Za-z0-9._~-]{32,256}$/.test(token)
      || !Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1 || maxFrameBytes > 8 * 1024 * 1024
      || !Number.isSafeInteger(handshakeTimeoutMs) || handshakeTimeoutMs < 1 || handshakeTimeoutMs > 30000
      || !input?.pause || !output?.write) throw fail('INVALID_SHARED_CONNECTION');

  return new Promise((resolveRun, rejectRun) => {
    let pending = Buffer.alloc(0), ending = false, settled = false, closeTimer;
    input.pause();
    const socket = new WebSocket(url, { maxPayload: maxFrameBytes,
      handshakeTimeout: handshakeTimeoutMs, headers: { authorization: `Bearer ${token}` } });
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(closeTimer); pending = Buffer.alloc(0);
      input.pause(); input.off('data', onData); input.off('end', onEnd);
      input.off('error', onInputError); input.off('close', onInputClose);
      output.off('error', onOutputError); output.off('close', onOutputClose); output.off('drain', onDrain);
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      error ? rejectRun(error) : resolveRun();
    };
    const send = frame => {
      if (frame.length === 0) return;
      if (frame.length > maxFrameBytes) throw fail('SHARED_FRAME_TOO_LARGE');
      if (socket.bufferedAmount + frame.length > maxFrameBytes * 2) throw fail('SHARED_INPUT_OVERLOADED');
      socket.send(frame, { binary: false }, error => { if (error) finish(fail('SHARED_TRANSPORT_CLOSED')); });
    };
    const onData = bytes => {
      if (settled) return;
      try {
        const chunk = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
        let start = 0, at;
        while ((at = chunk.indexOf(10, start)) !== -1) {
          const part = chunk.subarray(start, at);
          if (pending.length + part.length > maxFrameBytes) throw fail('SHARED_FRAME_TOO_LARGE');
          let frame = pending.length ? Buffer.concat([pending, part]) : part;
          if (frame.at(-1) === 13) frame = frame.subarray(0, -1);
          send(frame); pending = Buffer.alloc(0); start = at + 1;
        }
        const rest = chunk.subarray(start);
        if (pending.length + rest.length > maxFrameBytes) throw fail('SHARED_FRAME_TOO_LARGE');
        pending = rest.length ? Buffer.concat([pending, rest]) : pending;
      } catch (error) { finish(error.code ? error : fail('SHARED_TRANSPORT_CLOSED')); }
    };
    const onEnd = () => {
      if (settled) return;
      try {
        send(pending); pending = Buffer.alloc(0); ending = true;
        socket.close(1000);
        closeTimer = setTimeout(() => finish(fail('SHARED_CLOSE_TIMEOUT')), 3000);
      } catch { finish(fail('SHARED_TRANSPORT_CLOSED')); }
    };
    const onInputError = () => finish(fail('SHARED_INPUT_CLOSED'));
    const onInputClose = () => { if (!ending) finish(fail('SHARED_INPUT_CLOSED')); };
    const onOutputError = () => finish(fail('SHARED_OUTPUT_CLOSED'));
    const onOutputClose = () => finish(fail('SHARED_OUTPUT_CLOSED'));
    const onDrain = () => { if (!settled && socket.readyState === WebSocket.OPEN) socket.resume(); };
    input.on('error', onInputError); input.on('close', onInputClose);
    output.on('error', onOutputError); output.on('close', onOutputClose); output.on('drain', onDrain);
    socket.on('error', () => finish(fail('SHARED_TRANSPORT_CLOSED')));
    socket.once('open', () => {
      if (settled) return;
      input.on('data', onData); input.once('end', onEnd); input.resume();
    });
    socket.on('message', (bytes, binary) => {
      if (settled) return;
      if (binary || bytes.length > maxFrameBytes) { finish(fail('INVALID_SHARED_FRAME')); return; }
      if (!output.write(Buffer.concat([bytes, Buffer.from('\n')]))) socket.pause();
    });
    // EOF means the owning client requested shutdown. An absent close echo is
    // not a task receipt; callers must still inspect actual RPC responses.
    socket.once('close', () => finish(ending ? undefined : fail('SHARED_TRANSPORT_CLOSED')));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2 || !process.env.RAYNEO_SHARED_TOKEN_FILE) throw fail('INVALID_SHARED_CONNECTION');
    const token = readFileSync(process.env.RAYNEO_SHARED_TOKEN_FILE, 'utf8').trim();
    await runStdioProxy({ input: process.stdin, output: process.stdout,
      endpoint: process.env.RAYNEO_SHARED_WS_URL, token });
  } catch {
    console.error('共享连接原型已停止；未重连、未重发。'); process.exitCode = 1;
  }
}
