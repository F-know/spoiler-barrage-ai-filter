// 编排器:驱动整个"分析→分类→拦截→(自动)恢复播放"流程。
// 它监听 SPA 内的视频切换(通过播放器 / 页面状态),对每个新集执行:
//   auto: 暂停 -> 取全部弹幕 -> AI 分类 -> 登记拦截 -> 恢复播放
//   manual: 等待用户在 UI 触发,同样流程但不自动暂停/恢复
// 支持:通过 store.pushLog 向 UI 输出详细运行日志;通过 stop() 中止当前分析。

import { classifyTexts, cleanVideoKey, type DanmakuInput } from "./classify";
import { fetchSegment } from "./bilibili";
import { store, controlPlayback, readEpisodeInfo } from "./state";

const MAX_SEGMENTS = 100;

// 当前一次分析的可中止句柄(供 stop 调用)
let currentAbort: AbortController | null = null;
// 分析代际令牌:每启动一轮过滤自增;旧协程被新一轮取代后不再允许写 store,
// 避免"上一轮被停止的协程在后台延迟触发 catch,覆盖新一轮过滤状态"的竞态。
let currentRunId = 0;

/**
 * 读取当前视频的【全量】弹幕。
 * 直接逐段拉取 seg.so(覆盖整个视频的每个时段),保证任一时刻的弹幕都能被分类/屏蔽。
 */
async function fetchAllDanmaku(
  cid: number,
  aid: number,
  signal?: AbortSignal,
): Promise<{ texts: string[]; progressData: { text: string; progress: number }[]; src?: string; maxStime?: number }> {
  const all: { text: string; progress: number }[] = [];
  const textsMap = new Map<string, number>();
  let maxStime = 0;
  let segs = 0;
  for (let idx = 1; idx <= MAX_SEGMENTS; idx++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const { elems } = await fetchSegment(cid, aid, idx, { signal });
      segs++;
      store.pushLog(`拉取弹幕段 #${idx} 成功(${elems.length} 条)`);
      if (elems.length === 0) break;
      for (const e of elems) {
        if (!e.text.trim()) continue;
        if (e.progress > maxStime) maxStime = e.progress;
        all.push({ text: e.text, progress: e.progress });
        textsMap.set(e.text, e.progress);
      }
      // 每获取到一段,立即把"当前已累计的弹幕总数"写进 store,
      // 让面板上的弹幕总数在拉取过程中就实时往上加(带动效),而非等全部结束一次性展示。
      store.patch({ totalCount: all.length });
    } catch (e: any) {
      // 用户主动中止
      if (signal?.aborted) throw e;
      // 某段拉取失败(越界/被限)即停止,已拉到的段即为全量
      store.pushLog(`弹幕段 #${idx} 拉取结束(${e?.message || "到达边界"})`);
      break;
    }
  }
  return {
    texts: Array.from(textsMap.keys()),
    progressData: all,
    src: "seg-so",
    maxStime,
  };
}

