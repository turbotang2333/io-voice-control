import net from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { posix } from 'node:path';

const fail = code => Object.assign(Error(code), { code });
const integer = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;

/** Validate the private socket format before any future public listener is enabled. */
export function validateIsolatedRelayConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || Object.keys(config).some(key => !['version', 'listenPort', 'listenHost', 'targetSocket', 'maxConnections', 'maxPerIp', 'idleTimeoutMs', 'connectTimeoutMs'].includes(key))
    || config.version !== 2 || !integer(config.listenPort, 1, 65535)
    || config.listenHost !== undefined && !['127.0.0.1', '0.0.0.0'].includes(config.listenHost)
    || typeof config.targetSocket !== 'string'
    || !/^\/var\/lib\/rayneo-relay\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/tunnel\/relay[.]sock$/.test(config.targetSocket)) throw fail('RELAY_CONFIG_INVALID');
  const { version, listenPort, listenHost, ...options } = config;
  createOpaqueRelay(options);
}

/** The public CLI must not expose an unrelated service that later occupies a loopback TCP port. */
export function validatePublicRelayConfig(config) {
  if (config?.version === 2) { validateIsolatedRelayConfig(config); return; }
  if (!config || config.version !== 1 || !integer(config.listenPort, 1, 65535)
    || !integer(config.targetPort, 1024, 65535) || config.listenPort === config.targetPort) throw fail('RELAY_CONFIG_INVALID');
  throw fail('RELAY_ISOLATION_REQUIRED');
}

/** Byte transport only: no TLS certificate, HTTP parser, message logging, or arbitrary target address. */
export function createOpaqueRelay(options = {}) {
  const { targetPort, targetSocket, maxConnections = 128, maxPerIp = 16, idleTimeoutMs = 300000, connectTimeoutMs = 10000 } = options;
  const validSocket = typeof targetSocket === 'string' && posix.isAbsolute(targetSocket) && targetSocket.length <= 100
    && !/[\r\n\0]/.test(targetSocket) && posix.normalize(targetSocket) === targetSocket;
  if (Object.keys(options).some(key => !['targetPort', 'targetSocket', 'maxConnections', 'maxPerIp', 'idleTimeoutMs', 'connectTimeoutMs'].includes(key))
    || !(validSocket && targetPort === undefined || targetSocket === undefined && integer(targetPort, 1024, 65535))
    || !integer(maxConnections, 1, 4096) || !integer(maxPerIp, 1, 4096)
    || !integer(idleTimeoutMs, 1000, 3600000) || !integer(connectTimeoutMs, 100, 30000)) throw fail('RELAY_CONFIG_INVALID');
  const sockets = new Set(), perIp = new Map();
  const server = net.createServer(socket => {
    const ip = socket.remoteAddress, count = perIp.get(ip) ?? 0;
    if (count >= maxPerIp) { socket.destroy(); return; }
    perIp.set(ip, count + 1); sockets.add(socket);
    const upstream = net.connect(validSocket ? { path: targetSocket } : { host: '127.0.0.1', port: targetPort });
    const timer = setTimeout(() => { socket.destroy(); upstream.destroy(); }, connectTimeoutMs); timer.unref();
    socket.setTimeout(idleTimeoutMs, () => socket.destroy());
    upstream.setTimeout(idleTimeoutMs, () => upstream.destroy());
    socket.on('error', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
    socket.once('close', () => {
      clearTimeout(timer); sockets.delete(socket); upstream.destroy();
      const remaining = (perIp.get(ip) ?? 1) - 1;
      if (remaining > 0) perIp.set(ip, remaining); else perIp.delete(ip);
    });
    upstream.once('connect', () => { clearTimeout(timer); socket.pipe(upstream); upstream.pipe(socket); });
    upstream.once('close', () => socket.destroy());
  });
  server.maxConnections = maxConnections;
  server.closeAllConnections = () => { for (const socket of sockets) socket.destroy(); };
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--config') throw fail('RELAY_CONFIG_INVALID');
    const bytes = readFileSync(args[1]); if (bytes.length > 4096) throw fail('RELAY_CONFIG_INVALID');
    const config = JSON.parse(bytes.toString('utf8'));
    validatePublicRelayConfig(config);
    const { version, listenPort, listenHost = '0.0.0.0', ...options } = config;
    const server = createOpaqueRelay(options);
    server.on('error', () => { process.stderr.write('RELAY_LISTEN_FAILED\n'); process.exitCode = 1; });
    server.listen(listenPort, listenHost, () => process.stdout.write('RELAY_READY\n'));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.closeAllConnections(); server.close(); });
  } catch (error) { process.stderr.write((error.code === 'RELAY_ISOLATION_REQUIRED' ? error.code : 'RELAY_CONFIG_INVALID') + '\n'); process.exitCode = 1; }
}
