// 通用 AI(OpenAI 兼容接口)剧透风险分类服务。
// 一次性把一批弹幕文本交给 AI,要求它只依据单条文本判定风险(有/无)，
// 返回 JSON。响应字段为 risk: true|false(不再区分低/中/高,也不再返回原因)。

import {
  clearVideoAnalysisCache,
  readVideoAnalysisCache,
  writeVideoAnalysisCache,
} from "../extension/analysis-cache";
import {
  DEFAULT_EXTRA_REQUEST_PARAMS,
  DEFAULT_REQUEST_TIMEOUT_SECONDS,
  normalizeRequestTimeoutSeconds,
  parseExtraRequestParams,
} from "./api-config";

export type ClassifiedDm = {
  text: string;
  risk: boolean;
  /** 该条弹幕出现的秒数(用于按"每条弹幕条目"区分/对齐;同文本不同时间的条目各自独立) */
  time?: number;
};

/** 送给 AI 分类的单条弹幕:原文 + 出现时间(秒)。不去重、按时间排序。 */
export type DanmakuInput = {
  text: string;
  time: number;
};

/** 把用户填的 baseURL 规约成完整的 chat/completions 地址。
    OpenAI 兼容接口:baseURL 形如 https://api.openai.com/v1,需拼 /chat/completions；
    若用户已填完整地址(含 chat/completions)则原样使用。 */
export function buildChatUrl(baseUrl: string): string {
  const b = (baseUrl || "").trim().replace(/\/+$/, "");
  if (!b) return "";
  if (/\/chat\/completions\/?$/i.test(b)) return b;
  return b + "/chat/completions";
}

/** 单视频的条目级判定缓存:key 由 text+time 组成(entryKey 生成),value 为 risk。 */
type VideoEntryCache = Record<string, boolean>;

/** 生成"弹幕条目"缓存 key:用不可见分隔符拼接文本+出现秒,避免不同 text/time 组合碰撞。 */
function entryKey(d: { text: string; time: number }): string {
  return d.text + "\u0000" + d.time;
}

async function loadVideoCache(videoKey: string): Promise<VideoEntryCache | null> {
  try {
    return await readVideoAnalysisCache(videoKey);
  } catch {
    // 缓存不可用时继续分析，不影响核心过滤流程。
    return null;
  }
}

async function saveVideoCache(
  videoKey: string,
  entries: VideoEntryCache,
  maxVideos: number,
): Promise<void> {
  try {
    await writeVideoAnalysisCache(videoKey, entries, maxVideos);
  } catch {
    // 缓存写入失败不影响本次分析结果。
  }
}

/**
 * 把一个视频页 url 规约成"去掉 query/锚点"的干净 key。
 * 例如 https://www.bilibili.com/video/BV1De8d6HExa/?spm=...&vd_source=...
 *    -> https://www.bilibili.com/video/BV1De8d6HExa
 * https://www.bilibili.com/bangumi/play/ep373933?spm=...
 *    -> https://www.bilibili.com/bangumi/play/ep373933
 * 保证同一视频的不同带参 url 不会被视为两个视频。
 */
export function cleanVideoKey(url: string): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url.split(/[?#]/)[0] || url;
  }
}

const SYSTEM_PROMPT = `你是一个B站剧透弹幕AI过滤器，用于过滤掉那些涉及视频剧情的剧透弹幕。
你需要对给定的每一条弹幕文本判断它是否存在剧透风险。

输出:只输出一个 JSON 对象，不要任何额外文字。格式：
{"items":[{"text":"弹幕原文","risk":true|false}]}
items 必须覆盖我给出的每一条弹幕，text 必须与原文完全一致。`;
export type ClassifyResult = {
  items: ClassifiedDm[];
  /** 是否命中了已有视频缓存 */
  fromCache: boolean;
  usage?: { prompt_tokens: number; completion_tokens: number };
};

export type OpenAIConfig = {
  /** OpenAI 兼容接口 baseURL(不含 /chat/completions,请求时拼接) */
  url: string;
  /** 模型名 */
  model: string;
  /** API Key */
  apiKey: string;
  /** 合并进请求体的自定义 JSON 对象文本。 */
  extraRequestParams?: string;
  /** 正式分析与接口测试共用的单次请求超时时间（秒）。 */
  requestTimeoutSeconds?: number;
};

