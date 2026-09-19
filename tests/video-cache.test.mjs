import test from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB } from 'fake-indexeddb';
import { canonicalVideoUrl, videoNavigationKey, readVideoCache, writeVideoCache, clearVideoCache, hasVideoCache, VIDEO_CACHE_POLICY, getVideoCachePolicy } from '../src/extension/video-cache.ts';

globalThis.indexedDB = indexedDB;
const databaseName = 'spoiler-barrage-ai-filter';
const oldDatabase = await new Promise((resolve, reject) => {
  const request = indexedDB.open(databaseName, 3);
  request.onupgradeneeded = () => {
    for (const name of ['jev-probability-cache', 'global-text-hash-cache', 'video-analysis-cache']) {
      request.result.createObjectStore(name);
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
oldDatabase.close();
let listener;
globalThis.chrome = {
  storage: { local: { remove: async () => {} } },
  runtime: {
    onMessage: { addListener: fn => { listener = fn; } },
    sendMessage: message => new Promise(resolve => listener(message, {}, resolve)),
  },
};
await import('../src/extension/background.ts');
const url = 'https://www.bilibili.com/video/BVtest';
const record = {
  url, cid: 11, policy: VIDEO_CACHE_POLICY, completedAt: 100,
  items: [
    { text: '超过五个字也保存完整结果', time: 1, probability: 0.9 },
    { text: '超过五个字也保存完整结果', time: 20, probability: 0.9 },
    { text: '好看', time: 21, probability: 0.03 },
  ],
};

test('URL ignores tracking/hash/trailing slash, but SPA navigation distinguishes parts', () => {
  assert.equal(canonicalVideoUrl(url + '/?spm_id_from=a&t=90#reply'), url);
  assert.equal(videoNavigationKey(url + '?spm_id_from=a'), videoNavigationKey(url));
  assert.notEqual(videoNavigationKey(url + '?p=2'), videoNavigationKey(url + '?p=1'));
});

test('real IndexedDB upgrade removes global stores; single latest slot preserves every result', async () => {
  assert.equal(await hasVideoCache(), false);
  await writeVideoCache(record);
  assert.equal(await hasVideoCache(), true);
  assert.deepEqual((await readVideoCache(url + '?spm_id_from=abc&t=10#x', 11)).items, record.items);
  assert.equal(await readVideoCache(url, 12), null);
  assert.equal(await readVideoCache('https://www.bilibili.com/video/BVother', 11), null);
  await writeVideoCache({ ...record, cid: 22, completedAt: 200 });
  assert.equal(await readVideoCache(url, 11), null);
  assert.equal((await readVideoCache(url, 22)).items.length, 3);
  // A slower write from an earlier completed analysis must not replace the newest video.
  await writeVideoCache(record);
  assert.ok(await readVideoCache(url, 22));
  const db = await new Promise(resolve => {
    const request = indexedDB.open(databaseName);
    request.onsuccess = () => resolve(request.result);
  });
  assert.deepEqual([...db.objectStoreNames], ['last-video-analysis']);
  db.close();
  assert.equal(await clearVideoCache(), 1);
  assert.equal(await hasVideoCache(), false);
  assert.equal(await readVideoCache(url, 22), null);
  assert.equal(await clearVideoCache(), 0);
});

test('bad/incompatible records are not reused; empty completed video remains cacheable', async () => {
  await assert.rejects(writeVideoCache({ ...record, items: [{ text: 'x', time: 1, probability: 2 }] }), /无效/);
  await writeVideoCache({ ...record, policy: 'old-policy', completedAt: 300 });
  assert.equal(await readVideoCache(url, 11), null);
  await writeVideoCache({ ...record, items: [], completedAt: 400 });
  assert.deepEqual((await readVideoCache(url, 11)).items, []);
});

test('cache is isolated by actual system prompt, not only model version', async () => {
  const custom = '新的判断规则';
  await writeVideoCache({ ...record, policy: getVideoCachePolicy(custom), completedAt: 500 });
  assert.equal(await readVideoCache(url, 11), null);
  assert.equal(await readVideoCache(url, 11, '另一个规则'), null);
  assert.deepEqual((await readVideoCache(url, 11, custom)).items, record.items);
});
