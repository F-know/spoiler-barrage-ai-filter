import test from 'node:test';
import assert from 'node:assert/strict';
import { detailWindow, variableDetailWindow, rowAtOffset, shouldFollowLogs } from '../src/services/panel-view.ts';

test('variable rows cover full long comments and keep short comments compact', () => {
  const offsets = [0];
  for (let i = 0; i < 50000; i++) offsets.push(offsets.at(-1) + (i % 3 === 0 ? 1800 : 54));
  assert.equal(rowAtOffset(offsets, 900), 0);
  assert.equal(rowAtOffset(offsets, 1800), 1);
  for (const top of [0, 900, 1800, 10000, offsets.at(-1) - 500]) {
    const { start, end } = variableDetailWindow(offsets, top, 500);
    assert.ok(offsets[start] <= top);
    assert.ok(offsets[end] >= Math.min(offsets.at(-1), top + 500));
    assert.ok(end - start <= 22);
  }
  assert.deepEqual(variableDetailWindow([0], 0, 500), { start: 0, end: 0 });
  assert.deepEqual(variableDetailWindow([0, 9000], 4500, 500), { start: 0, end: 1 });
  assert.ok(variableDetailWindow(offsets, 10000, 500).start > 0);
});

test('large detail lists keep a bounded window, discard old rows and cover the visible range', () => {
  for (const count of [0, 1, 519, 50000, 100000]) {
    for (const top of [0, 77, 20000, Math.max(0, count * 76 - 500)]) {
      const { start, end } = detailWindow(count, top, 500);
      assert.ok(start >= 0 && end <= count && end >= start);
      assert.ok(end - start <= 17);
      if (count && top < count * 76) {
        assert.ok(start <= Math.floor(top / 76));
        assert.ok(end >= Math.min(count, Math.ceil((top + 500) / 76)));
      }
    }
  }
  assert.ok(detailWindow(50000, 20000, 500).start > 0);
  assert.equal(detailWindow(50000, 0, 500).start, 0);
});

test('threshold updates never scroll logs; new logs follow only near bottom', () => {
  const logs = ['first'];
  const bottom = { scrollHeight: 1000, scrollTop: 800, clientHeight: 200 };
  assert.equal(shouldFollowLogs(logs, logs, bottom), false);
  assert.equal(shouldFollowLogs(logs, [...logs, 'next'], bottom), true);
  assert.equal(shouldFollowLogs(logs, [...logs, 'next'], { ...bottom, scrollTop: 0 }), false);
  assert.equal(shouldFollowLogs(logs, [], null), false);
});
