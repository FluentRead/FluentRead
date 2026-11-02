import {parseHTML} from 'linkedom';
import {resolve} from 'node:path';
import * as Vue from 'vue';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {compileVueInlineFixture} from './helpers/compiledVueFixture';
import {registerAllUiLanguageBundles} from './helpers/uiLanguageBundles';
import {UI_LANGUAGE_OPTIONS, translate, translateLegacyText, type UiLanguage} from '@/src/core/i18n';
import {Config, normalizeConfig} from '@/src/core/config/model';
import * as appearance from '@/src/core/config/interfaceAppearance';
import * as harness from '@/src/core/config/harness';
import * as learning from '@/src/features/vocabulary/learningModel';
import * as source from '@/src/features/vocabulary/source';
import * as translationResult from '@/src/core/translation/result';
import * as catalog from '@/src/core/config/catalog';
import * as customOpenAI from '@/src/core/config/customOpenAI';
import * as writing from '@/src/core/config/writing';
import type {ReencounterState} from '@/src/features/vocabulary/content/reencounterState';
import type {ReadingRequest, ReadingResponse} from '@/src/features/reading-assistant/types';

registerAllUiLanguageBundles();
const apps: Vue.App[] = [];
afterEach(async () => {apps.splice(0).forEach(app => app.unmount()); await Vue.nextTick(); vi.unstubAllGlobals();});
const tick = async () => {for (let i = 0; i < 5; i++) await Vue.nextTick();};

function fixture(language: UiLanguage) {
    const {window, document} = parseHTML('<html><body></body></html>');
    Object.assign(window, {matchMedia: () => ({matches: false, addEventListener() {}, removeEventListener() {}})});
    vi.stubGlobal('window', window); vi.stubGlobal('document', document);
    for (const name of ['Node', 'Element', 'HTMLElement', 'ShadowRoot'] as const) vi.stubGlobal(name, window[name]);
    const locale = Vue.ref(language);
    const i18n = {language: locale, t: (key: string, params?: Record<string, string | number>) => translate(key, locale.value, params),
        translateLegacy: (text: string) => translateLegacyText(text, locale.value)};
    const renderer = Vue.createRenderer<Node, Element>({
        createElement: (tag, ns) => Vue.markRaw(ns === 'svg' ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag)) as unknown as Element,
        createText: text => document.createTextNode(text) as unknown as Node, createComment: text => document.createComment(text) as unknown as Node,
        insert: (node, parent, anchor) => parent.insertBefore(node, anchor || null), remove: node => {node.parentNode?.removeChild(node);},
        setText: (node, text) => {node.nodeValue = text;}, setElementText: (node, text) => {node.textContent = text;},
        parentNode: node => node.parentNode as Element | null, nextSibling: node => node.nextSibling, setScopeId: (node, id) => node.setAttribute(id, ''),
        patchProp(node, key, old, value) {
            if (/^on[A-Z]/u.test(key)) {const type = key.slice(2).toLowerCase(); if (old) node.removeEventListener(type, old); if (value) node.addEventListener(type, value);}
            else if (key === 'style') Object.assign((node as HTMLElement).style, value || {});
            else if (value == null || value === false && key === 'disabled') node.removeAttribute(key);
            else node.setAttribute(key, String(value));
        },
        insertStaticContent(html, parent, anchor) {const box = document.createElement('div'); box.innerHTML = html; const first = box.firstChild!, last = box.lastChild!;
            while (box.firstChild) parent.insertBefore(box.firstChild as unknown as Node, anchor || null); return [first as unknown as Node, last as unknown as Node];},
    });
    function mount(file: string, props: Record<string, unknown>, extra: Record<string, unknown>, components: Record<string, Vue.Component> = {}) {
        const compiled = compileVueInlineFixture(resolve(process.cwd(), file), {id: 'i18n-content-boundary'});
        const ports = {'vue': Vue, '@/src/ui/i18n': {useUiI18n: () => i18n}, ...extra};
        const module = {exports: {}} as {exports: {default?: Vue.Component}};
        new Function('require', 'module', 'exports', compiled.code)((id: string) => {
            if (!Object.hasOwn(ports, id)) throw new Error(`Unconfigured UI fixture dependency: ${id}`);
            return ports[id as keyof typeof ports];
        }, module, module.exports);
        const host = document.createElement('div'); document.body.append(host);
        const reactiveProps = Vue.shallowReactive(props);
        const app = renderer.createApp({setup: () => () => Vue.h(module.exports.default!, reactiveProps)});
        for (const [name, component] of Object.entries(components)) app.component(name, component);
        apps.push(app); app.mount(host as unknown as Element);
        return {host, props: reactiveProps};
    }
    return {mount, locale, i18n};
}

