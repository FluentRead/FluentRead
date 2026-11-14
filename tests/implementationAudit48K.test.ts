import {siteRuleTextRows} from '@/src/core/i18n/messages/siteRules';
/**
 * @file tests/implementationAudit48K.test.ts
 * 文件职责：经公开消费者验证第 48 批 K 的学习装配、词书状态、轻量引导资源及漫画排印边界。
 * 主要内容：执行真实功能注册表，验证材料续读、写作与默认关闭的个人校订独立协调；覆盖词书公开生命周期、客户端 SFC 模板及界面翻译入口，以有界长输入、完整输出哈希和分段操作数验证排印。
 * 模块边界：Shadow UI、材料、写作和个人校订公开挂载、扫描器、存储、Canvas 和模块加载为受控端口；不读取账号、不连接日常浏览器、不复制私有业务逻辑。
 */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseHTML} from 'linkedom';
import * as Vue from 'vue';
import {compileScript, compileTemplate, parse} from 'vue/compiler-sfc';
import ts from 'typescript';
import browser from 'webextension-polyfill';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {ContentScriptContext} from 'wxt/utils/content-script-context';
import type {Config} from '@/src/core/config/model';
import type {ReencounterState} from '@/src/features/vocabulary/content/reencounterState';
import type {ReencounterOccurrence} from '@/src/features/vocabulary/content/readingText';

const ports = vi.hoisted(() => ({
    config: {vocabularyReencounterEnabled: true, interfaceSkin: 'default', interfaceFont: 'system', theme: 'light'},
    extension: {inIncognitoContext: false}, send: vi.fn(), addMessage: vi.fn(), removeMessage: vi.fn(),
    createReencounterUi: vi.fn(), installScanner: vi.fn(), patch: vi.fn(),
    scanner: {setEntries: vi.fn(), dispose: vi.fn()}, writingMounted: false,
    mountWriting: vi.fn(), unmountWriting: vi.fn(), setLanguage: vi.fn(), language: undefined as unknown as Vue.Ref<string>,
    mountCorrections: vi.fn(), unmountCorrections: vi.fn(),
    mountMaterial: vi.fn(), unmountMaterial: vi.fn(),
    shareCardMounted: false, mountShareCard: vi.fn(), unmountShareCard: vi.fn(),
    appearance: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(), reload: vi.fn(),
}));
vi.mock('vue', async importOriginal => {
    const actual = await importOriginal<typeof Vue>();
    return {...actual, Transition: {inheritAttrs: false, props: ['name', 'mode'], emits: ['afterEnter'], setup(_props: unknown, {slots}: {slots: Record<string, () => unknown>}) {
        return () => slots.default?.();
    }}};
});
vi.mock('webextension-polyfill', () => ({default: {extension: ports.extension, i18n: {getUILanguage: () => 'en-US'},
    runtime: {sendMessage: ports.send, onMessage: {addListener: ports.addMessage, removeListener: ports.removeMessage}}}}));
vi.mock('@/src/platform/shadow-ui', () => ({createVueShadowUi: ports.createReencounterUi}));
vi.mock('@/src/features/vocabulary/ui/ReencounterPanel.vue', () => ({default: {name: 'ReencounterPanelPort'}}));
vi.mock('@/src/features/vocabulary/content/scanner', () => ({installReencounterScanner: ports.installScanner}));
vi.mock('@/src/services/config/store', () => ({config: ports.config, requestConfigPatch: ports.patch, subscribeConfig: ports.subscribe}));
vi.mock('@/src/features/writing-assistant/public', () => ({mountWritingAssistant: ports.mountWriting,
    unmountWritingAssistant: ports.unmountWriting, isWritingAssistantMounted: () => ports.writingMounted}));
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({language: ports.language, setLanguage: ports.setLanguage})}));
vi.mock('@/src/ui/interfaceAppearance', () => ({applyInterfaceSkin: ports.appearance, applyInterfaceFont: ports.appearance, applyInterfaceTheme: ports.appearance}));

