/** Fixed-height window: retain only visible rows and a small scrolling buffer. */
export function detailWindow(count: number, scrollTop: number, viewportHeight: number, rowHeight = 76) {
  const start = Math.max(0, Math.min(Math.floor(scrollTop / rowHeight), Math.max(0, count - 1)) - 5);
  const end = Math.min(count, start + Math.ceil(viewportHeight / rowHeight) + 10);
  return { start, end };
}

/** Other state changes must not move the log reader's position. */
export function shouldFollowLogs(previous: string[], next: string[], box: {
  scrollHeight: number; scrollTop: number; clientHeight: number;
} | null): boolean {
  return previous !== next && !!box && box.scrollHeight - box.scrollTop - box.clientHeight < 24;
}