/** 核心:分析一集弹幕。会更新 store 状态并输出日志。 */
export async function analyzeEpisode(
  opts: { mode?: "auto" | "manual"; resumeOnDone?: boolean } = {},
): Promise<{ ok: boolean; error?: string }> {
  const info = await readEpisodeInfo();
  if (!info || !info.cid) {
    store.pushLog("无法读取当前视频 cid,已终止");
    store.patch({ phase: "error", errorMsg: "无法读取当前视频 cid" });
    return { ok: false, error: "无法读取当前视频 cid" };
  }
  const { cid, aid, title, cover, danmakuCount } = info;
  const epKey = `${cid}`;
  // 以"去掉 query 后的当前页 url"作为视频缓存 key,用于按视频命中缓存。
  const videoKey = cleanVideoKey((typeof window !== "undefined" && window.location && window.location.href) || "");

  // 同一集已处理过则直接恢复/跳过(除非用户强制)
  if (store.get().handledEp === epKey && store.get().phase === "done") {
    store.pushLog("本集已处理过,跳过重复分析");
    if (opts.mode === "auto" && opts.resumeOnDone) await controlPlayback("play");
    return { ok: true };
  }

  const mode = opts.mode || store.get().mode || "manual";
  const resume = opts.resumeOnDone ?? store.get().resumeOnDone;

  store.resetForEpisode(cid, aid, title, cover, danmakuCount);
  store.patch({ mode, handledEp: epKey, phase: mode === "auto" ? "paused" : "analyzing" });

  const abort = new AbortController();
  currentAbort = abort;
  const signal = abort.signal;
  // 本轮的代际令牌:每个协程捕获启动时的 runId,之后只有在它仍是"最新一轮"时才允许写 store。
  const runId = ++currentRunId;

  store.pushLog(`开始过滤:${title || "本集"}(cid=${cid}${aid ? ", aid=" + aid : ""})`);
  store.pushLog(`模式:${mode === "auto" ? "自动(暂停→分析→恢复播放)" : "手动"}`);

  // 自动模式:先暂停
  if (mode === "auto") {
    store.pushLog("自动模式:先暂停播放…");
    await controlPlayback("pause");
    store.patch({ phase: "paused" });
  }

  try {
    // 1. 取弹幕
    store.patch({ phase: "analyzing", totalCount: 0 });
    store.pushLog("正在拉取完整弹幕数据…");
    const dm = await fetchAllDanmaku(cid, aid, signal);
    // 发给 AI 的弹幕:不去重、按时间排序、带出现时间(毫秒 -> 秒)。
    const danmakuInput: DanmakuInput[] = dm.progressData.map((p) => ({
      text: p.text,
      time: Math.round(p.progress / 1000),
    }));
    const totalDm = danmakuInput.length;
    store.patch({ totalCount: totalDm, analyzedCount: 0 });
    store.pushLog(
      `弹幕源=${dm.src ?? "seg-so"} 总条数=${totalDm} 覆盖时长≈${Math.round((dm.maxStime ?? 0) / 1000)}秒`,
    );
    if (LFRuntime.liveDebug) {
      LFRuntime.print(
        `[剧透] 弹幕源=${dm.src ?? "seg-so"} 总条数=${totalDm} 覆盖时长≈${Math.round((dm.maxStime ?? 0) / 1000)}秒`,
      );
    }

    if (totalDm === 0) {
      // 代际守卫:若已被新一轮接管则不再写 done。
      if (runId === currentRunId) {
        store.pushLog("没有可分析的弹幕,直接完成");
        store.patch({ phase: "done", progress: 1 });
        if (mode === "auto" && resume) await controlPlayback("play");
      }
      return { ok: true };
    }

    // 2. AI 分类:从 store 读取 OpenAI 兼容配置(url/model/apiKey)
    const s = store.get();
    const aiConfig = {
      url: s.apiUrl,
      model: s.apiModel,
      apiKey: s.apiKey,
    };
    const riskMap: Record<string, boolean> = {};
    const classifiedAcc: Record<string, { text: string; risk: boolean }> = {};
    const result = await classifyTexts(danmakuInput, aiConfig, {
      title,
      signal,
      cacheKey: videoKey || undefined,
      batchSize: s.batchSize,
      concurrency: s.concurrency,
      cacheVideoCount: s.cacheVideoCount,
      onCache: (hit) => { if (hit) store.pushLog(`命中缓存 ${hit} 条`); },
      onProgress: (done, total, batchItems) => {
        // 代际守卫:本协程已被新一轮取代时,不再写 store(否则会覆盖新一轮进度)。
        if (runId !== currentRunId) return;
        // 每批分类结果立即登记:让拦截器边分析边屏蔽。key 用 trim 后的文本,
        // 与 store.shouldHide 查询的 text.trim() 保持一致,避免带首尾空白的文本漏屏蔽。
        for (const it of (batchItems || [])) {
          const key = it.text.trim();
          riskMap[key] = it.risk;
          classifiedAcc[key] = { text: key, risk: it.risk };
        }
        store.setShouldHide((text) => riskMap[text.trim()] ?? riskMap[text] ?? undefined);
        store.patch({
          classified: { ...(store.get().classified as any), ...classifiedAcc } as any,
        });
        store.patch({ analyzedCount: done, totalCount: total, progress: total > 0 ? done / total : 1 });
      },
    });

    // 停止守卫:即使底层请求未被及时取消、classifyTexts 仍正常返回,
    // 若用户已点击停止(signal 已被 abort),则不得再把状态写回 done。
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    // 3. 登记到 state + 注册 shouldHide(拦截用),用完整 result.items。
    // key 统一用 trim 后的文本,与 store.shouldHide 查询的 text.trim() 保持一致。
    const finalClassified: Record<string, { text: string; risk: boolean }> = {};
    for (const it of result.items) {
      const key = it.text.trim();
      riskMap[key] = it.risk;
      finalClassified[key] = { text: key, risk: it.risk };
    }
    store.setShouldHide((text) => riskMap[text.trim()] ?? riskMap[text] ?? undefined);
    const filteredDm: { text: string; time: number }[] = [];
    // 全程不去重:按 result.items 的每条弹幕条目(text+time)独立记录。
    // result.items 现在自带 time,每条重复刷屏条目都进详情(不再合并同类文本)。
    for (const it of result.items) {
      if (it.risk) {
        filteredDm.push({ text: it.text.trim(), time: it.time ?? 0 });
      }
    }
    // 统计风险分布
    let risky = 0, safe = 0;
    for (const it of result.items) {
      if (it.risk) risky++;
      else safe++;
    }
    // 代际守卫:本协程已被新一轮接管时,不允许把状态写成 done(否则覆盖新一轮)。
    if (runId !== currentRunId) {
      return { ok: false, error: "已被新一轮取代" };
    }
    store.pushLog(`分类完成:有风险 ${risky} / 无风险 ${safe}`);
    store.pushLog(`已注册屏蔽规则(有风险弹幕将强制屏蔽)`);
    store.patch({
      classified: finalClassified as any,
      analyzedCount: totalDm,
      progress: 1,
      phase: "done",
      filteredDm,
    });
    // 4. 自动模式恢复播放
    if (mode === "auto" && resume) {
      store.pushLog("自动模式:恢复播放");
      await controlPlayback("play");
    }
    store.pushLog("本次过滤完成 ✔");
    return { ok: true };
  } catch (e: any) {
    // 代际守卫:本协程启动后若有新一轮过滤接管(被用户停止后又快速重新开始),
    // 则它的延迟 catch 不得再写 store(否则会覆盖新一轮 analyzing 状态)。
    if (runId !== currentRunId) {
      return { ok: false, error: "已被新一轮取代" };
    }
    if (signal?.aborted) {
      store.pushLog("已手动停止过滤");
      store.patch({
        phase: "idle",
        handledEp: null,
        classified: {},
        progress: 0,
        analyzedCount: 0,
        totalCount: 0,
        filteredDm: [],
        errorMsg: "",
      });
      if (mode === "auto") await controlPlayback("play");
      return { ok: false, error: "已停止" };
    }
    store.pushLog(`出错:${e?.message || String(e)}`);
    store.patch({ phase: "error", errorMsg: e?.message || String(e) });
    // 出错时自动恢复播放,避免卡住
    if (mode === "auto" && resume) await controlPlayback("play");
    return { ok: false, error: e?.message || String(e) };
  } finally {
    if (currentAbort === abort) currentAbort = null;
  }
}