vi.mock('@/src/app/content/personalCorrections', () => ({mountPersonalCorrectionContent: ports.mountCorrections, unmountPersonalCorrectionContent: ports.unmountCorrections}));
vi.mock('@/src/features/personal-corrections/public', () => ({unmountPersonalCorrections: vi.fn()}));
vi.mock('@/src/features/vocabulary/material/content/public', () => ({mountMaterialContent: ports.mountMaterial}));
vi.mock('@/src/features/share-card/public', () => ({
    mountShareCard: () => {ports.shareCardMounted = true; ports.mountShareCard();},
    unmountShareCard: () => {ports.shareCardMounted = false; ports.unmountShareCard();},
    isShareCardMounted: () => ports.shareCardMounted,
}));

import {createLearningContentFeatures} from '@/src/app/content/learningFeatures';
import {createContentFeatureRegistry, type ContentFeatureRegistry} from '@/src/app/content/featureRegistry';
import {resolveBrowserCapabilities} from '@/src/platform/browser/capabilities';
import {mountVocabularyReencounter, unmountVocabularyReencounter} from '@/src/features/vocabulary/content/public';
import {registerUiLanguageBundle, translate, translateLegacyText, type RegisteredUiLanguage} from '@/src/core/i18n';
import * as i18n from '@/src/core/i18n';
import * as onboardingMessages from '@/src/core/i18n/messages/onboarding';
import brandTaglines from '@/src/core/i18n/messages/brand-taglines.json';
import {createLegacyCorrectionText, correctionRows} from '@/src/core/i18n/messages/legacy-corrections';
import {useSettingsActionContext} from '@/src/features/settings/model/useSettingsActionContext';
import {layoutMangaTranslationText} from '@/src/features/image-translation/services/mangaTypography';
import {drawMangaTranslations} from '@/src/features/image-translation/services/mangaRendering';

