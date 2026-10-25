import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelCatalog } from '../upstream/modelCatalog';

test('catalog: list all static models with defaults', () => {
  const catalog = new ModelCatalog();
  const models = catalog.listAll();
  assert.ok(models.length >= 6);
  assert.ok(models.some((m) => m.id === 'gpt-4o'));
  assert.ok(models.some((m) => m.id === 'o3-mini'));
  assert.ok(models.some((m) => m.id === 'o1'));
});

test('catalog: matching exact and alias model names', () => {
  const catalog = new ModelCatalog();

  const m1 = catalog.match('gpt-4o');
  assert.equal(m1.model.id, 'gpt-4o');
  assert.equal(m1.kind, 'exact');

  const m2 = catalog.match('chatgpt-maestro/o3-mini');
  assert.equal(m2.model.id, 'o3-mini');
  assert.equal(m2.model.supportsThinking, true);

  const m3 = catalog.match('o1');
  assert.equal(m3.model.id, 'o1');

  const m4 = catalog.match('unknown-model');
  assert.equal(m4.model.id, 'gpt-4o');
  assert.equal(m4.kind, 'any');
});
