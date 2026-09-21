// 小样本在线测试，会消耗 OpenRouter 额度。只读环境变量或显式指定的本地凭据文件。
import { readFile } from 'node:fs/promises';
import { requestDecisions } from '../src/services/jev.ts';
import { DEFAULT_HIDE_THRESHOLD } from '../src/services/api-config.ts';

const args = process.argv.slice(2);
let apiKey = process.env.OPENROUTER_API_KEY?.trim();
const keyFileIndex = args.indexOf('--key-file');
if (!apiKey && keyFileIndex >= 0 && args[keyFileIndex + 1]) {
  const source = await readFile(args[keyFileIndex + 1], 'utf8');
  apiKey = source.match(/OPENROUTER_API_KEY\s*=\s*(\S+)/)?.[1];
}
if (!apiKey) throw new Error('请设置 OPENROUTER_API_KEY，或用 --key-file 指定本地接入文档。');

globalThis.LFHttp = { request: async (url, init) => {
  const result = await fetch(url, init);
  return { status: result.status, headers: Object.fromEntries(result.headers.entries()), text: () => result.text() };
} };
const samples = JSON.parse(await readFile(new URL('../tests/jev-samples.json', import.meta.url), 'utf8'));
const batchIndex = args.indexOf('--batch-size');
const batchSize = batchIndex >= 0 ? Number(args[batchIndex + 1]) : samples.length;
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new Error('batch-size 应为 1～100');
const texts = Array.from({ length: batchSize }, (_, index) => samples[index % samples.length].text);
try {
  const result = await requestDecisions(texts, { baseUrl: process.env.JEV_BASE_URL, model: process.env.JEV_MODEL, apiKey, hideThreshold: DEFAULT_HIDE_THRESHOLD, requestTimeoutSeconds: 60 });
  const rows = result.items.map((item, i) => ({
    text: item.text, probability: item.probability, hide: item.probability >= DEFAULT_HIDE_THRESHOLD,
    expected: samples[i % samples.length].expected,
  }));
  const scored = rows.filter(row => row.expected !== null);
  console.log(JSON.stringify({
    model: result.model, elapsedMs: result.elapsedMs, usage: result.usage,
    threshold: DEFAULT_HIDE_THRESHOLD, count: rows.length,
    smokeAgreement: `${scored.filter(row => row.hide === row.expected).length}/${scored.length}`,
    note: '人工构造的小样本，仅验证接入与边界表现，不代表真实弹幕准确率；--batch-size 可能循环使用样本。',
    rows,
  }, null, 2));
} catch (error) {
  // 不打印请求对象或 headers，避免在诊断输出中暴露 Key。
  console.error(`Jev 测试失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
