import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync, execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPairingStore } from '../bridge/pairing.mjs';

function fixture() {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/pairing');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'fixture-'));
  let time = 1000;
  const store = createPairingStore({ directory, now: () => time, ttlMs: 120000 });
  const profiles = {
    paseo: { endpoint: 'https://example.test/connect/trial/paseo', port: 7468, token: 'a'.repeat(64) },
    codex: { endpoint: 'https://example.test/connect/trial/codex', port: 19469, token: 'b'.repeat(64) },
  };
  return { directory, store, profiles, advance: ms => { time += ms; } };
}

test('pairing QR contains an expiring one-time proof and never a permanent access token', () => {
  const f = fixture();
  const ticket = f.store.issue({ computerLabel: '试用电脑', profiles: f.profiles, publicBaseUrl: f.profiles.paseo.endpoint });
  const url = new URL(ticket.url);
  assert.equal(url.search, ''); assert.match(url.hash, /^#rayneo_pair=[A-Za-z0-9_-]{43}$/);
  assert.ok(!ticket.url.includes(f.profiles.paseo.token)); assert.ok(!ticket.url.includes(f.profiles.codex.token));
  const raw = readFileSync(join(f.directory, 'ticket.json'), 'utf8');
  assert.ok(!raw.includes(url.hash.slice('#rayneo_pair='.length)));
  const credentials = f.store.claim(url.hash.slice('#rayneo_pair='.length));
  assert.equal(credentials.computerLabel, '试用电脑'); assert.deepEqual(credentials.profiles, f.profiles);
  assert.throws(() => f.store.claim(url.hash.slice('#rayneo_pair='.length)), { code: 'PAIRING_UNAVAILABLE' });
  const consumed = readFileSync(join(f.directory, 'ticket.json'), 'utf8');
  assert.ok(!consumed.includes(f.profiles.paseo.token)); assert.ok(!consumed.includes(f.profiles.codex.token));
});

test('wrong, expired and replaced QR codes cannot retrieve connection credentials', () => {
  const f = fixture();
  const first = f.store.issue({ computerLabel: '电脑', profiles: f.profiles, publicBaseUrl: f.profiles.paseo.endpoint });
  const firstCode = new URL(first.url).hash.slice('#rayneo_pair='.length);
  assert.throws(() => f.store.claim('x'.repeat(43)), { code: 'PAIRING_UNAVAILABLE' });
  const next = f.store.issue({ computerLabel: '电脑', profiles: f.profiles, publicBaseUrl: f.profiles.paseo.endpoint });
  assert.throws(() => f.store.claim(firstCode), { code: 'PAIRING_UNAVAILABLE' });
  f.advance(120000);
  assert.throws(() => f.store.claim(new URL(next.url).hash.slice('#rayneo_pair='.length)), { code: 'PAIRING_UNAVAILABLE' });
});

test('expired unclaimed pairing credentials are removed without another pairing', async () => {
  const f = fixture();
  let now = Date.now();
  const store = createPairingStore({ directory: f.directory, now: () => now, ttlMs: 1000 });
  store.issue({ computerLabel: '电脑', profiles: f.profiles, publicBaseUrl: f.profiles.paseo.endpoint });
  assert.equal(readdirSync(f.directory).filter(name => name.startsWith('credentials-')).length, 1);
  now += 1000;
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(readdirSync(f.directory).filter(name => name.startsWith('credentials-')).length, 0);
});

test('restarting pairing removes expired credentials left by a stopped process', () => {
  const f = fixture();
  f.store.issue({ computerLabel: '电脑', profiles: f.profiles, publicBaseUrl: f.profiles.paseo.endpoint });
  f.advance(120000);
  createPairingStore({ directory: f.directory, now: () => 121000 });
  assert.equal(readdirSync(f.directory).filter(name => name.startsWith('credentials-')).length, 0);
});

test('only an explicitly included public HTTPS backend may carry the one-time pairing endpoint', () => {
  const f = fixture();
  for (const endpoint of ['http://example.test', 'https://127.0.0.1:7468', 'https://user:pass@example.test', 'https://example.test/pair?token=x', 'https://other.test/not-in-profile']) {
    assert.throws(() => f.store.issue({ computerLabel: '电脑', profiles: f.profiles, publicBaseUrl: endpoint }), { code: 'PAIRING_PROFILE_INVALID' });
  }
  assert.throws(() => f.store.issue({ computerLabel: '电脑', profiles: { ...f.profiles, codex: { ...f.profiles.codex, token: f.profiles.paseo.token } }, publicBaseUrl: f.profiles.paseo.endpoint }), { code: 'PAIRING_PROFILE_INVALID' });
});

test('a process dying while publishing a QR cannot permanently block pairing after restart', () => {
  const f = fixture(), worker = join(f.directory, 'crash.mjs');
  writeFileSync(worker, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
    const rename=fs.renameSync;fs.renameSync=(from,to)=>{if(to===${JSON.stringify(join(f.directory, 'ticket.json'))})process.exit(42);return rename(from,to)};
    syncBuiltinESMExports();const {createPairingStore}=await import(${JSON.stringify(pathToFileURL(resolve('bridge/pairing.mjs')).href)});
    createPairingStore({directory:${JSON.stringify(f.directory)},now:()=>1000}).issue(${JSON.stringify({ computerLabel: '电脑', profiles: f.profiles, publicBaseUrl: f.profiles.paseo.endpoint })});`);
  assert.throws(() => execFileSync(process.execPath, [worker], { stdio: 'pipe', windowsHide: true }), error => error.status === 42);
  const restarted = createPairingStore({ directory: f.directory, now: () => 1000 });
  const next = restarted.issue({ computerLabel: '电脑', profiles: f.profiles, publicBaseUrl: f.profiles.paseo.endpoint });
  assert.deepEqual(restarted.claim(new URL(next.url).hash.slice('#rayneo_pair='.length)).profiles, f.profiles);
  assert.equal(restarted.status().kind, 'claimed');
});

test('simultaneous claimants in independent processes can release a credential only once', async () => {
  const f = fixture(), worker = join(f.directory, 'claim.mjs');
  const next = f.store.issue({ computerLabel: '电脑', profiles: f.profiles, publicBaseUrl: f.profiles.paseo.endpoint });
  const code = new URL(next.url).hash.slice('#rayneo_pair='.length);
  writeFileSync(worker, `import {createPairingStore} from ${JSON.stringify(pathToFileURL(resolve('bridge/pairing.mjs')).href)};
    try{createPairingStore({directory:process.argv[2],now:()=>1000}).claim(process.argv[3]);process.stdout.write('claimed')}
    catch{process.stdout.write('unavailable')}`);
  const results = await Promise.all(Array.from({ length: 6 }, () => new Promise((accept, reject) => {
    execFile(process.execPath, [worker, f.directory, code], { encoding: 'utf8', windowsHide: true }, (error, stdout) => error ? reject(error) : accept(stdout));
  })));
  assert.equal(results.filter(result => result === 'claimed').length, 1);
  assert.throws(() => f.store.claim(code), { code: 'PAIRING_UNAVAILABLE' });
  assert.equal(f.store.status().kind, 'claimed');
});

test('cancel revokes later claims and erases its private credential copy', () => {
  const f = fixture(), next = f.store.issue({ computerLabel: '电脑', profiles: f.profiles, publicBaseUrl: f.profiles.paseo.endpoint });
  f.store.cancel();
  assert.equal(f.store.status().kind, 'cancelled');
  assert.throws(() => f.store.claim(new URL(next.url).hash.slice('#rayneo_pair='.length)), { code: 'PAIRING_UNAVAILABLE' });
  const files = readdirSync(f.directory).map(name => readFileSync(join(f.directory, name), 'utf8')).join('');
  assert.ok(!files.includes(f.profiles.paseo.token));
  assert.ok(!files.includes(f.profiles.codex.token));
});

test('expiry after durable consumption still refuses credentials and a partial marker never permits retry', () => {
  const f = fixture(), next = f.store.issue({ computerLabel: '电脑', profiles: f.profiles, publicBaseUrl: f.profiles.paseo.endpoint });
  const code = new URL(next.url).hash.slice('#rayneo_pair='.length), worker = join(f.directory, 'expire.mjs');
  writeFileSync(worker, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
    let time=1000;const sync=fs.fsyncSync;fs.fsyncSync=fd=>{sync(fd);time=121000};syncBuiltinESMExports();
    const {createPairingStore}=await import(${JSON.stringify(pathToFileURL(resolve('bridge/pairing.mjs')).href)});
    try{createPairingStore({directory:process.argv[2],now:()=>time}).claim(process.argv[3]);process.exit(2)}
    catch(error){if(error.code!=='PAIRING_UNAVAILABLE')process.exit(3)}`);
  execFileSync(process.execPath, [worker, f.directory, code], { windowsHide: true, stdio: 'pipe' });
  assert.throws(() => f.store.claim(code), { code: 'PAIRING_UNAVAILABLE' });
  const current = JSON.parse(readFileSync(join(f.directory, 'ticket.json')));
  writeFileSync(join(f.directory, 'consumed-' + current.hash + '.json'), '');
  assert.throws(() => f.store.claim(code), { code: 'PAIRING_UNAVAILABLE' });
  const replacement = f.store.issue({ computerLabel: '电脑', profiles: f.profiles, publicBaseUrl: f.profiles.paseo.endpoint });
  assert.deepEqual(f.store.claim(new URL(replacement.url).hash.slice('#rayneo_pair='.length)).profiles, f.profiles);
});

test('a claim overlapping a new QR cannot erase or consume the newly issued ticket', () => {
  const f = fixture(), first = f.store.issue({ computerLabel: '电脑', profiles: f.profiles, publicBaseUrl: f.profiles.paseo.endpoint });
  const worker = join(f.directory, 'overlap.mjs'), output = join(f.directory, 'replacement-url');
  writeFileSync(worker, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
    const {createPairingStore}=await import(${JSON.stringify(pathToFileURL(resolve('bridge/pairing.mjs')).href)});
    const store=createPairingStore({directory:process.argv[2],now:()=>1000});let replaced=false;
    const open=fs.openSync;fs.openSync=(file,...args)=>{if(String(file).includes('consumed-')&&!replaced){replaced=true;
      const next=store.issue(${JSON.stringify({ computerLabel: '电脑', profiles: f.profiles, publicBaseUrl: f.profiles.paseo.endpoint })});fs.writeFileSync(process.argv[4],next.url)}return open(file,...args)};
    syncBuiltinESMExports();store.claim(process.argv[3]);`);
  execFileSync(process.execPath, [worker, f.directory, new URL(first.url).hash.slice('#rayneo_pair='.length), output], { windowsHide: true, stdio: 'pipe' });
  assert.equal(f.store.status().kind, 'waiting');
  const replacement = readFileSync(output, 'utf8');
  assert.deepEqual(f.store.claim(new URL(replacement).hash.slice('#rayneo_pair='.length)).profiles, f.profiles);
});
