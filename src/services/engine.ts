// 分析流程只生成完整概率；实际屏蔽规则由 state 中的实时阈值决定。
import { classifyTexts } from "./classify";
import { fetchSegment } from "./bilibili";
import { store, controlPlayback, readEpisodeInfo } from "./state";
import { checkAbort } from "./jev";
import { canonicalVideoUrl, videoNavigationKey, readVideoCache, writeVideoCache, getVideoCachePolicy } from "../extension/video-cache";
import type { ScoredDanmaku } from "./probability";

const MAX_SEGMENTS = 100;
let currentAbort: AbortController | null = null;
let currentRunId = 0;

function applyComplete(items: ScoredDanmaku[], cid: number) {
  store.patch({
    analysisItems: items, totalCount: items.length, analyzedCount: items.length,
    handledEp: String(cid), phase: "done", progress: 1, errorMsg: "",
  });
}

/** 启动/切集时即使是手动模式也恢复上一次完整分析，不调用 AI 或重新拉弹幕。 */
export async function restoreLastVideo(): Promise<boolean> {
  const snapshot = store.get();
  if (!snapshot.cid || snapshot.phase !== "idle") return false;
  const cid = snapshot.cid, generation = currentRunId, url = location.href;
  const systemPrompt = snapshot.systemPrompt;
  try {
    const cached = await readVideoCache(url, cid, systemPrompt);
    if (!cached || generation !== currentRunId || store.get().cid !== cid ||
      store.get().phase !== "idle" || getVideoCachePolicy(store.get().systemPrompt) !== getVideoCachePolicy(systemPrompt) ||
      videoNavigationKey(location.href) !== videoNavigationKey(url)) return false;
    applyComplete(cached.items, cid);
    store.pushLog(`已复用上次视频分析，共 ${cached.items.length} 条弹幕`);
    return true;
  } catch {
    return false;
  }
}

async function fetchAllDanmaku(cid: number, aid: number, signal: AbortSignal) {
  const items: { text: string; time: number }[] = [];
  let complete = false;
  for (let index = 1; index <= MAX_SEGMENTS; index++) {
    checkAbort(signal);
    try {
      const { elems } = await fetchSegment(cid, aid, index, { signal });
      checkAbort(signal);
      store.pushLog(`拉取弹幕段 #${index} 成功（${elems.length} 条）`);
      if (!elems.length) { complete = true; break; }
      for (const entry of elems) {
        if (entry.text.trim()) items.push({ text: entry.text, time: Math.round(entry.progress / 1000) });
      }
      store.patch({ totalCount: items.length });
    } catch (error) {
      checkAbort(signal);
      store.pushLog(`弹幕拉取未完成：${error instanceof Error ? error.message : String(error)}；本次不写入视频缓存`);
      break;
    }
  }
  return { items, complete };
}

