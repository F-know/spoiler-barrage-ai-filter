// 弹幕屏蔽层:DOM 层拦截。
// 实测:B站新版番剧播放器(video-page-v2)把弹幕渲染成 DOM 元素
//   · 滚动弹幕容器: .bpx-player-row-dm-wrap 等
//   · 每条弹幕:     div.bili-danmaku-x-dm,textContent 即弹幕文本
// 因播放器会复用弹幕节点(仅改 textContent),MutationObserver 的 childList 不可靠,
// 采用"轻量轮询扫描 + MutationObserver 加速"方式:命中"应屏蔽"则将文本改写为
// <已屏蔽>(保留节点/样式/动画,使其在原位置照常滚动)。

import { store } from "./state";

/** 当前剧透弹幕替换文本(实时读取,用户可在设置里改)。
    留空表示"直接隐藏":把被屏蔽弹幕文本置空(节点无内容即不可见),而不是显示 <已屏蔽>。 */
function maskText(): string {
  return store.get().replaceText ?? "";
}
const WRAP_SELECTORS = [
  ".bpx-player-row-dm-wrap",
  ".bpx-player-adv-dm-wrap",
  ".bpx-player-render-dm-wrap",
];
const ITEM_SELECTOR = ".bili-danmaku-x-dm, .bili-danmaku-x-dm-scroll, .bili-danmaku-x-dm-bottom";

// 被屏蔽弹幕节点 -> 原文。用于点击"恢复"后把已出现的 <已屏蔽> 还原回去。
const maskedNodes = new Map<Element, string>();

/** 判断某条弹幕文本是否应屏蔽(有风险=true 才屏蔽) */
function shouldMask(text: string): boolean {
  return store.shouldHide(text.trim());
}

/** 判断节点是否为"高级/顶部固定"弹幕(文本包在子元素里,外层还有 +1 图标等) */
function pickTextTarget(node: Element): Element {
  // 顶部/高级弹幕:纯文本在 .bili-danmaku-x-high-text 子元素里,外层 textContent 会拼上 +1 等图标文本,
  // 导致按纯文本匹配失败(这是"买华为硕士版啊!"这类顶部弹幕不被屏蔽的根因)。
  const ht = node.querySelector(".bili-danmaku-x-high-text");
  if (ht) return ht;
  return node;
}

/** 处理一个弹幕节点:若应屏蔽,改写其文本为 <已屏蔽>,并记录原文以便还原 */
function processDanmakuNode(node: Element) {
  const target = pickTextTarget(node);
  const text = (target.textContent || "").trim();
  if (!text || text === maskText()) return;
  if (shouldMask(text)) {
    // 只改文本,保留节点/样式/动画;记录原文,供"恢复"时还原。
    // 若目标元素已被记录且文本本就是 MASK_TEXT,跳过重复记录。
    if (!maskedNodes.has(target)) maskedNodes.set(target, text);
    target.textContent = maskText();
  }
}

/**
 * 还原所有已被屏蔽的弹幕节点,恢复其原文。
 * 点击"恢复"按钮时调用,让已出现在视频中的 <已屏蔽> 重新显示真实文本。
 */
export function restoreAllMasked(): void {
  for (const [target, original] of maskedNodes) {
    if (target.isConnected) target.textContent = original;
  }
  maskedNodes.clear();
}

/**
 * 全量重新屏蔽当前页面上所有应屏蔽的弹幕节点。
 * 点击"应用"(重新开启拦截)时调用,让已经还原回原文的 <已屏蔽> 立即恢复为 <已屏蔽>。
 */
export function applyAllMasked(): void {
  for (const node of collectDmNodes()) processDanmakuNode(node);
}

/** 从容器收集所有弹幕条目节点 */
function collectDmNodes(): Element[] {
  const nodes: Element[] = [];
  for (const sel of WRAP_SELECTORS) {
    const containers = document.querySelectorAll(sel);
    for (const c of containers) {
      for (const el of c.querySelectorAll(ITEM_SELECTOR)) nodes.push(el);
      // 兜底:容器直接叶子文本子元素
      for (const el of Array.from(c.children)) {
        if (el.children.length === 0 && el.textContent) nodes.push(el);
      }
    }
  }
  return nodes;
}

/**
 * 注册 DOM 弹幕屏蔽。轮询扫描 + observer 加速。
 * 返回取消函数(清状态,停止轮询与 observer)。
 */
export function registerInterceptor(): () => void {
  let active = true;
  let timer: any = null;
  const observers: MutationObserver[] = [];

  const sweep = () => {
    if (!active) return;
    const nodes = collectDmNodes();
    for (const node of nodes) processDanmakuNode(node);
  };

  // 观察器:新增节点即时处理
  const attach = () => {
    for (const sel of WRAP_SELECTORS) {
      for (const container of document.querySelectorAll(sel)) {
        const obs = new MutationObserver((mutations) => {
          if (!active) return;
          for (const m of mutations) {
            for (const added of m.addedNodes) {
              if (added instanceof Element) processDanmakuNode(added);
            }
          }
          sweep();
        });
        obs.observe(container, { childList: true, subtree: true });
        observers.push(obs);
      }
    }
  };

  // 轮询扫描(应对节点复用改文本、以及容器在 SPA 中重建)
  timer = setInterval(sweep, 300);
  sweep();
  attach();

  return () => {
    active = false;
    if (timer) clearInterval(timer);
    for (const o of observers) o.disconnect();
    observers.length = 0;
  };
}
