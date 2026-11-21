// Manual isolated integration test: installs OpenSSH inside a disposable container only.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createUnixRelayBundle } from '../../relay/unix-provision.mjs';

const installationId = randomUUID();
const key = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64');
const bundle = createUnixRelayBundle({ enrollment: { version: 1, installationId, requestedBackends: ['paseo'], sshPublicKey: key },
  hosting: 'self-hosted', publicBaseUrl: 'https://relay.example.test:24443',
  relay: { host: 'relay.example.test', port: 2222, user: 'rayneotest', hostKey: key } });
const directory = `/var/lib/rayneo-relay/${installationId}`;
const relaySource = readFileSync(new URL('../../relay/server.mjs', import.meta.url)).toString('base64');
const lines = [
  'set -eu',
  'stage=setup; flaky=0; trap \'status=$?; if [ "$status" -ne 0 ] || [ "$flaky" -ne 0 ]; then echo "Isolated test stopped at $stage with status $status; transient=$flaky" >&2; for log in /tmp/client.log /tmp/relay.log /tmp/tls-server.log /tmp/sshd.log; do if [ -f "$log" ]; then cat "$log" >&2; fi; done; fi\' EXIT',
  'export DEBIAN_FRONTEND=noninteractive',
  ...(process.env.RAYNEO_RELAY_TEST_HTTPS === '1' ? ["sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources"] : []),
  'apt-get -o Acquire::Retries=3 update -qq',
  'apt-get -o Acquire::Retries=3 install -y -qq --no-install-recommends openssh-server openssl python3 >/dev/null',
  'mkdir -p /run/sshd',
  'ssh-keygen -q -t ed25519 -N "" -f /tmp/relay-client',
  `mkdir -p ${directory}/tunnel`,
  'useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --password "*" rayneotest',
  `chown rayneotest:rayneotest ${directory}/tunnel`,
  `chmod 700 ${directory}/tunnel`,
  `printf 'restrict,port-forwarding ' > ${directory}/authorized_keys`,
  `cat /tmp/relay-client.pub >> ${directory}/authorized_keys`,
  `cat > ${directory}/sshd_config <<'RAYNEO_SSHD_CONFIG'`,
  bundle.sshdConfig.trimEnd(),
  'LogLevel DEBUG1',
  'RAYNEO_SSHD_CONFIG',
  `/usr/sbin/sshd -t -f ${directory}/sshd_config`,
  `/usr/sbin/sshd -D -e -f ${directory}/sshd_config >/tmp/sshd.log 2>&1 &`,
  'n=0; until python3 -c \'import socket; s=socket.create_connection(("127.0.0.1",2222),1); s.close()\' 2>/dev/null; do n=$((n+1)); if [ "$n" -gt 40 ]; then cat /tmp/sshd.log; exit 1; fi; sleep 0.25; done',
  'python3 -u -c \'import socket;s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(("127.0.0.1",12345));s.listen();exec("while True:\\n c,a=s.accept(); c.sendall(b\\"private tunnel\\"); c.close()")\' >/tmp/backend.log 2>&1 &',
  'start_tunnel() { ssh -i /tmp/relay-client -p 2222 -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=3 -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -NT -R /tunnel/relay.sock:127.0.0.1:12345 rayneotest@127.0.0.1 >/tmp/client.log 2>&1 & tunnel_pid=$!; }',
  `wait_socket() { n=0; while [ ! -S ${directory}/tunnel/relay.sock ]; do n=$((n+1)); if [ "$n" -gt 40 ]; then cat /tmp/client.log /tmp/sshd.log; exit 1; fi; sleep 0.25; done; }`,
  `check_socket() { su -s /bin/sh rayneotest -c 'python3 -c "import socket; s=socket.socket(socket.AF_UNIX); s.connect(\\\"${directory}/tunnel/relay.sock\\\"); assert s.recv(100)==b\\\"private tunnel\\\""'; }`,
  'start_tunnel; wait_socket; check_socket',
  `printf '%s' '${relaySource}' | base64 -d > /tmp/relay-server.mjs`,
  `printf '%s\n' "import { createOpaqueRelay } from './relay-server.mjs'; import { appendFileSync } from 'node:fs'; const relay = createOpaqueRelay({ targetSocket: '${directory}/tunnel/relay.sock' }); relay.on('connection', s => { const emit = s.emit; s.emit = function(event, ...args) { if (event === 'data') appendFileSync('/tmp/relay-wire', args[0]); return emit.call(this, event, ...args); }; const write = s.write; s.write = function(b, ...args) { appendFileSync('/tmp/relay-wire', b); return write.call(this, b, ...args); }; }); relay.listen(24443, '127.0.0.1');" > /tmp/test-relay.mjs`,
  'su -s /bin/sh rayneotest -c "NODE_DEBUG=net node /tmp/test-relay.mjs" >/tmp/relay.log 2>&1 & relay_pid=$!',
  'sleep 1; if ! kill -0 "$relay_pid"; then cat /tmp/relay.log; exit 1; fi; python3 -c \'import socket; s=socket.create_connection(("127.0.0.1",24443),3); assert s.recv(100)==b"private tunnel"\'',
  'kill -9 "$tunnel_pid"; wait "$tunnel_pid" || true',
  'sleep 1; python3 -c \'import socket; s=socket.create_connection(("127.0.0.1",24443),3); s.settimeout(3); assert s.recv(100)==b""\'',
  'start_tunnel; sleep 1; kill -0 "$tunnel_pid"; wait_socket; check_socket',
  'python3 -c \'import socket; s=socket.create_connection(("127.0.0.1",24443),3); assert s.recv(100)==b"private tunnel"\'',
  'useradd --system --user-group --no-create-home --shell /usr/sbin/nologin intrudertest',
  `if su -s /bin/sh intrudertest -c 'touch ${directory}/tunnel/unauthorized' 2>/dev/null; then exit 1; fi`,
  'set +e; timeout 5 ssh -i /tmp/relay-client -p 2222 -o BatchMode=yes -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -NT -R 127.0.0.1:12346:127.0.0.1:12345 rayneotest@127.0.0.1 >/tmp/tcp-forward.log 2>&1; tcp_status=$?; set -e; if [ "$tcp_status" -ne 255 ]; then cat /tmp/tcp-forward.log; echo "Unexpected TCP forwarding status: $tcp_status"; exit 1; fi',
  'set +e; printf test | timeout 5 ssh -i /tmp/relay-client -p 2222 -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -W 127.0.0.1:12345 rayneotest@127.0.0.1 >/dev/null 2>&1; direct_status=$?; set -e; if [ "$direct_status" -ne 255 ]; then echo "Unexpected direct forwarding status: $direct_status"; exit 1; fi',
  'kill "$tunnel_pid"; wait "$tunnel_pid" || true',
  'stage=tls_setup; openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost -addext subjectAltName=DNS:localhost -keyout /tmp/test.key -out /tmp/test.crt >/dev/null 2>&1',
  "cat > /tmp/test-tls-server.mjs <<'RAYNEO_TLS_SERVER'",
  "import https from 'node:https'; import { readFileSync, appendFileSync } from 'node:fs'; https.createServer({ key: readFileSync('/tmp/test.key'), cert: readFileSync('/tmp/test.crt') }, (req, res) => { appendFileSync('/tmp/requests', 'hit\\n'); if (req.url !== '/private-path' || req.headers.authorization !== 'Bearer synthetic-secret') { res.writeHead(403); res.end(); return; } res.end('synthetic-answer'); }).listen(12347, '127.0.0.1');",
  'RAYNEO_TLS_SERVER',
  'node /tmp/test-tls-server.mjs >/tmp/tls-server.log 2>&1 &',
  'n=0; until python3 -c \'import socket; s=socket.create_connection(("127.0.0.1",12347),1); s.close()\' 2>/dev/null; do n=$((n+1)); if [ "$n" -gt 40 ]; then cat /tmp/tls-server.log; exit 1; fi; sleep 0.25; done',
  'ssh -i /tmp/relay-client -p 2222 -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=3 -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -NT -R /tunnel/relay.sock:127.0.0.1:12347 rayneotest@127.0.0.1 >/tmp/client.log 2>&1 & tunnel_pid=$!',
  'sleep 1; kill -0 "$tunnel_pid"',
  "cat > /tmp/test-tls-phone.mjs <<'RAYNEO_TLS_PHONE'",
  "import tls from 'node:tls'; import { X509Certificate } from 'node:crypto'; import { readFileSync } from 'node:fs'; const expected = new X509Certificate(readFileSync('/tmp/test.crt')).fingerprint256; const wrong = process.argv[2] === 'wrong'; let checked = false; const socket = tls.connect({ host: '127.0.0.1', port: 24443, servername: 'localhost', rejectUnauthorized: false }, () => { checked = true; const peer = socket.getPeerCertificate(); const invalid = tls.checkServerIdentity('localhost', peer) || peer.fingerprint256 !== (wrong ? '00' : expected); if (invalid) { socket.destroy(); if (!wrong) { console.error('identity check failed', invalid); process.exitCode = 1; } return; } if (wrong) { socket.destroy(); process.exitCode = 1; return; } socket.write('GET /private-path HTTP/1.1\\r\\nHost: localhost\\r\\nAuthorization: Bearer synthetic-secret\\r\\nConnection: close\\r\\n\\r\\n'); }); let response = ''; socket.on('data', b => response += b); socket.on('error', e => { console.error(e.message); process.exitCode = 1; }); socket.on('close', () => { if (!checked) { console.error('TLS handshake did not complete'); process.exitCode = 1; } if (!wrong && !response.includes('synthetic-answer')) { console.error('expected response missing', response); process.exitCode = 1; } }); setTimeout(() => { socket.destroy(); process.exitCode = 1; }, 5000).unref();",
  'RAYNEO_TLS_PHONE',
  'stage=wrong_pin; node /tmp/test-tls-phone.mjs wrong; test ! -f /tmp/requests',
  `stage=valid_pin; test -S ${directory}/tunnel/relay.sock || { echo "relay socket disappeared" >&2; exit 1; }; node /tmp/test-tls-phone.mjs || { echo "valid client failed" >&2; exit 1; }; if [ "$(wc -l </tmp/requests)" -ne 1 ]; then echo "wrong request count" >&2; exit 1; fi`,
  'kill -9 "$tunnel_pid"; wait "$tunnel_pid" || true',
  'ssh -i /tmp/relay-client -p 2222 -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=3 -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -NT -R /tunnel/relay.sock:127.0.0.1:12347 rayneotest@127.0.0.1 >/tmp/client.log 2>&1 & tunnel_pid=$!',
  'stage=reconnect_wrong_pin; sleep 1; kill -0 "$tunnel_pid"; node /tmp/test-tls-phone.mjs wrong; test "$(wc -l </tmp/requests)" -eq 1',
  'stage=reconnect_valid_pin; node /tmp/test-tls-phone.mjs; test "$(wc -l </tmp/requests)" -eq 2',
  'stage=wire_privacy; python3 -c \'from pathlib import Path; w=Path("/tmp/relay-wire").read_bytes(); assert all(x not in w for x in (b"/private-path", b"synthetic-secret", b"synthetic-answer"))\'',
  'kill "$tunnel_pid"; wait "$tunnel_pid" || true',
  'printf "SSH_TLS_ISOLATION_AND_RECONNECT_OK\\n"',
];
const result = spawnSync('docker', ['run', '--rm', '-i', process.env.RAYNEO_RELAY_TEST_IMAGE || 'node:22-bookworm-slim', 'sh', '-s'],
  { input: lines.join('\n') + '\n', encoding: 'utf8', timeout: 180000, windowsHide: true });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) process.stderr.write(`Isolated SSH test failed: ${result.error.message}\n`);
if (result.error || result.status !== 0) process.exitCode = 1;
