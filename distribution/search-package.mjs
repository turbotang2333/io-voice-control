import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as tar from 'tar';
import { SEARCH_MODEL, SEARCH_REVISION, SEARCH_PACKAGE_READY_FILE } from '../bridge/search-embeddings.mjs';

export const searchPackageHome = () => join(homedir(), '.local/state/rayneo-paseo/optional-search');
const projectManifest = 'https://raw.githubusercontent.com/turbotang2333/io-voice-control/main/distribution/search-package-release.json';
const maxManifestBytes = 16 * 1024;
const checkInterval = 5 * 60 * 1000;
const maxArchiveBytes = 1024 * 1024 * 1024;
const maxExtractedBytes = 2 * maxArchiveBytes;
const releaseAssetPath = /^\/turbotang2333\/io-voice-control\/releases\/download\/[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*\.tar\.gz$/;
const redirectHosts = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com']);
const fail = code => Object.assign(new Error(code), { code });
const compatible = info => info?.format === 1 && info.model === SEARCH_MODEL && info.revision === SEARCH_REVISION;

function validRelease(release) {
  if (!release || typeof release.url !== 'string') return false;
  try {
    const url = new URL(release.url);
    return url.origin === 'https://github.com' && !url.username && !url.password
      && releaseAssetPath.test(url.pathname) && !url.search && !url.hash
      && typeof release.sha256 === 'string' && /^[a-f0-9]{64}$/.test(release.sha256)
      && Number.isSafeInteger(release.bytes) && release.bytes > 0 && release.bytes <= maxArchiveBytes
      && (release.expandedBytes === undefined || Number.isSafeInteger(release.expandedBytes)
        && release.expandedBytes > 0 && release.expandedBytes <= maxExtractedBytes);
  } catch { return false; }
}

async function readManifest(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxManifestBytes) throw fail('SEARCH_INTEGRITY_FAILED');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function fetchArchive(fetcher, url) {
  const signal = AbortSignal.timeout(10 * 60 * 1000);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetcher(url, { redirect: 'manual', signal });
    if (response.ok && response.body) return response;
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location || ![301, 302, 303, 307, 308].includes(response.status)) break;
    const next = new URL(location, url);
    if (next.protocol !== 'https:' || next.port || next.username || next.password
      || !redirectHosts.has(next.hostname)) break;
    url = next.href;
  }
  throw fail('SEARCH_DOWNLOAD_FAILED');
}

async function validateFiles(root) {
  const info = JSON.parse(await readFile(join(root, 'search-package.json'), 'utf8'));
  if (!compatible(info)) throw fail('SEARCH_INTEGRITY_FAILED');
  const module = await stat(join(root, 'node_modules/@huggingface/transformers/dist/transformers.node.mjs'));
  const model = await stat(join(root, 'model-cache', SEARCH_MODEL, SEARCH_REVISION, 'onnx/model_quantized.onnx'));
  if (!module.isFile() || !model.isFile()) throw fail('SEARCH_INTEGRITY_FAILED');
}

async function probeModel(root) {
  const script = fileURLToPath(new URL('./search-package-probe.mjs', import.meta.url));
  await promisify(execFile)(process.execPath, [script, root], { timeout: 120_000, windowsHide: true });
}

