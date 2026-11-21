import { createSharedHostedAllocator } from '../../relay/shared-hosted-allocator.mjs';

const [databasePath, encoded] = process.argv.slice(2);
const { shared, enrollment } = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
const allocator = await createSharedHostedAllocator({ databasePath, shared, activate: async () => {
  await new Promise(resolve => setTimeout(resolve, 500)); return true;
} });
try { process.stdout.write(JSON.stringify({ invitation: await allocator.provision(enrollment) })); }
catch (error) { process.stdout.write(JSON.stringify({ error: error.code })); }
finally { allocator.close(); }
