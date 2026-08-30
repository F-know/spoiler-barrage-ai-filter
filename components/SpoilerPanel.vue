<script setup lang="ts">
import { computed, ref, watch, nextTick, onMounted, onBeforeUnmount } from "vue";
import { store, type SpoilState, controlPlayback, seekTo, hidePanelHost } from "../src/services/state";
import { runOnce, reset, stop } from "../src/services/engine";
import { restoreAllMasked, applyAllMasked } from "../src/services/interceptor";
import SettingsPanel from "./SettingsPanel.vue";

const state = ref<SpoilState>({ ...store.get() });
const currentView = ref<"main" | "settings" | "detail">("main");
const shellRef = ref<HTMLElement | null>(null);
const mainViewRef = ref<HTMLElement | null>(null);
/** 主视图内容的自然高度，切换子视图时用 min-height 保持面板高度不变 */
const mainHeight = ref<number | null>(null);
const logBoxRef = ref<HTMLElement | null>(null);
/** 面板是否已收折成仅剩上边栏 */
const collapsed = ref(false);
let unsub: (() => void) | null = null;
let dragCleanup: (() => void) | null = null;

// 面板位置在扩展本地存储中的键。
const POS_KEY = "panelPos_v1";

onMounted(async () => {
  unsub = store.subscribe((s) => {
    state.value = { ...s };
    scrollLogToBottom();
    // 主视图内容高度会随异步视频信息(标题/封面)等变化，
    // 在 state 更新时重测，确保子视图 min-height 与最新主视图一致。
    if (currentView.value === "main") measureMainHeight();
  });
  await restorePanelPos();
});
onBeforeUnmount(() => {
  if (unsub) unsub();
  if (dragCleanup) dragCleanup();
  dragCleanup = null;
});

/** 最小化:隐藏整个插件面板(保留右侧 robot 图标,点它重新弹出)。 */
function toggleCollapse() {
  // 最小化 = 面板整体隐藏。右侧常驻 robot 图标由 main.js 注入,负责重新弹出。
  // hidePanelHost 会在指针处放一个 cursor:default 透明锚点,避免指针落到
  // B站播放器视频区(cursor:none)导致"鼠标消失、动一下才回来"。
  hidePanelHost();
}

/** 读回上次拖动的面板位置并应用(缺省保持右上角默认) */
async function restorePanelPos() {
  try {
    const pos = await LFStore.get<{ x: number; y: number } | null>(POS_KEY, null as any);
    const host = document.getElementById("lf-spoiler-dm-root");
    if (pos && typeof pos.x === "number" && typeof pos.y === "number" && host) {
      host.style.left = pos.x + "px";
      host.style.top = pos.y + "px";
      host.style.right = "auto";
    }
  } catch {
    // 无持久化位置时保持默认定位
  }
}

/** 以面板上边栏为手柄开拖动;持续更新 host 定位,结束后持久化 */
function startDrag(ev: PointerEvent) {
  if (ev.button !== 0 && ev.pointerType !== "touch") return;
  const host = document.getElementById("lf-spoiler-dm-root");
  if (!host) return;
  // 点击到按钮(设置/收折)不进入拖动
  const target = ev.target as HTMLElement;
  if (target.closest("button")) return;
  ev.preventDefault();
  const rect = host.getBoundingClientRect();
  const startX = ev.clientX;
  const startY = ev.clientY;
  const baseLeft = rect.left;
  const baseTop = rect.top;
  const move = (e: PointerEvent) => {
    const nx = baseLeft + e.clientX - startX;
    const ny = baseTop + e.clientY - startY;
    host.style.left = Math.max(0, nx) + "px";
    host.style.top = Math.max(0, ny) + "px";
    host.style.right = "auto";
  };
  const up = async () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    dragCleanup = null;
    const r = host.getBoundingClientRect();
    try {
      await LFStore.set(POS_KEY, { x: r.left, y: r.top });
    } catch {
      // 忽略持久化失败
    }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
  dragCleanup = up;
}

