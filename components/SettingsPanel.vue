<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";
import { store, type SpoilState } from "../src/services/state";
import { clearCache, testApi, type ApiTestResult } from "../src/services/classify";

const state = ref<SpoilState>({ ...store.get() });
let unsub: (() => void) | null = null;

// API 板块
const urlInput = ref(state.value.apiUrl);
const modelInput = ref(state.value.apiModel);
const keyInput = ref(state.value.apiKey);
// 功能板块
const batchSizeInput = ref(state.value.batchSize);
const concurrencyInput = ref(state.value.concurrency);
const replaceTextInput = ref(state.value.replaceText);
const cacheVideoCountInput = ref(state.value.cacheVideoCount);

// 功能板块默认值
const DEFAULT_BATCH = 30;
const DEFAULT_CONCURRENCY = 500;
const DEFAULT_REPLACE_TEXT = "<已屏蔽>";
const DEFAULT_CACHE_COUNT = 3;

onMounted(() => {
  unsub = store.subscribe((s) => {
    state.value = { ...s };
    urlInput.value = s.apiUrl;
    modelInput.value = s.apiModel;
    keyInput.value = s.apiKey;
    batchSizeInput.value = s.batchSize;
    concurrencyInput.value = s.concurrency;
    replaceTextInput.value = s.replaceText;
    cacheVideoCountInput.value = s.cacheVideoCount;
  });
});
onBeforeUnmount(() => {
  if (unsub) unsub();
});

/** 把当前所有设置写回 store 并持久化(及时生效,无保存按钮) */
function persist() {
  const cfg = {
    apiUrl: urlInput.value.trim(),
    apiModel: modelInput.value.trim(),
    apiKey: keyInput.value.trim(),
    batchSize: Math.max(1, Math.floor(Number(batchSizeInput.value) || DEFAULT_BATCH)),
    concurrency: Math.max(1, Math.floor(Number(concurrencyInput.value) || DEFAULT_CONCURRENCY)),
    replaceText: replaceTextInput.value.trim(),
    cacheVideoCount: Math.max(1, Math.floor(Number(cacheVideoCountInput.value) || DEFAULT_CACHE_COUNT)),
  };
  store.patch(cfg);
  void store.saveApiConfig(cfg);
}

/** API 板块:任一输入变化即保存(去掉保存按钮,及时生效) */
function onApiChange() {
  persist();
}

/** 功能板块:数字/文本输入变化即保存 */
function onFeatureChange() {
  persist();
}

/** 功能板块全部恢复默认(点击标题旁旋转箭头触发) */
function resetFeatures() {
  batchSizeInput.value = DEFAULT_BATCH;
  concurrencyInput.value = DEFAULT_CONCURRENCY;
  replaceTextInput.value = DEFAULT_REPLACE_TEXT;
  cacheVideoCountInput.value = DEFAULT_CACHE_COUNT;
  persist();
}
type ClearState = "idle" | "clearing" | "ok" | "error";
const clearState = ref<ClearState>("idle");
const clearMsg = ref<string>("");
let clearTimer: ReturnType<typeof setTimeout> | null = null;

async function handleClearCache() {
  if (clearState.value === "clearing") return;
  clearState.value = "clearing";
  clearMsg.value = "";
  try {
    const n = await clearCache();
    clearState.value = "ok";
    clearMsg.value = n > 0 ? `已清空 ${n} 个视频的缓存` : "缓存已是空的";
  } catch (e: any) {
    clearState.value = "error";
    clearMsg.value = "清理失败：" + (e?.message || String(e));
  }
  // 几秒后自动回到初始态，避免状态残留
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    clearState.value = "idle";
    clearMsg.value = "";
  }, 4000);
}

// ---- 测试 API 连接 ----
type TestState = "idle" | "testing" | "ok" | "error";
const testState = ref<TestState>("idle");
const testError = ref<string>("");
const testCode = ref<string>("");
const testMsg = ref<string>("");

