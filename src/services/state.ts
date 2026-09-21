// 插件核心状态:模式(自动/手动)、播放器控制、弹幕分类结果、拦截注册。
// 这个单例对象驱动 UI 和拦截逻辑,并提供跨模块的响应式状态。

import { segUrl, fetchViewDanmakuCount, formatCount } from "./bilibili";
import { DEFAULT_SYSTEM_PROMPT, normalizeSystemPrompt } from "./prompts";
import type { ScoredDanmaku } from "./probability";
import {
  DEFAULT_BATCH_SIZE, DEFAULT_CONCURRENCY, DEFAULT_HIDE_THRESHOLD,
  normalizeConnection, type ApiConnection,
  normalizeBatchSize, normalizeConcurrency, normalizeHideThreshold,
  optionalRequestTimeout,
} from "./api-config";

/** Jev 配置单独保存，不继承旧模型的 Key、参数或高并发值。 */
const API_CFG_KEY = "dmJevConfig_v1";
const PANEL_VISIBLE_KEY = "panelVisible_v1";

export type Mode = "auto" | "manual";

type PersistedConfig = ApiConnection & {
  baseUrl?: string;
  apiKey?: string;
  systemPrompt?: string;
  hideThreshold?: number;
  requestTimeoutSeconds?: number | null;
  batchSize?: number;
  concurrency?: number;
  replaceText?: string;
  mode?: Mode;
};
export type Phase =
  | "idle"        // 未处理
  | "paused"      // 自动模式:已暂停等待分析
  | "analyzing"   // AI 分析中
  | "done"        // 本集处理完成
  | "error";      // 出错

/** 一条被过滤(屏蔽)的弹幕及其在视频中的出现时间(秒) */
export type FilteredDm = {
  text: string;
  time: number;
};

export type SpoilState = Required<ApiConnection> & {
  mode: Mode;
  phase: Phase;
  cid: number | null;
  aid: number | null;
  title: string;
  /** 当前视频封面 URL */
  cover: string;
  /** 当前视频弹幕数量(展示用) */
  danmakuCount: string;
  /** 全部原始弹幕的分析概率，包含重复条目和时间。 */
  analysisItems: ScoredDanmaku[];
  /** 自动模式是否开启"处理完自动播放" */
  resumeOnDone: boolean;
  /** API Key */
  apiKey: string;
  baseUrl: string;
  systemPrompt: string;
  hideThreshold: number;
  /** 正式分析与接口测试共用的单次请求超时时间（秒）。 */
  requestTimeoutSeconds: number | null;
  /** 单次请求处理的弹幕数量(默认 1000) */
  batchSize: number;
  /** 请求并发数(默认 10) */
  concurrency: number;
  /** 剧透弹幕替换文本(默认 <已屏蔽>) */
  replaceText: string;
  /** 进度:已分析条数 / 总数 */
  analyzedCount: number;
  totalCount: number;
  errorMsg: string;
  /** 本集是否已被本插件拦截过(避免重复拦截同一集) */
  handledEp: string | null;
  /** 用 0~1 表示处理进度 */
  progress: number;
  /** 运行日志(点击开始过滤后逐条追加,供 UI 日志框显示) */
  logs: string[];
  /** 被过滤的弹幕列表(含出现时间,秒) */
  filteredDm: FilteredDm[];
  /** 拦截开关:为 true 时新弹幕仍会被屏蔽;点击"恢复"后置 false,后续新弹幕不再屏蔽 */
  interceptEnabled: boolean;
};

function defaultState(): SpoilState {
  return {
    mode: "manual",
    phase: "idle",
    cid: null,
    aid: null,
    title: "",
    cover: "",
    danmakuCount: "",
    analysisItems: [],
    resumeOnDone: true,
    ...normalizeConnection(),
    apiKey: "",
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    hideThreshold: DEFAULT_HIDE_THRESHOLD,
    requestTimeoutSeconds: null,
    batchSize: DEFAULT_BATCH_SIZE,
    concurrency: DEFAULT_CONCURRENCY,
    replaceText: "<已屏蔽>",
    analyzedCount: 0,
    totalCount: 0,
    errorMsg: "",
    handledEp: null,
    progress: 0,
    logs: [],
    filteredDm: [],
    interceptEnabled: true,
  };
}

class StateStore {
  private state: SpoilState = defaultState();
  private listeners = new Set<(s: SpoilState) => void>();
  private probabilities = new Map<string, number>();

  get(): SpoilState {
    return this.state;
  }

