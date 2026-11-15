import assert from 'node:assert/strict';
import test from 'node:test';
import { modelFamily, quotaPools } from '../accounts/quotaPools';
import { ModelCatalog } from '../upstream/modelCatalog';

test('quota families: classify GPT and o-series models', () => {
  assert.equal(modelFamily('gpt-4o'), 'gpt');
  assert.equal(modelFamily('o3-mini'), 'o-series');
  assert.equal(modelFamily('o1'), 'o-series');
  assert.equal(modelFamily('unknown-model'), 'other');
});

test('quota pools: groups models into pools and picks tightest first', () => {
  const pools = quotaPools([
    { modelId: 'gpt-4o', percentage: 70, resetTime: '' },
    { modelId: 'gpt-4o-mini', percentage: 100, resetTime: '' },
    { modelId: 'o3-mini', percentage: 40, resetTime: '' },
    { modelId: 'o1', percentage: 10, resetTime: '' },
  ]);
  assert.ok(pools.length > 0);
  assert.equal(pools[0].model.modelId, 'o1');
  assert.equal(pools[0].model.percentage, 10);
});

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

  const m2 = catalog.match('chatgpt/o3-mini');
  assert.equal(m2.model.id, 'o3-mini');
  assert.equal(m2.model.supportsThinking, true);

  const m3 = catalog.match('o1');
  assert.equal(m3.model.id, 'o1');

  const m4 = catalog.match('unknown-model');
  assert.equal(m4.model.id, 'gpt-4o');
  assert.equal(m4.kind, 'any');
});
