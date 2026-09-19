import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer, nextTick } from 'vue';
import SpoilerPanel from '../components/SpoilerPanel.vue';

test('actual panel setup and template render without initialization errors', async () => {
  globalThis.cancelAnimationFrame = () => {};
  globalThis.LFStore = { get: async (_key, fallback) => fallback };
  globalThis.document = { getElementById: () => null };
  const node = (type, text = '') => ({ type, text, children: [], parent: null });
  const renderer = createRenderer({
    insertStaticContent: (html, parent, anchor) => {
      const el = node('static', html);
      el.parent = parent;
      const index = parent.children.indexOf(anchor);
      if (index < 0) parent.children.push(el);
      else parent.children.splice(index, 0, el);
      return [el, el];
    },
    createElement: type => node(type), createText: text => node('text', text),
    createComment: text => node('comment', text),
    setText: (el, text) => { el.text = text; },
    setElementText: (el, text) => { el.text = text; el.children = []; },
    patchProp: (el, key, _previous, value) => { el[key] = value; },
    insert: (el, parent, anchor = null) => {
      el.parent = parent;
      const index = parent.children.indexOf(anchor);
      if (index < 0) parent.children.push(el);
      else parent.children.splice(index, 0, el);
    },
    remove: el => { el.parent?.children.splice(el.parent.children.indexOf(el), 1); },
    parentNode: el => el.parent,
    nextSibling: el => el.parent?.children[el.parent.children.indexOf(el) + 1] ?? null,
  });
  const app = renderer.createApp(SpoilerPanel);
  const errors = [];
  app.config.errorHandler = error => errors.push(error);
  const root = node('root');
  app.mount(root);
  await nextTick();
  const contents = el => el.text + ' ' + (el.title ?? '') + ' ' + el.children.map(contents).join(' ');
  const html = contents(root);
  app.unmount();
  assert.deepEqual(errors, []);
  assert.match(html, /剧透弹幕AI过滤器/);
  assert.match(html, /开始分析/);
  assert.match(html, /查看弹幕详情/);
});
