/** Jev Decisions 专用配置，不接受聊天模型的生成参数。 */
export const JEV_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
export const JEV_MODEL = "typesafe/jev-1.13";
export const DEFAULT_REQUEST_TIMEOUT_SECONDS = 120;
export const DEFAULT_BATCH_SIZE = 1000;
export const MAX_BATCH_SIZE = 1000;
export const DEFAULT_CONCURRENCY = 10;
export const MAX_CONCURRENCY = 16;
export const DEFAULT_HIDE_THRESHOLD = 0.7;

export type JevConfig = { apiKey: string; requestTimeoutSeconds: number; hideThreshold: number; systemPrompt?: string };

/** 将用户输入规约为正整数秒；无效值回退到默认值。 */
export function normalizeRequestTimeoutSeconds(value: unknown): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_REQUEST_TIMEOUT_SECONDS;
  return Math.min(600, Math.max(1, Math.floor(seconds)));
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
