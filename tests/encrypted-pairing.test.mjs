import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createPairingStore } from '../bridge/pairing.mjs';

const root = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/encrypted-pairing');
mkdirSync(root, { recursive: true });
function fixture() {
  const directory = mkdtempSync(join(root, 'fixture-'));
  return { directory, store: createPairingStore({ directory }),
    profiles: { paseo: { endpoint: 'https://relay.example.test:24443/paseo', port: 7468, token: 'a'.repeat(64) } } };
}

test('encrypted pairing binds the desktop identity before any long-lived credential is claimed', () => {
  const { store, directory, profiles } = fixture();
  const ticket = store.issue({ computerLabel: '电脑', profiles, publicBaseUrl: profiles.paseo.endpoint, certificateSha256: 'c'.repeat(64) });
  const url = new URL(ticket.url), fields = new URLSearchParams(url.hash.slice(1));
  assert.equal(fields.get('tls_sha256'), 'c'.repeat(64));
  assert.match(fields.get('rayneo_pair'), /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!ticket.url.includes(profiles.paseo.token));
  const claimed = store.claim(fields.get('rayneo_pair'));
  assert.equal(claimed.version, 2);
  assert.deepEqual(claimed.transport, { type: 'tls-passthrough-v1', certificateSha256: 'c'.repeat(64) });
  assert.deepEqual(claimed.profiles, profiles);
  assert.throws(() => store.claim(fields.get('rayneo_pair')), { code: 'PAIRING_UNAVAILABLE' });
  const consumed = readFileSync(join(directory, 'ticket.json'), 'utf8');
  assert.ok(!consumed.includes(profiles.paseo.token));
});

test('an invalid desktop fingerprint never produces an apparently encrypted QR', () => {
  const { store, profiles } = fixture();
  for (const pin of ['', null, '0'.repeat(63), 'A'.repeat(64), 'g'.repeat(64)]) {
    assert.throws(() => store.issue({ computerLabel: '电脑', profiles, publicBaseUrl: profiles.paseo.endpoint, certificateSha256: pin }), { code: 'PAIRING_PROFILE_INVALID' });
  }
  assert.equal(store.status().kind, 'none');
});
