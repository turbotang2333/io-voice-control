import net from 'node:net';
import { readServerName } from './shared-client-hello.mjs';

// connectRoute is a trusted server-side mapping, never a client-supplied path.
export function createSharedRelay({ connectRoute, maxConnections = 1024, maxPerIp = 32, helloTimeoutMs = 5000, connectTimeoutMs = 10000, idleTimeoutMs = 300000 } = {}) {
  const integer = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
  if (typeof connectRoute !== 'function' || !integer(maxConnections, 1, 65536) || !integer(maxPerIp, 1, 65536)
    || !integer(helloTimeoutMs, 100, 30000) || !integer(connectTimeoutMs, 100, 30000) || !integer(idleTimeoutMs, 1000, 3600000)) {
    throw Object.assign(Error('SHARED_RELAY_CONFIG_INVALID'), { code: 'SHARED_RELAY_CONFIG_INVALID' });
  }
  const sockets = new Set(), perIp = new Map();
  const server = net.createServer(socket => {
    const ip = socket.remoteAddress, count = perIp.get(ip) ?? 0;
    if (count >= maxPerIp) { socket.destroy(); return; }
    perIp.set(ip, count + 1); sockets.add(socket);
    let upstream, bytes = Buffer.allocUnsafe(65536), received = 0, checked = 0, records = 0;
    let timer = setTimeout(() => socket.destroy(), helloTimeoutMs); timer.unref();
    socket.setTimeout(idleTimeoutMs, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.once('close', () => {
      clearTimeout(timer); upstream?.destroy(); sockets.delete(socket);
      const left = (perIp.get(ip) ?? 1) - 1;
      if (left) perIp.set(ip, left); else perIp.delete(ip);
    });
    const onData = chunk => {
      if (received + chunk.length > bytes.length) { socket.destroy(); return; }
      chunk.copy(bytes, received); received += chunk.length;
      let name = null;
      while (received - checked >= 5) {
        if (bytes[checked] !== 22 || bytes[checked + 1] !== 3) { socket.destroy(); return; }
        const length = bytes.readUInt16BE(checked + 3);
        if (!length || length > 18432 || records >= 32) { socket.destroy(); return; }
        if (received - checked - 5 < length) break;
        records++; checked += 5 + length;
        try { name = readServerName(bytes.subarray(0, checked)); } catch { socket.destroy(); return; }
        if (name !== null) break;
      }
      if (name === null) return;
      socket.pause(); socket.removeListener('data', onData); clearTimeout(timer);
      try { upstream = connectRoute(name); } catch { socket.destroy(); return; }
      if (!(upstream instanceof net.Socket)) { upstream = undefined; socket.destroy(); return; }
      timer = setTimeout(() => socket.destroy(), connectTimeoutMs); timer.unref();
      upstream.on('error', () => socket.destroy());
      upstream.once('close', () => socket.destroy());
      upstream.setTimeout(idleTimeoutMs, () => upstream.destroy());
      upstream.once('connect', () => {
        clearTimeout(timer); upstream.write(bytes.subarray(0, received)); bytes = null;
        socket.pipe(upstream); upstream.pipe(socket); socket.resume();
      });
    };
    socket.on('data', onData);
  });
  server.maxConnections = maxConnections;
  server.closeAllConnections = () => { for (const socket of sockets) socket.destroy(); };
  return server;
}
