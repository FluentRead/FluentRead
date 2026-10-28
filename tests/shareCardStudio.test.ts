import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {compileScript, parse} from 'vue/compiler-sfc';
import ts from 'typescript';
import {afterEach, describe, expect, it, vi} from 'vitest';
import * as preferences from '@/src/core/config/shareCard';
import * as core from '@/src/features/share-card/core';

const Vue = createRequire(import.meta.url)('vue') as typeof import('vue');
let app: import('vue').App | undefined;
afterEach(() => {app?.unmount(); vi.useRealTimers(); vi.unstubAllGlobals();});
function fixture() {
    vi.useFakeTimers();
    const click = vi.fn(), remove = vi.fn(), append = vi.fn();
    vi.stubGlobal('document', {createElement: () => ({click, remove})});
    vi.stubGlobal('URL', {createObjectURL: () => 'blob:preview', revokeObjectURL: vi.fn()});
    const copy = vi.fn().mockResolvedValue(undefined);
    const patch = vi.fn().mockResolvedValue(undefined);
    const render = vi.fn().mockResolvedValue({canvas: {setAttribute() {}}, blob: new Blob(['png'])});
    const modules: Record<string, any> = {
        vue: Vue, 'webextension-polyfill': {default: {runtime: {sendMessage: vi.fn()}}},
        '@/src/services/config/store': {config: {shareCard: preferences.normalizeShareCardPreferences()}, requestConfigPatch: patch},
        '@/src/core/config/shareCard': preferences,
        '@/src/ui/i18n': {useUiI18n: () => ({t: (key: string) => key, language: Vue.ref('zh-CN')})},
        '../core': core,
        '../render': {renderShareCard: render, ShareCardRenderError: class extends Error {}},
        '../export': {canCopyCardImage: () => true, copyCardImage: copy, shareCardFilename: () => 'card.png'},
    };
    const filename = resolve('src/features/share-card/ui/ShareCardStudio.vue');
    const {descriptor} = parse(readFileSync(filename, 'utf8'), {filename});
    const js = ts.transpileModule(compileScript(descriptor, {id: 'card-studio'}).content, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext}}).outputText
        .replace(/import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?/g, (_all, binding, id) => binding.startsWith('{') ? `const ${binding.replace(/\s+as\s+/g, ': ')} = modules[${JSON.stringify(id)}];` : `const ${binding} = modules[${JSON.stringify(id)}].default;`)
        .replace('export default', 'return');
    const component = new Function('modules', js)(modules); component.render = () => null;
    const renderer = Vue.createRenderer<any, any>({patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null});
    app = renderer.createApp(component); app.config.warnHandler = () => undefined;
    const state = (app.mount({}).$ as any).setupState;
    state.dialog = {open: false, showModal() {this.open = true;}, close() {this.open = false;}, append};
    state.canvasSlot = {replaceChildren() {}};
    const open = async () => {await state.open({original: 'Hello', translation: '你好', source: ''}); await vi.advanceTimersByTimeAsync(100);};
    return {state, copy, patch, render, click, remove, open};
}
describe('制作卡片操作反馈与生命周期', () => {
    it('无法创建下载节点时提示失败并允许随后重试', async () => {
        const f = fixture(); await f.open();
        const create = vi.spyOn(document, 'createElement').mockImplementationOnce(() => {throw Error('blocked');});
        expect(() => f.state.saveImage()).not.toThrow();
        expect(f.state.status).toBe('shareCard.saveFailed'); expect(f.state.statusError).toBe(true);
        await vi.advanceTimersByTimeAsync(401); f.state.saveImage();
        expect(f.click).toHaveBeenCalledOnce(); expect(f.state.status).toBe('shareCard.saved');
        create.mockRestore();
    });
    it('保存触发同步关闭并重开时旧解锁计时器不影响新卡片的复制', async () => {
        const f = fixture(); await f.open();
        let reopened!: Promise<void>;
        f.click.mockImplementationOnce(() => {
            f.state.close(); reopened = f.state.open({original: 'New', translation: '新', source: ''});
        });
        f.state.saveImage(); await reopened; await vi.advanceTimersByTimeAsync(100);
        let finish!: () => void;
        f.copy.mockReturnValueOnce(new Promise<void>(resolve => {finish = resolve;}));
        const copy = f.state.copyImage(); expect(f.state.busy).toBe(true);
        await vi.advanceTimersByTimeAsync(401); expect(f.state.busy).toBe(true);
        f.state.saveImage(); expect(f.click).toHaveBeenCalledOnce();
        finish(); await copy; expect(f.state.status).toBe('shareCard.copied');
    });
    it('旧保存同步关闭后抛错不会向新卡片报告失败', async () => {
        const f = fixture(); await f.open(); let reopened!: Promise<void>;
        f.click.mockImplementationOnce(() => {
            f.state.close(); reopened = f.state.open({original: 'New', translation: '新', source: ''});
            throw Error('late');
        });
        expect(() => f.state.saveImage()).not.toThrow(); await reopened;
        expect(f.state.status).toBe(''); expect(f.remove).toHaveBeenCalledOnce();
    });
    it('下载节点清理抛错不遮挡失败提示或阻止下一次操作', async () => {
        const f = fixture(); await f.open();
        f.click.mockImplementationOnce(() => {throw Error('blocked');});
        f.remove.mockImplementationOnce(() => {throw Error('remove failed');});
        expect(() => f.state.saveImage()).not.toThrow(); expect(f.state.status).toBe('shareCard.saveFailed');
        await vi.advanceTimersByTimeAsync(401); f.state.saveImage();
        expect(f.state.status).toBe('shareCard.saved'); expect(f.remove).toHaveBeenCalledTimes(2);
    });
    it('保存反馈、重复保存重新通知、异常提示并释放下载节点', async () => {
        const f = fixture(); await f.open(); f.state.saveImage();
        expect(f.state.status).toBe('shareCard.saved'); expect(f.state.statusError).toBe(false);
        const sequence = f.state.feedbackSequence; f.state.saveImage(); expect(f.state.feedbackSequence).toBe(sequence);
        await vi.advanceTimersByTimeAsync(401); f.state.saveImage(); expect(f.state.feedbackSequence).toBe(sequence + 1);
        await vi.advanceTimersByTimeAsync(401); f.click.mockImplementationOnce(() => {throw Error('blocked');}); f.state.saveImage();
        expect(f.state.status).toBe('shareCard.saveFailed'); expect(f.state.statusError).toBe(true); expect(f.remove).toHaveBeenCalledTimes(3);
    });
    it('复制忙碌防重入，切换设置不吞掉已复制图片的反馈', async () => {
        const f = fixture(); await f.open(); let resolve!: () => void;
        f.copy.mockReturnValueOnce(new Promise<void>(yes => {resolve = yes;}));
        const task = f.state.copyImage(); expect(f.state.activeAction).toBe('copy'); expect(f.state.busy).toBe(true);
        await f.state.copyImage(); f.state.saveImage(); expect(f.copy).toHaveBeenCalledOnce(); expect(f.click).not.toHaveBeenCalled();
        f.state.setPreference('theme', 'linen'); resolve(); await task; await vi.advanceTimersByTimeAsync(100);
        expect(f.state.status).toBe('shareCard.copied'); expect(f.state.busy).toBe(false);
        f.state.setPreference('fontSize', 'large'); expect(f.state.status).toBe('shareCard.copied');
    });
    it('复制失败后可再次复制并显示成功反馈', async () => {
        const f = fixture(); await f.open(); f.copy.mockRejectedValueOnce(Error('denied'));
        await f.state.copyImage(); expect(f.state.status).toBe('shareCard.copyFailed'); expect(f.state.statusError).toBe(true);
        await f.state.copyImage(); expect(f.state.status).toBe('shareCard.copied'); expect(f.state.statusError).toBe(false);
    });
    it('关闭重开后旧复制结果不能提示，也不能解锁新操作', async () => {
        const f = fixture(); await f.open(); let old!: () => void, latest!: () => void;
        f.copy.mockReturnValueOnce(new Promise<void>(yes => {old = yes;})); const stale = f.state.copyImage();
        f.state.close(); await f.open(); f.copy.mockReturnValueOnce(new Promise<void>(yes => {latest = yes;})); const current = f.state.copyImage();
        old(); await stale; expect(f.state.status).toBe(''); expect(f.state.busy).toBe(true);
        latest(); await current; expect(f.state.status).toBe('shareCard.copied');
        f.state.close(); expect(f.state.status).toBe(''); expect(f.state.activeAction).toBe('');
    });
    it('外观保存失败提示不会从旧窗口泄漏到重新打开的窗口', async () => {
        const f = fixture(); await f.open(); f.patch.mockRejectedValueOnce(Error('offline'));
        f.state.setPreference('showSource', false); await vi.advanceTimersByTimeAsync(100);
        expect(f.state.status).toBe('shareCard.preferenceFailed');
        let reject!: (reason: Error) => void; f.patch.mockReturnValueOnce(new Promise((_yes, no) => {reject = no;}));
        f.state.setPreference('showBrand', false); await Vue.nextTick(); f.state.close(); await f.open();
        reject(Error('late')); await Vue.nextTick(); await Vue.nextTick(); expect(f.state.status).toBe('');
    });
    it('已打开时新摘录替换旧摘录，旧操作不锁住新卡片', async () => {
        const f = fixture(); await f.open(); let resolve!: () => void;
        f.copy.mockReturnValueOnce(new Promise<void>(yes => {resolve = yes;})); const old = f.state.copyImage();
        await f.open(); expect(f.state.busy).toBe(false); expect(f.state.activeAction).toBe('');
        resolve(); await old; expect(f.state.status).toBe('');
        await f.state.copyImage(); expect(f.state.status).toBe('shareCard.copied');
    });
});
