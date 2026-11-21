import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';
import { createSearchPackageManager } from '../distribution/search-package.mjs';
import { createSearchEmbeddings } from '../bridge/search-embeddings.mjs';

async function bundle({ link = false, runtime = 'export {};' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'search-package-test-')), input = join(root, 'input');
  const module = join(input, 'node_modules/@huggingface/transformers/dist');
  const model = join(input, 'model-cache/Xenova/bge-small-zh-v1.5/75c43b069aac4d136ba6bc1122f995fedcfd2781/onnx');
  await mkdir(module, { recursive: true }); await mkdir(model, { recursive: true });
  await writeFile(join(input, 'search-package.json'), JSON.stringify({ format: 1, model: 'Xenova/bge-small-zh-v1.5', revision: '75c43b069aac4d136ba6bc1122f995fedcfd2781' }));
  await writeFile(join(module, 'transformers.node.mjs'), runtime); await writeFile(join(model, 'model_quantized.onnx'), 'model');
  if (link) await symlink(join(input, 'search-package.json'), join(module, 'unsafe-link'));
  const file = join(root, 'bundle.tar.gz');
  await tar.c({ gzip: true, cwd: input, file }, ['search-package.json', 'node_modules/', 'model-cache/']);
  const data = await readFile(file), config = { url: 'https://github.com/turbotang2333/io-voice-control/releases/download/v1/search.tar.gz', bytes: data.length,
    sha256: createHash('sha256').update(data).digest('hex') };
  return { root, data, config };
}
test('optional search is disabled without a configured release', async () => {
  const home = await mkdtemp(join(tmpdir(), 'search-manager-'));
  const manager = createSearchPackageManager({ home });
  assert.equal((await manager.status()).configured, false);
  await assert.rejects(manager.install(), { code: 'SEARCH_UNAVAILABLE' });
});
test('verified optional bundle is installed and can be removed', async () => {
  const { root, data, config } = await bundle();
  const manager = createSearchPackageManager({ home: join(root, 'state'), config, fetcher: async () => new Response(data), verifyModel: async () => {} });
  await manager.install(); assert.equal((await manager.status()).ready, true);
  await manager.remove(); assert.equal((await manager.status()).installed, false);
});

test('a packaged connector discovers a later release from the project manifest', async () => {
  const { root, data, config } = await bundle();
  const manifestUrl = 'https://raw.githubusercontent.com/turbotang2333/io-voice-control/main/distribution/search-package-release.json';
  let clock = 0, release, verified = false, reads = 0;
  const manager = createSearchPackageManager({
    home: join(root, 'state'), config: { manifestUrl }, now: () => clock,
    fetcher: async url => {
      if (url === manifestUrl) { reads++; return Response.json({ format: 1, packages: release ? { [process.platform + '-' + process.arch]: release } : {} }); }
      assert.equal(url, config.url);
      return new Response(data);
    },
    verifyModel: async () => { verified = true; },
  });
  assert.equal((await manager.status()).configured, false);
  release = { ...config, model: 'Xenova/bge-small-zh-v1.5', revision: '75c43b069aac4d136ba6bc1122f995fedcfd2781' };
  assert.equal((await manager.status()).configured, false);
  assert.equal(reads, 1);
  clock += 10 * 60 * 1000;
  assert.equal((await manager.status()).configured, true);
  await manager.install();
  assert.equal(verified, true);
  assert.equal((await manager.status()).ready, true);
});

test('a foreign asset in the release manifest is rejected', async () => {
  const { root, config } = await bundle();
  const manifestUrl = 'https://raw.githubusercontent.com/turbotang2333/io-voice-control/main/distribution/search-package-release.json';
  const manager = createSearchPackageManager({ home: join(root, 'state'), config: { manifestUrl },
    fetcher: async url => {
      assert.equal(url, manifestUrl);
      return Response.json({ format: 1, packages: { [process.platform + '-' + process.arch]: { ...config,
        url: 'https://github.com/foreign/repo/releases/download/v1/search.tar.gz',
        model: 'Xenova/bge-small-zh-v1.5', revision: '75c43b069aac4d136ba6bc1122f995fedcfd2781' } } });
    },
  });
  assert.equal((await manager.status()).configured, false);
  await assert.rejects(manager.install(), { code: 'SEARCH_UNAVAILABLE' });
});

test('a model that fails to load is not installed or reported ready', async () => {
  const { root, data, config } = await bundle();
  const manager = createSearchPackageManager({ home: join(root, 'state'), config, fetcher: async () => new Response(data),
  });
  await assert.rejects(manager.install(), { code: 'SEARCH_MODEL_FAILED' });
  const status = await manager.status();
  assert.equal(status.installed, false);
  assert.equal(status.ready, false);
});
test('the real verification entry point runs the extracted runtime locally before making it available to search', async () => {
  const { root, data, config } = await bundle({ runtime: `
    export const env = {};
    export async function pipeline(task, model, options) {
      if (env.allowRemoteModels !== false || options.device !== 'cpu') throw Error('expected local CPU inference');
      const extractor = async texts => ({ tolist: () => texts.map(() => [0.5, 0.5]) });
      extractor.dispose = async () => {};
      return extractor;
    }
  ` });
  const home = join(root, 'state'), target = join(home, 'installed');
  const manager = createSearchPackageManager({ home, config, fetcher: async () => new Response(data) });
  await assert.rejects(access(target), { code: 'ENOENT' });
  await manager.install();
  assert.equal((await manager.status()).ready, true);
  const embed = createSearchEmbeddings({ optionalRoot: target });
  try { assert.deepEqual(await embed(['本地对话']), [[0.5, 0.5]]); }
  finally { await embed.close(); }
});
test('checksum mismatch and archive links do not install a search bundle', async () => {
  const a = await bundle();
  const badHash = createSearchPackageManager({ home: join(a.root, 'state'), config: { ...a.config, sha256: '0'.repeat(64) }, fetcher: async () => new Response(a.data) });
  await assert.rejects(badHash.install(), { code: 'SEARCH_INTEGRITY_FAILED' });
  assert.equal((await badHash.status()).installed, false);
  if (process.platform === 'win32') return; // Creating symlinks needs developer mode on Windows.
  const b = await bundle({ link: true });
  const badLink = createSearchPackageManager({ home: join(b.root, 'state'), config: b.config, fetcher: async () => new Response(b.data) });
  await assert.rejects(badLink.install(), { code: 'SEARCH_INTEGRITY_FAILED' });
});