/**
 * 把一组弹幕(含出现时间)送去 OpenAI 兼容接口分类。
 * 用户要求:发 AI 前不去重、按时间排序,并携带该弹幕出现的时间;
 * 同时把视频标题放到【用户】提示词里作为辅助上下文(而非系统提示词)。
 * 请求优先通过扩展后台转发，以支持用户配置的跨域 OpenAI 兼容接口；
 * 后台不可用时回退到页面原生 fetch。
 */
export async function classifyTexts(
  danmaku: DanmakuInput[],
  config: OpenAIConfig,
  opts: {
    /** 视频标题,放入用户提示词辅助 AI 判断 */
    title?: string;
    signal?: AbortSignal;
    /** 视频缓存 key(规约后的干净 url)。传了才做按视频缓存;不传则跳过缓存。 */
    cacheKey?: string;
    /** 命中缓存时回调(报告命中条数) */
    onCache?: (hit: number) => void;
    /** 每完成一批回调一次,报告已处理条数/总条数以及本批分类结果 */
    onProgress?: (done: number, total: number, batchItems?: ClassifiedDm[]) => void;
    /** 单次请求处理的弹幕条数(默认 100) */
    batchSize?: number;
    /** 请求并发数(默认 500) */
    concurrency?: number;
    /** 缓存分析结果的近期视频数量(默认 3) */
    cacheVideoCount?: number;
  } = {},
): Promise<ClassifyResult> {
  // 按出现时间排序(用户要求发 AI 前按时间顺序排好)。
  const sorted = [...danmaku].sort((a, b) => a.time - b.time);
  if (sorted.length === 0) return { items: [], fromCache: false };

  // ---- 按视频缓存(粗粒度):该视频此前跑过,则整体复用上次 AI 结果,不再调 AI ----
  let cachedByEntry: VideoEntryCache | null = null;
  let videoRan = false;
  if (opts.cacheKey) {
    const cached = await loadVideoCache(opts.cacheKey);
    videoRan = cached !== null;
    cachedByEntry = cached ?? {};
  }

  const totalEntries = sorted.length;

  // 粗粒度命中:已有该视频缓存 -> 直接应用上次 AI 结果,
  // 不理会是否存在新弹幕/弹幕变化,绝不重新调用 AI。
  if (videoRan && cachedByEntry) {
    // 全程不去重:按每条弹幕条目(text+time)逐条返回判定,
    // 同文本的重复刷屏条目各自独立返回,不合并同类文本。
    // 当前批量弹幕与上次缓存集可能略有出入(弹幕源每次抓取有几条差异):
    // 对本页这次抓到的、但缓存里没有的条目,按"拿不准均判有风险"兜底为 true,
    // 保证 有风险+无风险 === 弹幕总数(仍不调用 AI)。
    const cachedItems: ClassifiedDm[] = [];
    for (const d of sorted) {
      const r = cachedByEntry[entryKey(d)];
      cachedItems.push({ text: d.text, risk: r === undefined ? true : r, time: d.time });
    }
    if (opts.onCache) opts.onCache(totalEntries);
    if (opts.onProgress) opts.onProgress(totalEntries, totalEntries);
    return { items: cachedItems, fromCache: true };
  }

  // 首次跑该视频:逐条判定。每个条目(text+time)独立处理,不做任何文本级去重。
  // 已被本地预过滤/缓存的条目直接得结论;其余(含重复文本)进 AI 待发送,保留出现时间。
  const items: ClassifiedDm[] = [];
  const pending: DanmakuInput[] = [];
  let cacheHit = 0;
  let preDone = 0;
  for (const d of sorted) {
    const key = entryKey(d);
    const cached = cachedByEntry ? cachedByEntry[key] : undefined;
    if (cached !== undefined) {
      items.push({ text: d.text, risk: cached, time: d.time });
      cacheHit++;
      preDone++;
      continue;
    }
    if (shouldSkipLocally(d.text)) {
      items.push({ text: d.text, risk: false, time: d.time });
      preDone++;
      continue;
    }
    // 需要 AI:该条目(以及同文本的其它时间条目)都进待发送列表,保留时间(不去重)。
    pending.push(d);
  }
  if (opts.onCache) opts.onCache(cacheHit);
  if (opts.onProgress) opts.onProgress(preDone, totalEntries);

  if (pending.length === 0) {
    if (opts.cacheKey && cachedByEntry) {
      // 全部命中(或本地判定),写回该视频的条目缓存并落盘
      const merged: VideoEntryCache = { ...cachedByEntry };
      for (const it of items) merged[entryKey({ text: it.text, time: it.time ?? 0 })] = it.risk;
      await saveVideoCache(opts.cacheKey, merged, opts.cacheVideoCount ?? 3);
    }
    return { items, fromCache: cacheHit > 0 };
  }

  // 在创建并发批次前先校验，避免无效配置触发多条重复失败的请求。
  parseExtraRequestParams(config.extraRequestParams ?? DEFAULT_EXTRA_REQUEST_PARAMS);

  // 2. 分批调用(每批上限,避免一次塞太多)
  // 单次请求最多分析 BATCH 条弹幕,防止模型输出超过 token 上限被截断。
  // 并发拉到 CONCURRENCY,超出账户级并发上限会返回 HTTP 429。
  const BATCH = Math.max(1, Math.floor(opts.batchSize || 100));
  const CONCURRENCY = Math.max(1, Math.floor(opts.concurrency || 500));
  const newItems: ClassifiedDm[] = [];
  let doneCount = preDone;
  // 并发分片:一次并发发 CONCURRENCY 个批次,串行推进窗口
  const batches: DanmakuInput[][] = [];
  for (let i = 0; i < pending.length; i += BATCH) {
    batches.push(pending.slice(i, i + BATCH));
  }
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const window = batches.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      window.map((b) =>
        callChatModel(b, config, { signal: opts.signal, title: opts.title }),
      ),
    );
    for (let j = 0; j < window.length; j++) {
      const batchItems = results[j] || [];
      newItems.push(...batchItems);
      doneCount += window[j].length;
      if (opts.onProgress) opts.onProgress(doneCount, totalEntries, batchItems);
    }
  }

  // 合并缓存/本地判定 + 本次新分类结果,写回该视频的条目缓存(按 text+time 逐条,不去重)。
  // 注意:本地预过滤判无风险的条目也要写回缓存并计入 finalItems,
  // 否则 risky+safe < 弹幕总数,导致三个数字口径不一致。
  const finalVerdict: VideoEntryCache = { ...(cachedByEntry || {}) };
  for (const it of items) finalVerdict[entryKey({ text: it.text, time: it.time ?? 0 })] = it.risk;
  for (const it of newItems) if (it.text && it.risk != null) finalVerdict[entryKey({ text: it.text, time: it.time ?? 0 })] = it.risk;
  if (opts.cacheKey && cachedByEntry) {
    await saveVideoCache(opts.cacheKey, finalVerdict, opts.cacheVideoCount ?? 3);
  }
  // 全程不去重:按每条弹幕条目(text+time)逐条返回判定。
  const finalItems: ClassifiedDm[] = [];
  for (const d of sorted) {
    const r = finalVerdict[entryKey(d)];
    if (r !== undefined) finalItems.push({ text: d.text, risk: r, time: d.time });
  }
  return { items: finalItems, fromCache: cacheHit > 0 };
}

