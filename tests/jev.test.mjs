import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDecisionRequest, parseDecisionResponse, createDecisionBatches, requestDecisions, retryDelay,
} from '../src/services/jev.ts';
import { classifyTexts } from '../src/services/classify.ts';
import { DEFAULT_SYSTEM_PROMPT, JEV_QUESTION, normalizeSystemPrompt } from '../src/services/prompts.ts';

const config = { apiKey: 'test-key', hideThreshold: 0.7, requestTimeoutSeconds: 10 };
const response = (probabilities, status = 200, headers = {}) => ({
  status, headers,
  text: async () => JSON.stringify({
    model: 'test-model',
    answers: Object.fromEntries(probabilities.map((noul, i) => [`dm_${i}`, { type: 'noul', noul }])),
    usage: { input_tokens: 100, cost: 0.0000042 },
  }),
});

test('questions carry independent literal texts; answer IDs map out-of-order responses', () => {
  const texts = ['凶手是哥哥', '配乐很好听'];
  const body = buildDecisionRequest(texts);
  assert.deepEqual(Object.keys(body).sort(), ['model', 'questions', 'state']);
  assert.equal(body.questions.dm_0.instructions.danmaku, texts[0]);
  assert.equal(body.state, DEFAULT_SYSTEM_PROMPT);
  assert.equal(body.questions.dm_0.instructions.question, '这条弹幕是否存在剧透的风险？');
  const parsed = parseDecisionResponse({ answers: {
    dm_1: { type: 'noul', noul: 0 }, dm_0: { type: 'noul', noul: 1 },
  } }, texts);
  assert.deepEqual(parsed.items, [{ text: texts[0], probability: 1 }, { text: texts[1], probability: 0 }]);
  assert.equal(parsed.usage.cost, null);
});

test('custom system prompt reaches every question and actual transport; blank uses default', async () => {
  const custom = '只按这条自定义规则判断。';
  const body = buildDecisionRequest(['A', 'B'], custom);
  assert.equal(body.state, custom);
  assert.equal(body.questions.dm_1.instructions.question, JEV_QUESTION);
  assert.equal(normalizeSystemPrompt('  '), DEFAULT_SYSTEM_PROMPT);
  assert.equal(DEFAULT_SYSTEM_PROMPT, [
    '你是一个B站剧透弹幕AI过滤器，用于过滤掉那些涉及视频剧情的剧透弹幕。',
    '你看不到视频，只能根据单条弹幕的文字判断这条弹幕是否可能存在剧透的风险。',
    '剧透的定义：提前告知或暗示后续会呈现的内容、过程、结果或结论，导致改变了观众对当前内容的理解，实质性缩小了后续剧情发展的可能性，提前消除悬念或意外感。',
    '不属于剧透的：仅针对当前或此前已呈现的信息进行讨论，表达感受、评价或推测，不引入后续信息。',
  ].join('\n'));
  globalThis.LFHttp = { request: async (_url, init) => {
    assert.equal(JSON.parse(init.body).state, custom);
    return response([0.5]);
  } };
  await requestDecisions(['弹幕'], { ...config, systemPrompt: custom });
});

test('missing and malformed probabilities never become fabricated spoiler verdicts', () => {
  for (const noul of [undefined, null, true, '0.8', -0.1, 1.1, NaN, Infinity]) {
    assert.throws(() => parseDecisionResponse({ answers: { dm_0: { type: 'noul', noul } } }, ['弹幕']));
  }
  assert.throws(() => parseDecisionResponse({ answers: {} }, ['弹幕']));
  assert.throws(() => parseDecisionResponse({ choices: [] }, ['弹幕']));
});

test('batching respects configured count without the old 48 KB cutoff', () => {
  const texts = Array.from({ length: 100 }, (_, i) => `${i}${'长'.repeat(1000)}`);
  const batches = createDecisionBatches(texts, 50);
  assert.deepEqual(batches.flat(), texts);
  assert.deepEqual(batches.map(b => b.length), [50, 50]);
  const shortTexts = Array.from({ length: 430 }, (_, i) => `第${i}条普通视频弹幕`);
  assert.ok(Buffer.byteLength(JSON.stringify(buildDecisionRequest(shortTexts))) > 48000);
  assert.deepEqual(createDecisionBatches(shortTexts, 1000).map(b => b.length), [430]);
  assert.deepEqual(createDecisionBatches(Array(1001).fill('弹幕'), 1000).map(b => b.length), [1000, 1]);
  assert.throws(() => createDecisionBatches(['长'.repeat(10000)], 50));
});

test('519 comments deduplicate to 430 and send exactly one request at batch size 1000', async () => {
  const unique = Array.from({ length: 430 }, (_, i) => ({ text: `弹幕${i}`, time: i }));
  let requests = 0;
  globalThis.LFHttp = { request: async (_url, init) => {
    requests++;
    assert.equal(Object.keys(JSON.parse(init.body).questions).length, 430);
    return response(Array(430).fill(0.2));
  } };
  const result = await classifyTexts([...unique, ...unique.slice(0, 89)], config, { batchSize: 1000, concurrency: 10 });
  assert.equal(requests, 1);
  assert.equal(result.items.length, 519);
});