export async function analyzeEpisode(
  opts: { mode?: "auto" | "manual"; resumeOnDone?: boolean; force?: boolean } = {},
): Promise<{ ok: boolean; error?: string }> {
  currentAbort?.abort();
  const abort = new AbortController();
  currentAbort = abort;
  const runId = ++currentRunId;
  const url = location.href;
  // 整轮分析固定提示词，避免中途编辑造成不同批次混用或缓存错误归属。
  const systemPrompt = store.get().systemPrompt;
  const mode = opts.mode ?? store.get().mode;
  const resume = opts.resumeOnDone ?? store.get().resumeOnDone;
  const active = () => runId === currentRunId && !abort.signal.aborted &&
    videoNavigationKey(location.href) === videoNavigationKey(url);
  const guard = () => {
    checkAbort(abort.signal);
    if (!active()) throw new DOMException("视频已切换", "AbortError");
  };
  store.patch({ phase: "analyzing", errorMsg: "" });
  try {
    const info = await readEpisodeInfo();
    guard();
    if (!info?.cid) throw new Error("无法读取当前视频 cid");
    const { cid, aid, title, cover, danmakuCount } = info;
    store.resetForEpisode(cid, aid, title, cover, danmakuCount);
    store.patch({ mode, phase: "analyzing" });
    store.pushLog(`开始分析：${title || "当前视频"}（cid=${cid}）`);

    if (!opts.force) {
      let cached = null;
      try { cached = await readVideoCache(url, cid, systemPrompt); } catch { /* 缓存不可用不阻止新分析。 */ }
      guard();
      if (cached) {
        applyComplete(cached.items, cid);
        store.pushLog(`已复用上次视频分析，共 ${cached.items.length} 条弹幕`);
        return { ok: true };
      }
    }
    if (!store.get().apiKey.trim()) throw new Error("请先填写 Jev API Key");
    if (mode === "auto") {
      await controlPlayback("pause");
      guard();
    }
    store.pushLog("正在拉取完整弹幕数据…");
    const source = await fetchAllDanmaku(cid, aid, abort.signal);
    guard();
    const settings = store.get();
    store.patch({ totalCount: source.items.length });
    store.pushLog(`开始分析弹幕概率：每批最多 ${settings.batchSize} 条，并发 ${settings.concurrency}`);
    const result = await classifyTexts(source.items, {
      apiKey: settings.apiKey, hideThreshold: settings.hideThreshold,
      requestTimeoutSeconds: settings.requestTimeoutSeconds,
      systemPrompt,
    }, {
      signal: abort.signal, batchSize: settings.batchSize, concurrency: settings.concurrency,
      onDeduplicate: (before, after) => {
        if (active()) store.pushLog(`发送前文本去重：${before} → ${after} 条`);
      },
      onRetry: (batchIndex, { attempt, delayMs, status }) => {
        if (active()) store.pushLog(`批次 #${batchIndex} HTTP ${status}，等待 ${(delayMs / 1000).toFixed(1)} 秒后重试（${attempt}/2）`);
      },
      onBatchComplete: ({ batchIndex, completedBatches, totalBatches, requestCount, done, total, elapsedMs, usage }) => {
        if (active()) store.pushLog(
          `批次 #${batchIndex}：分析 ${requestCount} 条，耗时 ${(elapsedMs / 1000).toFixed(2)} 秒；` +
          `已完成 ${completedBatches}/${totalBatches} 批，总进度 ${done}/${total}；输入 ${usage.inputTokens} tokens`,
        );
      },
      onProgress: (done, total, items) => {
        if (!active()) return;
        store.setAnalysis(items ?? [], true);
        store.patch({ analyzedCount: done, totalCount: total, progress: total ? done / total : 1 });
      },
    });
    guard();
    applyComplete(result.items, cid);
    store.pushLog(`概率分析完成：${result.items.length} 条弹幕；输入 ${result.usage.inputTokens} tokens`);
    if (source.complete) {
      try {
        await writeVideoCache({
          url: canonicalVideoUrl(url), cid, policy: getVideoCachePolicy(systemPrompt),
          completedAt: Date.now(), items: result.items,
        });
      } catch {
        if (active()) store.pushLog("视频缓存保存失败，本次分析结果仍然有效");
      }
    } else {
      store.pushLog("弹幕源不完整，未更新上一次视频缓存");
    }
    guard();
    if (mode === "auto" && resume) await controlPlayback("play");
    return { ok: true };
  } catch (error) {
    if (runId !== currentRunId) return { ok: false, error: "已停止或切换视频" };
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof DOMException && error.name === "AbortError") {
      store.patch({ phase: "idle", analysisItems: [], progress: 0, analyzedCount: 0, handledEp: null });
    } else {
      store.pushLog(`出错：${message}`);
      store.patch({ phase: "error", errorMsg: message });
    }
    if (mode === "auto" && resume && active()) await controlPlayback("play");
    return { ok: false, error: message };
  } finally {
    if (currentAbort === abort) currentAbort = null;
  }
}

export async function runOnce(trigger: "manual" | "auto", force = false): Promise<void> {
  await analyzeEpisode({ mode: trigger, resumeOnDone: trigger === "auto", force });
}

export function stop(resumePlayback = true): void {
  const running = currentAbort !== null;
  currentAbort?.abort();
  currentAbort = null;
  currentRunId++;
  if (running) {
    store.patch({ phase: "idle", handledEp: null, analysisItems: [], progress: 0, analyzedCount: 0, totalCount: 0, errorMsg: "" });
    store.pushLog("已停止分析");
    if (resumePlayback && store.get().mode === "auto") void controlPlayback("play");
  }
}

export async function reset(): Promise<void> {
  stop(false);
  store.patch({ handledEp: null, phase: "idle", analysisItems: [], progress: 0, analyzedCount: 0, totalCount: 0 });
}
