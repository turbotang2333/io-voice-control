import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionChoiceView } from '../distribution/ui/view.js';

test('new users choose between author relay and self-hosting before seeing either setup', () => {
  assert.deepEqual(connectionChoiceView({ phase: 'new' }, null), { showChoices: true, showConnection: false, showSelfHosted: false });
  assert.deepEqual(connectionChoiceView({ phase: 'new' }, 'project-hosted'), { showChoices: true, showConnection: true, showSelfHosted: false });
  assert.deepEqual(connectionChoiceView({ phase: 'new' }, 'self-hosted'), { showChoices: true, showConnection: false, showSelfHosted: true });
});

test('configured connections keep their status and self-hosted recovery without offering unsafe switching', () => {
  assert.deepEqual(connectionChoiceView({ phase: 'configured', hosting: 'self-hosted' }, null), { showChoices: false, showConnection: true, showSelfHosted: true });
  assert.deepEqual(connectionChoiceView({ phase: 'configured', hosting: 'project-hosted' }, 'self-hosted'), { showChoices: false, showConnection: true, showSelfHosted: false });
  assert.deepEqual(connectionChoiceView({ phase: 'configuration_error', ipRecoveryOptions: [{ id: 'old' }] }, null), { showChoices: false, showConnection: true, showSelfHosted: true });
});
