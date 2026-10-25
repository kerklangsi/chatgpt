import assert from 'node:assert/strict';
import test from 'node:test';
import { displayNameFor, displayNamesFor } from '../upstream/modelNames';

test('ChatGPT model display names', () => {
  assert.equal(displayNameFor('gpt-4o'), 'GPT-4o (Omni)');
  assert.equal(displayNameFor('chatgpt-maestro/o3-mini'), 'OpenAI o3-mini');
  assert.equal(displayNameFor('o1'), 'OpenAI o1');
  assert.equal(displayNameFor('gpt-4o-mini'), 'GPT-4o Mini');
  assert.equal(displayNameFor('auto'), 'ChatGPT Auto (Default)');
});

test('displayNamesFor maps model list', () => {
  const names = displayNamesFor([
    { modelId: 'gpt-4o' },
    { modelId: 'o3-mini', displayName: 'OpenAI o3-mini (Reasoning)' },
  ]);
  assert.equal(names['gpt-4o'], 'GPT-4o (Omni)');
  assert.equal(names['o3-mini'], 'OpenAI o3-mini (Reasoning)');
});
