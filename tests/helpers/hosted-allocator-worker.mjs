import { createHostedAllocator } from '../../relay/hosted-allocator.mjs';
const [databasePath, payload] = process.argv.slice(2);
const { slots, enrollment, delay, notifyReserved } = JSON.parse(Buffer.from(payload, 'base64').toString());
const allocator = await createHostedAllocator({ databasePath, slots, activate: async () => {
  if (notifyReserved) process.stdout.write('RESERVED\n');
  await new Promise(resolve => setTimeout(resolve, delay)); return true;
} });
try { const invitation = await allocator.provision(enrollment); process.stdout.write(JSON.stringify({ invitation })); }
catch (error) { process.stdout.write(JSON.stringify({ error: error.code })); }
finally { allocator.close(); }
