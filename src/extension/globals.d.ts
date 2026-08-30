type LFDisposeRegistrar = (fn: () => void) => void;

declare const LFStore: {
  get<T>(key: string, fallback: T): Promise<T>;
  set<T>(key: string, value: T): Promise<void>;
};

declare const LFHttp: {
  request(
    url: string,
    init?: RequestInit & { throwOnHTTPError?: boolean },
  ): Promise<{
    status: number;
    statusText: string;
    ok: boolean;
    text(): Promise<string>;
  }>;
};

declare const LFRuntime: {
  liveDebug: boolean;
  print(...args: unknown[]): void;
  mountHot(
    id: string,
    mount: (context: { onDispose: LFDisposeRegistrar }) => void,
  ): void;
  trackNode(node: Node): void;
  runInMainWorld<T>(
    fn: (...args: any[]) => T,
    options?: { args?: unknown[] },
  ): Promise<Awaited<T>>;
  timeout(fn: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
};
