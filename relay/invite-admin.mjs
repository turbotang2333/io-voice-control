import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createInviteStore } from './invite-store.mjs';

// Run locally on the relay host; no management endpoint is exposed on the network.
async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('Usage: node invite-admin.mjs issue | revoke\nCodes expire after seven days and bind to one installation. Revoking a code does not disconnect an existing installation.\n'); return;
  }
  if (process.platform !== 'linux' || process.geteuid?.() !== 0 || args.length !== 1 || !['issue', 'revoke'].includes(args[0])) throw Error('INVITE_ADMIN_INVALID');
  const store = await createInviteStore({ path: '/var/lib/rayneo-paseo-shared-hosted/invites.sqlite' });
  try {
    if (args[0] === 'issue') { process.stdout.write(store.issue() + '\n'); return; }
    const input = createInterface({ input: process.stdin, output: process.stderr });
    let code; try { code = (await input.question('Invitation code: ')).trim(); } finally { input.close(); }
    if (!store.revoke(code)) throw Error('INVITE_REVOKE_FAILED');
    process.stdout.write('INVITE_REVOKED\n');
  } finally { store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => { process.stderr.write('INVITE_ADMIN_FAILED\n'); process.exitCode = 1; });
}
