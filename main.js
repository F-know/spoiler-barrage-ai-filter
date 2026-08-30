// 内容脚本的页面入口：挂载控制面板、播放器按钮与弹幕过滤器。

import { createApp } from "vue";
import SpoilerPanel from "./components/SpoilerPanel.vue";
import {
  store,
  readEpisodeInfo,
  showPanelHost,
  hidePanelHost,
  loadPanelVisibility,
} from "./src/services/state";
import { registerInterceptor, restoreAllMasked } from "./src/services/interceptor";
import { cleanVideoKey } from "./src/services/classify";
import { runOnce } from "./src/services/engine";

// 全局侧边悬浮容器 id
const HOST_ID = "lf-spoiler-dm-root";
// 右侧常驻 robot 触发按钮 id(面板最小化隐藏后,点它重新弹出)
const TOGGLE_ID = "lf-spoiler-dm-toggle";

async function bootstrap() {
// 先加载已保存的 OpenAI 兼容接口配置(用户填过的 url/模型/key),再挂载面板,
// 保证打开设置面板时显示的是持久化后的值,且过滤按钮可用性基于真实配置判断。
await store.loadApiConfig();
const panelVisible = await loadPanelVisibility();

LFRuntime.mountHot("spoiler-dm-main", ({ onDispose }) => {
  // 1. 悬浮宿主节点：固定在右侧，不挡业务
  if (!document.getElementById(HOST_ID)) {
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText =
      "position:fixed;top:110px;right:16px;z-index:2147483640;" +
      (panelVisible ? "" : "display:none;");
    document.body.appendChild(host);
    LFRuntime.trackNode(host);
  }

  // 1.5 常驻 robot 图标:注入到弹幕设置按钮(.bpx-player-dm-setting)右侧。
  // 面板最小化隐藏后,点它重新弹出主面板。不随面板显隐。
  function ensureToggleIntoDmRoot() {
    if (document.getElementById(TOGGLE_ID)) return;
    const dmSetting = document.querySelector(".bpx-player-dm-setting");
    const dmRoot = dmSetting && dmSetting.parentElement;
    if (!dmRoot) return; // 播放器未就绪,稍后重试
    const toggle = document.createElement("button");
    toggle.id = TOGGLE_ID;
    // 用 black tooltip 复刻弹幕开关样式,不再用原生 title。
    toggle.removeAttribute("title");
    // 与旁边弹幕开关/设置按钮一致:viewBox 0 0 24 24、fill 实心、同色深灰 #61666d。
    // margin-right 拉开右边到输入框的空隙(避免与右侧输入栏贴死)。
    toggle.style.cssText =
      "display:inline-flex;align-items:center;justify-content:center;" +
      "width:24px;height:24px;margin-right:16px;flex:0 0 auto;position:relative;" +
      "background:transparent;border:none;color:#61666d;cursor:pointer;" +
      "padding:0;transition:color .15s;";
    toggle.innerHTML =
      '<svg width="25" height="25" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">' +
      '<circle cx="12" cy="4.6" r="1.4" fill="currentColor"/>' +
      '<rect x="10.8" y="5.8" width="2.4" height="2.4" fill="currentColor"/>' +
      '<rect x="5.5" y="8" width="13" height="10.5" rx="3.5" fill="currentColor"/>' +
      '<rect x="8.6" y="11.2" width="3.2" height="3.2" rx="1" fill="#fff"/>' +
      '<rect x="12.2" y="11.2" width="3.2" height="3.2" rx="1" fill="#fff"/>' +
      '<circle cx="9.6" cy="15.4" r="0.9" fill="currentColor"/>' +
      '<circle cx="14.4" cy="15.4" r="0.9" fill="currentColor"/>' +
      "<rect x=\"7\" y=\"18.5\" width=\"2\" height=\"2.2\" rx=\"0.6\" fill=\"currentColor\"/>" +
      "<rect x=\"15\" y=\"18.5\" width=\"2\" height=\"2.2\" rx=\"0.6\" fill=\"currentColor\"/>" +
      "</svg>" +
      '<div class="lf-dm-toggle-tip">剧透弹幕AI过滤器</div>' +
      "<style>" +
      ".lf-dm-toggle-tip{" +
      "position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);" +
      "background-color:rgb(35,37,39);color:#fff;font-size:12px;line-height:1.5;" +
      "padding:6px 10px;border-radius:6px;white-space:nowrap;opacity:0;" +
      "pointer-events:none;transition:opacity .18s;z-index:999999;}" +
      "#" + TOGGLE_ID + ":hover{color:#00a1d6;}" +
      "#" + TOGGLE_ID + ":hover .lf-dm-toggle-tip{opacity:1;}" +
      "</style>";
    // hover 变蓝(参考弹幕开关):用 JS 事件直接设置 color,稳定可靠。
    // CSS :hover 作为辅助,但内嵌 style 作用域受限,JS 事件兜底确保生效。
    toggle.addEventListener("mouseenter", () => {
      toggle.style.color = "#00a1d6";
    });
    toggle.addEventListener("mouseleave", () => {
      toggle.style.color = "#61666d";
    });
    toggle.addEventListener("click", () => {
      const host = document.getElementById(HOST_ID);
      if (!host) return;
      // 点击机器人图标:面板当前隐藏则弹出,当前可见则重新最小化隐藏(toggle)。
      const isHidden = host.style.display === "none" || getComputedStyle(host).display === "none";
      if (isHidden) {
        showPanelHost();
      } else {
        hidePanelHost();
      }
    });
    // 插入到弹幕设置按钮之后
    dmSetting.insertAdjacentElement("afterend", toggle);
    LFRuntime.trackNode(toggle);
  }
  ensureToggleIntoDmRoot();
  // 播放器是 SPA 延迟挂载的,轮询确保注入成功(注入后由于已有 id 自动去重)
  const dmRootTimer = setInterval(ensureToggleIntoDmRoot, 500);
  onDispose(() => clearInterval(dmRootTimer));

  // 2. 单面板：主控制 + 齿轮弹窗(设置)
  const app = createApp(SpoilerPanel);
  app.mount("#" + HOST_ID);
  onDispose(() => {
    app.unmount();
    const t = document.getElementById(TOGGLE_ID);
    if (t && t.parentNode) t.parentNode.removeChild(t);
  });

  // 3. 注册页面弹幕节点过滤器。
  const unsubInterceptor = registerInterceptor();
  onDispose(() => {
    if (typeof unsubInterceptor === "function") unsubInterceptor();
  });
});

// 启动时读一次当前集信息（用于自动处理的"检测新集"）。
// 若开启了自动模式,首屏(打开视频页/刷新视频页)就自动对当前集执行过滤。
async function initAutoDetect() {
  const ready = await refreshVideoInfo();
  if (ready && shouldAutoRun()) {
    if (LFRuntime.liveDebug) LFRuntime.print(`[剧透] 自动模式:首屏自动过滤(${cleanVideoKey(location.href)})`);
    await runOnce("auto");
  }
}

function shouldAutoRun() {
  const state = store.get();
  return state.mode === "auto" &&
    !!state.apiUrl?.trim() &&
    !!state.apiModel?.trim() &&
    !!state.apiKey?.trim();
}

// 读取当前视频信息并回填面板。SPA 切集时,新集的 player.getManifest() 往往要稍后才就绪,
// 因此这里做有限重试:拿不到就在短时间内反复读,直到成功或超时。
// 避免"切集瞬间 readEpisodeInfo 返回空 -> 视频信息区被清空后永远不恢复"的竞态。
function refreshVideoInfo(maxAttempts = 15, delayMs = 250, previousCid = null) {
  return new Promise((resolve) => {
    let attempt = 0;
    const tick = async () => {
      attempt++;
      const info = await readEpisodeInfo();
      const isNewVideo = info && info.cid && (previousCid == null || info.cid !== previousCid);
      if (isNewVideo) {
        store.patch({
          cid: info.cid,
          aid: info.aid || 0,
          title: info.title || "",
          cover: info.cover || "",
          danmakuCount: info.danmakuCount || "",
        });
        resolve(true);
        return;
      }
      if (attempt >= maxAttempts) {
        resolve(false);
        return;
      }
      setTimeout(tick, delayMs);
    };
    tick();
  });
}

// 监听 SPA 内的视频切换。
// B 站点击"下一个视频"等操作会改 URL(去掉参数后的路径变化)但页面不整体跳转,
// 导致插件仍停留在上一集的分类/过滤状态。这里轮询规约后的 URL key,
// 一旦发现"干净视频 key"变化,就自动重置整个插件面板状态。
let lastVideoKey = cleanVideoKey(location.href);
function watchUrlChange() {
  const cur = cleanVideoKey(location.href);
  if (cur !== lastVideoKey) {
    // 只有非空 key 且确实变了才重置(空 key(如未加载完成)不触发)。
    if (cur) {
      lastVideoKey = cur;
      const previousCid = store.get().cid;
      // 还原旧视频已屏蔽的弹幕节点 + 清空拦截判定 + 重置面板运行态到 idle。
      restoreAllMasked();
      store.resetForUrlChange();
      // 读取新视频的标题/封面等信息回填面板(带重试,等新集信息就绪)。
      refreshVideoInfo(15, 250, previousCid).then((ready) => {
        // 自动模式:新视频(切集/点击下一集等 SPA 导航)就绪后自动过滤当前集。
        if (ready && shouldAutoRun()) {
          if (LFRuntime.liveDebug) LFRuntime.print(`[剧透] 自动模式:切集后自动过滤(${cur})`);
          runOnce("auto");
        }
      });
      if (LFRuntime.liveDebug) LFRuntime.print(`[剧透] 检测到视频切换(${cur}),已重置面板`);
    }
  }
}
// 双保险:history.pushState/replaceState 时也立即检查一次(SVG/hash 变更不会整页刷新)。
const origPush = history.pushState;
const origReplace = history.replaceState;
history.pushState = function (...args) {
  const r = origPush.apply(this, args);
  watchUrlChange();
  return r;
};
history.replaceState = function (...args) {
  const r = origReplace.apply(this, args);
  watchUrlChange();
  return r;
};
// 兜底轮询(防漏):B 站部分导航不经 pushState,靠 500ms 间隔扫描 URL。
setInterval(watchUrlChange, 500);

// 首屏加载:读当前视频信息回填面板(标题/封面),否则面板打开时视频信息区是空的。
// 若处于自动模式,同时会对当前集执行一次性自动过滤。
initAutoDetect();
}

void bootstrap();
