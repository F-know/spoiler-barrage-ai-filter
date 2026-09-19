export type MainWorldOperation = "control-playback" | "seek" | "read-episode-info";

import type { ScoredDanmaku } from '../services/probability';

export type VideoAnalysisRecord = {
  url: string;
  cid: number;
  policy: string;
  completedAt: number;
  items: ScoredDanmaku[];
};

export type ExtensionRequest =
  | {
      type: "lf-http-request";
      requestId: string;
      url: string;
      init: SerializableRequestInit;
    }
  | {
      type: "lf-http-abort";
      requestId: string;
    }
  | {
      type: "lf-main-world";
      operation: MainWorldOperation;
      args: unknown[];
    }
  | {
      type: "video-analysis-cache-read" | "video-analysis-cache-status";
    }
  | {
      type: "video-analysis-cache-write";
      record: VideoAnalysisRecord;
    }
  | {
      type: "video-analysis-cache-clear";
    };

export type SerializableRequestInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  credentials?: RequestCredentials;
  cache?: RequestCache;
  redirect?: RequestRedirect;
  referrerPolicy?: ReferrerPolicy;
};

export type HttpResponsePayload = {
  ok: true;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
};

export type ErrorPayload = {
  ok: false;
  errorName: string;
  errorMessage: string;
};

export type AnalysisCacheReadPayload = {
  ok: true;
  record: VideoAnalysisRecord | null;
};

export type AnalysisCacheClearPayload = {
  ok: true;
  count: number;
};
