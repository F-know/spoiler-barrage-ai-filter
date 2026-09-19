/** Fixed-height window: retain only visible rows and a small scrolling buffer. */
export function detailWindow(count: number, scrollTop: number, viewportHeight: number, rowHeight = 76) {
  const start = Math.max(0, Math.min(Math.floor(scrollTop / rowHeight), Math.max(0, count - 1)) - 5);
  const end = Math.min(count, start + Math.ceil(viewportHeight / rowHeight) + 10);
  return { start, end };
}

/** Prefix offsets include the trailing gap; binary search also handles very tall rows. */
export function rowAtOffset(offsets: number[], position: number): number {
  let low = 0;
  let high = Math.max(0, offsets.length - 2);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (offsets[middle] <= position) low = middle;
    else high = middle - 1;
  }
  return low;
}

export function variableDetailWindow(offsets: number[], top: number, height: number) {
  const count = offsets.length - 1;
  return {
    start: Math.max(0, rowAtOffset(offsets, top) - 5),
    end: Math.min(count, rowAtOffset(offsets, top + height) + 6),
  };
}

/** Other state changes must not move the log reader's position. */
export function shouldFollowLogs(previous: string[], next: string[], box: {
  scrollHeight: number; scrollTop: number; clientHeight: number;
} | null): boolean {
  return previous !== next && !!box && box.scrollHeight - box.scrollTop - box.clientHeight < 24;
}
