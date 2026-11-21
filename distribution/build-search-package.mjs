import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, cp, copyFile, open, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import * as tar from 'tar';
import { searchDependencyPaths } from './search-dependencies.mjs';
import { SEARCH_MODEL, SEARCH_REVISION } from '../bridge/search-embeddings.mjs';

// Builds a separate bundle only from the pinned search dependency graph and four model files.
export async function buildSearchPackage({ source, output, modelCache } = {}) {
  if (![source, output, modelCache].every(p => typeof p === 'string' && isAbsolute(p))) throw Error('SEARCH_PACKAGE_PATH_INVALID');
  source = resolve(source); output = resolve(output); modelCache = resolve(modelCache);
  if (!relative(source, output).startsWith('..')) throw Error('SEARCH_PACKAGE_OUTPUT_IN_SOURCE');
  const lock = JSON.parse(await readFile(join(source, 'package-lock.json'), 'utf8'));
  const all = [...searchDependencyPaths(lock, true)];
  const roots = all.filter(path => !all.some(other => path.startsWith(other + '/')));
  if (!roots.includes('node_modules/@huggingface/transformers')) throw Error('SEARCH_DEPENDENCY_MISSING');
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts');
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(join(parent, 'search-bundle-'));
  try {
    for (const path of roots) {
      const from = join(source, path), to = join(stage, path);
      try { if (!(await lstat(from)).isDirectory() || (await lstat(from)).isSymbolicLink()) throw Error('SEARCH_LINK_REJECTED'); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      await mkdir(dirname(to), { recursive: true });
      await cp(from, to, { recursive: true, errorOnExist: true, force: false, filter: async path => {
        const info = await lstat(path); if (info.isSymbolicLink()) throw Error('SEARCH_LINK_REJECTED');
        const normalized = path.replace(/\\/g, '/');
        if (normalized.includes('/onnxruntime-node/bin/napi-v3/') && /\/(linux|darwin|win32\/arm64)(\/|$)/.test(normalized)) return false;
        return true;
      } });
    }
    for (const file of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx']) {
      const sourceFile = join(modelCache, SEARCH_MODEL, SEARCH_REVISION, file);
      const destination = join(stage, 'model-cache', SEARCH_MODEL, SEARCH_REVISION, file);
      const info = await lstat(sourceFile); if (!info.isFile() || info.isSymbolicLink()) throw Error('SEARCH_MODEL_MISSING');
      await mkdir(dirname(destination), { recursive: true }); await copyFile(sourceFile, destination);
    }
    await copyFile(join(source, 'distribution/model-license.txt'), join(stage, 'model-cache/MODEL-LICENSE.txt'));
    await writeFile(join(stage, 'search-package.json'), JSON.stringify({ format: 1, model: SEARCH_MODEL, revision: SEARCH_REVISION }));
    const reserved = await open(output, 'wx'); await reserved.close();
    await tar.c({ cwd: stage, file: output, gzip: true, strict: true, noMtime: true, portable: true }, ['search-package.json', 'node_modules/', 'model-cache/']);
    const digest = createHash('sha256'); let bytes = 0;
    for await (const chunk of createReadStream(output)) { digest.update(chunk); bytes += chunk.length; }
    let expandedBytes = 0; await tar.t({ file: output, strict: true, onReadEntry(entry) { expandedBytes += entry.size; } });
    return { bytes, expandedBytes, sha256: digest.digest('hex') };
  } finally { if (dirname(resolve(stage)) === resolve(parent)) await rm(stage, { recursive: true, force: true }); }
}
