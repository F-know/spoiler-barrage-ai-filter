// 只分析概率：文本去重、有限并发和逐批进度；屏蔽阈值由本地状态管理。
import { normalizeBatchSize, normalizeConcurrency, type JevConfig } from "./api-config";
import { checkAbort, createDecisionBatches, requestDecisions, JevHttpError, type JevUsage, type RetryInfo } from "./jev";
import type { ScoredDanmaku } from "./probability";

export type DanmakuInput = { text: string; time: number };
export type ClassifyResult = { items: ScoredDanmaku[]; usage: JevUsage };
export type BatchProgress = {
  batchIndex: number; completedBatches: number; totalBatches: number;
  requestCount: number; done: number; total: number; elapsedMs: number; usage: JevUsage;
};

export async function classifyTexts(
  danmaku: DanmakuInput[], config: JevConfig,
  opts: {
    signal?: AbortSignal;
    onDeduplicate?: (before: number, after: number) => void;
    onProgress?: (done: number, total: number, items?: ScoredDanmaku[]) => void;
    onBatchComplete?: (info: BatchProgress) => void;
    onRetry?: (batchIndex: number, info: RetryInfo) => void;
    batchSize?: number; concurrency?: number;
  } = {},
): Promise<ClassifyResult> {
  checkAbort(opts.signal);
  const sorted = [...danmaku].sort((a, b) => a.time - b.time);
  const occurrences = new Map<string, DanmakuInput[]>();
  for (const entry of sorted) {
    const text = entry.text.trim();
    const group = occurrences.get(text) ?? [];
    group.push(entry);
    occurrences.set(text, group);
  }
  const texts = [...occurrences.keys()];
  opts.onDeduplicate?.(sorted.length, texts.length);
  const probabilities = new Map<string, number>();
  const expand = (text: string, probability: number): ScoredDanmaku[] =>
    (occurrences.get(text) ?? []).map(entry => ({ ...entry, probability }));
  const blank = expand("", 0);
  probabilities.set("", 0);
  let done = blank.length;
  opts.onProgress?.(done, sorted.length, blank);
  const batches = createDecisionBatches(texts.filter(Boolean), normalizeBatchSize(opts.batchSize), config.systemPrompt);
  let nextBatch = 0, completedBatches = 0;
  const usage: JevUsage = { inputTokens: 0, cost: 0 };
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  if (opts.signal?.aborted) controller.abort();
  let failure: unknown;
  let failed = false;

  async function worker() {
    try {
      while (nextBatch < batches.length) {
        checkAbort(controller.signal);
        const index = nextBatch++;
        const batch = batches[index];
        const result = await requestDecisions(batch, config, {
          signal: controller.signal,
          onRetry: info => { if (!controller.signal.aborted) opts.onRetry?.(index + 1, info); },
        });
        checkAbort(controller.signal);
        const expanded: ScoredDanmaku[] = [];
        for (const item of result.items) {
          probabilities.set(item.text, item.probability);
          expanded.push(...expand(item.text, item.probability));
        }
        done += expanded.length;
        completedBatches++;
        usage.inputTokens += result.usage.inputTokens;
        usage.cost = usage.cost !== null && result.usage.cost !== null ? usage.cost + result.usage.cost : null;
        opts.onProgress?.(done, sorted.length, expanded);
        opts.onBatchComplete?.({
          batchIndex: index + 1, completedBatches, totalBatches: batches.length,
          requestCount: batch.length, done, total: sorted.length,
          elapsedMs: result.elapsedMs, usage: result.usage,
        });
      }
    } catch (error) {
      if (!failed) { failed = true; failure = error; }
      controller.abort();
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(normalizeConcurrency(opts.concurrency), batches.length) }, worker));
    checkAbort(opts.signal);
    if (failed) throw failure;
    return {
      items: sorted.map(entry => ({ ...entry, probability: probabilities.get(entry.text.trim())! })),
      usage,
    };
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

export type ApiTestResult =
  | { ok: true; elapsedMs: number; probability: number }
  | { ok: false; code: string; message: string };

export async function testApi(config: JevConfig): Promise<ApiTestResult> {
  try {
    const result = await requestDecisions(["下一集主角就会死，凶手是他的哥哥"], config);
    return { ok: true, elapsedMs: result.elapsedMs, probability: result.items[0].probability };
  } catch (error) {
    return {
      ok: false,
      code: error instanceof JevHttpError ? String(error.status) : "Error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