async function handleTestApi() {
  if (testState.value === "testing") return;
  testState.value = "testing";
  testError.value = "";
  testCode.value = "";
  testMsg.value = "";
  const cfg = {
    url: urlInput.value.trim(),
    model: modelInput.value.trim(),
    apiKey: keyInput.value.trim(),
  };
  try {
    const r: ApiTestResult = await testApi(cfg);
    if (r.ok) {
      testState.value = "ok";
    } else {
      testState.value = "error";
      testCode.value = r.code;
      testMsg.value = r.message;
    }
  } catch (e: any) {
    testState.value = "error";
    testCode.value = e?.name || "Error";
    testMsg.value = e?.message || String(e);
  }
}
</script>

<template>
  <div class="setting-shell">
    <!-- API 板块 -->
    <div class="setting-group">
      <div class="setting-group-title">API</div>
      <label class="setting-label">接口地址 (Base URL)</label>
      <input v-model="urlInput" type="text" class="key-input" placeholder="" @change="onApiChange" />
      <label class="setting-label">模型名称</label>
      <input v-model="modelInput" type="text" class="key-input" placeholder="" @change="onApiChange" />
      <label class="setting-label">API Key</label>
      <input v-model="keyInput" type="password" class="key-input" placeholder="sk-..." @change="onApiChange" />
      <span class="api-test-row">
        <button class="btn api-test-btn" :disabled="testState === 'testing'" @click="handleTestApi">测试</button>
        <span v-if="testState === 'testing'" class="api-test-status testing">
          <span class="api-test-spinner"></span>
          <span class="api-test-text">测试中…</span>
        </span>
        <span v-else-if="testState === 'ok'" class="api-test-status ok">
          <svg class="api-test-mark" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          <span class="api-test-text">OK</span>
        </span>
        <span v-else-if="testState === 'error'" class="api-test-status error" :title="testMsg">
          <svg class="api-test-mark" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
          <span class="api-test-text">Error {{ testCode }}</span>
        </span>
      </span>
    </div>

    <div class="setting-divider"></div>

    <!-- 功能板块 -->
    <div class="setting-group">
      <div class="setting-group-title-wrap">
        <span class="setting-group-title">功能</span>
        <button class="feature-reset" title="恢复默认配置" @click="resetFeatures">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 12a9 9 0 1 0 3-6.71L3 8"/>
            <path d="M3 3v5h5"/>
          </svg>
        </button>
      </div>

      <div class="setting-row">
        <label class="setting-label">单次请求处理弹幕数量</label>
        <input v-model.number="batchSizeInput" type="number" class="small-input" min="1" step="1" @change="onFeatureChange" />
      </div>
      <div class="setting-row">
        <label class="setting-label">请求并发数</label>
        <input v-model.number="concurrencyInput" type="number" class="small-input" min="1" step="1" @change="onFeatureChange" />
      </div>
      <div class="setting-row">
        <label class="setting-label">剧透弹幕替换文本（可留空）</label>
        <input v-model="replaceTextInput" type="text" class="small-input" @change="onFeatureChange" />
      </div>
      <div class="setting-row">
        <label class="setting-label">缓存分析结果的近期视频数量</label>
        <input v-model.number="cacheVideoCountInput" type="number" class="small-input" min="1" step="1" @change="onFeatureChange" />
      </div>

      <span class="clear-cache-row">
        <button class="btn danger" :disabled="clearState === 'clearing'" @click="handleClearCache">清空分析缓存</button>
        <span v-if="clearState === 'clearing'" class="clear-cache-status clearing">
          <span class="clear-cache-spinner"></span>
          <span class="clear-cache-text">正在清理…</span>
        </span>
        <span v-else-if="clearState === 'ok'" class="clear-cache-status ok" :title="clearMsg">
          <svg class="clear-cache-mark" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          <span class="clear-cache-text">{{ clearMsg }}</span>
        </span>
        <span v-else-if="clearState === 'error'" class="clear-cache-status error" :title="clearMsg">
          <svg class="clear-cache-mark" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
          <span class="clear-cache-text">{{ clearMsg }}</span>
        </span>
      </span>
    </div>

    <div class="setting-footer">
      <a
        class="github-link"
        href="https://github.com/F-know"
        target="_blank"
        rel="noopener noreferrer"
        title="访问 F-know 的 GitHub 主页"
        aria-label="访问 F-know 的 GitHub 主页"
      >
        <svg class="github-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="currentColor" d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2.23c-3.22.7-3.9-1.37-3.9-1.37-.52-1.34-1.28-1.7-1.28-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.57-.29-5.27-1.28-5.27-5.68 0-1.26.45-2.28 1.18-3.08-.12-.29-.51-1.47.11-3.05 0 0 .97-.31 3.16 1.18A10.9 10.9 0 0 1 12 6.14c.98 0 1.96.13 2.88.39 2.2-1.49 3.16-1.18 3.16-1.18.62 1.58.23 2.76.11 3.05.74.8 1.18 1.82 1.18 3.08 0 4.41-2.71 5.38-5.29 5.67.42.36.79 1.07.79 2.16v3.24c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z"/>
        </svg>
        <span>F-know</span>
      </a>
    </div>
  </div>