  subscribe(fn: (s: SpoilState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn(this.state);
  }

  /** 合并更新状态(浅合并),然后通知 UI */
  patch(p: Partial<SpoilState>) {
    Object.assign(this.state, p);
    if (p.analysisItems !== undefined) {
      this.probabilities = new Map(p.analysisItems.map(item => [item.text.trim(), item.probability]));
    }
    if (p.analysisItems !== undefined || p.hideThreshold !== undefined || p.interceptEnabled !== undefined) {
      this.state.filteredDm = this.state.interceptEnabled
        ? this.state.analysisItems.filter(item => item.probability >= this.state.hideThreshold)
        : [];
    }
    this.emit();
  }

  setThreshold(value: unknown) {
    this.patch({ hideThreshold: normalizeHideThreshold(value) });
  }

  setAnalysis(items: ScoredDanmaku[], append = false) {
    this.patch({ analysisItems: append ? [...this.state.analysisItems, ...items] : items });
  }

  /** 追加一条带时间戳的运行日志并通知 UI */
  pushLog(line: string) {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const ts = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    this.state.logs = [...this.state.logs, `[${ts}] ${line}`];
    this.emit();
  }

  resetForEpisode(cid: number, aid: number, title: string, cover: string, danmakuCount: string) {
    this.probabilities.clear();
    this.state = {
      ...defaultState(),
      cid,
      aid,
      title,
      cover,
      danmakuCount,
      apiKey: this.state.apiKey,
      ...normalizeConnection(this.state),
      systemPrompt: this.state.systemPrompt,
      hideThreshold: this.state.hideThreshold,
      requestTimeoutSeconds: this.state.requestTimeoutSeconds,
      batchSize: this.state.batchSize,
      concurrency: this.state.concurrency,
      replaceText: this.state.replaceText,
      mode: this.state.mode,
      resumeOnDone: this.state.resumeOnDone,
    };
    this.emit();
  }

  /**
   * 当 SPA 内 URL 规约 key 变化(切到另一个视频/集,页面未整体跳转)时,
   * 重置整个面板的运行态:清空分类结果/过滤列表/日志/进度/拦截判定,
   * 恢复 idle 空状态,并让拦截不再命中旧视频的 shouldHide。
   * 保留 mode/apiKey/resumeOnDone 等用户偏好。
   */
  resetForUrlChange() {
    this.state = {
      ...defaultState(),
      apiKey: this.state.apiKey,
      ...normalizeConnection(this.state),
      systemPrompt: this.state.systemPrompt,
      hideThreshold: this.state.hideThreshold,
      requestTimeoutSeconds: this.state.requestTimeoutSeconds,
      batchSize: this.state.batchSize,
      concurrency: this.state.concurrency,
      replaceText: this.state.replaceText,
      mode: this.state.mode,
      resumeOnDone: this.state.resumeOnDone,
    };
    // 清空拦截判定,避免拦截器继续用旧视频的 risk 结果屏蔽新视频弹幕。
    this.probabilities.clear();
    this.emit();
  }

  /** 持久化 Jev 配置和功能参数。 */
  async saveApiConfig(cfg: ApiConnection & {
    baseUrl?: string;
    apiKey: string;
    systemPrompt?: string;
    hideThreshold: number;
    requestTimeoutSeconds: number | null;
    batchSize: number;
    concurrency: number;
    replaceText: string;
  }): Promise<void> {
    try {
      await LFStore.set(API_CFG_KEY, {
        apiKey: cfg.apiKey,
        ...normalizeConnection({ ...this.state, ...cfg }),
        systemPrompt: normalizeSystemPrompt(cfg.systemPrompt ?? this.state.systemPrompt),
        hideThreshold: cfg.hideThreshold,
        requestTimeoutSeconds: cfg.requestTimeoutSeconds,
        batchSize: cfg.batchSize,
        concurrency: cfg.concurrency,
        replaceText: cfg.replaceText,
        mode: this.state.mode,
      });
    } catch {
      // 环境不支持存储时静默,仍保留内存态
    }
  }

  /** 切换并持久化自动/手动模式，不覆盖已有 API 配置。 */
  async setMode(mode: Mode): Promise<void> {
    this.patch({ mode });
    try {
      const saved = await LFStore.get<PersistedConfig | null>(API_CFG_KEY, null);
      await LFStore.set(API_CFG_KEY, {
        ...(saved && typeof saved === "object" ? saved : {}),
        mode,
      });
    } catch {
      // 持久化失败时仍保留本次会话的内存状态。
    }
  }

  /** 启动时加载已保存的接口配置，并覆盖内存中的默认值。 */
  async loadApiConfig(): Promise<Required<ApiConnection> & {
    baseUrl: string;
    apiKey: string;
    systemPrompt: string;
    hideThreshold: number;
    requestTimeoutSeconds: number | null;
    batchSize: number;
    concurrency: number;
    replaceText: string;
    mode: Mode;
  } | null> {
    try {
      const v = await LFStore.get<PersistedConfig | null>(API_CFG_KEY, null);
      if (v && typeof v === "object") {
        const cfg = {
          apiKey: v.apiKey ?? "",
          ...normalizeConnection(v),
          systemPrompt: normalizeSystemPrompt(v.systemPrompt),
          hideThreshold: normalizeHideThreshold(v.hideThreshold),
          requestTimeoutSeconds: optionalRequestTimeout(v.requestTimeoutSeconds),
          batchSize: normalizeBatchSize(v.batchSize),
          concurrency: normalizeConcurrency(v.concurrency),
          replaceText: v.replaceText ?? "<已屏蔽>",
          mode: v.mode === "auto" ? "auto" as const : "manual" as const,
        };
        this.patch(cfg);
        return cfg;
      }
    } catch {
      // 读取失败忽略
    }
    return null;
  }

  /** 判断是否应屏蔽一条弹幕(拦截器实际用到的唯一决策) */
  shouldHide(text: string): boolean {
    // 拦截开关:用户在完成态点击"恢复"后,后续新出现的弹幕不再屏蔽。
    if (!this.state.interceptEnabled) return false;
    const probability = this.probabilities.get(text.trim());
    return probability !== undefined && probability >= this.state.hideThreshold;
  }
}

export const store = new StateStore();

/** 播放器控制工具:播放/暂停/是否在播放。通过 window.player 访问。 */
export function getPlayer(): any {
  // USER_SCRIPT world 里读不到 page 源的 window.player,这里返回 null,
  // 由调用方用 LFRuntime.runInMainWorld 去 MAIN world 读。
  return null;
}

/** 通过 LFRuntime.runInMainWorld 读取播放器状态并控制播放/暂停。 */
export async function controlPlayback(action: "pause" | "play"): Promise<void> {
  try {
    await LFRuntime.runInMainWorld(
      (act: string) => {
        const p = (window as any).player;
        if (!p) return "no-player";
        if (act === "pause") p.pause();
        else if (act === "play") p.play();
        return "ok";
      },
      { args: [action] },
    );
  } catch (e: any) {
    // runInMainWorld 失败时静默,不做二次 fallback
  }
}

/** 跳转到视频指定时间(秒)。通过 window.player.seek 访问。 */
export async function seekTo(seconds: number): Promise<void> {
  try {
    await LFRuntime.runInMainWorld(
      (sec: number) => {
        const p = (window as any).player;
        if (!p) return "no-player";
        if (typeof p.seek === "function") {
          p.seek(sec);
          return "ok";
        }
        // 兼容性兜底:部分版本暴露 setCurrentTime
        if (typeof p.setCurrentTime === "function") {
          p.setCurrentTime(sec);
          return "ok";
        }
        return "no-seek";
      },
      { args: [seconds] },
    );
  } catch (e: any) {
    // 静默
  }
}

/** 读取当前视频的 cid/aid/标题/封面/弹幕数(页面自取或 MAIN bridge)。 */
export async function readEpisodeInfo(): Promise<{
  cid: number; aid: number; title: string; cover: string; danmakuCount: string;
} | null> {
  try {
    const info = await LFRuntime.runInMainWorld(
      () => {
        const doc = document as any;
        // 封面:优先 og:image,其次初始化状态里的 pic
        const ogImage = (doc.querySelector('meta[property="og:image"]') as any)?.content;
        // 标题:优先 og:title,其次 document.title
        const ogTitle = (doc.querySelector('meta[property="og:title"]') as any)?.content;
        const fallbackTitle = ogTitle || doc.title || "";
        const p = (window as any).player;
        // 播放器 getManifest() 是最可靠的 cid/aid 来源
        if (p && typeof p.getManifest === "function") {
          try {
            const m = p.getManifest();
            if (m && m.cid) {
              return {
                cid: Number(m.cid),
                aid: m.aid ? Number(m.aid) : 0,
                title: fallbackTitle,
                cover: ogImage ? String(ogImage).replace(/^http:/, "https:") : "",
                danmakuCount: "",
              };
            }
          } catch {
            // fall through
          }
        }
        const s = (window as any).__INITIAL_STATE__;
        const ep = s && (s.epInfo || (s.h1 && s.h1.epInfo));
        const vd = s && s.videoData;
        // 视频页:当前视频弹幕数 = videoData.stat.danmaku
        const vdDanmaku = vd && vd.stat && typeof vd.stat.danmaku === "number" ? vd.stat.danmaku : null;
        if (vd && vd.cid) {
          return {
            cid: Number(vd.cid),
            aid: vd.aid ? Number(vd.aid) : 0,
            title: (vd.title || fallbackTitle || "") as string,
            cover: (vd.pic || ogImage || "") as string,
            danmakuCount: vdDanmaku != null ? formatCount(vdDanmaku) : "",
          };
        }
        if (ep && ep.cid) {
          return {
            cid: Number(ep.cid),
            aid: ep.aid ? Number(ep.aid) : 0,
            title: (ep.title || ep.long_title || fallbackTitle || "") as string,
            cover: (ep.pic || ogImage || "") as string,
            danmakuCount: "",
          };
        }
        return null;
      },
    );
    if (info && info.cid) {
      // 弹幕数兜底:视频页已从 INITIAL 拿到;视频/番剧页若为空,用 x/web-interface/view 接口取当前集
      if (!info.danmakuCount && info.aid) {
        const viaApi = await fetchViewDanmakuCount(info.aid);
        if (viaApi) info.danmakuCount = viaApi;
      }
      return info as any;
    }
  } catch (e) {
    // ignore
  }
  return null;
}

/** 当前弹幕引擎是否活跃(用于决定拦截是否生效) */
export function isDanmakuActive(): boolean {
  const p = getPlayer();
  if (!p) return false;
  try {
    const d = p.danmaku;
    if (!d) return false;
    const open = typeof d.isOpen === "function" ? d.isOpen() : true;
    const disabled = typeof d.isDisabled === "function" ? d.isDisabled() : false;
    return open && !disabled;
  } catch {
    return true;
  }
}

export { segUrl };

// ---- 面板显隐 + 光标锚点 ----
// 面板最小化后,鼠标指针可能落到 B站播放器视频区(该区域 cursor:none,静止时隐藏系统光标),
// 导致"点击最小化后鼠标消失、动一下才回来"。这里在隐藏面板时,于按钮附近插入一个透明的
// cursor:default 锚点接管指针,让光标始终可见;显示面板时清理该锚点。
const CURSOR_ANCHOR_ID = "lf-spoiler-cursor-anchor";
let hidePanelFrame: number | null = null;

/** 读取上次保存的面板显隐状态；首次安装默认隐藏。 */
export async function loadPanelVisibility(): Promise<boolean> {
  try {
    return (await LFStore.get<boolean>(PANEL_VISIBLE_KEY, false)) === true;
  } catch {
    return false;
  }
}

function savePanelVisibility(visible: boolean): void {
  void LFStore.set(PANEL_VISIBLE_KEY, visible).catch(() => {
    // 存储不可用时仅影响跨页面记忆，不影响本次显隐操作。
  });
}

function ensureCursorAnchor(x: number, y: number): void {
  let anchor = document.getElementById(CURSOR_ANCHOR_ID);
  if (!anchor) {
    anchor = document.createElement("div");
    anchor.id = CURSOR_ANCHOR_ID;
    anchor.style.cssText =
      "position:fixed;left:" + (x - 12) + "px;top:" + (y - 12) + "px;" +
      "width:24px;height:24px;background:transparent;border:none;padding:0;margin:0;" +
      "cursor:default;z-index:2147483647;";
    document.body.appendChild(anchor);
    LFRuntime.trackNode(anchor);
  } else {
    anchor.style.left = (x - 12) + "px";
    anchor.style.top = (y - 12) + "px";
  }
}

function removeCursorAnchor(): void {
  const anchor = document.getElementById(CURSOR_ANCHOR_ID);
  if (anchor && anchor.parentNode) anchor.parentNode.removeChild(anchor);
}

/** 隐藏面板(延迟一帧,避免点击瞬间指针状态未清理),并在指针处放光标锚点。 */
export function hidePanelHost(): void {
  const host = document.getElementById("lf-spoiler-dm-root");
  if (!host) return;
  const r = host.getBoundingClientRect();
  // 锚点放在面板中央附近,接管最小化后指针落点,避免落到播放器 cursor:none 区域。
  const ax = Math.round(r.left + r.width / 2);
  const ay = Math.round(r.top + 20);
  ensureCursorAnchor(ax, ay);
  if (hidePanelFrame !== null) cancelAnimationFrame(hidePanelFrame);
  savePanelVisibility(false);
  hidePanelFrame = requestAnimationFrame(() => {
    host.style.display = "none";
    hidePanelFrame = null;
  });
}

/** 显示面板并清理光标锚点。 */
export function showPanelHost(): void {
  if (hidePanelFrame !== null) {
    cancelAnimationFrame(hidePanelFrame);
    hidePanelFrame = null;
  }
  removeCursorAnchor();
  const host = document.getElementById("lf-spoiler-dm-root");
  if (host) {
    host.style.display = "";
    savePanelVisibility(true);
  }
}
