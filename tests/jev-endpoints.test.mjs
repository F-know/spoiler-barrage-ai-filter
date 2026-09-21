import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveJevApi, buildApiHeaders } from '../src/services/api-config.ts';
import { requestDecisions } from '../src/services/jev.ts';
import { testApi } from '../src/services/classify.ts';
import { getVideoCachePolicy, VIDEO_CACHE_POLICY } from '../src/extension/video-cache.ts';

const connections = [
  { baseUrl: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest' },
  { baseUrl: 'https://openrouter.ai/api/alpha/decisions', model: 'typesafe/jev-1.13' },
  { baseUrl: 'https://proxy.example:8443/custom/evaluate', model: 'private-alias' },
  { baseUrl: 'http://localhost:8080/custom/eval?version=2', model: 'local-model' },
];

test('arbitrary hosts, ports, models and complete URLs do not depend on provider mappings', () => {
  for (const config of connections) {
    const api = resolveJevApi(config);
    const expected = new URL(config.baseUrl);
    assert.deepEqual(api, { endpoint: expected.href, model: config.model });
  }
  assert.equal(resolveJevApi({ baseUrl: 'https://proxy.example/base/', requestPath: '/evaluate', model: 'x' }).endpoint,
    'https://proxy.example/base/evaluate');
  for (const baseUrl of ['abc', 'file:///tmp/file', 'https://user:key@proxy.example', 'https://proxy.example#x']) {
    assert.throws(() => resolveJevApi({ baseUrl }), /Base URL/);
  }
  assert.throws(() => resolveJevApi({ baseUrl: 'https://test.example', model: '' }), /model/);
  assert.deepEqual(resolveJevApi(), {
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-latest',
  });
});

test('analysis and connection tests use the same custom endpoint, model and credentials', async () => {
  for (const connection of connections) {
    const api = resolveJevApi(connection);
    let calls = 0;
    globalThis.LFHttp = { request: async (url, init) => {
      calls++;
      assert.equal(url, api.endpoint);
      assert.equal(init.headers.authorization, 'Bearer test-key');
      assert.equal(init.redirect, 'error');
      assert.equal(init.credentials, 'omit');
      const body = JSON.parse(init.body);
      assert.equal(body.model, api.model);
      assert.equal(body.state, 'custom prompt');
      assert.equal(body.questions.dm_0.type, 'noul');
      return { status: 200, headers: {}, text: async () => JSON.stringify({
        answers: { dm_0: { type: 'noul', noul: 0.8 } }, usage: { input_tokens: 12 },
      }) };
    } };
    const config = { ...connection, apiKey: 'test-key', systemPrompt: 'custom prompt', requestTimeoutSeconds: 120, hideThreshold: 0.7 };
    const result = await requestDecisions(['test'], config);
    assert.equal(result.model, api.model);
    assert.equal(result.items[0].probability, 0.8);
    assert.equal((await testApi(config)).ok, true);
    assert.equal(calls, 2);
  }
});

test('custom auth headers, prefixes, no-auth endpoints and extra headers', () => {
  const config = { apiKey: 'secret', requestTimeoutSeconds: 120, hideThreshold: 0.7 };
  assert.equal(buildApiHeaders({ ...config, authHeader: 'X-API-Key', authPrefix: '' })['x-api-key'], 'secret');
  assert.equal(buildApiHeaders({ ...config, authPrefix: 'Token' }).authorization, 'Token secret');
  assert.equal(buildApiHeaders({ ...config, apiKey: '', authHeader: '' }).authorization, undefined);
  assert.equal(buildApiHeaders({ ...config, extraHeaders: '{"X-Tenant":"a"}' })['x-tenant'], 'a');
  for (const extraHeaders of ['{', '[]', '{"a":1}', '{"Cookie":"session=x"}']) {
    assert.throws(() => buildApiHeaders({ ...config, extraHeaders }), /请求头/);
  }
  assert.throws(() => buildApiHeaders({ ...config, apiKey: '', authHeader: 'X-Key' }), /API Key/);
});

test('cache identity includes actual endpoint and model, never credentials', () => {
  assert.equal(getVideoCachePolicy(undefined, connections[0]), VIDEO_CACHE_POLICY);
  assert.notEqual(getVideoCachePolicy(undefined, connections[1]), VIDEO_CACHE_POLICY);
  assert.notEqual(getVideoCachePolicy(undefined, connections[2]),
    getVideoCachePolicy(undefined, { ...connections[2], model: 'different-model' }));
  assert.equal(getVideoCachePolicy(undefined, connections[0]), getVideoCachePolicy(undefined, {
    ...connections[0], baseUrl: 'https://api.typesafe.ai/v1/systemone',
  }));
  assert.ok(!getVideoCachePolicy(undefined, { ...connections[2], extraHeaders: '{"x-secret":"secret"}' }).includes('secret'));
});

test('network permissions support user-configured providers; content injection stays limited to Bilibili', async () => {
  const manifest = JSON.parse(await readFile(new URL('../public/manifest.json', import.meta.url), 'utf8'));
  for (const url of ['https://*/*', 'http://*/*']) assert.ok(manifest.host_permissions.includes(url));
  assert.ok(manifest.content_scripts.every(script => script.matches.every(url => url.startsWith('https://www.bilibili.com/'))));
});
