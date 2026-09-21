import test from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../src/services/state.ts';
import { DEFAULT_SYSTEM_PROMPT } from '../src/services/prompts.ts';
import {
  normalizeBatchSize, normalizeConcurrency, normalizeHideThreshold, normalizeRequestTimeoutSeconds, normalizeConnection,
} from '../src/services/api-config.ts';

test('Jev defaults and configuration limits', () => {
  const defaults = store.get();
  assert.equal(defaults.apiKey, '');
  assert.equal(defaults.systemPrompt, DEFAULT_SYSTEM_PROMPT);
  assert.equal(defaults.hideThreshold, 0.7);
  assert.equal(defaults.batchSize, 1000);
  assert.equal(defaults.concurrency, 10);
  assert.equal(defaults.baseUrl, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(defaults.model, 'jev-latest');
  assert.equal(defaults.requestTimeoutSeconds, 60);
  for (const key of ['authHeader', 'authPrefix', 'extraHeaders']) assert.equal(defaults[key], '');
  assert.equal(normalizeBatchSize(5000), 1000);
  assert.equal(normalizeConcurrency(1000), 16);
  assert.equal(normalizeHideThreshold(''), 0.7);
  assert.equal(normalizeHideThreshold(2), 1);
  assert.equal(normalizeRequestTimeoutSeconds(0), 60);
  assert.equal(normalizeRequestTimeoutSeconds(900), 600);
});

test('new config does not reuse old provider keys; persists settings and keeps them on video change', async () => {
  const memory = new Map([['dmApiConfig_v1', { apiKey: 'old-provider-key', concurrency: 100 }]]);
  globalThis.LFStore = {
    get: async (key, fallback) => memory.has(key) ? memory.get(key) : fallback,
    set: async (key, value) => memory.set(key, value),
  };
  assert.equal(await store.loadApiConfig(), null);
  assert.equal(store.get().apiKey, '');
  const config = {
    baseUrl: 'https://api.typesafe.ai/v2/evaluate',
    model: 'custom-model', authHeader: 'X-Key', authPrefix: '', extraHeaders: '{"X-Tenant":"test"}',
    apiKey: 'new-test-key', hideThreshold: 0.85, batchSize: 25,
    concurrency: 2, requestTimeoutSeconds: 90, replaceText: '', systemPrompt: '自定义剧透判断规则',
  };
  await store.saveApiConfig(config);
  await store.setMode('auto');
  await store.loadApiConfig();
  store.resetForUrlChange();
  for (const [key, value] of Object.entries(config)) assert.equal(store.get()[key], value);
  assert.equal(store.get().mode, 'auto');
  assert.equal(memory.get('dmJevConfig_v1').apiKey, config.apiKey);
  assert.equal(memory.get('dmJevConfig_v1').systemPrompt, config.systemPrompt);
  assert.equal(memory.get('dmApiConfig_v1').apiKey, 'old-provider-key');
  store.resetForEpisode(42, 1, 'video', '', '');
  assert.equal(store.get().baseUrl, config.baseUrl);
  for (const [key, value] of Object.entries(config)) assert.equal(store.get()[key], value);
});

test('missing API settings use defaults and saved keys are preserved', async () => {
  globalThis.LFStore = { get: async () => ({ apiKey: 'existing-key' }) };
  await store.loadApiConfig();
  assert.equal(store.get().baseUrl, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(store.get().model, 'jev-latest');
  assert.equal(store.get().requestTimeoutSeconds, 60);
  assert.equal(store.get().apiKey, 'existing-key');
});

test('saved separate paths migrate to a full URL without a provider-specific guess', () => {
  const migrated = normalizeConnection({ baseUrl: 'https://custom.example/prefix', requestPath: '/v2/eval', model: 'own-model' });
  assert.equal(migrated.baseUrl, 'https://custom.example/prefix/v2/eval');
  assert.equal(migrated.model, 'own-model');
  assert.equal(migrated.requestPath, undefined);
  assert.deepEqual(normalizeConnection(migrated), migrated);
});

test('saving unrelated settings uses API defaults without populating advanced fields', async () => {
  let saved;
  globalThis.LFStore = { set: async (_key, value) => { saved = value; }, get: async () => saved };
  store.patch({ ...normalizeConnection(), apiKey: '', requestTimeoutSeconds: null });
  await store.saveApiConfig(store.get());
  await store.loadApiConfig();
  assert.equal(store.get().baseUrl, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(store.get().model, 'jev-latest');
  for (const key of ['authHeader', 'authPrefix', 'extraHeaders', 'apiKey']) assert.equal(store.get()[key], '');
  assert.equal(store.get().requestTimeoutSeconds, null);
});
