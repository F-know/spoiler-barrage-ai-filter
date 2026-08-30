import type {
  AnalysisCacheClearPayload,
  AnalysisCacheReadPayload,
  ErrorPayload,
  VideoAnalysisEntries,
} from "./messages";

function makeRemoteError(payload: ErrorPayload): Error {
  const error = new Error(payload.errorMessage);
  error.name = payload.errorName || "Error";
  return error;
}

async function sendCacheMessage<T>(message: object): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

/** 读取单个视频的分析结果。null 表示该视频尚未缓存。 */
export async function readVideoAnalysisCache(
  videoKey: string,
): Promise<VideoAnalysisEntries | null> {
  const payload = await sendCacheMessage<AnalysisCacheReadPayload | ErrorPayload>({
    type: "analysis-cache-read",
    videoKey,
  });
  if (!payload.ok) throw makeRemoteError(payload);
  return payload.found ? payload.entries : null;
}

/** 写入单个视频的分析结果，并由后台按最近使用顺序淘汰旧视频。 */
export async function writeVideoAnalysisCache(
  videoKey: string,
  entries: VideoAnalysisEntries,
  maxVideos: number,
): Promise<void> {
  const payload = await sendCacheMessage<{ ok: true } | ErrorPayload>({
    type: "analysis-cache-write",
    videoKey,
    entries,
    maxVideos,
  });
  if (!payload.ok) throw makeRemoteError(payload);
}

/** 清空所有视频分析结果，返回被删除的视频数量。 */
export async function clearVideoAnalysisCache(): Promise<number> {
  const payload = await sendCacheMessage<AnalysisCacheClearPayload | ErrorPayload>({
    type: "analysis-cache-clear",
  });
  if (!payload.ok) throw makeRemoteError(payload);
  return payload.count;
}
