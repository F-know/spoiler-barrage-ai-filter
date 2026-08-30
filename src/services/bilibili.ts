// B站弹幕数据获取与"屏蔽判定"服务。
// 数据源为 https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid=<cid>&pid=<aid>&segment_index=N
// 接口返回 protobuf(DmSegMobileReply)，由内容脚本同源获取并解析。

import { parseSegments, rebuildSegment, listContents } from "./proto";

export type DmItem = {
  text: string;
  progress: number;
  mode: number;
};

/** 组装弹幕段 URL(番剧 pid=aid,类型 type=1 为普通弹幕池) */
export function segUrl(cid: number, aid: number, segmentIndex: number): string {
  return `https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid=${cid}&pid=${aid}&segment_index=${segmentIndex}`;
}

/** 从 URL 里解析当前集数的 cid / aid(由调用方传入更稳妥,这里做兜底) */
export function parseCids(url: string | undefined): { cid: number; aid: number } | null {
  if (!url) return null;
  const cidMatch = /[?&]cid=(\d+)/.exec(url);
  const aidMatch = /[?&]aid=(\d+)/.exec(url);
  if (cidMatch && aidMatch) {
    return { cid: Number(cidMatch[1]), aid: Number(aidMatch[1]) };
  }
  return null;
}

/**
 * 拉取并解析一段弹幕(页面内自取)。
 * 使用内容脚本原生 fetch，同源请求会携带 B 站 cookie。
 * 返回底层 elems 供重建。
 */
export async function fetchSegment(
  cid: number,
  aid: number,
  segmentIndex: number,
  opts: { signal?: AbortSignal } = {},
): Promise<{ elems: DmItem[]; raw: Uint8Array }> {
  const url = segUrl(cid, aid, segmentIndex);
  // cache: "no-store" 强制从源取最新,避免命中浏览器缓存返回 HTTP 304
  // (resp.ok 对 304 为 false,会被当成失败而提前中断整段拉取)。
  const params: RequestInit = { credentials: "include", signal: opts.signal, cache: "no-store" };
  // 同源请求，无需经过扩展后台转发。
  const resp = await fetch(url, params);
  if (!resp.ok) {
    // 304 = 缓存命中且未变化,内容仍可由浏览器返回,不视为失败
    if (resp.status !== 304) {
      throw new Error(`弹幕段 ${segmentIndex} 请求失败: ${resp.status}`);
    }
  }
  const buf = new Uint8Array(await resp.arrayBuffer());
  const parsed = parseSegments(buf);
  const elems = parsed.elems.map((e) => ({
    text: e.content,
    progress: e.progress,
    mode: 1,
  }));
  return { elems, raw: buf };
}

/**
 * 给定一段弹幕的原字节,以及一个风险判定函数(文本 -> boolean),
 * 返回"剔除有风险(risk=true)后"的新字节。用于拦截 seg.so 响应。
 * 无风险/拿不准(undefined)保留。
 */
export function filterSegment(
  raw: Uint8Array,
  isRisk: (text: string) => boolean | undefined,
): Uint8Array {
  const parsed = parseSegments(raw);
  const out = rebuildSegment(parsed, (content) => {
    // 内容为空或纯符号的保留(不影响观感)
    const v = isRisk(content);
    return v !== true;
  });
  return out;
}

/** 单段内所有弹幕文本(用于统计/展示) */
export function segmentTexts(raw: Uint8Array): string[] {
  return listContents(raw);
}

/** 是否需要处理(存在有风险=true 的内容需剔除) */
export function hasHigh(risks: boolean[]): boolean {
  return risks.includes(true);
}

/**
 * 通过 x/web-interface/view 接口取【当前这一视频/集】的弹幕总数(stat.danmaku)。
 * 视频页可直接读 __INITIAL_STATE__.videoData.stat.danmaku;此接口用于番剧页等
 * 页面状态里没有该字段的场景(aid 取自播放器 manifest)。返回可展示的字符串(如"142,911")。
 */
export async function fetchViewDanmakuCount(aid: number): Promise<string | null> {
  if (!aid) return null;
  try {
    const resp = await fetch(`https://api.bilibili.com/x/web-interface/view?aid=${aid}`, {
      credentials: "include",
      cache: "no-store",
    });
    if (!resp.ok) return null;
    const j: any = await resp.json();
    const n = j?.data?.stat?.danmaku;
    if (typeof n === "number") return formatCount(n);
    return null;
  } catch {
    return null;
  }
}

/** 数字格式化为带千分位/万的中文展示 */
export function formatCount(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return n.toLocaleString("en-US");
}
