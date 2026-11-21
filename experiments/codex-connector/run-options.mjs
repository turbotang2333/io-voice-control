const invalid = () => Object.assign(new Error('USAGE'), { code: 'USAGE' });

export function parseRunOptions(args) {
  const [mode, ...rest] = args;
  if (!['check', 'serve'].includes(mode)) throw invalid();
  let configPath, independentTest = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--config' && configPath === undefined && rest[i + 1] && !rest[i + 1].startsWith('--')) configPath = rest[++i];
    else if (rest[i] === '--independent-test' && !independentTest) independentTest = true;
    else throw invalid();
  }
  if (mode === 'serve' && !configPath) throw invalid();
  return { mode, configPath, independentTest };
}

export function independentProfile(profile, enabled) {
  if (!profile || !enabled) return profile;
  const copy = { ...profile };
  delete copy.sharedConnection;
  return copy;
}