const ctx = {isInvalid: false} as ContentScriptContext;
const measure = (text: string, size: number) => Array.from(text).length * size;
function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
    return {promise, resolve, reject};
}
async function settle() {for (let n = 0; n < 8; n++) {await Promise.resolve(); await Vue.nextTick();}}
let app: Vue.App | undefined, registry: ContentFeatureRegistry | undefined, document: Document;
let events: Map<Element, Record<string, unknown>>;
let focused: Element | null;
beforeEach(() => {
    vi.clearAllMocks(); vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    ports.config.vocabularyReencounterEnabled = true; ports.extension.inIncognitoContext = false; ports.writingMounted = false;
    ports.shareCardMounted = false;
    ports.mountWriting.mockImplementation(() => {ports.writingMounted = true;});
    ports.unmountWriting.mockImplementation(() => {ports.writingMounted = false;});
    ports.mountMaterial.mockReturnValue(ports.unmountMaterial);
    ports.installScanner.mockReturnValue(ports.scanner); ports.patch.mockResolvedValue(undefined);
    ports.subscribe.mockReturnValue(ports.unsubscribe); ports.language = Vue.ref('zh-CN');
    ports.setLanguage.mockResolvedValue(true); ports.send.mockResolvedValue({success: true, data: []});
    ports.createReencounterUi.mockResolvedValue({remove: vi.fn(), shadowHost: {isConnected: true}});
    const dom = parseHTML('<html><body><div id="app"></div></body></html>');
    document = dom.document as unknown as Document; focused = document.body; events = new Map();
    Object.defineProperty(document, 'activeElement', {configurable: true, get: () => focused});
    vi.stubGlobal('document', document); vi.stubGlobal('window', {location: {href: 'https://github.com/team/project/issues/new'},
        addEventListener: dom.window.addEventListener.bind(dom.window), removeEventListener: dom.window.removeEventListener.bind(dom.window)});
    vi.stubGlobal('navigator', {language: 'en-US', languages: ['en-US']}); vi.stubGlobal('location', {reload: ports.reload});
    vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn()}));
});
afterEach(async () => {
    registry?.unmountAll(); registry = undefined;
    unmountVocabularyReencounter(); app?.unmount(); app = undefined;
    await settle(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function mountClient(component: Vue.Component, props: Record<string, unknown> = {}) {
    const renderer = Vue.createRenderer<Element, Element>({
        patchProp(element, key, _previous, next) {
            if (/^on[A-Z]/u.test(key)) {const actions = events.get(element) ?? {}; actions[key] = next; events.set(element, actions);}
            else if (key === 'class') element.setAttribute('class', next ?? '');
            else if (next == null || (next === false && !key.startsWith('aria-'))) element.removeAttribute(key);
            else element.setAttribute(key, String(next));
        },
        insert: (child, parent, anchor) => {parent.insertBefore(child, anchor ?? null);}, remove: node => {node.parentNode?.removeChild(node);},
        createElement: tag => {const element = document.createElement(tag); element.focus = () => {focused = element;}; return element;},
        createText: value => document.createTextNode(value) as unknown as Element,
        createComment: value => document.createComment(value) as unknown as Element,
        setText: (node, value) => {node.nodeValue = value;}, setElementText: (node, value) => {node.textContent = value;},
        parentNode: node => node.parentNode as Element | null, nextSibling: node => node.nextSibling as Element | null,
        insertStaticContent(content, parent, anchor) {
            const template = document.createElement('template'); template.innerHTML = content;
            const first = template.content.firstChild!, last = template.content.lastChild!;
            parent.insertBefore(template.content, anchor ?? null); return [first as Element, last as Element];
        },
    });
    app = renderer.createApp(component, props); app.mount(document.getElementById('app')!);
}
/** 编译完整生产 SFC 的 script 与缓存客户端 template；仅把外部端口接入其 import，资源对象直接绑定生产模块。 */
function loadClientComponent(file: 'src/ui/components/UiLanguageOnboarding.vue' | 'src/app/popup/PopupOnboarding.vue'): Vue.Component {
    const filename = resolve(file), {descriptor, errors} = parse(readFileSync(filename, 'utf8'), {filename});
    if (errors.length) throw errors[0];
    const script = compileScript(descriptor, {id: 'audit48k-client'});
    const modules: Record<string, Record<string, unknown>> = {
        vue: Vue, '@/src/core/i18n': i18n, '@/src/core/i18n/messages/onboarding': onboardingMessages,
        '@/src/core/i18n/messages/brand-taglines.json': {default: brandTaglines},
        '@/src/ui/i18n': {useUiI18n: () => ({language: ports.language, setLanguage: ports.setLanguage})},
        '@/src/features/settings/model/useSettingsActionContext': {useSettingsActionContext},
        'webextension-polyfill': {default: browser}, '@/src/services/config/store': {config: ports.config, subscribeConfig: ports.subscribe},
        '@/src/core/i18n/language': i18n,
        '@/src/ui/interfaceAppearance': {applyInterfaceSkin: ports.appearance, applyInterfaceFont: ports.appearance, applyInterfaceTheme: ports.appearance},
    };
    if (file === 'src/app/popup/PopupOnboarding.vue') modules['@/src/ui/components/UiLanguageOnboarding.vue'] = {default: loadClientComponent('src/ui/components/UiLanguageOnboarding.vue')};
    const imports = ts.createSourceFile(filename + '.ts', script.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const bindings: Record<string, unknown> = {loadPopupMain: () => Promise.reject(new Error('controlled main menu load failure'))};
    for (const node of imports.statements) {
        if (!ts.isImportDeclaration(node) || !node.importClause || node.importClause.isTypeOnly) continue;
        const module = modules[(node.moduleSpecifier as ts.StringLiteral).text];
        if (!module) throw new Error(`Unbound external SFC port: ${node.moduleSpecifier.getText(imports)}`);
        if (node.importClause.name) bindings[node.importClause.name.text] = module.default;
        const named = node.importClause.namedBindings;
        if (named && ts.isNamedImports(named)) for (const item of named.elements) if (!item.isTypeOnly) bindings[item.name.text] = module[item.propertyName?.text ?? item.name.text];
    }
    const code = ts.transpileModule(script.content, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext}, transformers: {before: [context => source => {
        const visit: ts.Visitor = node => {
            if (ts.isImportDeclaration(node)) return undefined;
            if (ts.isExportAssignment(node)) return ts.factory.createVariableStatement(undefined, ts.factory.createVariableDeclarationList([
                ts.factory.createVariableDeclaration('component', undefined, undefined, node.expression),
            ], ts.NodeFlags.Const));
            // 动态加载主菜单是外部端口；保留原 Promise 链及组件自己的失败/重试行为。
            if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
                if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]) || node.arguments[0].text !== './PopupApp.vue') throw new Error('Unexpected SFC dynamic import');
                return ts.factory.createCallExpression(ts.factory.createIdentifier('loadPopupMain'), undefined, []);
            }
            return ts.visitEachChild(node, visit, context);
        };
        return ts.visitEachChild(source, visit, context);
    }]}}).outputText.replace(/export\s*\{\s*\};?/gu, '');
    const component = new Function(...Object.keys(bindings), code + '\nreturn component;')(...Object.values(bindings));
    const template = compileTemplate({source: descriptor.template!.content, filename, id: 'audit48k-client', compilerOptions: {
        mode: 'function', cacheHandlers: true, bindingMetadata: script.bindings, expressionPlugins: ['typescript'],
    }});
    if (template.errors.length) throw template.errors[0];
    component.render = new Function('Vue', ts.transpileModule(template.code, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText)(Vue);
    return component;
}
function element(selector: string) {const node = document.querySelector(selector); expect(node, selector).not.toBeNull(); return node!;}
function click(selector: string) {const callback = events.get(element(selector))?.onClick; expect(callback).toBeTypeOf('function'); return (callback as () => unknown)();}
function learning(config: {on: boolean; writing: {enabled: boolean}; personalCorrectionsEnabled?: boolean}, browser = 'chrome') {
    const capabilities = resolveBrowserCapabilities({browser, manifestVersion: 3});
    registry = createContentFeatureRegistry(createLearningContentFeatures(ctx, config as Config, capabilities), {capabilities});
    return registry;
}
function activation(controller = new AbortController()) {return {ctx, signal: controller.signal, isCurrent: () => !controller.signal.aborted};}

