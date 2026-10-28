// @vitest-environment node
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseHTML } from 'linkedom';
import * as ts from 'typescript';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import vue from '@vitejs/plugin-vue';
import {createServer, type ViteDevServer} from 'vite';

let server: ViteDevServer | undefined;
async function loadPromptTemplateEditor(vueRuntime: typeof import('vue')): Promise<import('vue').Component> {
  const compiler = createRequire(require.resolve('@vitejs/plugin-vue'))('@vue/compiler-sfc');
  const filename = resolve(process.cwd(), 'src/features/settings/ui/services/PromptTemplateEditor.vue');
  const source = readFileSync(filename, 'utf8');
  const descriptor = compiler.parse(source, {filename}).descriptor;
  const compiledScript = compiler.compileScript(descriptor, {id: 'data-v-settings-composition-test'});
  server = await createServer({root: process.cwd(), configFile: false, appType: 'custom', logLevel: 'silent',
    plugins: [{name: 'prompt-help-display-port', enforce: 'pre', resolveId(id) {return id.endsWith('/FieldHelp.vue') ? '\0prompt-help' : null;},
      load(id) {return id === '\0prompt-help' ? 'export default {render: () => null};' : null;}}, vue()],
    resolve: {alias: {'@': process.cwd()}}, server: {hmr: false, middlewareMode: true}});
  const component = (await server.ssrLoadModule('/src/features/settings/ui/services/PromptTemplateEditor.vue')).default;
  component.ssrRender = undefined;

  const template = compiler.compileTemplate({
    source: descriptor.template.content,
    filename,
    id: 'data-v-settings-composition-test',
    compilerOptions: {mode: 'function', bindingMetadata: compiledScript.bindings, expressionPlugins: ['typescript']},
  });
  expect(template.errors).toEqual([]);
  const renderCode = ts.transpileModule(template.code, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
  component.render = new Function('Vue', renderCode)(vueRuntime);
  return component;
}

function createDomRenderer(vueRuntime: typeof import('vue'), document: Document) {
  return vueRuntime.createRenderer({
    patchProp(element: any, key: string, previous: unknown, next: unknown) {
      if (key === 'class') {
        element.className = String(next ?? '');
        return;
      }
      if (key === 'value') {
        element.value = next ?? '';
        return;
      }
      if (/^on[A-Z]/u.test(key)) {
        const eventName = key.slice(2).toLowerCase();
        if (previous) element.removeEventListener(eventName, previous);
        if (next) element.addEventListener(eventName, next);
        return;
      }
      if (next === null || next === undefined || next === false) element.removeAttribute(key);
      else element.setAttribute(key, String(next));
    },
    insert: (child: any, parent: any, anchor: any = null) => parent.insertBefore(child, anchor),
    remove: (child: any) => child.parentNode?.removeChild(child),
    createElement: (type: string) => document.createElement(type),
    createText: (text: string) => document.createTextNode(text),
    createComment: (text: string) => document.createComment(text),
    setText: (node: any, text: string) => { node.nodeValue = text; },
    setElementText: (element: any, text: string) => { element.textContent = text; },
    parentNode: (node: any) => node.parentNode,
    nextSibling: (node: any) => node.nextSibling,
    querySelector: (selector: string) => document.querySelector(selector),
    setScopeId: () => undefined,
    cloneNode: (node: any) => node.cloneNode(true),
    insertStaticContent: (content: string, parent: any, anchor: any) => {
      const element = document.createElement('template');
      element.innerHTML = content;
      const first = element.content.firstChild;
      const last = element.content.lastChild;
      parent.insertBefore(element.content, anchor);
      return [first, last];
    },
  });
}

function compositionEvent(window: any, type: string, data: string): Event {
  const event = new window.Event(type, {bubbles: true});
  Object.defineProperty(event, 'data', {configurable: true, value: data});
  return event;
}

// 组件定义无状态，三个用例只需编译和加载一次；每次挂载仍使用独立 DOM 与 app。
let cachedEditor: Promise<import('vue').Component> | undefined;
afterEach(() => {vi.unstubAllGlobals();});
afterAll(async () => {await server?.close();server = undefined;cachedEditor = undefined;});

async function mountEditor() {
  const {window} = parseHTML('<html><body><div id="app"></div></body></html>');
  const {document} = window;
  for (const [key, value] of Object.entries({
    window,
    document,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    SVGElement: window.SVGElement,
    Event: window.Event,
    Text: window.Text,
    Comment: window.Comment,
    navigator: window.navigator,
  })) {
    vi.stubGlobal(key, value);
  }

  const require = createRequire(import.meta.url);
  const vueRuntime = require('vue') as typeof import('vue');
  const editor = await (cachedEditor ??= loadPromptTemplateEditor(vueRuntime));
  const updates: string[] = [];
  const saves: string[] = [];
  let setExternalValue: (value: string) => void = () => undefined;
  const appComponent = vueRuntime.defineComponent({
    setup() {
      const value = vueRuntime.ref('原始提示词');
      setExternalValue = (next) => { value.value = next; };
      vueRuntime.watch(value, (next) => saves.push(next), {flush: 'sync'});
      return {value};
    },
    render() {
      return vueRuntime.h(editor, {
        role: 'user',
        modelValue: this.value,
        'onUpdate:modelValue': (next: string) => {
          updates.push(next);
          this.value = next;
        },
      });
    },
  });
  const app = createDomRenderer(vueRuntime, document).createApp(appComponent);
  app.provide(vueRuntime.ssrContextKey, {modules: new Set<string>()});
  app.mount(document.getElementById('app')!);
  await vueRuntime.nextTick();
  return {
    app,
    document,
    textarea: document.querySelector('textarea') as HTMLTextAreaElement,
    updates,
    saves,
    setExternalValue,
    nextTick: vueRuntime.nextTick,
    Event: window.Event,
    window,
  };
}

describe('设置页输入法与自动保存集成', () => {
  it('原生提示词 textarea 在 IME 组合期间不保存中间文本，只提交最终文本', async () => {
    const h = await mountEditor();
    expect(h.textarea).not.toBeNull();
    h.textarea.dispatchEvent(compositionEvent(h.window, 'compositionstart', 'n'));
    h.textarea.value = 'ni';
    h.textarea.dispatchEvent(new h.Event('input', {bubbles: true}));
    await h.nextTick();

    expect(h.updates).toEqual([]);
    expect(h.saves).toEqual([]);

    h.textarea.value = '你';
    h.textarea.dispatchEvent(compositionEvent(h.window, 'compositionend', '你'));
    h.textarea.dispatchEvent(new h.Event('input', {bubbles: true}));
    await h.nextTick();

    expect(h.updates).toEqual(['你']);
    expect(h.saves).toEqual(['你']);
    h.app.unmount();
  });

  it('外部 modelValue 变化后不会吞掉与旧提交值相同的新输入', async () => {
    const h = await mountEditor();
    h.textarea.value = '你';
    h.textarea.dispatchEvent(new h.Event('input', {bubbles: true}));
    await h.nextTick();

    h.setExternalValue('other');
    await h.nextTick();
    expect(h.textarea.value).toBe('other');

    h.textarea.value = '你';
    h.textarea.dispatchEvent(new h.Event('input', {bubbles: true}));
    await h.nextTick();

    expect(h.updates).toEqual(['你', '你']);
    expect(h.saves).toEqual(['你', 'other', '你']);
    h.app.unmount();
  });

  it('InputEvent.isComposing 为 true 时即使漏掉 compositionstart 也不会提交中间文本', async () => {
    const h = await mountEditor();
    h.textarea.value = 'ni';
    const composingInput = new h.Event('input', {bubbles: true});
    Object.defineProperty(composingInput, 'isComposing', {configurable: true, value: true});
    h.textarea.dispatchEvent(composingInput);
    await h.nextTick();
    expect(h.updates).toEqual([]);
    expect(h.saves).toEqual([]);

    h.textarea.value = '你';
    h.textarea.dispatchEvent(compositionEvent(h.window, 'compositionend', '你'));
    await h.nextTick();
    expect(h.updates).toEqual(['你']);
    expect(h.saves).toEqual(['你']);
    h.app.unmount();
  });
});
