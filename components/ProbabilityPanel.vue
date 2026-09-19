<script setup lang="ts">
import { computed } from "vue";
import { probabilityHistogram, type ScoredDanmaku } from "../src/services/probability";

const props = defineProps<{ items: ScoredDanmaku[]; threshold: number; enabled: boolean }>();
const emit = defineEmits<{ threshold: [value: number]; save: []; detail: [] }>();
const bins = computed(() => probabilityHistogram(props.items, props.threshold, props.enabled));
const maximum = computed(() => Math.max(1, ...bins.value.map(bin => bin.count)));
function update(event: Event) {
  const value = (event.target as HTMLInputElement).valueAsNumber;
  if (Number.isFinite(value)) emit("threshold", value);
}
function binTitle(index: number) {
  const bin = bins.value[index];
  return `${(index / 10).toFixed(1)}～${((index + 1) / 10).toFixed(1)}：${bin.count} 条，屏蔽 ${bin.hidden} 条`;
}
</script>

<template>
  <section class="probability-panel" aria-label="剧透概率分布与屏蔽阈值">
    <div class="probability-heading">
      <div class="chart-title"><span>剧透概率分布</span><button class="chart-detail" title="查看弹幕详情" aria-label="查看弹幕详情" @click="emit('detail')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" /></svg></button></div>
      <div class="chart-legend"><i class="retained"></i>保留<i class="blocked"></i>屏蔽</div>
    </div>
    <div class="histogram" role="img" :aria-label="items.length ? bins.map((_, i) => binTitle(i)).join('；') : '暂无分析结果'">
      <div v-for="(bin, index) in bins" :key="index" class="bin-slot" :title="binTitle(index)">
        <span v-if="bin.count" class="bin-count">{{ bin.count }}</span>
        <div class="bin-bar" :style="{ height: (bin.count / maximum * 64) + 'px' }">
          <div class="bin-blocked" :style="{ height: (bin.count ? bin.hidden / bin.count * 100 : 0) + '%' }"></div>
        </div>
      </div>
      <div class="threshold-marker" :style="{ left: (threshold * 100) + '%' }"></div>
    </div>
    <div class="chart-axis" aria-hidden="true">
      <span v-for="tick in 11" :key="tick" :style="{ left: ((tick - 1) * 10) + '%' }">{{ ((tick - 1) / 10).toFixed(1) }}</span>
    </div>
    <div class="threshold-heading">
      <label for="sp-threshold-number">屏蔽阈值</label>
      <input id="sp-threshold-number" class="threshold-number" type="number" min="0" max="1" step="0.01"
        :value="threshold" @input="update" @change="emit('save')" />
    </div>
    <input class="threshold-slider" aria-label="屏蔽阈值" type="range" min="0" max="1" step="0.01"
      :value="threshold" @input="update" @change="emit('save')" />
  </section>
</template>

<style scoped>
.probability-panel { margin: 0 0 16px; padding: 12px; border: 1px solid #ebeef3; border-radius: 10px; }
.chart-title { display: flex; align-items: center; gap: 8px; line-height: 1.4; }
.chart-detail { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; box-sizing: border-box; border: 1px solid #e4e7ec; border-radius: 5px; padding: 0; background: #ffffff; color: #5b6472; font: inherit; font-size: 11px; cursor: pointer; transition: background .15s, color .15s; }
.chart-detail:hover { background: #f5f7fa; color: #1f2329; }
.probability-heading, .threshold-heading { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #5b6472; }
.chart-legend { display: flex; align-items: center; gap: 4px; font-size: 10px; color: #8a919f; }
.chart-legend i { width: 7px; height: 7px; border-radius: 2px; margin-left: 5px; }
.retained { background: #dce1e8; }
.blocked, .bin-blocked { background: #00a1d6; }
.histogram { position: relative; display: flex; align-items: flex-end; height: 88px; margin-top: 8px; border-bottom: 1px solid #dce1e8; }
.bin-slot { width: 10%; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; }
.bin-count { font-size: 9px; color: #8a919f; line-height: 16px; font-variant-numeric: tabular-nums; }
.bin-bar { width: calc(100% - 4px); background: #dce1e8; position: relative; border-radius: 2px 2px 0 0; overflow: hidden; }
.bin-blocked { position: absolute; bottom: 0; width: 100%; transition: height .08s linear; }
.threshold-marker { position: absolute; top: 0; bottom: 0; border-left: 1px dashed #00a1d6; pointer-events: none; }
.chart-axis { height: 24px; position: relative; color: #8a919f; font-size: 9px; }
.chart-axis span { position: absolute; top: 4px; transform: translateX(-50%); }
.threshold-number { width: 62px; padding: 3px 4px; box-sizing: border-box; border: 1px solid #e4e7ec; border-radius: 5px; font: inherit; text-align: center; color: #1f2329; background: white; }
.threshold-slider { display: block; width: 100%; margin: 10px 0 0; accent-color: #00a1d6; cursor: pointer; }
</style>
