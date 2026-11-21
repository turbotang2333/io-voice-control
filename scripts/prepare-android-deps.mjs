import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const expected = '8d8064c1636fdaef7189dd9055c7d59950a8940a12f2293956446ec3c109fd82';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export async function ensureZxing() {
  const directory = join(homedir(), '.local/state/rayneo-paseo/build-tools');
  const file = join(directory, 'zxing-core-3.5.3.jar');
  if (existsSync(file)) {
    if (sha(readFileSync(file)) !== expected) throw Error('ZXING_CHECKSUM_MISMATCH');
    return file;
  }
  const response = await fetch('https://repo.maven.apache.org/maven2/com/google/zxing/core/3.5.3/core-3.5.3.jar', { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw Error('ZXING_DOWNLOAD_FAILED');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha(bytes) !== expected) throw Error('ZXING_CHECKSUM_MISMATCH');
  mkdirSync(directory, { recursive: true }); writeFileSync(file + '.tmp', bytes, { flag: 'wx' }); renameSync(file + '.tmp', file);
  return file;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await ensureZxing(); console.log('二维码识别依赖已准备并通过校验。');
}
