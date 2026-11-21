import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import net from 'node:net';
import { tlsFixture, listen, close } from './helpers/tls-fixture.mjs';
import { createSharedRelay } from '../relay/shared-router.mjs';

test('two encrypted connections share one port and reach only their assigned desktop', async t => {
  const names = ['one.relay.example.test', 'two.relay.example.test'];
  const identities = names.map((name, i) => tlsFixture(`shared-relay-${i}`, { extraDnsNames: [name] }));
  const upstreams = identities.map((identity, i) => https.createServer(identity, (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer synthetic-secret');
    assert.equal(req.url, '/synthetic-private-path');
    res.end(`desktop-${i}`);
  }));
  const ports = await Promise.all(upstreams.map(listen));
  const relay = createSharedRelay({ maxPerIp: 128, connectRoute: name => {
    const index = name === 'wrong.relay.example.test' ? 0 : names.indexOf(name);
    return index < 0 ? null : net.connect(ports[index], '127.0.0.1');
  } });
  t.after(async () => { await close(relay); await Promise.all(upstreams.map(close)); });
  const wire = [];
  relay.on('connection', socket => {
    socket.on('data', chunk => wire.push(Buffer.from(chunk)));
    const write = socket.write;
    socket.write = function(chunk, ...args) { wire.push(Buffer.from(chunk)); return write.call(this, chunk, ...args); };
  });
  const port = await listen(relay);
  const request = (name, identity) => new Promise((resolve, reject) => {
    https.get({ host: '127.0.0.1', port, servername: name, ca: identity.cert,
      path: '/synthetic-private-path', headers: { authorization: 'Bearer synthetic-secret' }
    }, response => { let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve(body)); }).on('error', reject);
  });
  assert.deepEqual(await Promise.all(names.map((name, i) => request(name, identities[i]))), ['desktop-0', 'desktop-1']);
  const parallel = Array.from({ length: 64 }, (_, i) => request(names[i % 2], identities[i % 2]));
  assert.deepEqual(await Promise.all(parallel), Array.from({ length: 64 }, (_, i) => `desktop-${i % 2}`));
  await assert.rejects(request(names[0], identities[1]));
  await assert.rejects(request('wrong.relay.example.test', identities[0]));
  await assert.rejects(request('unknown.relay.example.test', identities[0]));
  const captured = Buffer.concat(wire);
  for (const secret of ['synthetic-secret', 'synthetic-private-path', 'desktop-0', 'desktop-1']) {
    assert.equal(captured.includes(Buffer.from(secret)), false);
  }
});