/** 本地可确定的"无剧透风险"弹幕,无需调用 AI */
function shouldSkipLocally(text: string): boolean {
  const s = text.trim();
  if (!s) return true;
  // 纯符号/纯表情/纯数字(≤4字符)
  if (/^[^\p{L}\p{N}]{1,4}$/u.test(s)) return true;
  // 纯数字
  if (/^[\d\s]{1,4}$/.test(s)) return true;
  const bare = s.replace(/[^\p{L}]/gu, "").toLowerCase();
  // 去掉标点后不足 2 个汉字的超短弹幕
  if (bare.length <= 1) return true;
  // 纯重复字(哈哈哈/啊啊啊/啦啦啦)且字符种类极少
  if (/^(.+?)\1+$/.test(s) && new Set(bare).size <= 2) return true;
  // 纯字母刷屏
  if (/^[a-zA-Z]{3,6}$/.test(s)) return true;
  // 某些超短常用词直接判无风险
  if (/^(哈哈|嘿嘿|呵呵|嘻嘻|草|啊|哦|嗯|6|666|好|中|对|行的|可以|确实)[!！。.~～]*$/.test(s)) return true;
  return false;
}

async function callChatModel(
  danmaku: DanmakuInput[],
  config: OpenAIConfig,
  opts: { signal?: AbortSignal; title?: string } = {},
): Promise<ClassifiedDm[]> {
  // 用户提示词:带视频标题 + 按时间顺序排列的弹幕文本(仅文本,不传时间;仍不去重)。
  // 时间仅用于本批内部的排序,不提供给 AI(用户要求):AI 只按文本判断剧透风险。
  const lines = danmaku.map((d) => d.text);
  const userContent = `视频标题:${opts?.title?.trim() || "未知"}
以下是该视频按出现时间排序的全部弹幕(未去重):
${lines.join("\n")}`;
  const extraRequestParams = parseExtraRequestParams(
    config.extraRequestParams ?? DEFAULT_EXTRA_REQUEST_PARAMS,
  );
  const body = {
    model: config.model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
    response_format: { type: "json_object" },
    temperature: 0.1,
    ...extraRequestParams,
  };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
  };
  const params: RequestInit = {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: opts.signal,
  };
  const url = buildChatUrl(config.url);
  const modelLabel = config.model;

  let txt: string;
  let status = 0;
  const timeoutSeconds = normalizeRequestTimeoutSeconds(
    config.requestTimeoutSeconds ?? DEFAULT_REQUEST_TIMEOUT_SECONDS,
  );
  const timeoutMs = timeoutSeconds * 1000;
  // 给可能启用思考模式的模型留出足够时间，同时避免单次请求永久挂起。
  const perCall = new AbortController();
  const perTimer = LFRuntime.timeout(() => perCall.abort(), timeoutMs);
  const mergeSignal = opts.signal ? AbortSignal.any([opts.signal, perCall.signal]) : perCall.signal;
  try {
    const res = await LFHttp.request(url, { ...params, signal: mergeSignal, throwOnHTTPError: false });
    status = res.status;
    txt = await res.text();
  } catch (e: any) {
    // 扩展后台请求不可用时回退原生 fetch。
    if (opts.signal?.aborted) throw e;
    if (perCall.signal.aborted) {
      throw new Error(`${modelLabel} 请求超时（超过 ${timeoutSeconds} 秒）`);
    }
    try {
      const resp = await fetch(url, { ...params, signal: mergeSignal });
      status = resp.status;
      txt = await resp.text();
    } catch (e2: any) {
      if (opts.signal?.aborted) throw e2;
      if (perCall.signal.aborted) {
        throw new Error(`${modelLabel} 请求超时（超过 ${timeoutSeconds} 秒）`);
      }
      throw new Error(`${modelLabel} 请求失败: ` + (e2?.message || String(e2)));
    }
  } finally {
    LFRuntime.clearTimeout?.(perTimer);
  }

  if (status !== 200) {
    const errText = txt.slice(0, 300);
    const err = new Error(`${modelLabel} ${status}: ${errText}`);
    (err as any).status = status;
    throw err;
  }

  const data = JSON.parse(txt);
  const content =
    data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? "";
  if (!content) {
    throw new Error(`${config.model} 返回为空 content`);
  }
  // 尽力从模型输出中恢复出合法的 JSON 对象,而不是直接把整段 content 当作 JSON。
  // 优先级:原文直接解析 -> 去掉 ```json 代码块 -> 截取第一个 { 到最后一个 } 之间的片段。
  let parsed: any = tryParseJson(content);
  if (parsed === undefined) {
    // 去掉 ``` 代码块标记后再解析
    const block = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (block) parsed = tryParseJson(block[1]);
  }
  if (parsed === undefined) {
    // 截取第一个 { (或 [) 到最后一个 } (或 ]) 之间的片段(处理轻微截断)
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start >= 0 && end > start) {
      parsed = tryParseJson(content.slice(start, end + 1));
    }
  }
  if (parsed === undefined) {
    if (LFRuntime.liveDebug) {
      LFRuntime.print(
        `[剧透诊断] finish_reason=${data?.choices?.[0]?.finish_reason} content_len=${content.length} usage=${JSON.stringify(data?.usage)}`,
      );
      LFRuntime.print(`[剧透诊断] content_head=${JSON.stringify(content.slice(0, 120))}`);
      LFRuntime.print(`[剧透诊断] content_tail=${JSON.stringify(content.slice(-200))}`);
    }
  }
  const rawItems: any[] = Array.isArray(parsed) ? parsed : parsed?.items ?? [];
  let result: ClassifiedDm[] = [];
  if (parsed === undefined) {
    // 三级兜底:逐条正则提取 {"text":...,"risk":...} 片段。risk 既可能是字符串
    // ("true"/"false" 亦可能是布尔 true/false),text 也可能含特殊字符导致整体解析失败。
    // 能捞回多少就算多少(跳过损坏项),绝不因此中断整场过滤。
    result = extractItemsRobustly(content);
    // 不抛错:即便整批都捞不回(极端截断),也交给下游按"拿不准=有风险"兜底,
    // 保证该批每一条都有判定, 有风险+无风险 === 弹幕总数,且不中断整场过滤。
    // 诊断信息已在上面 parsed===undefined 分支里打印(content_head/tail)。
    // 返回遗漏属正常现象、无伤大雅,不做记录。
  } else {
    for (const it of rawItems) {
      const text = String(it?.text ?? "").trim();
      const risk = normalizeRisk(it?.risk);
      if (text && risk != null) result.push({ text, risk });
    }
  }
  // AI 返回的 items 只含 text+risk(不带 time)。这里按 text 建立 risk 映射,
  // 再遍历【本批的每一条弹幕条目】(danmaku 含 time),逐条赋值并保留出现时间。
  // 同文本重复刷屏条目共享同一 risk(同一文本的剧透判定一致),但每条都带自己的 time,
  // 从而实现"逐条弹幕条目不去重"。
  // 注意:无论走正常 JSON 解析还是 extractItemsRobustly 兜底,都必须补上 time,
  // 否则缓存/最终集合里会以 time=0 作为 key,导致该条在 finalItems 中被丢弃,
  // 使 risky+safe < 弹幕总数。
  const riskByText = new Map<string, boolean>();
  for (const it of result) riskByText.set(it.text, it.risk);
  const enriched: ClassifiedDm[] = [];
  for (const d of danmaku) {
    const r = riskByText.get(d.text);
    // AI 偶发漏返某条(少返回/正则没捞回)时,按系统提示词"拿不准均判有风险"兜底为 true。
    // 否则该条不进缓存/finalItems,导致 有风险+无风险 < 弹幕总数,数字不自洽。
    enriched.push({ text: d.text, risk: r === undefined ? true : r, time: d.time });
  }
  return enriched;
}