export function createSearchPackageManager({ home = searchPackageHome(), config = null, fetcher = fetch, now = Date.now, verifyModel = probeModel } = {}) {
  let current = { state: 'idle', received: 0, total: 0 };
  let pending;
  let manifestCheck;
  let nextCheck = 0;
  const target = join(home, 'installed');

  function getRelease() {
    if (validRelease(config)) return { release: config, availability: 'available' };
    if (config?.manifestUrl !== projectManifest) return { availability: 'unavailable' };
    if (!manifestCheck || now() >= nextCheck) {
      nextCheck = Infinity;
      manifestCheck = (async () => {
        try {
          const response = await fetcher(projectManifest, { redirect: 'error', signal: AbortSignal.timeout(5000) });
          if (!response.ok) {
            await response.body?.cancel();
            return { availability: response.status === 404 ? 'unavailable' : 'offline' };
          }
          const manifest = await readManifest(response);
          if (manifest?.format !== 1 || !manifest.packages || typeof manifest.packages !== 'object'
            || Array.isArray(manifest.packages)) return { availability: 'offline' };
          const release = manifest.packages[process.platform + '-' + process.arch];
          if (release === undefined) return { availability: 'unavailable' };
          if (!compatible({ ...release, format: manifest.format }) || !validRelease(release)) return { availability: 'offline' };
          return { release, availability: 'available' };
        } catch { return { availability: 'offline' }; }
        finally { nextCheck = now() + checkInterval; }
      })();
    }
    return manifestCheck;
  }

  async function installed() {
    try { await validateFiles(target); return true; }
    catch { return false; }
  }

  function hasReadyMarker() {
    return stat(join(target, SEARCH_PACKAGE_READY_FILE)).then(marker => marker.isFile(), () => false);
  }

  async function status() {
    const present = await installed();
    const ready = present && await hasReadyMarker();
    if (present || pending) return { ...current, configured: false, installed: present, ready };
    const { release, availability } = await getRelease();
    return { ...current, total: current.total || release?.bytes || 0, expandedBytes: release?.expandedBytes || 0,
      configured: Boolean(release), availability, installed: false, ready: false };
  }

  async function checkModel(root) {
    current.state = 'verifying';
    try { await verifyModel(root); }
    catch { throw fail('SEARCH_MODEL_FAILED'); }
    await writeFile(join(root, SEARCH_PACKAGE_READY_FILE), '1\n');
  }

  async function install() {
    if (pending) throw fail('SEARCH_BUSY');
    current = { state: 'checking', received: 0, total: 0 };
    pending = (async () => {
      let stage;
      try {
        if (await installed()) {
          if (!await hasReadyMarker()) await checkModel(target);
          current.state = 'idle';
          return;
        }
        const { release } = await getRelease();
        if (!release) throw fail('SEARCH_UNAVAILABLE');
        current = { state: 'downloading', received: 0, total: release.bytes };
        await mkdir(home, { recursive: true });
        stage = await mkdtemp(join(home, 'download-'));
        const archive = join(stage, 'package.tar.gz'), extracted = join(stage, 'content');
        const response = await fetchArchive(fetcher, release.url);
        const hash = createHash('sha256');
        const meter = new Transform({ transform(chunk, encoding, callback) {
          current.received += chunk.length;
          if (current.received > release.bytes) return callback(fail('SEARCH_INTEGRITY_FAILED'));
          hash.update(chunk);
          callback(null, chunk);
        } });
        await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(archive, { flags: 'wx' }));
        if (current.received !== release.bytes || hash.digest('hex') !== release.sha256) throw fail('SEARCH_INTEGRITY_FAILED');

        current.state = 'installing';
        let count = 0, expanded = 0, bad = false;
        await tar.t({ file: archive, strict: true, onReadEntry(entry) {
          const name = entry.path.replace(/\\/g, '/');
          expanded += entry.size;
          if (++count > 50000 || expanded > maxExtractedBytes || !['File', 'Directory'].includes(entry.type)
            || name.startsWith('/') || name.includes(':') || name.split('/').some(part => part === '..' || part === '.')
            || !(name === 'search-package.json' || name.startsWith('node_modules/') || name.startsWith('model-cache/'))) bad = true;
        } });
        if (bad) throw fail('SEARCH_INTEGRITY_FAILED');
        await mkdir(extracted);
        await tar.x({ file: archive, cwd: extracted, strict: true, preservePaths: false });
        await validateFiles(extracted);
        await checkModel(extracted);
        await rename(extracted, target);
        current.state = 'idle';
      } catch (error) {
        current = { state: error.code === 'SEARCH_UNAVAILABLE' ? 'idle' : 'error',
          error: error.code, received: 0, total: current.total };
        throw error;
      } finally {
        if (stage) await rm(stage, { recursive: true, force: true }).catch(() => {});
      }
    })();
    try { await pending; } finally { pending = undefined; }
  }

  async function remove() {
    if (pending) throw fail('SEARCH_BUSY');
    pending = (async () => {
      const staged = join(home, 'removed-' + randomUUID());
      try { await rename(target, staged); }
      catch (error) {
        if (error.code === 'ENOENT') return;
        if (['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw fail('SEARCH_IN_USE');
        throw error;
      }
      current = { state: 'idle', received: 0, total: 0 };
      await rm(staged, { recursive: true, force: true });
    })();
    try { await pending; } finally { pending = undefined; }
  }
  return { status, install, remove };
}
