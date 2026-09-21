import type { ErrorPayload, VideoAnalysisRecord } from './messages';
import { JEV_MODEL, JEV_ENDPOINT, resolveJevApi, type ApiConnection } from '../services/api-config';
import { JEV_POLICY_VERSION, JEV_QUESTION, normalizeSystemPrompt } from '../services/prompts';

/** 缓存链接不包含追踪参数、播放时间或 fragment；分 P 由 cid 区分。 */
export function canonicalVideoUrl(url: string): string {
  const parsed = new URL(url);
  return parsed.origin + parsed.pathname.replace(/\/+$/, '');
}

/** SPA 导航还需关注 p 参数，其余 query 变化不表示换视频。 */
export function videoNavigationKey(url: string): string {
  const parsed = new URL(url);
  const part = Math.max(1, Number(parsed.searchParams.get('p')) || 1);
  return `${canonicalVideoUrl(url)}?p=${part}`;
}

export function getVideoCachePolicy(systemPrompt?: string, connection: ApiConnection = { baseUrl: JEV_ENDPOINT, model: JEV_MODEL }): string {
  const api = resolveJevApi(connection);
  const policy = [JEV_MODEL, JEV_POLICY_VERSION, normalizeSystemPrompt(systemPrompt), JEV_QUESTION];
  // 原接口保持已有缓存可用；切换服务后不混用结果。
  if (api.endpoint !== JEV_ENDPOINT || api.model !== JEV_MODEL) policy.push(api.endpoint, api.model);
  return JSON.stringify(policy);
}
export const VIDEO_CACHE_POLICY = getVideoCachePolicy();

export function validVideoRecord(value: unknown): value is VideoAnalysisRecord {
  const record = value as VideoAnalysisRecord | null;
  return !!record && typeof record.url === 'string' &&
    Number.isSafeInteger(record.cid) && record.cid > 0 &&
    typeof record.policy === 'string' && Number.isFinite(record.completedAt) &&
    Array.isArray(record.items) && record.items.every(item =>
      typeof item?.text === 'string' && Number.isFinite(item.time) && item.time >= 0 &&
      typeof item.probability === 'number' && Number.isFinite(item.probability) &&
      item.probability >= 0 && item.probability <= 1);
}

function checked<T extends { ok: boolean }>(payload: T | ErrorPayload): T {
  if (!payload.ok) throw new Error((payload as ErrorPayload).errorMessage);
  return payload as T;
}

export async function readVideoCache(url: string, cid: number, systemPrompt?: string, connection?: ApiConnection): Promise<VideoAnalysisRecord | null> {
  const payload = checked<{ ok: true; record: unknown }>(await chrome.runtime.sendMessage({ type: 'video-analysis-cache-read' }));
  const record = payload.record;
  if (!validVideoRecord(record) || record.policy !== getVideoCachePolicy(systemPrompt, connection) ||
    record.cid !== cid || record.url !== canonicalVideoUrl(url)) return null;
  return record;
}

export async function writeVideoCache(record: VideoAnalysisRecord): Promise<void> {
  if (!validVideoRecord(record)) throw new Error('视频分析结果无效');
  checked(await chrome.runtime.sendMessage({ type: 'video-analysis-cache-write', record }));
}

export async function clearVideoCache(): Promise<number> {
  const payload = checked<{ ok: true; count: number }>(await chrome.runtime.sendMessage({ type: 'video-analysis-cache-clear' }));
  return payload.count;
}

/** 仅检查键是否存在，避免为按钮状态传输整份弹幕缓存。 */
export async function hasVideoCache(): Promise<boolean> {
  const payload = checked<{ ok: true; hasCache: boolean }>(await chrome.runtime.sendMessage({ type: 'video-analysis-cache-status' }));
  return payload.hasCache;
}
