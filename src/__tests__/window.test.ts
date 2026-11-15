import assert from 'node:assert/strict';
import test from 'node:test';
import { WINDOW_ENV, withWindowHeader } from '../integrations/window';

test('ChatGPT integration identifiers are isolated', () => {
  assert.equal(WINDOW_ENV, 'CHATGPT_WINDOW');
});

test('window header: added after the headers the user set', () => {
  assert.equal(withWindowHeader('X-Team: core', 'w-1'), 'X-Team: core\nx-chatgpt-window: w-1');
  assert.equal(withWindowHeader(undefined, 'w-1'), 'x-chatgpt-window: w-1');
});

test('window header: replaced rather than repeated, and removable', () => {
  const seeded = withWindowHeader('X-Team: core\nx-chatgpt-window: w-old', 'w-new');
  assert.equal(seeded, 'X-Team: core\nx-chatgpt-window: w-new');
  assert.equal(withWindowHeader(seeded, undefined), 'X-Team: core');
  assert.equal(withWindowHeader('x-chatgpt-window: w-1', undefined), undefined);
});