</template>

<style scoped>
.setting-shell {
  font-family: "PingFang SC", "Microsoft YaHei", sans-serif;
  color: #1f2329;
}
.setting-footer {
  display: flex;
  justify-content: flex-end;
  margin-top: 14px;
}
.github-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: #8a919f;
  font-size: 12px;
  line-height: 1;
  text-decoration: none;
  transition: color 0.15s ease;
}
.github-link:hover { color: #1f2329; }
.github-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}
.setting-group-title-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}
.setting-group-title {
  font-size: 13px;
  font-weight: 600;
  color: #1f2329;
}
.feature-reset {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: none;
  background: transparent;
  color: #8a919f;
  cursor: pointer;
  padding: 0;
  border-radius: 4px;
}
.feature-reset:hover { color: #1f2329; background: #f5f7fa; }
.setting-label { font-size: 12px; color: #8a919f; }
.key-input {
  display: block;
  width: 100%;
  box-sizing: border-box;
  padding: 7px;
  border: 1px solid #e4e7ec;
  background: #ffffff;
  color: #1f2329;
  border-radius: 8px;
  font-size: 13px;
  min-width: 0;
  margin-bottom: 12px;
}
.key-input:focus { outline: none; border-color: #1a1a1a; }
.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}
.setting-row .setting-label { flex: 1; min-width: 0; }
.small-input {
  width: 70px;
  box-sizing: border-box;
  padding: 5px 6px;
  border: 1px solid #e4e7ec;
  background: #ffffff;
  color: #1f2329;
  border-radius: 6px;
  font-size: 12px;
  text-align: center;
  flex-shrink: 0;
}
.small-input:focus { outline: none; border-color: #1a1a1a; }
.btn {
  padding: 7px 10px;
  border: none;
  border-radius: 8px;
  background: #1a1a1a;
  color: #fff;
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
}
.btn:hover { background: #000; }
.setting-divider { height: 1px; background: #ebeef3; margin: 12px 0; }
.btn.danger { background: #fdeaea; color: #d64545; margin-top: 6px; }
.btn.danger:hover { background: #fbdcdc; }
.btn.danger:disabled { opacity: 0.6; cursor: default; }
.clear-cache-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  flex-wrap: wrap;
}
.clear-cache-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
}
.clear-cache-status.clearing { color: #8a919f; }
.clear-cache-status.ok { color: #2e9e5b; }
.clear-cache-status.error { color: #d64545; }
.clear-cache-mark { flex-shrink: 0; }
.clear-cache-text { white-space: nowrap; }
.clear-cache-spinner {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  border: 2px solid #c9ced6;
  border-top-color: #8a919f;
  border-radius: 50%;
  animation: clear-cache-spin 0.8s linear infinite;
}
@keyframes clear-cache-spin { to { transform: rotate(360deg); } }
.api-test-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
}
.api-test-btn {
  padding: 5px 12px;
  font-size: 12px;
  background: #1a1a1a;
  color: #fff;
}
.api-test-btn:hover { background: #000; }
.api-test-btn:disabled { opacity: 0.6; cursor: default; }
.api-test-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
}
.api-test-status.testing { color: #8a919f; }
.api-test-status.ok { color: #2e9e5b; }
.api-test-status.error { color: #d64545; }
.api-test-mark { flex-shrink: 0; }
.api-test-text { white-space: nowrap; }
.api-test-spinner {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  border: 2px solid #c9ced6;
  border-top-color: #8a919f;
  border-radius: 50%;
  animation: api-test-spin 0.8s linear infinite;
}
@keyframes api-test-spin { to { transform: rotate(360deg); } }
</style>
