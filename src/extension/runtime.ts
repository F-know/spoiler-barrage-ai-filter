import type {
  ErrorPayload,
  ExtensionRequest,
  HttpResponsePayload,
  MainWorldOperation,
  SerializableRequestInit,
} from "./messages";

const trackedNodes = new Set<Node>();
const disposeCallbacks: Array<() => void> = [];
let disposed = false;

function makeRequestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function toSerializableInit(init: RequestInit): SerializableRequestInit {
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  const body = typeof init.body === "string" ? init.body : undefined;
  return {
    method: init.method,
    headers,
    body,
    credentials: init.credentials,
    cache: init.cache,
    redirect: init.redirect,
    referrerPolicy: init.referrerPolicy,
  };
}

function makeRemoteError(payload: ErrorPayload): Error {
  const error = new Error(payload.errorMessage);
  error.name = payload.errorName || "Error";
  return error;
}

async function sendMessage<T>(message: ExtensionRequest): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

const storeAdapter = {
  async get<T>(key: string, fallback: T): Promise<T> {
    const result = await chrome.storage.local.get(key);
    return Object.prototype.hasOwnProperty.call(result, key)
      ? (result[key] as T)
      : fallback;
  },

  async set<T>(key: string, value: T): Promise<void> {
    await chrome.storage.local.set({ [key]: value });
  },
};

const httpAdapter = {
  async request(
    url: string,
    init: RequestInit & { throwOnHTTPError?: boolean } = {},
  ) {
    const requestId = makeRequestId();
    const signal = init.signal;
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const abortRemote = () => {
      void sendMessage({ type: "lf-http-abort", requestId }).catch(() => undefined);
    };
    signal?.addEventListener("abort", abortRemote, { once: true });

    try {
      const payload = await sendMessage<HttpResponsePayload | ErrorPayload>({
        type: "lf-http-request",
        requestId,
        url,
        init: toSerializableInit(init),
      });
      if (!payload.ok) throw makeRemoteError(payload);
      return {
        status: payload.status,
        statusText: payload.statusText,
        ok: payload.status >= 200 && payload.status < 300,
        async text() {
          return payload.body;
        },
      };
    } finally {
      signal?.removeEventListener("abort", abortRemote);
    }
  },
};

function inferMainWorldOperation(args: unknown[]): MainWorldOperation {
  if (args.length === 0) return "read-episode-info";
  if (typeof args[0] === "string") return "control-playback";
  return "seek";
}

function dispose(): void {
  if (disposed) return;
  disposed = true;
  for (const callback of disposeCallbacks.splice(0).reverse()) {
    try {
      callback();
    } catch (error) {
      console.error("[剧透弹幕AI过滤器] 清理失败", error);
    }
  }
  for (const node of trackedNodes) {
    if (node.parentNode) node.parentNode.removeChild(node);
  }
  trackedNodes.clear();
}

const runtimeAdapter = {
  liveDebug: false,

  print(...args: unknown[]): void {
    console.log(...args);
  },

  mountHot(
    _id: string,
    mount: (context: { onDispose: LFDisposeRegistrar }) => void,
  ): void {
    mount({
      onDispose(callback) {
        disposeCallbacks.push(callback);
      },
    });
  },

  trackNode(node: Node): void {
    trackedNodes.add(node);
  },

  async runInMainWorld<T>(
    _fn: (...args: any[]) => T,
    options?: { args?: unknown[] },
  ): Promise<Awaited<T>> {
    const args = options?.args ?? [];
    const payload = await sendMessage<{ ok: true; result: Awaited<T> } | ErrorPayload>({
      type: "lf-main-world",
      operation: inferMainWorldOperation(args),
      args,
    });
    if (!payload.ok) throw makeRemoteError(payload);
    return payload.result;
  },

  timeout(fn: () => void, delay: number): ReturnType<typeof setTimeout> {
    return setTimeout(fn, delay);
  },

  clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    clearTimeout(handle);
  },
};

Object.assign(globalThis, {
  LFStore: storeAdapter,
  LFHttp: httpAdapter,
  LFRuntime: runtimeAdapter,
});

window.addEventListener("pagehide", dispose, { once: true });