describe('48K 当前写作学习装配公开消费者', () => {
    it.each([
        ['userscript', true, true, 'https://github.com/a/b/issues/new', 'skipped'],
        ['chrome', false, true, 'https://github.com/a/b/issues/new', 'skipped'],
        ['chrome', true, false, 'https://github.com/a/b/issues/new', 'skipped'],
        ['chrome', true, true, 'https://github.com/a/b/issues/new', 'mounted'],
        ['chrome', true, true, 'https://example.test/article', 'skipped'],
    ] as const)('%s 开关 %s/%s 与页面 %s 的写作注册状态', async (browser, on, writing, href, status) => {
        window.location.href = href;
        const runtime = learning({on, writing: {enabled: writing}}, browser);
        const active = activation();
        expect((await runtime.mountEnabled(active)).map(row => ({id: row.id, status: row.status}))).toEqual([
            {id: 'vocabulary-reencounter', status: 'skipped'},
            {id: 'material-resume', status: browser !== 'userscript' && on ? 'mounted' : 'skipped'},
            {id: 'personal-corrections', status: 'skipped'}, {id: 'writing-assistant', status},
            {id: 'share-card', status: on ? 'mounted' : 'skipped'},
        ]);
        expect(ports.mountMaterial).toHaveBeenCalledTimes(browser !== 'userscript' && on ? 1 : 0);
        expect(ports.mountCorrections).not.toHaveBeenCalled();
        expect(ports.mountWriting).toHaveBeenCalledTimes(status === 'mounted' ? 1 : 0);
    });
    it('配置水合和关闭协调当前写作入口，反复协调不重复挂载', async () => {
        const config = {on: true, writing: {enabled: false}};
        const runtime = learning(config); await runtime.mountEnabled(activation());
        config.writing.enabled = true;
        expect((await runtime.reconcileEnabled()).map(row => ({id: row.id, status: row.status}))).toEqual([
            {id: 'vocabulary-reencounter', status: 'skipped'},
            {id: 'material-resume', status: 'mounted'},
            {id: 'personal-corrections', status: 'skipped'}, {id: 'writing-assistant', status: 'mounted'},
            {id: 'share-card', status: 'mounted'},
        ]);
        await runtime.reconcileEnabled(); expect(ports.mountWriting).toHaveBeenCalledOnce(); expect(ports.mountMaterial).toHaveBeenCalledOnce();
        config.on = false; await runtime.reconcileEnabled();
        expect(ports.unmountMaterial).toHaveBeenCalledOnce();
        expect(ports.unmountWriting).toHaveBeenCalledOnce(); expect(ports.writingMounted).toBe(false);
        config.on = true; await runtime.reconcileEnabled();
        expect(ports.mountWriting).toHaveBeenCalledTimes(2); expect(ports.writingMounted).toBe(true);
        expect(ports.mountMaterial).toHaveBeenCalledTimes(2);
        runtime.unmountAll(); registry = undefined;
        expect(ports.unmountWriting).toHaveBeenCalledTimes(2);
        expect(ports.unmountMaterial).toHaveBeenCalledTimes(2);
    });
    it('个人校订显式开启才挂载，开关变化独立清理，不卸载或重复挂载写作', async () => {
        const config = {on: true, writing: {enabled: true}, personalCorrectionsEnabled: false};
        const runtime = learning(config), active = activation();
        await runtime.mountEnabled(active);
        expect(ports.mountWriting).toHaveBeenCalledWith(ctx);
        expect(ports.mountCorrections).not.toHaveBeenCalled();
        config.personalCorrectionsEnabled = true;
        expect((await runtime.reconcileEnabled()).filter(row => row.id === 'personal-corrections')).toEqual([{id: 'personal-corrections', status: 'mounted'}]);
        expect(ports.mountCorrections).toHaveBeenCalledWith(ctx, active.signal);
        await runtime.reconcileEnabled(); expect(ports.mountCorrections).toHaveBeenCalledOnce();
        expect(ports.mountWriting).toHaveBeenCalledOnce();
        config.personalCorrectionsEnabled = false; await runtime.reconcileEnabled();
        expect(ports.unmountCorrections).toHaveBeenCalledOnce(); expect(ports.unmountWriting).not.toHaveBeenCalled();
        config.personalCorrectionsEnabled = true; await runtime.reconcileEnabled();
        expect(ports.mountCorrections).toHaveBeenCalledTimes(2); expect(ports.mountWriting).toHaveBeenCalledOnce();
        config.on = false; await runtime.reconcileEnabled();
        expect(ports.unmountCorrections).toHaveBeenCalledTimes(2); expect(ports.unmountWriting).toHaveBeenCalledOnce();
    });
});

