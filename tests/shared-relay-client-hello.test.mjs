import test from 'node:test';
import assert from 'node:assert/strict';
import { readServerName } from '../relay/shared-client-hello.mjs';

const u16 = n => Buffer.from([n >> 8, n & 255]);
const vector16 = bytes => Buffer.concat([u16(bytes.length), bytes]);
const extension = (type, bytes) => Buffer.concat([u16(type), vector16(bytes)]);
const record = bytes => Buffer.concat([Buffer.from([22, 3, 3]), u16(bytes.length), bytes]);
const hello = extensions => {
  const body = Buffer.concat([Buffer.from([3, 3]), Buffer.alloc(32), Buffer.from([0]), vector16(Buffer.from([0x13, 1])), Buffer.from([1, 0]), vector16(Buffer.concat(extensions))]);
  return Buffer.concat([Buffer.from([1, body.length >> 16, body.length >> 8 & 255, body.length & 255]), body]);
};
const serverName = name => extension(0, vector16(Buffer.concat([Buffer.from([0]), vector16(Buffer.from(name))])));

test('extracts a name across fragmented TLS records and never consumes the original bytes', () => {
  const handshake = hello([serverName('one.relay.example.test')]);
  const bytes = Buffer.concat([record(handshake.subarray(0, 9)), record(handshake.subarray(9))]);
  for (let i = 0; i < bytes.length; i++) assert.equal(readServerName(bytes.subarray(0, i)), null);
  const original = Buffer.from(bytes);
  assert.equal(readServerName(bytes), 'one.relay.example.test');
  assert.deepEqual(bytes, original);
});

test('rejects malformed, ambiguous, missing and oversized routing information', () => {
  const fragmented = hello([serverName('a.example')]);
  const bad = [
    record(hello([])),
    record(hello([serverName('a.example'), serverName('b.example')])),
    record(hello([serverName('a.example\0.evil')])),
    record(hello([serverName('bad_name.example')])),
    Buffer.from([23, 3, 3, 0, 0]),
    Buffer.from([22, 3, 3, 255, 255]),
    Buffer.concat(Array.from(fragmented.subarray(0, 33), byte => record(Buffer.from([byte])))),
  ];
  for (const bytes of bad) assert.throws(() => readServerName(bytes), { code: 'SHARED_HELLO_INVALID' });
});
