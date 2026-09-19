import type {
  AnalysisCacheClearPayload,
  AnalysisCacheReadPayload,
  ErrorPayload,
  ExtensionRequest,
  VideoAnalysisRecord,
  HttpResponsePayload,
  MainWorldOperation,
} from "./messages";

import { validVideoRecord } from "./video-cache";

const pendingRequests = new Map<string, AbortController>();

const DATABASE_NAME = "spoiler-barrage-ai-filter";
const DATABASE_VERSION = 4;
const CACHE_STORE_NAME = "last-video-analysis";
const OLD_GLOBAL_CACHE_STORE_NAME = "global-text-hash-cache";
const OLD_VIDEO_CACHE_STORE_NAME = "video-analysis-cache";
const LEGACY_CACHE_KEY = "dmRiskCache_v4";



let databasePromise: Promise<IDBDatabase> | null = null;
let legacyCleanupPromise: Promise<void> | null = null;

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (database.objectStoreNames.contains("jev-probability-cache")) database.deleteObjectStore("jev-probability-cache");
      if (database.objectStoreNames.contains(OLD_VIDEO_CACHE_STORE_NAME)) {
        database.deleteObjectStore(OLD_VIDEO_CACHE_STORE_NAME);
      }
      if (database.objectStoreNames.contains(OLD_GLOBAL_CACHE_STORE_NAME)) {
        database.deleteObjectStore(OLD_GLOBAL_CACHE_STORE_NAME);
      }
      if (!database.objectStoreNames.contains(CACHE_STORE_NAME)) {
        database.createObjectStore(CACHE_STORE_NAME);
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => { database.close(); databasePromise = null; };
      resolve(database);
    };
    request.onerror = () => reject(request.error || new Error("Unable to open analysis cache"));
    request.onblocked = () => reject(new Error("Analysis cache upgrade is blocked"));
  });
  databasePromise.catch(() => {
    databasePromise = null;
  });
  return databasePromise;
}

/** 清理旧版存储，当前缓存仅保存最后一次完成的视频分析。 */
async function ensureLegacyCacheCleaned(): Promise<void> {
  if (!legacyCleanupPromise) {
    legacyCleanupPromise = chrome.storage.local.remove(LEGACY_CACHE_KEY).catch((error) => {
      console.warn("[剧透弹幕AI过滤器] 旧视频缓存清理失败", error);
    });
  }
  await legacyCleanupPromise;
}

async function analysisCacheStatus(): Promise<{ ok: true; hasCache: boolean }> {
  const database = await openDatabase();
  const transaction = database.transaction(CACHE_STORE_NAME, "readonly");
  const [count] = await Promise.all([
    requestResult(transaction.objectStore(CACHE_STORE_NAME).count("latest")),
    transactionComplete(transaction),
  ]);
  return { ok: true, hasCache: count > 0 };
}

async function readAnalysisCache(): Promise<AnalysisCacheReadPayload> {
  const database = await openDatabase();
  const transaction = database.transaction(CACHE_STORE_NAME, "readonly");
  const completion = transactionComplete(transaction);
  const [record] = await Promise.all([
    requestResult(transaction.objectStore(CACHE_STORE_NAME).get("latest")),
    completion,
  ]);
  return { ok: true, record: validVideoRecord(record) ? record : null };
}

async function writeAnalysisCache(record: VideoAnalysisRecord): Promise<{ ok: true }> {
  if (!validVideoRecord(record)) throw new Error("视频分析结果无效");
  const database = await openDatabase();
  const transaction = database.transaction(CACHE_STORE_NAME, "readwrite");
  const completion = transactionComplete(transaction);
  const store = transaction.objectStore(CACHE_STORE_NAME);
  // 同一个键原子覆盖，永远只有一个视频；较早完成的跨标签页写入不能覆盖较新的结果。
  const previous = store.get("latest");
  previous.onsuccess = () => {
    if (!validVideoRecord(previous.result) || previous.result.completedAt <= record.completedAt) {
      store.put(record, "latest");
    }
  };
  await completion;
  return { ok: true };
}

async function clearAnalysisCache(): Promise<AnalysisCacheClearPayload> {
  const database = await openDatabase();
  const transaction = database.transaction(CACHE_STORE_NAME, "readwrite");
  const completion = transactionComplete(transaction);
  const store = transaction.objectStore(CACHE_STORE_NAME);
  const request = store.count();
  const countResult = new Promise<number>((resolve, reject) => {
    request.onsuccess = () => { store.clear(); resolve(request.result); };
    request.onerror = () => reject(request.error);
  });
  const [count] = await Promise.all([countResult, completion]);
  return { ok: true, count };
}

// 扩展升级后立即建立新缓存结构并清理旧视频缓存，不等待第一次分析请求。
void ensureLegacyCacheCleaned();
void openDatabase().catch((error) => {
  console.warn("[剧透弹幕AI过滤器] 视频缓存初始化失败", error);
});

