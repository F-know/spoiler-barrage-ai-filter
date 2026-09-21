import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../src/services/state.ts';
import { analyzeEpisode, restoreLastVideo, stop } from '../src/services/engine.ts';
import { VIDEO_CACHE_POLICY, getVideoCachePolicy } from '../src/extension/video-cache.ts';
import { DEFAULT_SYSTEM_PROMPT } from '../src/services/prompts.ts';
import { normalizeConnection } from '../src/services/api-config.ts';

const baseUrl = 'https://www.bilibili.com/video/BVtest';
const cachedItems = [
  { text: '下一集主角死亡', time: 1, probability: 0.95 },
  { text: '音乐很好听', time: 2, probability: 0.02 },
  { text: '下一集主角死亡', time: 3, probability: 0.95 },
];
let record, calls, apiCalls, writes;
const encodeSegment = text => {
  const bytes = [...new TextEncoder().encode(text)];
  const item = [16, 0, 58, bytes.length, ...bytes];
  return new Uint8Array([10, item.length, ...item]);
};
beforeEach(() => {
  stop(false);
  store.resetForUrlChange();
  store.patch({ ...normalizeConnection(), cid: 11, apiKey: 'test-key', mode: 'manual', hideThreshold: 0.7, systemPrompt: DEFAULT_SYSTEM_PROMPT });
  record = { url: baseUrl, cid: 11, policy: VIDEO_CACHE_POLICY, completedAt: 1, items: cachedItems };
  calls = apiCalls = writes = 0;
  globalThis.location = { href: baseUrl + '?spm_id_from=refresh#top' };
  globalThis.LFRuntime = {
    runInMainWorld: async (_fn, options) => options ? 'ok' : ({
      cid: 11, aid: 1, title: '测试视频', cover: '', danmakuCount: '3',
    }),
  };
  globalThis.chrome = { runtime: { sendMessage: async message => {
    if (message.type === 'video-analysis-cache-read') return { ok: true, record };
    if (message.type === 'video-analysis-cache-write') { writes++; record = message.record; return { ok: true }; }
    throw new Error('unexpected message');
  } } };
  globalThis.fetch = async url => {
    calls++;
    const segment = new URL(url).searchParams.get('segment_index');
    return { ok: true, arrayBuffer: async () => segment === '1' ? encodeSegment('下一集主角死亡') : new Uint8Array() };
  };
  globalThis.LFHttp = { request: async () => {
    apiCalls++;
    return { status: 200, headers: {}, text: async () => JSON.stringify({
      answers: { dm_0: { type: 'noul', noul: 0.8 } }, usage: { input_tokens: 100, cost: 999 },
    }) };
  } };
});

test('refresh in manual mode restores every cached result without key, fetch or AI', async () => {
  store.patch({ apiKey: '' });
  assert.equal(await restoreLastVideo(), true);
  assert.equal(store.get().phase, 'done');
  assert.equal(store.get().analysisItems.length, 3);
  assert.equal(store.get().filteredDm.length, 2);
  store.setThreshold(0.99);
  assert.equal(store.get().filteredDm.length, 0);
  assert.equal(calls + apiCalls + writes, 0);
});

test('new video runs normal analysis; explicit reanalysis bypasses matching cache', async () => {
  assert.equal((await analyzeEpisode({ force: true })).ok, true);
  assert.equal(apiCalls, 1);
  assert.equal(writes, 1);
  assert.equal(record.items.length, 1);
  assert.equal(record.items[0].probability, 0.8);
  assert.equal(record.url, baseUrl);
  assert.ok(store.get().logs.every(line => !/费用|花费|屏蔽 \d|有风险|无风险|\$/.test(line)));
  stop(false);
  store.resetForUrlChange();
  record = { ...record, cid: 22 };
  await analyzeEpisode();
  assert.equal(apiCalls, 2);
});

test('failed or aborted analysis never replaces last complete video', async () => {
  const previous = record;
  globalThis.LFHttp.request = async () => { throw new Error('offline'); };
  assert.equal((await analyzeEpisode({ force: true })).ok, false);
  assert.equal(record, previous);
  let finish;
  globalThis.LFHttp.request = () => new Promise(resolve => { finish = resolve; });
  const task = analyzeEpisode({ force: true });
  while (!finish) await new Promise(resolve => setTimeout(resolve, 1));
  stop(false);
  await task;
  finish({ status: 200, headers: {}, text: async () => '{}' });
  assert.equal(record, previous);
  assert.equal(writes, 0);
  assert.equal(store.get().analysisItems.length, 0);
});

test('a cache read finishing after navigation cannot populate the new video', async () => {
  let finish;
  globalThis.chrome.runtime.sendMessage = () => new Promise(resolve => { finish = resolve; });
  const task = restoreLastVideo();
  stop(false);
  store.resetForUrlChange();
  store.patch({ cid: 22 });
  globalThis.location.href = 'https://www.bilibili.com/video/BVother';
  finish({ ok: true, record });
  assert.equal(await task, false);
  assert.equal(store.get().analysisItems.length, 0);
});

test('one analysis uses a prompt snapshot and tags its cache correctly even if settings change', async () => {
  store.patch({ systemPrompt: '规则 A' });
  const send = globalThis.LFHttp.request;
  globalThis.LFHttp.request = async (url, init) => {
    assert.equal(JSON.parse(init.body).state, '规则 A');
    store.patch({ systemPrompt: '规则 B' });
    return send(url, init);
  };
  assert.equal((await analyzeEpisode()).ok, true);
  assert.equal(apiCalls, 1);
  assert.equal(record.policy, getVideoCachePolicy('规则 A'));
  store.resetForUrlChange();
  store.patch({ cid: 11 });
  assert.equal(await restoreLastVideo(), false);
});

test('full engine supports custom no-auth services and keeps request/cache configuration consistent', async () => {
  const connection = { baseUrl: 'http://localhost:8080/eval', model: 'custom-jev', authHeader: '', authPrefix: '', extraHeaders: '{"X-Tenant":"a"}' };
  store.patch({ ...connection, apiKey: '' });
  const send = globalThis.LFHttp.request;
  globalThis.LFHttp.request = async (url, init) => {
    assert.equal(url, connection.baseUrl);
    assert.equal(JSON.parse(init.body).model, connection.model);
    assert.equal(init.headers.authorization, undefined);
    assert.equal(init.headers['x-tenant'], 'a');
    store.patch({ model: 'changed-model' });
    return send(url, init);
  };
  assert.equal((await analyzeEpisode()).ok, true);
  assert.equal(apiCalls, 1);
  assert.equal(record.policy, getVideoCachePolicy(DEFAULT_SYSTEM_PROMPT, connection));
  store.resetForUrlChange();
  store.patch({ cid: 11 });
  assert.equal(await restoreLastVideo(), false);
});