/** 触发一次"处理当前视频"(由 UI 手动/自动按钮调用) */
export async function runOnce(trigger: "manual" | "auto"): Promise<void> {
  if (trigger === "auto") {
    await analyzeEpisode({ mode: "auto", resumeOnDone: true });
  } else {
    await analyzeEpisode({ mode: "manual", resumeOnDone: false });
  }
}

/** 停止当前分析(UI"停止"按钮)。无可中止任务时静默。 */
export function stop(): void {
  if (currentAbort) currentAbort.abort();
  // 立即复位 UI,使"停止"即时生效(即使底层请求未及时传播 AbortSignal)。
  // 否则一旦底层 fetch 卡住/未传播 abort,界面会一直停留在"过滤中"。
  const s = store.get();
  if (s.phase !== "idle" && s.phase !== "done" && s.phase !== "error") {
    store.patch({
      phase: "idle",
      handledEp: null,
      classified: {},
      progress: 0,
      analyzedCount: 0,
      totalCount: 0,
      filteredDm: [],
      errorMsg: "",
    });
  }
}

/** 复位(清空当前集已处理标记,让下次可重跑) */
export async function reset(): Promise<void> {
  store.patch({ handledEp: null, phase: "idle", classified: {}, progress: 0, analyzedCount: 0, totalCount: 0 });
}