function errorPayload(error: unknown): ErrorPayload {
  const value = error as { name?: string; message?: string } | null;
  return {
    ok: false,
    errorName: value?.name || "Error",
    errorMessage: value?.message || String(error),
  };
}

async function handleHttpRequest(
  message: Extract<ExtensionRequest, { type: "lf-http-request" }>,
): Promise<HttpResponsePayload | ErrorPayload> {
  const controller = new AbortController();
  pendingRequests.set(message.requestId, controller);
  try {
    const response = await fetch(message.url, {
      ...message.init,
      signal: controller.signal,
    });
    return {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.text(),
    };
  } catch (error) {
    return errorPayload(error);
  } finally {
    pendingRequests.delete(message.requestId);
  }
}

function executeMainWorldOperation(operation: MainWorldOperation, args: unknown[]): unknown {
  const pageWindow = window as typeof window & {
    player?: {
      pause?: () => void;
      play?: () => void;
      seek?: (seconds: number) => void;
      setCurrentTime?: (seconds: number) => void;
      getManifest?: () => { cid?: number | string; aid?: number | string } | null;
    };
    __INITIAL_STATE__?: any;
  };

  if (operation === "control-playback") {
    const player = pageWindow.player;
    if (!player) return "no-player";
    if (args[0] === "pause") player.pause?.();
    else player.play?.();
    return "ok";
  }

  if (operation === "seek") {
    const player = pageWindow.player;
    if (!player) return "no-player";
    const seconds = Number(args[0]);
    if (typeof player.seek === "function") {
      player.seek(seconds);
      return "ok";
    }
    if (typeof player.setCurrentTime === "function") {
      player.setCurrentTime(seconds);
      return "ok";
    }
    return "no-seek";
  }

  const doc = document;
  const ogImage = doc.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content;
  const ogTitle = doc.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content;
  const fallbackTitle = ogTitle || doc.title || "";
  const player = pageWindow.player;
  if (player && typeof player.getManifest === "function") {
    try {
      const manifest = player.getManifest();
      if (manifest?.cid) {
        return {
          cid: Number(manifest.cid),
          aid: manifest.aid ? Number(manifest.aid) : 0,
          title: fallbackTitle,
          cover: ogImage ? String(ogImage).replace(/^http:/, "https:") : "",
          danmakuCount: "",
        };
      }
    } catch {
      // 与原运行时保持一致，继续使用页面初始化状态兜底。
    }
  }

  const state = pageWindow.__INITIAL_STATE__;
  const episode = state && (state.epInfo || (state.h1 && state.h1.epInfo));
  const video = state && state.videoData;
  const videoDanmaku =
    video && video.stat && typeof video.stat.danmaku === "number"
      ? video.stat.danmaku
      : null;
  const formatCount = (count: number) =>
    count >= 10000 ? `${(count / 10000).toFixed(1)}万` : count.toLocaleString("en-US");

  if (video?.cid) {
    return {
      cid: Number(video.cid),
      aid: video.aid ? Number(video.aid) : 0,
      title: video.title || fallbackTitle || "",
      cover: video.pic || ogImage || "",
      danmakuCount: videoDanmaku != null ? formatCount(videoDanmaku) : "",
    };
  }
  if (episode?.cid) {
    return {
      cid: Number(episode.cid),
      aid: episode.aid ? Number(episode.aid) : 0,
      title: episode.title || episode.long_title || fallbackTitle || "",
      cover: episode.pic || ogImage || "",
      danmakuCount: "",
    };
  }
  return null;
}

async function handleMainWorldRequest(
  message: Extract<ExtensionRequest, { type: "lf-main-world" }>,
  sender: chrome.runtime.MessageSender,
): Promise<{ ok: true; result: unknown } | ErrorPayload> {
  const tabId = sender.tab?.id;
  if (tabId == null) return errorPayload(new Error("无法确定当前 B 站标签页"));
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: executeMainWorldOperation,
      args: [message.operation, message.args],
    });
    return { ok: true, result: results[0]?.result };
  } catch (error) {
    return errorPayload(error);
  }
}

chrome.runtime.onMessage.addListener((message: ExtensionRequest, sender, sendResponse) => {
  if (message.type === "lf-http-abort") {
    pendingRequests.get(message.requestId)?.abort();
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "lf-http-request") {
    void handleHttpRequest(message).then(sendResponse);
    return true;
  }

  if (message.type === "lf-main-world") {
    void handleMainWorldRequest(message, sender).then(sendResponse);
    return true;
  }

  if (message.type === "video-analysis-cache-status") {
    void analysisCacheStatus().catch(errorPayload).then(sendResponse);
    return true;
  }

  if (message.type === "video-analysis-cache-read") {
    void readAnalysisCache().catch(errorPayload).then(sendResponse);
    return true;
  }

  if (message.type === "video-analysis-cache-write") {
    void writeAnalysisCache(message.record)
      .catch(errorPayload)
      .then(sendResponse);
    return true;
  }

  if (message.type === "video-analysis-cache-clear") {
    void clearAnalysisCache().catch(errorPayload).then(sendResponse);
    return true;
  }

  return false;
});
