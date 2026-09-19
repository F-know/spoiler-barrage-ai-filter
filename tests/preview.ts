// 本地 UI 回归夹具，不参与扩展构建，不加载真实凭据。
import { createApp } from 'vue';
import SpoilerPanel from '../components/SpoilerPanel.vue';
import { store } from '../src/services/state';
import { registerInterceptor } from '../src/services/interceptor';

Object.assign(globalThis, {
  LFStore: { get: async (_key: string, fallback: unknown) => fallback, set: async () => {} },
  LFRuntime: { trackNode: () => {}, runInMainWorld: async () => null },
});
createApp(SpoilerPanel).mount('#lf-spoiler-dm-root');
registerInterceptor();
document.getElementById('seed')!.onclick = () => {
  const items = Array.from({ length: 100 }, (_, i) => ({
    text: '测试弹幕' + i, time: i, probability: (i % 10) / 10 + 0.02,
  }));
  items.push(
    { text: '下一集主角死亡', time: 1, probability: 0.95 },
    { text: '他是凶手', time: 2, probability: 0.7 },
    { text: '音乐很好听', time: 3, probability: 0.02 },
  );
  store.patch({ title: '本地预览视频', phase: 'done', analysisItems: items, totalCount: items.length, analyzedCount: items.length, progress: 1 });
};
document.getElementById('empty')!.onclick = () => store.resetForUrlChange();
