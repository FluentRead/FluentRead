import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {parse, compileScript} from 'vue/compiler-sfc';
import ts from 'typescript';
import {parseHTML} from 'linkedom';
import {afterEach, describe, expect, it, vi} from 'vitest';
import * as areaCore from '@/src/features/area-translation/core';

const Vue = createRequire(import.meta.url)('vue') as typeof import('vue');
let app: import('vue').App | undefined;
afterEach(() => {app?.unmount(); vi.unstubAllGlobals();});
function deferred() {let resolve!: () => void; const promise = new Promise<void>(yes => {resolve = yes;}); return {promise, resolve};}

function mountRecovery() {
  const {window, document} = parseHTML('<html><body></body></html>');
  Object.defineProperty(document, 'visibilityState', {value: 'visible'});
  Object.assign(window, {matchMedia: () => ({matches: false, addEventListener() {}, removeEventListener() {}})});
  vi.stubGlobal('window', window); vi.stubGlobal('document', document);
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  const config = {on: true, selectionAreaEnabled: true, animations: true, from: 'auto', theme: 'light'};
  const captured = 'data:image/png,original-selection';
  const result = {image: 'data:image/png,crop', sourceText: 'Source', translatedText: '译文', service: 'microsoft', serviceName: '微软翻译', model: '', mode: 'standard', lines: [], warnings: []};
  const capture = vi.fn().mockResolvedValue(captured);
  const translate = vi.fn().mockRejectedValueOnce(new Error('图片文字识别需要先下载中文、English语言包，请前往设置下载')).mockResolvedValue(result);
  const prepare = vi.fn().mockResolvedValue(undefined);
  const modules: Record<string, any> = {
    vue: Vue, 'webextension-polyfill': {default: {runtime: {sendMessage: vi.fn()}}},
    '@/src/services/config/store': {config, subscribeConfig: () => () => undefined},
    '@/src/core/config/customOpenAI': {isCustomOpenAIProviderId: () => false},
    '@/src/ui/i18n': {useUiI18n: () => ({translateLegacy: (text: string) => text})},
    '@/src/features/area-translation/services/client': {captureVisibleAreaInExtension: capture, translateCapturedAreaInExtension: translate},
    '@/src/features/area-translation/core': areaCore,
    '@/src/features/image-translation/public': {prepareImageOcrLanguages: prepare},
  };
  const filename = resolve('src/features/area-translation/ui/AreaTranslator.vue');
  const {descriptor} = parse(readFileSync(filename, 'utf8'), {filename});
  const script = compileScript(descriptor, {id: 'area-recovery'}).content;
  const js = ts.transpileModule(script, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext}}).outputText
    .replace(/import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?/g, (_all, binding, id) => binding.startsWith('{')
      ? `const ${binding.replace(/\s+as\s+/g, ': ')} = modules[${JSON.stringify(id)}];`
      : `const ${binding} = modules[${JSON.stringify(id)}].default;`)
    .replace('export default', 'return');
  const component = new Function('modules', js)(modules);
  component.render = () => null;
  const renderer = Vue.createRenderer<any, any>({patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null});
  app = renderer.createApp(component); app.config.warnHandler = () => undefined;
  const vm = app.mount({});
  const state = (vm.$ as any).setupState;
  const rect = {left: 10, top: 20, width: 120, height: 90};
  state.activeRect = rect; state.phase = 'loading';
  return {state, rect, config, captured, capture, translate, prepare, result};
}

describe('圈选缺少语言包的一键恢复', () => {
  it('缺包后只下载一次，使用原截图和原语言继续，无需重新圈选', async () => {
    const f = mountRecovery();
    await f.state.requestTranslation(f.rect);
    expect(f.state.needsLanguages).toBe(true); expect(f.state.phase).toBe('error');
    f.config.from = 'ja';
    f.state.downloadLanguagesAndRetry(); f.state.downloadLanguagesAndRetry();
    await vi.waitFor(() => expect(f.state.phase).toBe('translated'));
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.prepare).toHaveBeenCalledWith('auto', expect.any(AbortSignal));
    expect(f.capture).toHaveBeenCalledOnce();
    expect(f.translate.mock.calls[1][0]).toBe(f.captured);
    expect(f.translate.mock.calls[1][2]).toBe('auto');
    expect(f.state.result.translatedText).toBe('译文');
  });
  it('下载失败保留恢复按钮，取消下载后迟到结果不触发翻译', async () => {
    const f = mountRecovery(); await f.state.requestTranslation(f.rect);
    f.prepare.mockRejectedValueOnce(new Error('network unavailable'));
    f.state.downloadLanguagesAndRetry();
    await vi.waitFor(() => expect(f.state.phase).toBe('error'));
    expect(f.state.needsLanguages).toBe(true);
    const pending = deferred(); f.prepare.mockReturnValueOnce(pending.promise);
    f.state.downloadLanguagesAndRetry();
    expect(f.state.preparingLanguages).toBe(true);
    f.state.clearResult(); pending.resolve(); await Vue.nextTick();
    expect(f.prepare.mock.calls.at(-1)![1].aborted).toBe(true);
    expect(f.translate).toHaveBeenCalledOnce(); expect(f.state.phase).toBe('idle');
  });
});