/** 尝试把字符串解析成 JSON;失败返回 undefined,不抛错 */
function tryParseJson(s: string): any {
  try {
    return JSON.parse(s.trim());
  } catch {
    return undefined;
  }
}

/**
 * 三级兜底解析:从模型输出中逐条正则提取 {"text":...,"risk":...} 片段。
 * 模型有时会对个别含特殊字符(未转义双引号/控制字符/代理对)的弹幕转义不当,
 * 导致整体 JSON.parse 失败。这里用宽容的正则逐条捞回可解析的条目,跳过损坏项。
 */
function extractItemsRobustly(content: string): ClassifiedDm[] {
  const out: ClassifiedDm[] = [];
  // 匹配 { "text": "值", "risk": 值 } 对象;text/risk 顺序与键名均容错。
  // risk 既可以是带引号的字符串("true"/"false"),也可以是布尔字面量 true/false。
  // 捕获组 1=text,2=risk(含引号或布尔),逐个尝试独立解析。
  const re =
    /\{\s*"text"\s*:\s*("(?:\\.|[^"\\])*")\s*,\s*"risk"\s*:\s*("(?:\\.|[^"\\])*"|true|false)\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    // 优先整体 JSON.parse 该 { ... } 片段(能处理 text 内转义字符),失败再回退到捕获组。
    const start = content.lastIndexOf("{", m.index);
    const segment = content.slice(start, re.lastIndex);
    let text = "";
    let risk: boolean | null = null;
    try {
      const obj = JSON.parse(segment);
      text = String(obj?.text ?? "").trim();
      risk = normalizeRisk(obj?.risk);
    } catch {
      try { text = JSON.parse(m[1]); } catch { text = ""; }
      try { risk = normalizeRisk(JSON.parse(m[2])); } catch { risk = null; }
    }
    if (text && risk != null) out.push({ text, risk });
  }
  return out;
}

