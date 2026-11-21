// Extract only the routing name; the TLS handshake and payload remain opaque.
// This parser does not establish trust or validate the peer's certificate.
const invalid = () => { throw Object.assign(new Error('SHARED_HELLO_INVALID'), { code: 'SHARED_HELLO_INVALID' }); };
const MAX_INPUT = 65536;
const MAX_RECORD = 18432;

function parseHello(data) {
  let offset = 4;
  const take = n => {
    if (n < 0 || offset + n > data.length) invalid();
    const value = data.subarray(offset, offset + n); offset += n; return value;
  };
  const vector8 = () => take(take(1)[0]);
  const vector16 = () => take(take(2).readUInt16BE());
  take(2); take(32); vector8();
  const ciphers = vector16();
  if (!ciphers.length || ciphers.length % 2) invalid();
  if (!vector8().length) invalid();
  const extensions = vector16();
  if (offset !== data.length) invalid();
  let index = 0, name;
  while (index < extensions.length) {
    if (index + 4 > extensions.length) invalid();
    const type = extensions.readUInt16BE(index), length = extensions.readUInt16BE(index + 2);
    index += 4;
    if (index + length > extensions.length) invalid();
    const value = extensions.subarray(index, index + length); index += length;
    if (type !== 0) continue;
    if (name !== undefined || value.length < 5 || value.readUInt16BE(0) !== value.length - 2) invalid();
    if (value[2] !== 0 || value.readUInt16BE(3) !== value.length - 5) invalid();
    const bytes = value.subarray(5);
    if (!bytes.length || bytes.length > 253 || [...bytes].some(byte => byte > 127)) invalid();
    name = bytes.toString('ascii').toLowerCase();
    if (!name.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) invalid();
  }
  if (name === undefined) invalid();
  return name;
}

export function readServerName(input) {
  if (!Buffer.isBuffer(input) || input.length > MAX_INPUT) invalid();
  let offset = 0, length = 0, expected, records = 0;
  const parts = [];
  while (offset < input.length) {
    if (input.length - offset < 5) return null;
    if (input[offset] !== 22 || input[offset + 1] !== 3) invalid();
    if (++records > 32) invalid();
    const recordLength = input.readUInt16BE(offset + 3);
    if (!recordLength || recordLength > MAX_RECORD) invalid();
    if (input.length - offset - 5 < recordLength) return null;
    const body = input.subarray(offset + 5, offset + 5 + recordLength);
    parts.push(body); length += body.length; offset += 5 + recordLength;
    const joined = Buffer.concat(parts, length);
    if (length >= 4 && expected === undefined) {
      if (joined[0] !== 1) invalid();
      expected = 4 + joined.readUIntBE(1, 3);
      if (expected > MAX_INPUT || expected < 4 + 2 + 32 + 1 + 2 + 1 + 2) invalid();
    }
    if (expected !== undefined && length >= expected) return parseHello(joined.subarray(0, expected));
  }
  return null;
}
