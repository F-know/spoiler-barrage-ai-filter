export type ScoredDanmaku = { text: string; time: number; probability: number };
export type DanmakuSort = "time-asc" | "time-desc" | "probability-desc" | "probability-asc";

export function sortDanmaku(items: ScoredDanmaku[], order: DanmakuSort): ScoredDanmaku[] {
  return [...items].sort((a, b) => {
    if (order === "time-asc") return a.time - b.time;
    if (order === "time-desc") return b.time - a.time;
    const delta = order === "probability-desc" ? b.probability - a.probability : a.probability - b.probability;
    return delta || a.time - b.time;
  });
}

/** 左闭右开，最后一组包含 1；按原始弹幕条目而非去重文本统计。 */
export function probabilityHistogram(items: ScoredDanmaku[], threshold: number, enabled = true) {
  const bins = Array.from({ length: 10 }, () => ({ count: 0, hidden: 0 }));
  for (const item of items) {
    const bin = bins[Math.min(9, Math.floor(item.probability * 10))];
    bin.count++;
    if (enabled && item.probability >= threshold) bin.hidden++;
  }
  return bins;
}