test('deduplication, real completion order, worker pool and timestamp expansion', async () => {
  let active = 0, maxActive = 0;
  const pending = [];
  globalThis.LFHttp = { request: (_url, init) => {
    active++; maxActive = Math.max(maxActive, active);
    return new Promise(resolve => pending.push({
      body: JSON.parse(init.body),
      finish: value => { active--; resolve(response([value])); },
    }));
  } };
  const log = [];
  const task = classifyTexts([
    { text: '配乐很好听', time: 10 }, { text: '凶手是哥哥', time: 2 },
    { text: ' 凶手是哥哥 ', time: 8 }, { text: '下一集全员死亡', time: 20 },
  ], config, { batchSize: 1, concurrency: 2, onBatchComplete: info => log.push(info) });
  while (pending.length < 2) await new Promise(r => setTimeout(r, 1));
  pending[1].finish(0.05);
  while (pending.length < 3) await new Promise(r => setTimeout(r, 1));
  assert.equal(log[0].batchIndex, 2);
  assert.equal(log[0].done, 1);
  pending[2].finish(0.95);
  pending[0].finish(0.9);
  const result = await task;
  assert.equal(pending.length, 3);
  assert.equal(maxActive, 2);
  assert.deepEqual(result.items.map(i => [i.time, i.probability]), [[2, 0.9], [8, 0.9], [10, 0.05], [20, 0.95]]);
  assert.equal(result.usage.inputTokens, 300);
  assert.equal(log.at(-1).done, 4);
});


test('empty input and whitespace complete locally without an API call', async () => {
  globalThis.LFHttp = { request: () => { throw new Error('must not request'); } };
  assert.deepEqual((await classifyTexts([], config)).items, []);
  const result = await classifyTexts([{ text: '   ', time: 1 }], config);
  assert.equal(result.items[0].probability, 0);
  assert.equal(result.usage.cost, 0);
});

test('stop suppresses all late progress', async () => {
  const controller = new AbortController();
  let finish;
  let called = false;
  globalThis.LFHttp = { request: () => { called = true; return new Promise(r => { finish = r; }); } };
  const log = [];
  const task = classifyTexts([{ text: '他是凶手', time: 1 }], config, {
    signal: controller.signal, onBatchComplete: i => log.push(i),
  });
  while (!called) await new Promise(r => setTimeout(r, 1));
  controller.abort();
  await assert.rejects(task, { name: 'AbortError' });
  finish(response([0.9]));
  await new Promise(r => setTimeout(r, 1));
  assert.equal(log.length, 0);
});

test('one invalid batch cancels siblings and prevents later callbacks', async () => {
  const requests = [];
  globalThis.LFHttp = { request: (_url, init) => new Promise(resolve => requests.push({ init, resolve })) };
  const log = [];
  const task = classifyTexts([{ text: '凶手是哥哥', time: 1 }, { text: '音乐真好听', time: 2 }], config, {
    batchSize: 1, concurrency: 2, onBatchComplete: i => log.push(i),
  });
  while (requests.length < 2) await new Promise(r => setTimeout(r, 1));
  requests[0].resolve(response([]));
  await assert.rejects(task, /判定缺失/);
  assert.equal(requests[1].init.signal.aborted, true);
  requests[1].resolve(response([0.1]));
  await new Promise(r => setTimeout(r, 1));
  assert.equal(log.length, 0);
});

test('retries throttling with Retry-After; does not retry auth or network failures', async () => {
  let calls = 0;
  const retries = [];
  globalThis.LFHttp = { request: async () => ++calls === 1 ? response([], 429, { 'retry-after': '0.25' }) : response([0.9]) };
  await requestDecisions(['弹幕'], config, { onRetry: info => retries.push(info) });
  assert.equal(calls, 2);
  assert.equal(retries[0].delayMs, 250);
  calls = 0;
  globalThis.LFHttp = { request: async () => { calls++; return response([], 401); } };
  await assert.rejects(requestDecisions(['弹幕'], config), /401/);
  assert.equal(calls, 1);
  globalThis.LFHttp = { request: async () => { throw new Error('network offline'); } };
  await assert.rejects(requestDecisions(['弹幕'], config), /network offline/);
  assert.equal(retryDelay('Wed, 21 Oct 2015 07:28:00 GMT', 1, Date.parse('2015-10-21T07:27:58Z')), 2000);
});

test('timeout includes backoff; no retry request is sent after timeout', async () => {
  let calls = 0;
  globalThis.LFHttp = { request: async () => { calls++; return response([], 429, { 'retry-after': '30' }); } };
  await assert.rejects(requestDecisions(['弹幕'], { ...config, requestTimeoutSeconds: 1 }), /超时/);
  assert.equal(calls, 1);
});