/** 归一化风险字段:true/false 以及字符串 "true"/"false" 均支持 */
function normalizeRisk(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "true" || s === "1" || s === "有" || s === "有风险" || s === "是") return true;
  if (s === "false" || s === "0" || s === "无" || s === "无风险" || s === "否") return false;
  return null;
}

/**
 * 清空全部按视频分类缓存(设置面板"清空分析缓存"按钮调用)。
 * 返回本次清空的视频数量(>=0);清空失败/环境不支持时仍返回 0。
 */
export async function clearCache(): Promise<number> {
  try {
    return await clearVideoAnalysisCache();
  } catch {
    // 缓存不可用时保持设置面板可操作。
    return 0;
  }
}

/** 测试 API 连接是否可用（设置面板"测试"按钮）。
    发送一个最小的 chat/completions 请求:校验 baseURL/模型/Key 都能正常工作。
    成功返回 { ok:true };失败返回 { ok:false, code, message }。
    code 优先为 HTTP 状态码(如 401/429),网络/超时等返回其错误名。 */
export type ApiTestResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export async function testApi(config: OpenAIConfig): Promise<ApiTestResult> {
  const url = buildChatUrl(config.url);
  if (!url || !config.model || !config.apiKey) {
    return { ok: false, code: "Incomplete", message: "请先填写接口地址/模型名称/API Key" };
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
  };
  let extraRequestParams: Record<string, unknown>;
  try {
    extraRequestParams = parseExtraRequestParams(
      config.extraRequestParams ?? DEFAULT_EXTRA_REQUEST_PARAMS,
    );
  } catch (error) {
    return {
      ok: false,
      code: "InvalidExtraParams",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const body = {
    model: config.model,
    messages: [
      { role: "system", content: "你是测试助手。" },
      { role: "user", content: "你好，请回复OK" },
    ],
    temperature: 0,
    ...extraRequestParams,
  };
  const timeoutSeconds = normalizeRequestTimeoutSeconds(
    config.requestTimeoutSeconds ?? DEFAULT_REQUEST_TIMEOUT_SECONDS,
  );
  const perCall = new AbortController();
  const perTimer = LFRuntime.timeout(() => perCall.abort(), timeoutSeconds * 1000);
  let txt = "";
  let status = 0;
  try {
    const res = await LFHttp.request(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: perCall.signal,
      throwOnHTTPError: false,
    });
    status = res.status;
    txt = await res.text();
  } catch (e: any) {
    // 扩展后台请求不可用时回退原生 fetch。
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: perCall.signal,
      });
      status = resp.status;
      txt = await resp.text();
    } catch (e2: any) {
      if (perCall.signal.aborted) {
        return { ok: false, code: "TimeOut", message: `请求超时（超过 ${timeoutSeconds} 秒）` };
      }
      const name = e2?.name || "NetworkError";
      return { ok: false, code: name, message: e2?.message || String(e2) };
    }
  } finally {
    LFRuntime.clearTimeout?.(perTimer);
  }

  if (status === 0) return { ok: false, code: "Network", message: txt || "网络错误" };
  if (status !== 200) {
    return { ok: false, code: String(status), message: txt.slice(0, 200) || `HTTP ${status}` };
  }
  // 校验响应里确实有模型输出(避免"200 但空响应"被误判成功)
  let data: any = null;
  try { data = JSON.parse(txt); } catch { /* ignore */ }
  const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? "";
  if (!content) return { ok: false, code: "EmptyContent", message: "接口返回为空内容" };
  return { ok: true };
}
