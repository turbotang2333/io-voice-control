import { createSearchEmbeddings } from '../bridge/search-embeddings.mjs';

const embed = createSearchEmbeddings({ optionalRoot: process.argv[2], verifyPackage: true });
try {
  const [vector] = await embed(['智能搜索']);
  if (!vector?.length || !vector.every(Number.isFinite)) throw new Error('Invalid search model output');
} finally {
  await embed.close();
}
