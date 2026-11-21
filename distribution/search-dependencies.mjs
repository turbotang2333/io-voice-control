// Dependencies used only by optional semantic search stay out of the base package.
export function searchDependencyPaths(lock, includeShared = false) {
  const packages = lock.packages ?? {};
  const find = (parent, name) => {
    let prefix = parent;
    while (prefix) {
      const path = prefix + '/node_modules/' + name;
      if (packages[path]) return path;
      const cut = prefix.lastIndexOf('/node_modules/');
      if (cut < 0) break;
      prefix = prefix.slice(0, cut);
    }
    const root = 'node_modules/' + name;
    return packages[root] ? root : null;
  };
  function closure(names) {
    const seen = new Set(), pending = names.map(n => find('', n)).filter(Boolean);
    while (pending.length) {
      const path = pending.pop(); if (seen.has(path)) continue;
      seen.add(path);
      const info = packages[path];
      for (const name of Object.keys({ ...info.dependencies, ...info.optionalDependencies })) {
        const child = find(path, name); if (child) pending.push(child);
      }
    }
    return seen;
  }
  const optional = closure(['@huggingface/transformers']);
  if (includeShared) return optional;
  const mandatory = closure([...Object.keys(packages['']?.dependencies ?? {}).filter(n => n !== '@huggingface/transformers'), 'tar']);
  return new Set([...optional].filter(path => !mandatory.has(path)));
}
