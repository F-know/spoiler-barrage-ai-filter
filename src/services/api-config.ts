/** Jev Decisions 专用配置，不接受聊天模型的生成参数。 */
export const JEV_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
export const DEFAULT_BASE_URL = "";
export const JEV_MODEL = "typesafe/jev-1.13";
export const DEFAULT_REQUEST_TIMEOUT_SECONDS = 120;
export const DEFAULT_BATCH_SIZE = 1000;
export const MAX_BATCH_SIZE = 1000;
export const DEFAULT_CONCURRENCY = 10;
export const MAX_CONCURRENCY = 16;
export const DEFAULT_HIDE_THRESHOLD = 0.7;

export type ApiConnection = {
  baseUrl?: string; model?: string;
  authHeader?: string; authPrefix?: string; extraHeaders?: string;
};
export type JevConfig = ApiConnection & { apiKey: string; requestTimeoutSeconds: number | null; hideThreshold: number; systemPrompt?: string };

export function normalizeConnection(config: ApiConnection = {}): Required<ApiConnection> {
  let baseUrl = normalizeBaseUrl(config.baseUrl);
  const legacyPath = (config as ApiConnection & { requestPath?: string }).requestPath;
  if (baseUrl && typeof legacyPath === 'string' && legacyPath.trim()) {
    try {
      const url = new URL(baseUrl);
      url.pathname = url.pathname.replace(/\/+$/, '') + '/' + legacyPath.trim().replace(/^\/+/, '');
      baseUrl = url.href;
    } catch { /* 保留原输入，由请求校验显示错误。 */ }
  }
  return {
    baseUrl,
    model: typeof config.model === 'string' ? config.model.trim() : '',
    authHeader: typeof config.authHeader === 'string' ? config.authHeader.trim() : '',
    authPrefix: typeof config.authPrefix === 'string' ? config.authPrefix.trim() : '',
    extraHeaders: typeof config.extraHeaders === 'string' ? config.extraHeaders : '',
  };
}

export function normalizeBaseUrl(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_BASE_URL;
}

/** 使用用户填写的完整请求地址，不猜测或追加服务商路径。 */
export function resolveJevApi(config: ApiConnection = {}): { endpoint: string; model: string } {
  const value = normalizeConnection(config);
  let url: URL;
  try { url = new URL(value.baseUrl); }
  catch { throw new Error("Base URL 不是有效的网址"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error("Base URL 须使用 HTTP 或 HTTPS，且不能包含账号或锚点");
  }
  if (!value.model) throw new Error("请填写 model");
  return { endpoint: url.href, model: value.model };
}

export function buildApiHeaders(config: JevConfig): Record<string, string> {
  const value = normalizeConnection(config);
  const headers = new Headers({ 'Content-Type': 'application/json' });
  // 未设置高级认证项时，填写 Key 即使用标准 Bearer 认证；无 Key 则不发送。
  if (!value.authHeader && config.apiKey.trim()) {
    try { headers.set('Authorization', [value.authPrefix || 'Bearer', config.apiKey.trim()].join(' ')); }
    catch { throw new Error('API Key 格式无效'); }
  }
  if (value.authHeader) {
    if (!config.apiKey.trim()) throw new Error('请先填写 API Key，或将认证请求头留空');
    try { headers.set(value.authHeader, [value.authPrefix, config.apiKey.trim()].filter(Boolean).join(' ')); }
    catch { throw new Error('认证请求头或 API Key 格式无效'); }
  }
  if (value.extraHeaders.trim()) {
    let extra: unknown;
    try { extra = JSON.parse(value.extraHeaders); } catch { throw new Error('额外请求头必须是 JSON 对象'); }
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error('额外请求头必须是 JSON 对象');
    for (const [name, content] of Object.entries(extra)) {
      if (typeof content !== 'string') throw new Error('额外请求头的值必须是字符串');
      if (/^(host|cookie|content-length|origin|referer|connection|proxy-|sec-)/i.test(name)) throw new Error('额外请求头包含浏览器保留字段');
      try { headers.set(name, content); } catch { throw new Error('额外请求头格式无效'); }
    }
  }
  return Object.fromEntries(headers.entries());
}

/** 将用户输入规约为正整数秒；无效值回退到默认值。 */
export function normalizeRequestTimeoutSeconds(value: unknown): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_REQUEST_TIMEOUT_SECONDS;
  return Math.min(600, Math.max(1, Math.floor(seconds)));
}

/** 输入留空时不回填默认值；发送时仍使用安全的超时兜底。 */
export function optionalRequestTimeout(value: unknown): number | null {
  return value == null || value === '' ? null : normalizeRequestTimeoutSeconds(value);
}

export function normalizeHideThreshold(value: unknown): number {
  if (value === "" || value == null) return DEFAULT_HIDE_THRESHOLD;
  const threshold = Number(value);
  return Number.isFinite(threshold) ? Math.min(1, Math.max(0, threshold)) : DEFAULT_HIDE_THRESHOLD;
}

export function normalizeBatchSize(value: unknown): number {
  return normalizeCount(value, DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE);
}

export function normalizeConcurrency(value: unknown): number {
  return normalizeCount(value, DEFAULT_CONCURRENCY, MAX_CONCURRENCY);
}

function normalizeCount(value: unknown, fallback: number, max: number): number {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.min(max, Math.max(1, Math.floor(count))) : fallback;
}
