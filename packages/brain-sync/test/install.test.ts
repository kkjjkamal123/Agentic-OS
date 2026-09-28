import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isOurs } from '../src/install.ts';

test('hook detection matches the quoted launcher command and nothing else', () => {
  const entry = (command: string) => ({ hooks: [{ type: 'command', command }] });
  assert.ok(isOurs(entry('"/Users/me/.brain-sync/bin/brain-sync" hook')));
  assert.ok(isOurs(entry('/Users/me/.brain-sync/bin/brain-sync hook')));
  assert.ok(!isOurs(entry('echo hello')));
  assert.ok(!isOurs(entry('"/Users/me/.brain-sync/bin/brain-sync" sync')));
});
