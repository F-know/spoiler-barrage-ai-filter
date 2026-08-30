export type MainWorldOperation = "control-playback" | "seek" | "read-episode-info";

export type VideoAnalysisEntries = Record<string, boolean>;

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
      type: "analysis-cache-read";
      videoKey: string;
    }
  | {
      type: "analysis-cache-write";
      videoKey: string;
      entries: VideoAnalysisEntries;
      maxVideos: number;
    }
  | {
      type: "analysis-cache-clear";
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
  found: boolean;
  entries: VideoAnalysisEntries;
};

export type AnalysisCacheClearPayload = {
  ok: true;
  count: number;
};