describe('48K 再次遇见状态合同的公开消费者', () => {
    it('无痕、关闭、失效与取消上下文不读取收藏或创建状态 UI', () => {
        ports.extension.inIncognitoContext = true; mountVocabularyReencounter(ctx, new AbortController().signal);
        ports.extension.inIncognitoContext = false; ports.config.vocabularyReencounterEnabled = false; mountVocabularyReencounter(ctx, new AbortController().signal);
        ports.config.vocabularyReencounterEnabled = true; mountVocabularyReencounter({isInvalid: true} as ContentScriptContext, new AbortController().signal);
        const controller = new AbortController(); controller.abort(); mountVocabularyReencounter(ctx, controller.signal);
        expect(ports.installScanner).not.toHaveBeenCalled(); expect(ports.send).not.toHaveBeenCalled(); expect(ports.createReencounterUi).not.toHaveBeenCalled();
    });
    it('收藏读取通过真实状态流进入浮层，关闭与暂停清空读取归属', async () => {
        const controller = new AbortController(); mountVocabularyReencounter(ctx, controller.signal); await settle();
        const callbacks = ports.installScanner.mock.calls[0][1];
        const occurrence = {entry: {id: 'k-entry', term: 'reading'}, sentence: 'Reading matters.', ranges: [{startContainer: document.body, startOffset: 0}]} as unknown as ReencounterOccurrence;
        callbacks.changed([occurrence]); await settle();
        const props = ports.createReencounterUi.mock.calls[0][1].props as {state: ReencounterState; open: (hit: ReencounterOccurrence) => Promise<void>; close: () => void; pause: () => void};
        expect(props.state).toEqual({occurrences: [occurrence], current: null, saved: null, loading: false, error: '', paused: false});
        const gate = deferred<unknown>(); ports.send.mockReturnValueOnce(gate.promise); const reading = props.open(occurrence);
        expect(props.state.current).toBe(occurrence); expect(props.state.loading).toBe(true);
        props.close(); gate.resolve({success: true, data: {...occurrence.entry, savedSentence: 'Late saved sentence'}}); await reading;
        expect(props.state.saved).toBeNull(); expect(props.state.loading).toBe(false);
        ports.send.mockResolvedValueOnce({success: true, data: {...occurrence.entry, savedSentence: 'Current saved sentence'}}); await props.open(occurrence);
        expect(props.state.saved?.savedSentence).toBe('Current saved sentence'); expect(props.state.error).toBe('');
        props.pause(); expect(props.state.paused).toBe(true); expect(props.state.current).toBeNull();
        const count = ports.send.mock.calls.length; await props.open(occurrence); expect(ports.send).toHaveBeenCalledTimes(count);
        controller.abort(); expect(ports.removeMessage).toHaveBeenCalledWith(ports.addMessage.mock.calls[0][0]);
    });
});

