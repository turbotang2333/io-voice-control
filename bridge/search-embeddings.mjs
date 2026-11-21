import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SEARCH_MODEL = 'Xenova/bge-small-zh-v1.5';
export const SEARCH_REVISION = '75c43b069aac4d136ba6bc1122f995fedcfd2781';
export const SEARCH_PACKAGE_READY_FILE = 'model-ready';
/** Downloads model files only. All text inference is CPU-local; no hosted inference API. */
export function createSearchEmbeddings({ cacheDir = join(homedir(), '.local/state/rayneo-paseo/search-model-cache'),
  optionalRoot = join(homedir(), '.local/state/rayneo-paseo/optional-search/installed'), verifyPackage = false } = {}) {
  let loading, extractor;
  const embed = async texts => {
    if (!loading) loading = (async () => {
      const root = optionalRoot;
      const optional = join(root, 'node_modules/@huggingface/transformers/dist/transformers.node.mjs');
      const available = verifyPackage || existsSync(optional) && existsSync(join(root, SEARCH_PACKAGE_READY_FILE));
      const { pipeline, env } = available ? await import(pathToFileURL(optional).href) : await import('@huggingface/transformers');
      env.cacheDir = available ? join(root, 'model-cache') : cacheDir;
      if (available) env.allowRemoteModels = false;
      extractor = await pipeline('feature-extraction', SEARCH_MODEL, { revision: SEARCH_REVISION, device: 'cpu', dtype: 'q8',
        session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 } });
    })().catch(error => { loading = undefined; throw error; });
    await loading;
    if (!texts.length) return [];
    const result = await extractor(texts, { pooling: 'cls', normalize: true });
    return result.tolist();
  };
  embed.close = async () => { if (loading) await loading.catch(() => {}); await extractor?.dispose(); };
  return embed;
}
