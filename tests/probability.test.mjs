import test from 'node:test';
import assert from 'node:assert/strict';
import { probabilityHistogram, sortDanmaku } from '../src/services/probability.ts';
import { store } from '../src/services/state.ts';
import { applyAllMasked, restoreAllMasked } from '../src/services/interceptor.ts';

const items = [0, 0.099, 0.1, 0.69, 0.7, 0.7, 0.99, 1].map((probability, i) => ({
  text: '弹幕' + i, time: i, probability,
}));
test('all-comment sorting retains safe comments and duplicates without mutating results', () => {
  const source = [items[7], items[0], items[4], items[4], items[5]];
  const snapshot = [...source];
  assert.deepEqual(sortDanmaku(source, 'time-asc').map(i => i.time), [0, 4, 4, 5, 7]);
  assert.deepEqual(sortDanmaku(source, 'time-desc').map(i => i.time), [7, 5, 4, 4, 0]);
  assert.deepEqual(sortDanmaku(source, 'probability-desc').map(i => i.probability), [1, 0.7, 0.7, 0.7, 0]);
  assert.deepEqual(sortDanmaku(source, 'probability-asc').map(i => i.probability), [0, 0.7, 0.7, 0.7, 1]);
  assert.deepEqual(source, snapshot);
});
test('ten bins include exact boundaries and duplicates; highlighted counts use exact threshold', () => {
  let bins = probabilityHistogram(items, 0.7);
  assert.equal(bins.length, 10);
  assert.equal(bins[0].count, 2);
  assert.equal(bins[1].count, 1);
  assert.equal(bins[9].count, 2);
  assert.equal(bins.reduce((n, bin) => n + bin.count, 0), items.length);
  assert.equal(bins.reduce((n, bin) => n + bin.hidden, 0), 4);
  bins = probabilityHistogram(items, 0.995);
  assert.equal(bins[9].hidden, 1);
  assert.equal(probabilityHistogram(items, 0)[0].hidden, 2);
  assert.ok(probabilityHistogram(items, 0, false).every(bin => !bin.hidden));
});

test('threshold changes update counts/details and actual DOM both ways without another request', () => {
  store.resetForUrlChange();
  store.setAnalysis(items);
  store.setThreshold(0.7);
  assert.equal(store.get().filteredDm.length, 4);
  assert.equal(store.shouldHide('弹幕4'), true);
  const node = { textContent: '弹幕4', isConnected: true, querySelector: () => null };
  const container = { children: [], querySelectorAll: () => [node] };
  globalThis.document = { querySelectorAll: () => [container] };
  applyAllMasked();
  assert.equal(node.textContent, '<已屏蔽>');
  store.setThreshold(0.8);
  applyAllMasked();
  assert.equal(node.textContent, '弹幕4');
  assert.equal(store.get().filteredDm.length, 2);
  store.setThreshold(0.5);
  applyAllMasked();
  assert.equal(node.textContent, '<已屏蔽>');
  assert.equal(store.get().filteredDm.length, 5);
  // A recycled node must never restore the previous comment.
  node.textContent = '播放器复用了这个节点';
  restoreAllMasked();
  assert.equal(node.textContent, '播放器复用了这个节点');
  store.patch({ interceptEnabled: false });
  assert.equal(store.get().filteredDm.length, 0);
  assert.equal(store.shouldHide('弹幕7'), false);
  store.patch({ interceptEnabled: true, replaceText: '' });
  node.textContent = '弹幕7';
  applyAllMasked();
  assert.equal(node.textContent, '');
  store.setThreshold(1);
  applyAllMasked();
  assert.equal(node.textContent, '');
  store.resetForUrlChange();
  applyAllMasked();
  assert.equal(node.textContent, '弹幕7');
  assert.equal(store.shouldHide('弹幕7'), false);
});