describe('content UI localization boundaries', () => {
    it('localizes optional segmentation import details in all six non-Chinese UI bundles',()=>{
        for(const {value:language} of UI_LANGUAGE_OPTIONS.filter(({value})=>value!=='zh-CN')){
            for(const source of ['精确文字分割（可选）','约 90 MB · 仅离线导入','未导入']){
                const value=translateLegacyText(source,language);
                expect(value,language+': '+source).not.toBe(source);expect(value.trim()).not.toBe('');
            }
        }
    });
    it('localizes real writing inheritance options across seven languages without translating custom service names', async () => {
        const ui = fixture('zh-CN');
        const config = Vue.reactive(new Config());
        const defaultId = config.service;
        const customName = '设置';
        config.customOpenAIProviders = [{id: 'custom:i18n', name: customName, endpoint: 'https://example.invalid/v1', models: [customName]}];
        const passthrough = {setup: (_: unknown, {slots}: {slots: Vue.Slots}) => () => Vue.h('section', slots.default?.())};
        const empty = {render: () => null};
        const mounted = ui.mount('src/features/settings/ui/WritingSettings.vue', {config}, {
            '@/src/core/config/catalog': catalog, '@/src/core/config/harness': harness, '@/src/core/config/customOpenAI': customOpenAI,
            '@/src/core/config/writing': writing,
            '@/src/core/config/writingReadiness': {resolveWritingReadiness: () => ({supported: true, message: '', issue: ''})},
            '@/src/services/translation/capabilities': {filterAvailableTranslationServices: (items: unknown[]) => items, getTranslationServiceUnavailableMessage: () => ''},
            '@/src/features/writing-assistant/ui/public': {WritingChoices: empty},
            '@/src/ui/components/FeatureEnableCard.vue': {default: empty},
            './components/SettingsGroup.vue': {default: passthrough}, './components/SettingsItem.vue': {default: passthrough},
            './components/WritingStylePreview.vue': {default: empty},
        }, {
            'el-input': empty,
            'el-select': {props: ['modelValue'], setup: (_: unknown, {slots}: {slots: Vue.Slots}) => () => Vue.h('div', slots.default?.())},
            'el-option': {props: ['value', 'label'], setup: (props: Record<string, unknown>) => () => Vue.h('span', {'data-option-value': props.value}, String(props.label ?? ''))},
        });
        for (const {value: language} of UI_LANGUAGE_OPTIONS) {
            ui.locale.value = language; config.service = defaultId; await tick();
            const serviceSelect = mounted.host.querySelector(`[aria-label="${translateLegacyText('写作服务', language)}"]`)!;
            const builtin = catalog.options.services.find(item => item.value === defaultId)!;
            expect(serviceSelect.querySelector('[data-option-value=""]')?.textContent).toBe(translate('writing.experience.inheritService', language, {service: translateLegacyText(builtin.label, language)}));
            expect(serviceSelect.querySelector('[data-option-value="custom:i18n"]')?.textContent).toBe(customName);
            const languageSelect = mounted.host.querySelector('.writing-default-language[data-i18n-ignore]')!;
            const target = writing.WRITING_LANGUAGES.find(item => item.value === writing.resolveWritingLanguage('target', config.to))!;
            expect(languageSelect.querySelector('[data-option-value="target"]')?.textContent).toBe(translate('writing.experience.inheritTargetLanguage', language, {language: catalog.getMultilingualTargetLanguageLabel(target.value, target.label, language)}));
            config.service = 'custom:i18n'; await tick();
            expect(serviceSelect.querySelector('[data-option-value=""]')?.textContent).toBe(translate('writing.experience.inheritService', language, {service: customName}));
            expect(serviceSelect.getAttribute('aria-label')).toBe(translateLegacyText('写作服务', language));
            const modelSelect = mounted.host.querySelector(`[aria-label="${translateLegacyText('写作模型', language)}"]`)!;
            expect(modelSelect.hasAttribute('data-i18n-ignore')).toBe(true);
            expect(modelSelect.querySelector(`[data-option-value="${customName}"]`)?.textContent).toBe(customName);
            for (const option of mounted.host.querySelectorAll('[data-option-value]')) expect(option.hasAttribute('data-i18n-ignore')).toBe(true);
            const referenceSelect = mounted.host.querySelectorAll('.writing-default-language')[1];
            expect(referenceSelect.querySelector('[data-option-value="ui"]')?.textContent).toBe(translate('writing.interfaceLanguage', language));
            expect(referenceSelect.querySelector('[data-option-value="en"]')?.textContent).toBe(catalog.getMultilingualTargetLanguageLabel('en', 'English', language));
        }
    });

    it('maps the real legacy read error to the same semantic resource in every non-Chinese language', () => {
        for (const {value: language} of UI_LANGUAGE_OPTIONS.filter(({value}) => value !== 'zh-CN')) {
            expect(translateLegacyText('收藏暂时无法读取', language)).toBe(translate('reencounter.readFailed', language));
        }
    });

    it.each(UI_LANGUAGE_OPTIONS.map(({value}) => value))('localizes %s collection tooltips while preserving the saved expression', async language => {
        const ui = fixture(language);
        const entry = {id: 'saved', term: '打开听读与解释', kind: 'expression', contexts: [], translations: {}, status: 'new'};
        const mounted = ui.mount('src/features/vocabulary/ui/CollectionEntry.vue', {entry, translation: '', playing: false, speechPhase: 'idle', busy: false, status: 'New', review: ''}, {
            '../learningModel': learning, '../source': source,
            './SavedExplanation.vue': {default: {render: () => null}}, './VocabularySource.vue': {default: {render: () => null}},
            '@/src/ui/components/UiIcon.vue': {default: {render: () => null}}, '@/src/core/translation/result': translationResult,
        });
        await tick();
        const button = mounted.host.querySelector('.entry-open')!;
        expect(button.textContent).toBe(entry.term);
        expect(button.getAttribute('title')).toBe(translate('learning.collection.learnUsage', language));
        mounted.props.entry = {...entry, kind: 'sentence'}; await tick();
        expect(button.textContent).toBe(entry.term);
        expect(button.getAttribute('title')).toBe(translate('learning.collection.listenLearn', language));
    });

    it('localizes current reencounter read, explanation and save feedback without scanning source text', async () => {
        const ui = fixture('en-US');
        const original = '收藏暂时无法读取';
        const occurrence = {entry: {id: 'saved', term: original, sourceLanguage: 'en'}, sentence: original, ranges: [], root: document};
        const state = Vue.shallowReactive({occurrences: [occurrence], current: occurrence, saved: {reference: original, savedSentence: original}, loading: false, error: original, paused: false}) as unknown as ReencounterState;
        let callbacks!: {result(value: ReadingResponse): void; error(error: Error): void};
        const config = Vue.reactive(normalizeConfig({...new Config(), on: true, harness: {...harness.DEFAULT_HARNESS_PREFERENCES, enabled: true, contextMode: 'paragraph'}}));
        const mounted = ui.mount('src/features/vocabulary/ui/ReencounterPanel.vue', {state, close: () => {}, open: () => {}, pause: () => {}, disable: () => {}, retry: () => {}}, {
            'webextension-polyfill': {default: {runtime: {sendMessage: vi.fn(async () => ({success: true}))}}},
            '@/src/services/config/store': {config, subscribeConfig: () => () => {}},
            '@/src/core/config/interfaceAppearance': appearance, '@/src/core/config/harness': harness,
            '@/src/ui/components/UiIcon.vue': {default: {render: () => null}},
            '@/src/features/reading-assistant/ui/answer/public': {ReadingAnswer: {props: ['text'], setup: (props: {text: string}) => () => Vue.h('pre', {'data-answer': ''}, props.text)}},
            '@/src/features/reading-assistant/public': {streamReading: (_request: ReadingRequest, handlers: typeof callbacks) => {callbacks = handlers; return {cancel: vi.fn()};}},
        });
        await tick();
        expect(mounted.host.querySelector('[role="alert"]')?.textContent).toContain(translate('reencounter.readFailed', 'en-US'));
        expect(mounted.host.querySelector('h3')?.textContent).toBe(original);
        expect([...mounted.host.querySelectorAll('blockquote')].every(node => node.textContent === original)).toBe(true);
        state.error = '设置保存失败'; await tick();
        expect(mounted.host.querySelector('[role="alert"]')?.textContent).toContain(translateLegacyText('设置保存失败', 'en-US'));
        state.error = '';
        const explain = () => [...mounted.host.querySelectorAll('button')].find(node => node.textContent === ui.i18n.t('reencounter.explain') || node.textContent === ui.i18n.t('reencounter.explainAgain'))!;
        explain().dispatchEvent(new window.Event('click')); await tick();
        callbacks.result({success: false, error: '理解请求未完成，请重试'}); await tick();
        expect(mounted.host.querySelector('[role="alert"]')?.textContent).toContain(translateLegacyText('理解请求未完成，请重试', 'en-US'));
        ui.locale.value = 'fr-FR'; await tick();
        expect(mounted.host.querySelector('[role="alert"]')?.textContent).toContain(translateLegacyText('理解请求未完成，请重试', 'fr-FR'));
        expect(mounted.host.querySelector('h3')?.textContent).toBe(original);
        explain().dispatchEvent(new window.Event('click')); await tick();
        const warning = '本次会话未能保存，仍可继续阅读。请稍后检查本机存储。';
        callbacks.result({success: true, text: original, service: 'fixture', model: 'fixture', persistenceWarning: warning}); await tick();
        expect(mounted.host.textContent).toContain(translateLegacyText(warning, 'fr-FR'));
        expect(mounted.host.querySelector('[data-answer]')?.textContent).toBe(original);
        explain().dispatchEvent(new window.Event('click')); await tick();
        callbacks.error(new Error('阅读助手连接已断开，请重试。')); await tick();
        expect(mounted.host.querySelector('[role="alert"]')?.textContent).toContain(translateLegacyText('阅读助手连接已断开，请重试。', 'fr-FR'));
        state.error = 'custom provider feedback'; await tick();
        expect(mounted.host.querySelector('[role="alert"]')?.textContent).toContain('custom provider feedback');
    });
});
