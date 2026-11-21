import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sharedHostArguments } from './desktop-host.mjs';

test('desktop launch preserves its settings while selecting one authenticated shared listener', () => {
  const args = ['-c', 'features.code_mode_host=true', 'app-server', '--analytics-default-enabled', '-c', 'mcp_servers.example.command="fixture"'];
  const result = sharedHostArguments(args, 'ws://127.0.0.1:19570/rpc', 'synthetic-token-'.repeat(4));
  assert.deepEqual(result.slice(0, args.length), args);
  assert.deepEqual(result.slice(args.length), ['--listen', 'ws://127.0.0.1:19570', '--ws-auth', 'capability-token',
    '--ws-token-sha256', createHash('sha256').update('synthetic-token-'.repeat(4)).digest('hex')]);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-token/);
  for (const bad of [[], ['--version'], ['app-server', 'app-server'], ['app-server', '--listen=stdio://'], ['app-server', '--ws-auth', 'none']]) {
    assert.throws(() => sharedHostArguments(bad, 'ws://127.0.0.1:19570/rpc', 'synthetic-token-'.repeat(4)));
  }
});