/** 测量主视图的自然高度，作为面板切换时的固定最小高度 */
function measureMainHeight() {
  nextTick(() => {
    const inner = mainViewRef.value;
    // 只测主视图内容 wrapper 的自然高度(不含 min-height 自引用)，
    // 该值正好就是 shell 的 min-height(等价于主视图的 content 高度)。
    if (inner) mainHeight.value = inner.offsetHeight;
  });
}

// 回到主视图时重新测量高度（适配弹幕总数/日志等动态高度）
watch(currentView, (v) => {
  if (v === "main") measureMainHeight();
});

function scrollLogToBottom() {
  nextTick(() => {
    const el = logBoxRef.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

const isBusy = computed(() => state.value.phase === "analyzing" || state.value.phase === "paused");
const isDone = computed(() => state.value.phase === "done");
/** 当前是否处于"拦截中"状态(决定完成态左按钮显示"恢复"还是"应用") */
const isIntercepting = computed(() => state.value.interceptEnabled);
/** OpenAI 兼容接口三项是否都已填(决定开始/重新过滤按钮是否可用) */
const isApiReady = computed(
  () => !!state.value.apiUrl?.trim() && !!state.value.apiModel?.trim() && !!state.value.apiKey?.trim(),
);

// 已过滤数字滚动动效:从 0 快速滚动到最终值
const animatedCount = ref(0);
let animRaf = 0;
function startCountAnim(target: number) {
  cancelAnimationFrame(animRaf);
  const start = performance.now();
  const dur = 700;
  const step = (t: number) => {
    const p = Math.min(1, (t - start) / dur);
    // easeOutCubic
    const eased = 1 - Math.pow(1 - p, 3);
    animatedCount.value = Math.round(target * eased);
    if (p < 1) {
      animRaf = requestAnimationFrame(step);
    } else {
      animatedCount.value = target;
    }
  };
  animRaf = requestAnimationFrame(step);
}

// 弹幕总数数字滚动动效:随"拉取/分析过程中 totalCount 实时增长"而往上加。
// 从当前已显示的动画值(上一段累计值)续滚到新值,而不是每次从 0 重播,
// 这样在逐段拉取时数字会连贯地一路往上滚,不会发生"跳回 0 再滚"的闪烁。
const animatedTotalCount = ref(0);
let totalRaf = 0;
function startTotalAnim(target: number) {
  cancelAnimationFrame(totalRaf);
  const from = animatedTotalCount.value;
  if (from === target) return;
  const start = performance.now();
  const dur = 700;
  const step = (t: number) => {
    const p = Math.min(1, (t - start) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    animatedTotalCount.value = Math.round(from + (target - from) * eased);
    if (p < 1) {
      totalRaf = requestAnimationFrame(step);
    } else {
      animatedTotalCount.value = target;
    }
  };
  totalRaf = requestAnimationFrame(step);
}

// 已过滤百分数滚动动效:完成时从 0 滚动到最终占比(x.x%)。
const animatedPercent = ref(0);
let percentRaf = 0;
function startPercentAnim(target: number) {
  cancelAnimationFrame(percentRaf);
  const from = animatedPercent.value;
  if (Math.abs(from - target) < 0.05) {
    animatedPercent.value = target;
    return;
  }
  const start = performance.now();
  const dur = 700;
  const step = (t: number) => {
    const p = Math.min(1, (t - start) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    animatedPercent.value = from + (target - from) * eased;
    if (p < 1) {
      percentRaf = requestAnimationFrame(step);
    } else {
      animatedPercent.value = target;
    }
  };
  percentRaf = requestAnimationFrame(step);
}

// 过滤完成时触发"已过滤"数字的滚动动效。
// 只监听 phase 字符串原语(而非返回新对象),避免"恢复/应用"切换 interceptEnabled
// 触发 store.patch 重建 state 时,因 getter 返回新对象引用而被误判为变化,重播数字动画。
watch(
  () => state.value.phase,
  (phase) => {
    if (phase === "done") {
      startCountAnim(state.value.filteredDm?.length ?? 0);
      startTotalAnim(state.value.totalCount ?? 0);
      const total = state.value.totalCount || 0;
      const filtered = state.value.filteredDm?.length || 0;
      startPercentAnim(total > 0 ? (filtered / total) * 100 : 0);
    } else if (phase === "idle" || phase === "error") {
      // 回到空闲/出错:动画数字清零,等待下次处理。
      cancelAnimationFrame(animRaf);
      cancelAnimationFrame(totalRaf);
      cancelAnimationFrame(percentRaf);
      animatedCount.value = 0;
      animatedTotalCount.value = 0;
      animatedPercent.value = 0;
    }
    // analyzing / paused 阶段:总数数字的滚动由下面的 totalCount 监听负责,
    // 不能在这里清零,否则会打断"拉取过程逐段往上加"的连贯滚动。
  },
  { immediate: true },
);

// 弹幕总数随拉取过程实时累加:
// engine 每拉到一段就把当前已累计的 totalCount 写进 store,这里监听它的变化,
// 让数字从上一段的值"续滚"到新值,形成一段段往上加的动效,而非等全部结束一次到位。
watch(
  () => state.value.totalCount,
  (total) => {
    if (state.value.phase === "analyzing" || state.value.phase === "paused") {
      startTotalAnim(total ?? 0);
    }
  },
);
onBeforeUnmount(() => {
  cancelAnimationFrame(animRaf);
  cancelAnimationFrame(totalRaf);
  cancelAnimationFrame(percentRaf);
});

/** 已过滤占比:未完成时用横杠占位,完成后显示"已过滤条目数/弹幕总数"的百分数 */
const filteredCount = computed(() => {
  if (!isDone.value && state.value.phase !== "error") return "--";
  const total = state.value.totalCount || 0;
  const filtered = state.value.filteredDm?.length || 0;
  if (total <= 0) return "--";
  return animatedPercent.value.toFixed(1) + "%";
});

/** 弹幕总数:空闲/出错时为横杠;拉取、分析、完成阶段都显示数字,
    并随拉取过程逐段累加(带滚动动效) */
const totalCountDisplay = computed(() => {
  if (state.value.phase === "idle" || state.value.phase === "error") return "--";
  if (state.value.totalCount <= 0 && animatedTotalCount.value <= 0) return "--";
  return String(animatedTotalCount.value);
});

/** 将秒格式化为 hh:mm:ss(支持超过 1 小时的弹幕;不足 1 小时也只显示两位分钟) */
function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

/** 被过滤弹幕按出现时间升序排序(未标注时间的排最后) */
const sortedFiltered = computed(() => {
  const list = state.value.filteredDm || [];
  return [...list].sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
});

/** 懒加载:每次渲染的弹幕条数 */
const DETAIL_PAGE = 1000;
const detailVisibleCount = ref(DETAIL_PAGE);
/** 详情视图目前可见的弹幕(分页截断) */
const visibleFiltered = computed(() => sortedFiltered.value.slice(0, detailVisibleCount.value));
/** 是否还有更多待加载 */
const hasMoreDetail = computed(() => detailVisibleCount.value < sortedFiltered.value.length);

/** 滚动到底部附近时,加载下一批 */
function loadMoreDetail() {
  if (!hasMoreDetail.value) return;
  detailVisibleCount.value = Math.min(
    detailVisibleCount.value + DETAIL_PAGE,
    sortedFiltered.value.length,
  );
}

/** 详情视图列表区高度:撑满 shell(与主视图同高),消除下方留白。
    shell 是 content-box,min-height=mainHeight 只约束内容区；
    content 内含 sub-view-head(26) + 其 margin-bottom(12) + 列表体，
    因此列表体高度 = mainHeight - (26+12)。 */
const detailBodyHeight = computed(() => {
  if (!mainHeight.value) return undefined;
  return Math.max(0, mainHeight.value - (26 + 12));
});

/** 点击定位按钮:让视频跳转到对应时间 */
async function handleSeek(sec: number) {
  await seekTo(sec);
}

async function toggleAuto() {
  const nextMode = store.get().mode === "auto" ? "manual" : "auto";
  await store.setMode(nextMode);

  // 开启自动模式时立即处理当前尚未处理的视频；以后刷新或切换视频也会自动运行。
  const phase = store.get().phase;
  if (nextMode === "auto" && isApiReady.value && (phase === "idle" || phase === "error")) {
    store.patch({ logs: [] });
    await runOnce("auto");
  }
}

async function handleStart() {
  if (store.get().phase === "done") await reset();
  store.patch({ logs: [] });
  await runOnce(store.get().mode);
}

async function handleRestart() {
  await reset();
  store.patch({ logs: [] });
  await runOnce(store.get().mode);
}

function handleStop() {
  stop();
}

async function handleResume() {
  // 恢复/应用二态切换:仅切换拦截开关,保留已过滤数据与 done 状态,
  // 不改变"重新过滤"按钮,也不清空已过滤列表。
  const s = store.get();
  if (s.interceptEnabled) {
    // 当前拦截中 -> 点"恢复":取消拦截 + 把已出现的 <已屏蔽> 还原回原文。
    restoreAllMasked();
    store.patch({ interceptEnabled: false });
  } else {
    // 当前未拦截 -> 点"应用":恢复拦截 + 全量重新屏蔽页面上已还原的弹幕。
    applyAllMasked();
    store.patch({ interceptEnabled: true });
  }
}
</script>

<template>
  <div ref="shellRef" class="spoiler-shell" :style="{ minHeight: (!collapsed && mainHeight) ? mainHeight + 'px' : undefined }">
    <!-- 主视图：标题 + 齿轮 + 视频信息 + 统计 + 动作 + 自动 + 日志 -->
    <div v-if="currentView === 'main'" ref="mainViewRef" class="main-view" :class="{ collapsed }">
    <!-- 头部(可拖动手柄)：标题 + 收折 + 齿轮(设置) -->
    <div class="spoiler-head" @pointerdown="startDrag">
      <div class="spoiler-title-wrap">
        <!-- 机器人图标(与注入的 robot 触发按钮同款),替换原 B站弹幕图标 -->
        <svg class="spoiler-dm-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" width="20" height="20">
          <circle cx="12" cy="4.6" r="1.4" fill="currentColor"/>
          <rect x="10.8" y="5.8" width="2.4" height="2.4" fill="currentColor"/>
          <rect x="5.5" y="8" width="13" height="10.5" rx="3.5" fill="currentColor"/>
          <rect x="8.6" y="11.2" width="3.2" height="3.2" rx="1" fill="#fff"/>
          <rect x="12.2" y="11.2" width="3.2" height="3.2" rx="1" fill="#fff"/>
          <circle cx="9.6" cy="15.4" r="0.9" fill="currentColor"/>
          <circle cx="14.4" cy="15.4" r="0.9" fill="currentColor"/>
          <rect x="7" y="18.5" width="2" height="2.2" rx="0.6" fill="currentColor"/>
          <rect x="15" y="18.5" width="2" height="2.2" rx="0.6" fill="currentColor"/>
        </svg>
        <span class="spoiler-title">剧透弹幕AI过滤器</span>
      </div>
      <div class="spoiler-head-btns">
        <button class="spoiler-collapse" title="最小化" @click="toggleCollapse">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </button>
        <button class="spoiler-gear" title="设置" @click="currentView = 'settings'">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- 视频信息: 封面 + 标题(两行/省略/hover),无卡片包裹 -->
    <div class="sp-video-row" v-if="state.title || state.cover">
      <img v-if="state.cover" class="sp-video-cover" :src="state.cover" alt="封面" />
      <div class="sp-video-meta">
        <span class="sp-video-title" :title="state.title || ''">{{ state.title || "当前视频" }}</span>
      </div>
    </div>

    <!-- 统计区: 左弹幕总数 / 右已过滤数(靠右,放大),详情在已过滤数字右侧且下端对齐 -->
    <div class="sp-stat-row">
      <div class="sp-stat">
        <div class="sp-stat-label-wrap">
          <span class="sp-stat-label">弹幕总数</span>
          <span class="sp-stat-info" data-tip="由于各种原因，有时跟页面显示的弹幕数量对不上是正常的"></span>
        </div>
        <span class="sp-stat-val">{{ totalCountDisplay }}</span>
      </div>
      <div class="sp-stat sp-stat-right">
        <div class="sp-stat-main">
          <span class="sp-stat-label">已过滤</span>
          <span class="sp-stat-val">{{ filteredCount }}</span>
        </div>
        <span v-if="isDone" class="sp-detail-link" @click="currentView = 'detail'">详情</span>
      </div>
    </div>

    <!-- 主动作区(三态: 开始过滤 / 过滤中+停止 / 重新过滤+恢复) -->
    <div class="spoiler-main">
      <!-- 空闲态: 开始过滤 -->
      <template v-if="!isBusy && !isDone">
        <span class="sp-btn-wrap" :class="{ 'sp-btn-disabled': !isApiReady }" :data-tip="!isApiReady ? '请先在设置中接入API' : ''">
          <button class="sp-btn sp-btn-dark sp-btn-big" :disabled="!isApiReady" @click="handleStart">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
            </svg>
            <span>开始过滤</span>
          </button>
        </span>
      </template>

      <!-- 过滤中: 停止(左) + 过滤中(右,禁用) -->
      <template v-else-if="isBusy">
        <div class="sp-btn-row">
          <button class="sp-btn sp-btn-red sp-btn-mid" @click="handleStop">停止</button>
          <button class="sp-btn sp-btn-dark sp-btn-big" disabled>
            <span class="sp-spinner"></span>
            <span>过滤中</span>
          </button>
        </div>
      </template>

      <!-- 完成态: 恢复(左) + 重新过滤(右) -->
      <template v-else-if="isDone">
        <div class="sp-btn-row">
          <button class="sp-btn sp-btn-plain sp-btn-mid" @click="handleResume">{{ isIntercepting ? "恢复" : "应用" }}</button>
          <span class="sp-btn-wrap" :class="{ 'sp-btn-disabled': !isApiReady }" :data-tip="!isApiReady ? '请先在设置中接入API' : ''">
            <button class="sp-btn sp-btn-dark sp-btn-big" :disabled="!isApiReady" @click="handleRestart">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
              </svg>
              <span>重新过滤</span>
            </button>
          </span>
        </div>
      </template>
    </div>

    <!-- 自动处理: 默认置于主按钮右下角,仅文字/勾选框可点击,无 hover 按钮效果 -->
    <div class="sp-auto">
      <span class="sp-auto-text" @click="toggleAuto">自动</span>
      <input type="checkbox" :checked="state.mode === 'auto'" @change="toggleAuto" />
    </div>

    <!-- 日志框 -->
    <div ref="logBoxRef" class="sp-log">
      <p v-if="state.logs.length === 0" class="sp-log-empty">点击「开始过滤」后,这里会显示详细日志。</p>
      <p v-for="(line, i) in state.logs" :key="i" class="sp-log-line">{{ line }}</p>
    </div>
    </div>

    <!-- 设置视图：返回箭头 + 标题 + 设置内容(嵌入主面板) -->
    <template v-else-if="currentView === 'settings'">
      <div class="sub-view-head" @pointerdown="startDrag">
        <button class="back-btn" title="返回" @click="currentView = 'main'">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="19" y1="12" x2="5" y2="12"/>
            <polyline points="12 19 5 12 12 5"/>
          </svg>
        </button>
        <span class="sub-view-title">设置</span>
      </div>
      <div class="settings-view-body" :style="{ height: detailBodyHeight ? detailBodyHeight + 'px' : undefined }">
        <SettingsPanel />
      </div>
    </template>

    <!-- 详情视图：返回箭头 + 标题 + 被过滤弹幕列表 -->
    <template v-else>
      <div class="sub-view-head" @pointerdown="startDrag">
        <button class="back-btn" title="返回" @click="currentView = 'main'">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="19" y1="12" x2="5" y2="12"/>
            <polyline points="12 19 5 12 12 5"/>
          </svg>
        </button>
        <div class="sub-view-title-wrap">
          <span class="sub-view-title">被过滤的弹幕</span>
          <span class="detail-info" data-tip="未结合视频内容分析判断，准确度有限，仅供参考"></span>
        </div>
      </div>
      <div class="detail-view-body" :style="{ height: detailBodyHeight ? detailBodyHeight + 'px' : undefined }" @scroll.passive="loadMoreDetail">
        <template v-if="visibleFiltered.length">
          <div class="detail-list">
            <div v-for="(item, i) in visibleFiltered" :key="i" class="detail-item">
              <span class="detail-item-time">{{ fmtTime(item.time) }}</span>
              <span class="detail-item-text">{{ item.text }}</span>
              <button class="detail-item-seek" title="跳转到该时间" @click="handleSeek(item.time)">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
              </button>
            </div>
          </div>
        </template>
        <p v-else class="detail-empty">还没有过滤结果</p>
        <p v-if="hasMoreDetail" class="detail-loading-hint">加载更多…</p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.spoiler-shell {
  position: relative;
  font-family: "PingFang SC", "Microsoft YaHei", sans-serif;
  width: 300px;
  background: #ffffff;
  color: #1f2329;
  border-radius: 14px;
  padding: 16px;
  box-shadow: 0 8px 30px rgba(0,0,0,.12);
  border: 1.5px solid #d0d0d0;
}
.spoiler-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  cursor: move;
  user-select: none;
  -webkit-user-select: none;
}
.spoiler-head-btns {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}
.spoiler-title-wrap {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
/* B站官方弹幕图标:黑色,横排于标题左侧 */
.spoiler-dm-icon {
  width: 22px;
  height: 22px;
  color: #1f2329;
  flex: 0 0 auto;
}
.spoiler-title { font-weight: 700; font-size: 17px; color: #1f2329; }
.spoiler-gear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid #e4e7ec;
  background: #ffffff;
  color: #5b6472;
  border-radius: 8px;
  cursor: pointer;
  transition: background .15s, color .15s;
}
.spoiler-gear:hover { background: #f5f7fa; color: #c0392b; }

/* 收折按钮: 与设置按钮同款 */
.spoiler-collapse {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid #e4e7ec;
  background: #ffffff;
  color: #5b6472;
  border-radius: 8px;
  cursor: pointer;
  transition: background .15s, color .15s;
}
.spoiler-collapse:hover { background: #f5f7fa; color: #1f2329; }

/* 收折态: 仅保留上边栏(.spoiler-head),其余内容隐藏 */
.main-view.collapsed > :not(.spoiler-head) {
  display: none !important;
}

/* 视频信息: 无卡片包裹,只留封面 + 标题并排 */
.sp-video-row {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-bottom: 8px;
}
.sp-video-cover {
  width: 64px;
  height: 40px;
  object-fit: cover;
  border-radius: 6px;
  background: #eee;
  flex-shrink: 0;
}
.sp-video-meta { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
/* 标题: 加粗,最多两行,超出省略,hover 显示完整标题 */
.sp-video-title {
  font-size: 12px;
  font-weight: 600;
  color: #1a1a1a;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
  word-break: break-all;
  line-height: 1.35;
}

/* 统计区: 无卡片包裹,弹幕总数居左/已过滤居右,间隔居中固定(gap 40px),位置不随过滤结果偏移 */
.sp-stat-row {
  display: flex;
  align-items: flex-end;
  justify-content: center;
  gap: 40px;
  margin-bottom: 10px;
}
.sp-stat { display: flex; flex-direction: column; align-items: center; gap: 1px; }
.sp-stat-main { display: flex; flex-direction: column; align-items: center; gap: 1px; }
/* 已过滤: 横向排列(label+数字竖向居中),详情在右侧,整体下端对齐;
   预留固定宽度(数字+详情),使详情出现时数字位置保持不变 */
.sp-stat-right {
  display: flex;
  flex-direction: row;
  align-items: flex-end;
  gap: 8px;
  min-width: 88px;
  justify-content: space-between;
}
/* 标签文字: 更大、颜色更深；弹幕总数标签与感叹号图标横排 */
.sp-stat-label { font-size: 13px; color: #3a4454; }
.sp-stat-label-wrap {
  display: flex;
  align-items: center;
  gap: 2px;
}
/* 弹幕总数旁的感叹号图标,鼠标 hover 显示 tooltip 提示 */
.sp-stat-info {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #f0f2f5;
  color: #8a919f;
  cursor: pointer;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
}
/* 单个感叹号图标: 仅由 ::before 渲染一个 "!"(模板里不再有字面文本,避免双感叹号) */
.sp-stat-info::before { content: "!"; }
/* 自定义 tooltip(用 data-tip,不用 title,避免触发浏览器原生 tooltip 导致两种样式重复) */
.sp-stat-info:hover::after {
  content: attr(data-tip);
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  white-space: nowrap;
  background: rgba(31,35,41,.95);
  color: #fff;
  font-size: 11px;
  font-weight: 400;
  line-height: 1.4;
  padding: 6px 8px;
  border-radius: 6px;
  z-index: 1000;
  box-shadow: 0 4px 12px rgba(0,0,0,.2);
  pointer-events: none;
}
/* 数字放大一倍 */
.sp-stat-val { font-size: 26px; font-weight: 700; color: #1a1a1a; line-height: 1.2; }
/* 详情: 仅过滤后出现的小号可点击文字,放已过滤数字右侧,下端对齐 */
.sp-detail-link {
  font-size: 11px;
  color: #8a919f;
  cursor: pointer;
  line-height: 1;
  margin-bottom: 3px;
}
.sp-detail-link:hover { color: #b71c1c; text-decoration: underline; }

.spoiler-main { margin-bottom: 8px; }
.sp-btn-row { display: flex; gap: 8px; }
/* 开始/重新过滤按钮外层容器:承载禁用时的 hover 提示(disabled 按钮不触发 hover,故由外层处理) */
.sp-btn-wrap {
  position: relative;
  display: flex;
  flex: 1;
}
.sp-btn-wrap .sp-btn-big { width: 100%; }
.sp-btn-wrap.sp-btn-disabled:hover::after {
  content: attr(data-tip);
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  white-space: nowrap;
  background: rgba(31,35,41,.95);
  color: #fff;
  font-size: 11px;
  font-weight: 400;
  line-height: 1.4;
  padding: 6px 8px;
  border-radius: 6px;
  z-index: 1000;
  box-shadow: 0 4px 12px rgba(0,0,0,.2);
  pointer-events: none;
}
.sp-btn-wrap.sp-btn-disabled .sp-btn {
  opacity: .55;
  cursor: not-allowed;
}
.sp-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border-radius: 10px;
  cursor: pointer;
  font-size: 15px;
  font-weight: 600;
  background: #ffffff;
  border: 1.5px solid;
  transition: background .15s, border-color .15s, color .15s;
}
.sp-btn-big { flex: 1; width: 100%; padding: 11px 14px; }
.sp-btn-mid { padding: 11px 14px; white-space: nowrap; }
.sp-btn-dark { border-color: #d0d0d0; color: #1a1a1a; }
.sp-btn-dark:hover { background: #f5f5f5; }
.sp-btn-red { border-color: #b71c1c; color: #b71c1c; }
.sp-btn-red:hover { background: #fdf3f3; }
.sp-btn-plain { border-color: #d0d0d0; color: #1a1a1a; }
.sp-btn-plain:hover { background: #f5f5f5; }
.sp-btn:disabled { opacity: .55; cursor: not-allowed; }
.sp-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid #d0d0d0;
  border-top-color: #1a1a1a;
  border-radius: 50%;
  animation: sp-spin .7s linear infinite;
}
@keyframes sp-spin { to { transform: rotate(360deg); } }

/* 自动处理: 仅文字/勾选框可点击,无 hover 按钮效果 */
.sp-auto {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  margin: 2px 2px 12px 0;
  user-select: none;
  line-height: 1;
}
.sp-auto-text {
  font-size: 12px;
  color: #8a919f;
  cursor: pointer;
}
.sp-auto input {
  accent-color: #1a1a1a;
  margin: 0;
  cursor: pointer;
  width: 16px;
  height: 16px;
}

/* 日志框 */
.sp-log {
  background: #f7f8fa;
  color: #1a1a1a;
  border: 1.5px solid #d0d0d0;
  border-radius: 8px;
  padding: 8px 10px;
  height: 140px;
  overflow-y: auto;
  font-family: "SFMono-Regular", "Menlo", "Consolas", monospace;
  font-size: 11px;
  line-height: 1.6;
}
.sp-log-empty { color: #5b5b5b; margin: 0; }
.sp-log-line { color: #1a1a1a; margin: 0; white-space: pre-wrap; word-break: break-all; }
.sp-log-line:last-child { margin-bottom: 0; }

/* 子视图头:返回箭头 + 标题;同样作为可拖动区域 */
.sub-view-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  cursor: move;
  user-select: none;
  -webkit-user-select: none;
}
.back-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid #e4e7ec;
  background: #ffffff;
  color: #1f2329;
  border-radius: 8px;
  cursor: pointer;
  transition: background .15s, color .15s;
  flex-shrink: 0;
}
.back-btn:hover { background: #f5f7fa; color: #1f2329; }
.sub-view-title { font-weight: 700; font-size: 15px; color: #1f2329; }
.sub-view-title-wrap {
  display: flex;
  align-items: center;
  gap: 4px;
}

/* 详情体：被过滤弹幕列表，在面板内滚动（高度由绑定 style 提供，撑满面板消除留白） */
.detail-view-body {
  overflow-y: auto;
  overflow-x: hidden;
  box-sizing: border-box;
  min-width: 0;
}
/* 设置体：与详情体一致的受限滚动容器,保证设置面板高度不超主视图 */
.settings-view-body {
  overflow-y: auto;
  overflow-x: hidden;
  box-sizing: border-box;
  min-width: 0;
}
/* "被过滤的弹幕"旁的感叹号图标: 仅由 ::before 渲染一个 "!",hover 显示自定义 tooltip */
.detail-info {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #f0f2f5;
  color: #8a919f;
  cursor: pointer;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
}
.detail-info::before { content: "!"; }
.detail-info:hover::after {
  content: attr(data-tip);
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  white-space: nowrap;
  background: rgba(31,35,41,.95);
  color: #fff;
  font-size: 11px;
  font-weight: 400;
  line-height: 1.4;
  padding: 6px 8px;
  border-radius: 6px;
  z-index: 1000;
  box-shadow: 0 4px 12px rgba(0,0,0,.2);
  pointer-events: none;
}
.detail-list { display: flex; flex-direction: column; gap: 6px; }
.detail-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 8px;
  background: #fafafa;
  border-radius: 6px;
  font-size: 12px;
  min-width: 0;
}
.detail-item-time {
  flex-shrink: 0;
  font-family: "SFMono-Regular", "Menlo", "Consolas", monospace;
  font-size: 11px;
  color: #b71c1c;
  font-weight: 600;
}
.detail-item-text { color: #1a1a1a; word-break: break-all; flex: 1; }
.detail-empty { color: #8a919f; font-size: 12px; margin: 0; }
.detail-loading-hint {
  color: #8a919f;
  font-size: 11px;
  text-align: center;
  margin: 10px 0 2px;
}
/* 定位按钮:跳转到该弹幕出现的时间 */
.detail-item-seek {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: 1px solid #e4e7ec;
  background: #ffffff;
  color: #5b6472;
  border-radius: 5px;
  cursor: pointer;
  transition: background .15s, color .15s;
  margin-top: 1px;
}
.detail-item-seek:hover { background: #f0f4ff; color: #b71c1c; border-color: #b71c1c; }
</style>