describe('48K 轻量资源经实际运行时消费者', () => {
    it('客户端单屏语言选择、等待、保存失败重试与立即交接使用轻量文案', async () => {
        const saved = vi.fn(), confirmed = vi.fn(); mountClient(loadClientComponent('src/ui/components/UiLanguageOnboarding.vue'), {initialLanguage: 'en-US', onSaved: saved, onConfirmed: confirmed}); await settle();
        expect(element('#language-onboarding-title').textContent).toContain('选择界面语言');
        expect(document.querySelector('[data-testid="onboarding-language-next"]')).toBeNull();
        expect(element('#language-onboarding-title').textContent).toContain('Choose interface language');
        expect(element('[role="radiogroup"]').getAttribute('aria-label')).toBe('语言 / Language');
        expect(document.querySelector('.onboarding-back')).toBeNull();
        expect(element('[data-language="ja-JP"]').textContent).toContain('日本語');
        const gate = deferred<boolean>(); ports.setLanguage.mockReturnValueOnce(gate.promise); click('.onboarding-form > .onboarding-confirm'); await settle();
        expect(element('.onboarding-form > .onboarding-confirm').textContent).toContain('加载中…'); expect(element('.onboarding-form > .onboarding-confirm').textContent).toContain('Loading…');
        expect(saved).not.toHaveBeenCalled(); expect(confirmed).not.toHaveBeenCalled();
        gate.reject(new Error('controlled persistence failure')); await settle();
        expect(element('[role="alert"]').textContent).toBe('Could not confirm the language was saved. Confirm again to retry.');
        expect(element('.onboarding-form > .onboarding-confirm').textContent).toContain('确认'); expect(element('.onboarding-form > .onboarding-confirm').textContent).toContain('Confirm');
        click('.onboarding-form > .onboarding-confirm'); await settle(); expect(saved).toHaveBeenCalledWith('en-US');
        expect(confirmed).toHaveBeenCalledOnce(); expect(confirmed).toHaveBeenCalledWith('en-US');
        expect(element('.onboarding-confirm').hasAttribute('disabled')).toBe(true);
        click('.onboarding-confirm'); await settle(); expect(saved).toHaveBeenCalledOnce(); expect(confirmed).toHaveBeenCalledOnce();
        expect(translate('language.onboardingWelcomeNext', 'zh-CN')).toBe('设置界面语言');
    });
    it('实际 Popup 模块加载失败同时显示双语反馈，重试释放订阅并调用重开端口', async () => {
        mountClient(loadClientComponent('src/app/popup/PopupOnboarding.vue')); await settle();
        click('.onboarding-form > .onboarding-confirm'); await settle();
        expect(element('.onboarding-load-error').textContent).toContain('菜单加载失败，请重试。');
        expect(element('.onboarding-load-error').textContent).toContain('The menu could not be loaded. Please retry.');
        expect(element('.onboarding-load-error button').textContent).toBe('重试 / Retry');
        click('.onboarding-load-error button'); await settle(); expect(ports.reload).toHaveBeenCalledOnce(); expect(ports.unsubscribe).toHaveBeenCalledOnce();
    });
    it.each([
        ['en-US', 'Site preferences', 'CSS selector'], ['ja-JP', 'サイト設定', 'CSS セレクター'],
        ['ko-KR', '사이트 설정', 'CSS 선택자'], ['fr-FR', 'Préférences par site', 'Sélecteur CSS'],
        ['ru-RU', 'Настройки сайтов', 'CSS-селектор'], ['es-ES', 'Preferencias por sitio', 'Selector CSS'],
    ] as const)('%s 资源经校正目录、注册与旧文案翻译保留空白和用户输入', (language, title, selector) => {
        const legacyText = createLegacyCorrectionText(language as RegisteredUiLanguage);
        registerUiLanguageBundle(language, {messages: {}, legacyText, legacyPatterns: {early: [], late: []}});
        expect(translateLegacyText(' \n网站偏好\t', language)).toBe(` \n${title}\t`);
        expect(translateLegacyText('CSS 选择器', language)).toBe(selector);
        for (const userValue of ['example.test', 'article[data-title="网站偏好"]', '{"name":"CSS 选择器"}']) expect(translateLegacyText(userValue, language)).toBe(userValue);
        // 通过目录的公开消费者取源项，逐条验证真实登记结果可用，不复制私有行或键清单。
        for (const source of [...correctionRows, ...siteRuleTextRows].map(row => row[0])) expect(translateLegacyText(source, language)).toBe(legacyText[source]);
    });
});

