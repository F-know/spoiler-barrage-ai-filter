import type {
  AnalysisCacheClearPayload,
  AnalysisCacheReadPayload,
  ErrorPayload,
  ExtensionRequest,
  HttpResponsePayload,
  MainWorldOperation,
  VideoAnalysisEntries,
} from "./messages";

const pendingRequests = new Map<string, AbortController>();

const DATABASE_NAME = "spoiler-barrage-ai-filter";
const DATABASE_VERSION = 1;
const CACHE_STORE_NAME = "video-analysis-cache";
const LEGACY_CACHE_KEY = "dmRiskCache_v4";

type VideoAnalysisRecord = {
  videoKey: string;
  entries: VideoAnalysisEntries;
  lastAccessed: number;
};

type LegacyVideoCache = {
  order: string[];
  map: Record<string, VideoAnalysisEntries>;
};

let databasePromise: Promise<IDBDatabase> | null = null;
let migrationPromise: Promise<void> | null = null;

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
      if (!database.objectStoreNames.contains(CACHE_STORE_NAME)) {
        database.createObjectStore(CACHE_STORE_NAME, { keyPath: "videoKey" });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
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

function isLegacyCache(value: unknown): value is LegacyVideoCache {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LegacyVideoCache>;
  return Array.isArray(candidate.order) && !!candidate.map && typeof candidate.map === "object";
}

/** 将旧版 chrome.storage.local 大对象一次性迁入扩展自己的 IndexedDB。 */
async function migrateLegacyCache(): Promise<void> {
  const stored = await chrome.storage.local.get(LEGACY_CACHE_KEY);
  const legacy = stored[LEGACY_CACHE_KEY];
  if (!isLegacyCache(legacy)) return;

  const orderedKeys = [
    ...legacy.order.filter((key) => typeof key === "string" && key in legacy.map),
    ...Object.keys(legacy.map).filter((key) => !legacy.order.includes(key)),
  ];
  const uniqueKeys = [...new Set(orderedKeys)];
  const database = await openDatabase();
  const transaction = database.transaction(CACHE_STORE_NAME, "readwrite");
  const store = transaction.objectStore(CACHE_STORE_NAME);
  const now = Date.now();
  uniqueKeys.forEach((videoKey, index) => {
    const entries = legacy.map[videoKey];
    if (!entries || typeof entries !== "object") return;
    store.put({
      videoKey,
      entries,
      lastAccessed: now - uniqueKeys.length + index,
    } satisfies VideoAnalysisRecord);
  });
  await transactionComplete(transaction);
  await chrome.storage.local.remove(LEGACY_CACHE_KEY);
}

async function ensureLegacyCacheMigrated(): Promise<void> {
  if (!migrationPromise) {
    migrationPromise = migrateLegacyCache().catch((error) => {
      console.warn("[剧透弹幕AI过滤器] 旧分析缓存迁移失败，保留旧数据", error);
    });
  }
  await migrationPromise;
}

async function readAnalysisCache(videoKey: string): Promise<AnalysisCacheReadPayload> {
  await ensureLegacyCacheMigrated();
  const database = await openDatabase();
  const transaction = database.transaction(CACHE_STORE_NAME, "readwrite");
  const store = transaction.objectStore(CACHE_STORE_NAME);
  const record = await requestResult(
    store.get(videoKey) as IDBRequest<VideoAnalysisRecord | undefined>,
  );
  if (record) {
    record.lastAccessed = Date.now();
    store.put(record);
  }
  await transactionComplete(transaction);
  return {
    ok: true,
    found: !!record,
    entries: record?.entries ?? {},
  };
}

async function writeAnalysisCache(
  videoKey: string,
  entries: VideoAnalysisEntries,
  maxVideos: number,
): Promise<{ ok: true }> {
  await ensureLegacyCacheMigrated();
  const database = await openDatabase();
  const transaction = database.transaction(CACHE_STORE_NAME, "readwrite");
  const store = transaction.objectStore(CACHE_STORE_NAME);
  store.put({ videoKey, entries, lastAccessed: Date.now() } satisfies VideoAnalysisRecord);

  const records = await requestResult(
    store.getAll() as IDBRequest<VideoAnalysisRecord[]>,
  );
  const limit = Math.max(1, Math.floor(maxVideos) || 3);
  records
    .sort((a, b) => b.lastAccessed - a.lastAccessed)
    .slice(limit)
    .forEach((record) => store.delete(record.videoKey));
  await transactionComplete(transaction);
  return { ok: true };
}

async function clearAnalysisCache(): Promise<AnalysisCacheClearPayload> {
  await ensureLegacyCacheMigrated();
  const database = await openDatabase();
  const transaction = database.transaction(CACHE_STORE_NAME, "readwrite");
  const store = transaction.objectStore(CACHE_STORE_NAME);
  const count = await requestResult(store.count());
  store.clear();
  await transactionComplete(transaction);
  return { ok: true, count };
}

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

  if (message.type === "analysis-cache-read") {
    void readAnalysisCache(message.videoKey).catch(errorPayload).then(sendResponse);
    return true;
  }

  if (message.type === "analysis-cache-write") {
    void writeAnalysisCache(message.videoKey, message.entries, message.maxVideos)
      .catch(errorPayload)
      .then(sendResponse);
    return true;
  }

  if (message.type === "analysis-cache-clear") {
    void clearAnalysisCache().catch(errorPayload).then(sendResponse);
    return true;
  }

  return false;
});
