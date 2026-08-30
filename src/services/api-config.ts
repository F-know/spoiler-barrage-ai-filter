/** API 请求配置的跨模块默认值。 */
export const DEFAULT_EXTRA_REQUEST_PARAMS = '{"thinking": { "type": "disabled" }}';
export const DEFAULT_REQUEST_TIMEOUT_SECONDS = 120;

/**
 * 将设置面板中的 JSON 文本解析为可合并进请求体的普通对象。
 * 留空等同于不附加额外参数；数组、null 和基础类型不属于合法参数对象。
 */
export function parseExtraRequestParams(source: string): Record<string, unknown> {
  const text = (source || "").trim();
  if (!text) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`自定义额外参数不是合法 JSON：${message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("自定义额外参数必须是一个 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

/** 将用户输入规约为正整数秒；无效值回退到默认值。 */
export function normalizeRequestTimeoutSeconds(value: unknown): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_REQUEST_TIMEOUT_SECONDS;
  return Math.max(1, Math.floor(seconds));
}