describe('48K 漫画排印的数值、Unicode 与操作边界', () => {
    it.each([
        ['', 10, 10, 10], [' \r\n\t ', 10, 10, 10], ['x', 0, 10, 10], ['x', -1, 10, 10],
        ['x', Infinity, 10, 10], ['x', 10, NaN, 10], ['x', 10, -1, 10], ['x', 10, 10, 0], ['x', 10, 10, Infinity],
    ] as const)('预算 %s/%s/%s/%s 无效时不调用度量端口', (text, width, height, maxSize) => {
        const port = vi.fn(measure); expect(layoutMangaTranslationText(text, width, height, port, maxSize)).toEqual({lines: [], fontSize: 0, lineHeight: 0}); expect(port).not.toHaveBeenCalled();
    });
    it('显式空行、重复空白、孤立开闭标点与长词均在实际布局保留', () => {
        expect(layoutMangaTranslationText('  Alpha  Beta\r\n\r中文 OK  ', 60, 160, measure, 10).lines).toEqual(['Alpha', 'Beta', '', '中文 OK']);
        for (const text of ['。你好', '「', '（「你好」）', '你好。再见！「好的」', '你 。好', '「 。好', 'Supercalifragilistic']) {
            const output = layoutMangaTranslationText(text, 20, 80, measure, 10);
            expect(output.lines.join('').replace(/\s/gu, '')).toBe(text.replace(/\s/gu, ''));
            expect(output.lines.every(line => measure(line, output.fontSize) <= 20)).toBe(true);
        }
    });
    it('字素拆分保留组合音标、ZWJ 家庭与肤色 emoji，闭标点不独占行', () => {
        const segmenter = new Intl.Segmenter(undefined, {granularity: 'grapheme'});
        const text = 'e\u0301👨‍👩‍👧‍👦👍🏽e\u0301';
        const layout = layoutMangaTranslationText(text, 12, 180, (value, size) => Array.from(segmenter.segment(value)).length * size, 10);
        expect(layout.lines).toEqual(['e\u0301', '👨‍👩‍👧‍👦', '👍🏽', 'e\u0301']);
    });
    it('无 Segmenter 的实际公开模块仍完整保留码点与标点', async () => {
        const intl = Intl; vi.resetModules(); vi.stubGlobal('Intl', new Proxy(intl, {get: (target, key) => key === 'Segmenter' ? undefined : Reflect.get(target, key)}));
        try {
            const fallback = await import('@/src/features/image-translation/services/mangaTypography');
            const layout = fallback.layoutMangaTranslationText('abc😊def。', 20, 100, measure, 10);
            expect(layout.lines.join('')).toBe('abc😊def。'); expect(layout.lines.every(line => measure(line, layout.fontSize) <= 20)).toBe(true);
        } finally {vi.stubGlobal('Intl', intl); vi.resetModules();}
    });
    it('短末行平衡保留字号、行数与完整标点，相近行宽无需重排', () => {
        expect(layoutMangaTranslationText('我早就确认过了。', 70, 50, measure, 10)).toEqual({lines: ['我早就确认', '过了。'], fontSize: 10, lineHeight: 12});
        expect(layoutMangaTranslationText('x Hello', 60, 100, measure, 10).lines).toEqual(['x', 'Hello']);
        expect(layoutMangaTranslationText('你好再见', 20, 100, measure, 10).lines).toEqual(['你好', '再见']);
    });
    it('135001 段有效输入无参数展开崩溃，保留显式段落并满足高度预算', () => {
        const text = 'x\n'.repeat(135000) + 'x', layout = layoutMangaTranslationText(text, 1, 1, measure, 10);
        expect(layout.lines).toHaveLength(135001); expect(layout.lines.join('\n')).toBe(text);
        expect(layout.lines.length * layout.lineHeight).toBeLessThanOrEqual(1); expect(Number.isFinite(layout.fontSize)).toBe(true);
    });
    it('135002 个排版行求最大宽度无调用上限，整段内容与字号完整保留', () => {
        const text = '你'.repeat(135001) + '好', layout = layoutMangaTranslationText(text, 1, 1000000, measure, 1);
        expect(layout.lines).toHaveLength(135002); expect(layout.lines.join('')).toBe(text); expect(layout.fontSize).toBe(1); expect(layout.lineHeight).toBe(1.2);
    });
    it('4000 字符长词分段一次，保持原始完整输出哈希及 52293 次度量，跨调用重新分段', () => {
        const segmentation = vi.spyOn(Intl.Segmenter.prototype, 'segment'), port = vi.fn(measure), text = 'abcdefghijklmnopqrst'.repeat(200);
        const layout = layoutMangaTranslationText(text, 80, 80, port, 30);
        expect(createHash('sha256').update(JSON.stringify(layout)).digest('hex')).toBe('d9829a075c3532bd9e3deb5bfead217c73a82fab2da83e91ab7c63a7305b0e2a');
        expect(segmentation).toHaveBeenCalledTimes(1); expect(port).toHaveBeenCalledTimes(52293);
        expect(layoutMangaTranslationText(text, 80, 80, measure, 30)).toEqual(layout); expect(segmentation).toHaveBeenCalledTimes(2);
    });
    it('真实漫画绘制消费者按区域裁剪完整译文，异常 Canvas 端口仍恢复状态', () => {
        const drawn: string[] = [], context = {font: '', save: vi.fn(), restore: vi.fn(), fillRect: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(),
            measureText(text: string) {return {width: measure(text, Number(this.font.match(/ ([\d.]+)px/)![1]))};},
            fillText: (text: string) => {drawn.push(text);}, strokeText: vi.fn()};
        const text = '你好。Hello world！'.repeat(20), region = {text, fontSize: 40, bbox: {x0: 5, y0: 5, x1: 195, y1: 95}};
        const pixels = new Uint8ClampedArray(200 * 100 * 4).fill(255);
        drawMangaTranslations(context as unknown as CanvasRenderingContext2D, pixels, 200, 100, [region], true, [{uniform: true, color: 'rgb(255,255,255)'}]);
        expect(drawn.join('').replace(/\s/gu, '')).toBe(text.replace(/\s/gu, '')); expect(context.rect).toHaveBeenCalledWith(5, 5, 190, 90); expect(context.clip).toHaveBeenCalledOnce(); expect(context.restore).toHaveBeenCalledOnce();
        vi.spyOn(context, 'measureText').mockImplementationOnce(() => {throw new Error('controlled canvas failure');});
        expect(() => drawMangaTranslations(context as unknown as CanvasRenderingContext2D, pixels, 200, 100, [region])).toThrow('controlled canvas failure'); expect(context.restore).toHaveBeenCalledTimes(2);
    });
});
