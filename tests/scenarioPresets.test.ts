import {parseHTML} from 'linkedom';
import * as Vue from 'vue';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {options} from '@/src/core/config/catalog';
import {extractConfigCredentials, sanitizeConfigCredentials} from '@/src/core/config/credentials';
import {createConfigApplication} from '@/src/services/config/application';
import {createConfigPersistenceHandler} from '@/src/app/background/handlers/configPersistence';
import type {ConfigStoragePort} from '@/src/platform/storage/configStorage';
import {
    buildScenarioPresetPatch,
    DEVELOPER_PROTECTED_TAGS,
    isScenarioPresetId,
    normalizeScenarioPresetIds,
    SCENARIO_PRESETS,
    type ScenarioPresetCurrentConfig,
} from '@/src/core/config/scenarioPresets';

const {elMessageSuccess, elMessageInfo, elMessageError} = vi.hoisted(() => ({
    elMessageSuccess: vi.fn(),
    elMessageInfo: vi.fn(),
    elMessageError: vi.fn(),
}));

vi.mock('element-plus', () => ({
    ElMessage: Object.assign(vi.fn(), {
        success: elMessageSuccess,
        info: elMessageInfo,
        error: elMessageError,
        warning: vi.fn(),
    }),
}));

vi.mock('@/src/ui/i18n', () => ({
    useUiI18n: () => ({
        language: Vue.ref('zh-CN'),
        t: (key: string) => key,
        translateLegacy: (text: string) => text,
    }),
}));

describe('scenarioPresets 纯配置领域逻辑', () => {
    it('校验场景标识并按目录顺序去重归一化', () => {
        expect(SCENARIO_PRESETS.map((item) => item.id)).toEqual([
            'academic',
            'developer',
            'language-learning',
            'media-manga',
            'cross-border',
        ]);
        expect(isScenarioPresetId('academic')).toBe(true);
        expect(isScenarioPresetId('cross-border')).toBe(true);
        expect(isScenarioPresetId('unknown')).toBe(false);
        expect(isScenarioPresetId(42)).toBe(false);

        expect(normalizeScenarioPresetIds(['cross-border', 'academic', 'invalid', null, 'academic', 'developer']))
            .toEqual(['academic', 'developer', 'cross-border']);
    });

    it('空选或全非法输入返回空补丁且不标记为已满足', () => {
        const config = new Config();
        const result = buildScenarioPresetPatch(['bogus', undefined], config);
        expect(result.scenarioIds).toEqual([]);
        expect(result.patch).toEqual({});
        expect(result.changedKeys).toEqual([]);
        expect(result.featureSummaryKeys).toEqual([]);
        expect(result.alreadySatisfied).toBe(false);
    });

    it('五个独立场景均生成最小非破坏性补丁且绝不改动凭据与站点规则', () => {
        const makeDisabledConfig = (): Config => {
            const cfg = new Config();
            cfg.display = 0;
            cfg.hotkey = 'none';
            cfg.excludedTags = ['svg'];
            cfg.bilingualSentenceHighlightEnabled = false;
            cfg.glossaryEnabled = false;
            cfg.enableAIContext = false;
            cfg.sectionTranslationHotkeyEnabled = false;
            cfg.selectionTranslatorMode = 'disabled';
            cfg.disableSelectionTranslator = true;
            cfg.selectionTranslatorBidirectional = false;
            cfg.vocabularyBookEnabled = false;
            cfg.vocabularyReencounterEnabled = false;
            cfg.informationHighlight = {...cfg.informationHighlight, enabled: false};
            cfg.videoTranslationEnabled = false;
            cfg.videoSubtitleVisible = false;
            cfg.videoSubtitleDisplayMode = 'original-only';
            cfg.disableImageTranslator = true;
            cfg.imageTranslationHoverEnabled = false;
            cfg.imageTranslationMangaEnabled = false;
            cfg.disableFloatingBall = true;
            cfg.inputBoxTranslationTrigger = 'disabled';
            cfg.writing = {...cfg.writing, enabled: false};
            cfg.token = {openai: 'sk-secret-keep-me'};
            cfg.proxy = {openai: 'https://custom.endpoint.test/v1'};
            cfg.alwaysTranslateDomains = ['example.com'];
            return cfg;
        };

        const academic = buildScenarioPresetPatch(['academic'], makeDisabledConfig());
        expect(academic.patch).toMatchObject({
            display: 1,
            disableSelectionTranslator: false,
            selectionTranslatorMode: 'bilingual',
            bilingualSentenceHighlightEnabled: true,
            glossaryEnabled: true,
            enableAIContext: true,
            informationHighlight: expect.objectContaining({enabled: true}),
        });
        expect(academic.patch).not.toHaveProperty('token');
        expect(academic.patch).not.toHaveProperty('proxy');
        expect(academic.patch).not.toHaveProperty('alwaysTranslateDomains');

        const developer = buildScenarioPresetPatch(['developer'], makeDisabledConfig());
        expect(developer.patch).toMatchObject({
            display: 1,
            disableSelectionTranslator: false,
            selectionTranslatorMode: 'bilingual',
            hotkey: 'Control',
            sectionTranslationHotkeyEnabled: true,
            excludedTags: ['svg', ...DEVELOPER_PROTECTED_TAGS],
        });

        const learning = buildScenarioPresetPatch(['language-learning'], makeDisabledConfig());
        expect(learning.patch).toMatchObject({
            disableSelectionTranslator: false,
            selectionTranslatorMode: 'bilingual',
            selectionTranslatorBidirectional: true,
            vocabularyBookEnabled: true,
            vocabularyReencounterEnabled: true,
            informationHighlight: expect.objectContaining({enabled: true}),
            videoTranslationEnabled: true,
            videoSubtitleVisible: true,
            videoSubtitleDisplayMode: 'bilingual',
        });

        const media = buildScenarioPresetPatch(['media-manga'], makeDisabledConfig());
        expect(media.patch).toMatchObject({
            videoTranslationEnabled: true,
            videoSubtitleVisible: true,
            videoSubtitleDisplayMode: 'bilingual',
            disableImageTranslator: false,
            imageTranslationHoverEnabled: true,
            imageTranslationMangaEnabled: true,
            disableFloatingBall: false,
        });

        const crossBorder = buildScenarioPresetPatch(['cross-border'], makeDisabledConfig());
        expect(crossBorder.patch).toMatchObject({
            display: 1,
            inputBoxTranslationTrigger: 'triple_space',
            writing: expect.objectContaining({enabled: true}),
            disableFloatingBall: false,
        });
    });

    it('每个场景预设补丁字段都符合 catalog 枚举并在 normalizeConfig 往返后完全保真', () => {
        const validTriggers = new Set(options.inputBoxTranslationTrigger.map((item) => item.value));
        const validHoverKeys = new Set(options.keys.map((item) => item.value));
        const disabledBase = new Config();
        disabledBase.display = 0;
        disabledBase.hotkey = 'none';
        disabledBase.excludedTags = [];
        disabledBase.bilingualSentenceHighlightEnabled = false;
        disabledBase.glossaryEnabled = false;
        disabledBase.enableAIContext = false;
        disabledBase.sectionTranslationHotkeyEnabled = false;
        disabledBase.selectionTranslatorMode = 'disabled';
        disabledBase.disableSelectionTranslator = true;
        disabledBase.selectionTranslatorBidirectional = false;
        disabledBase.vocabularyBookEnabled = false;
        disabledBase.vocabularyReencounterEnabled = false;
        disabledBase.informationHighlight = {...disabledBase.informationHighlight, enabled: false};
        disabledBase.videoTranslationEnabled = false;
        disabledBase.videoSubtitleVisible = false;
        disabledBase.videoSubtitleDisplayMode = 'original-only';
        disabledBase.disableImageTranslator = true;
        disabledBase.imageTranslationHoverEnabled = false;
        disabledBase.imageTranslationMangaEnabled = false;
        disabledBase.disableFloatingBall = true;
        disabledBase.inputBoxTranslationTrigger = 'disabled';
        disabledBase.writing = {...disabledBase.writing, enabled: false};

        for (const preset of SCENARIO_PRESETS) {
            const {patch} = buildScenarioPresetPatch([preset.id], disabledBase);
            if (patch.inputBoxTranslationTrigger !== undefined) {
                expect(validTriggers.has(patch.inputBoxTranslationTrigger), preset.id).toBe(true);
            }
            if (patch.hotkey !== undefined) {
                expect(validHoverKeys.has(patch.hotkey), preset.id).toBe(true);
            }
            const normalized = normalizeConfig({...disabledBase, ...patch});
            for (const [key, value] of Object.entries(patch)) {
                expect((normalized as unknown as Record<string, unknown>)[key], `${preset.id}.${key}`).toEqual(value);
            }
        }
    });

    it('真实 createConfigApplication 集成：不预改 config 直接 requestConfigPatch 持久化并触发订阅者', async () => {
        const initial = normalizeConfig({
            display: 0,
            inputBoxTranslationTrigger: 'disabled',
            disableFloatingBall: true,
            writing: {...new Config().writing, enabled: false},
        });
        const records = new Map<string, unknown>([
            ['local:config', {...sanitizeConfigCredentials(initial), __fluentConfigRevision: 1}],
            ['local:credentials', extractConfigCredentials(initial)],
        ]);
        const listeners = new Map<string, Set<(value: unknown) => void>>();
        const notify = (key: string) => {
            for (const listener of listeners.get(key) ?? []) listener(structuredClone(records.get(key) ?? null));
        };
        const storage: ConfigStoragePort = {
            writeOwner: true,
            getItem: async <T>(key: string) => structuredClone(records.get(key) ?? null) as T | null,
            setItem: async <T>(key: string, value: T) => { records.set(key, structuredClone(value)); notify(key); },
            setItems: async (entries, removeKeys = []) => {
                for (const [key, value] of entries) records.set(key, structuredClone(value));
                for (const key of removeKeys) records.delete(key);
                for (const key of [...entries.keys(), ...removeKeys]) notify(key);
            },
            removeItem: async (key) => { records.delete(key); notify(key); },
            watch: (key, cb) => {
                const set = listeners.get(key) ?? new Set();
                set.add(cb as (value: unknown) => void);
                listeners.set(key, set);
                return () => { set.delete(cb as (value: unknown) => void); };
            },
        };
        const authorityApp = createConfigApplication({storage, trustedContext: true});
        const clientApp = createConfigApplication({storage: {...storage, writeOwner: false}, trustedContext: true});
        await Promise.all([authorityApp.start(), clientApp.start()]);
        const persistHandler = createConfigPersistenceHandler({
            ready: authorityApp.configReady,
            getCurrentConfig: () => authorityApp.config,
            prepareConfigSaveRequest: authorityApp.prepareConfigSaveRequest,
            prepareConfigPatchRequest: authorityApp.prepareConfigPatchRequest,
            saveConfig: authorityApp.saveConfig,
            getCurrentRevision: authorityApp.getConfigRevision,
            isExtensionUrl: (url) => url.startsWith('chrome-extension://ext-test/'),
        });
        const sendMessage = async (message: unknown) => persistHandler.handle(
            JSON.parse(JSON.stringify(message)),
            {sender: {url: 'chrome-extension://ext-test/popup.html'}},
        );

        const notified = vi.fn();
        const unsubscribe = clientApp.subscribeConfig(notified);
        const {patch} = buildScenarioPresetPatch(['cross-border'], clientApp.config);
        expect(patch.inputBoxTranslationTrigger).toBe('triple_space');

        await clientApp.requestConfigPatch(patch, sendMessage);
        expect(clientApp.config.display).toBe(1);
        expect(clientApp.config.inputBoxTranslationTrigger).toBe('triple_space');
        expect(clientApp.config.disableFloatingBall).toBe(false);
        expect(clientApp.config.writing.enabled).toBe(true);
        expect((records.get('local:config') as Record<string, unknown>).inputBoxTranslationTrigger).toBe('triple_space');
        expect(notified).toHaveBeenCalled();

        unsubscribe();
        await Promise.all([authorityApp.flushConfigHistory(), clientApp.flushConfigHistory()]);
    });

    it('多选叠加保留用户已有快捷键、排除标签与启用项，全部满足时返回 alreadySatisfied', () => {
        const cfg = new Config();
        cfg.display = 1;
        cfg.hotkey = 'Alt';
        cfg.excludedTags = ['CODE', 'pre', 'kbd', 'samp', 'custom-tag'];
        cfg.bilingualSentenceHighlightEnabled = true;
        cfg.glossaryEnabled = true;
        cfg.enableAIContext = true;
        cfg.sectionTranslationHotkeyEnabled = true;
        cfg.selectionTranslatorMode = 'translation';
        cfg.disableSelectionTranslator = false;
        cfg.selectionTranslatorBidirectional = true;
        cfg.vocabularyBookEnabled = true;
        cfg.vocabularyReencounterEnabled = true;
        cfg.informationHighlight = {...cfg.informationHighlight, enabled: true};
        cfg.videoTranslationEnabled = true;
        cfg.videoSubtitleVisible = true;
        cfg.videoSubtitleDisplayMode = 'bilingual';
        cfg.disableImageTranslator = false;
        cfg.imageTranslationHoverEnabled = true;
        cfg.imageTranslationMangaEnabled = true;
        cfg.disableFloatingBall = false;
        cfg.inputBoxTranslationTrigger = 'ctrlEnter';
        cfg.writing = {...cfg.writing, enabled: true};

        const satisfied = buildScenarioPresetPatch(
            ['academic', 'developer', 'language-learning', 'media-manga', 'cross-border'],
            cfg,
        );
        expect(satisfied.alreadySatisfied).toBe(true);
        expect(satisfied.changedKeys).toEqual([]);
        expect(satisfied.patch).toEqual({});
        expect(satisfied.featureSummaryKeys.length).toBeGreaterThanOrEqual(15);

        // excludedTags 缺失时也安全补齐开发者标签，不报错
        const withoutTags = {...cfg, excludedTags: undefined as unknown as string[]} as ScenarioPresetCurrentConfig;
        const devResult = buildScenarioPresetPatch(['developer'], withoutTags);
        expect(devResult.patch.excludedTags).toEqual([...DEVELOPER_PROTECTED_TAGS]);
    });
});

describe('ScenarioPresetsSettings 真实 Vue 组件行为', () => {
    let app: Vue.App | undefined;
    let document: Document;
    let events: Map<Element, Record<string, any>>;

    async function settle() {
        await Vue.nextTick();
        await Promise.resolve();
        await Vue.nextTick();
    }

    beforeEach(() => {
        vi.clearAllMocks();
        events = new Map();
        const parsed = parseHTML('<html><body><div id="app"></div></body></html>');
        document = parsed.window.document;
        vi.stubGlobal('document', document);
        vi.stubGlobal('window', parsed.window);
        vi.stubGlobal('HTMLElement', parsed.window.HTMLElement);
        vi.stubGlobal('Node', parsed.window.Node);
        vi.stubGlobal('Event', parsed.window.Event);
    });

    afterEach(async () => {
        (app as Vue.App | undefined)?.unmount();
        app = undefined;
        await settle();
        vi.unstubAllGlobals();
    });

    async function mountComponent(props: {
        config: Config;
        active?: boolean;
        applyPatch?: (patch: Partial<Config>) => Promise<void> | void;
    }) {
        const Component = (await import('@/src/features/settings/ui/ScenarioPresetsSettings.vue')).default;
        const renderer = Vue.createRenderer({
            patchProp(el: any, key: string, _prev: any, next: any) {
                if (/^on[A-Z]/u.test(key)) {
                    const handlers = events.get(el) || {};
                    handlers[key] = next;
                    events.set(el, handlers);
                    return;
                }
                if (key === 'class') {
                    el.className = next ?? '';
                    return;
                }
                if (next === undefined || next === null || (next === false && !/^(?:aria-|data-)/u.test(key))) {
                    el.removeAttribute(key);
                } else {
                    el.setAttribute(key, String(next));
                }
            },
            insert: (child: any, parent: any, anchor: any = null) => parent.insertBefore(child, anchor),
            remove: (child: any) => child.parentNode?.removeChild(child),
            createElement: (tag: string) => Vue.markRaw(document.createElement(tag)),
            createText: (val: string) => document.createTextNode(val),
            createComment: (val: string) => document.createComment(val),
            setText: (node: any, val: string) => { node.nodeValue = val; },
            setElementText: (el: any, val: string) => { el.textContent = val; },
            parentNode: (node: any) => node.parentNode,
            nextSibling: (node: any) => node.nextSibling,
            querySelector: (sel: string) => document.querySelector(sel),
            setScopeId: () => {},
            cloneNode: (node: any) => node.cloneNode(true),
            insertStaticContent: (html: string, parent: any, anchor: any) => {
                const tpl = document.createElement('template');
                tpl.innerHTML = html;
                const first = tpl.content.firstChild!;
                const last = tpl.content.lastChild!;
                parent.insertBefore(tpl.content, anchor);
                return [first, last];
            },
        });
        const reactiveProps = Vue.reactive(props);
        app = renderer.createApp({
            setup: () => () => Vue.h(Component as Vue.Component, reactiveProps),
        });
        app.component('ElButton', Vue.defineComponent({
            inheritAttrs: false,
            emits: ['click'],
            setup(_, {attrs, slots, emit}) {
                return () => Vue.h('button', {
                    ...attrs,
                    onClick: (event: unknown) => emit('click', event),
                }, slots.default?.());
            },
        }));
        app.config.warnHandler = () => {};
        app.mount(document.getElementById('app')!);
        await settle();
        return reactiveProps;
    }

    it('展开面板、多选预览、通过 applyPatch 提交、已满足提示及清空重选', async () => {
        const config = new Config();
        config.display = 0;
        config.glossaryEnabled = false;
        config.bilingualSentenceHighlightEnabled = false;
        const appliedPatches: Partial<Config>[] = [];
        const applyPatch = vi.fn(async (patch: Partial<Config>) => {
            appliedPatches.push(patch);
            Object.assign(config, patch);
        });

        const reactiveProps = await mountComponent({config, applyPatch});
        expect(document.querySelector('[data-testid="scenario-presets-panel"]')).toBeNull();

        const toggleBtn = document.querySelector('[data-testid="scenario-presets-toggle"]')!;
        events.get(toggleBtn)?.onClick();
        await settle();
        expect(document.querySelector('[data-testid="scenario-presets-panel"]')).not.toBeNull();

        const academicBtn = document.querySelector('[data-scenario-id="academic"]')!;
        const developerBtn = document.querySelector('[data-scenario-id="developer"]')!;
        events.get(academicBtn)?.onClick();
        events.get(developerBtn)?.onClick();
        await settle();

        expect(academicBtn.getAttribute('aria-pressed')).toBe('true');
        expect(developerBtn.getAttribute('aria-pressed')).toBe('true');
        expect(document.querySelector('[data-testid="scenario-presets-preview"]')).not.toBeNull();

        // 取消选中一个场景
        events.get(developerBtn)?.onClick();
        await settle();
        expect(developerBtn.getAttribute('aria-pressed')).toBe('false');

        // 应用场景补丁
        const applyBtn = document.querySelector('[data-testid="scenario-presets-apply"]')!;
        await events.get(applyBtn)?.onClick();
        await settle();
        expect(applyPatch).toHaveBeenCalledTimes(1);
        expect(appliedPatches[0]).toMatchObject({
            display: 1,
            glossaryEnabled: true,
            bilingualSentenceHighlightEnabled: true,
        });
        expect(elMessageSuccess).toHaveBeenCalledTimes(1);

        // 再次应用同一已满足场景 -> 显示 info，不重复调用 applyPatch
        await events.get(applyBtn)?.onClick();
        await settle();
        expect(applyPatch).toHaveBeenCalledTimes(1);
        expect(elMessageInfo).toHaveBeenCalledTimes(1);

        // active=false 时不执行应用
        reactiveProps.active = false;
        await settle();
        await events.get(applyBtn)?.onClick();
        expect(elMessageInfo).toHaveBeenCalledTimes(1);

        // 清空选择
        const clearBtn = document.querySelector('[data-testid="scenario-presets-clear"]')!;
        events.get(clearBtn)?.onClick();
        await settle();
        expect(document.querySelector('[data-testid="scenario-presets-preview"]')).toBeNull();
    });

    it('未传入 applyPatch 时直接写入绑定 config 对象', async () => {
        const config = new Config();
        config.disableFloatingBall = true;
        config.imageTranslationMangaEnabled = false;
        await mountComponent({config});

        events.get(document.querySelector('[data-testid="scenario-presets-toggle"]')!)?.onClick();
        await settle();
        events.get(document.querySelector('[data-scenario-id="media-manga"]')!)?.onClick();
        await settle();
        await events.get(document.querySelector('[data-testid="scenario-presets-apply"]')!)?.onClick();
        await settle();

        expect(config.disableFloatingBall).toBe(false);
        expect(config.imageTranslationMangaEnabled).toBe(true);
        expect(elMessageSuccess).toHaveBeenCalledTimes(1);
    });

    it('applyPatch 失败时提示错误；异步等待期间页面失活不弹出过时提示', async () => {
        const config = new Config();
        config.display = 0;
        const failingPatch = vi.fn(async () => { throw new Error('persist failed'); });
        await mountComponent({config, applyPatch: failingPatch});

        events.get(document.querySelector('[data-testid="scenario-presets-toggle"]')!)?.onClick();
        await settle();
        events.get(document.querySelector('[data-scenario-id="academic"]')!)?.onClick();
        await settle();
        await events.get(document.querySelector('[data-testid="scenario-presets-apply"]')!)?.onClick();
        await settle();
        expect(elMessageError).toHaveBeenCalledWith('scenarioPresets.settings.saveFailed');

        // 异步等待期间失活：成功和失败都不会触发过时提示
        (app as Vue.App | undefined)?.unmount();
        app = undefined;
        await settle();
        vi.clearAllMocks();

        let resolvePending!: () => void;
        let rejectPending!: (err: Error) => void;
        const reactiveProps = await mountComponent({
            config,
            applyPatch: () => new Promise<void>((resolve) => { resolvePending = resolve; }),
        });
        events.get(document.querySelector('[data-testid="scenario-presets-toggle"]')!)?.onClick();
        await settle();
        events.get(document.querySelector('[data-scenario-id="academic"]')!)?.onClick();
        await settle();
        const inFlightSuccess = events.get(document.querySelector('[data-testid="scenario-presets-apply"]')!)?.onClick();
        reactiveProps.active = false;
        await settle();
        resolvePending();
        await inFlightSuccess;
        expect(elMessageSuccess).not.toHaveBeenCalled();

        (app as Vue.App | undefined)?.unmount();
        app = undefined;
        await settle();
        const reactiveProps2 = await mountComponent({
            config,
            applyPatch: () => new Promise<void>((_resolve, reject) => { rejectPending = reject; }),
        });
        events.get(document.querySelector('[data-testid="scenario-presets-toggle"]')!)?.onClick();
        await settle();
        events.get(document.querySelector('[data-scenario-id="academic"]')!)?.onClick();
        await settle();
        const inFlightFail = events.get(document.querySelector('[data-testid="scenario-presets-apply"]')!)?.onClick();
        reactiveProps2.active = false;
        await settle();
        rejectPending(new Error('late failure'));
        await inFlightFail;
        expect(elMessageError).not.toHaveBeenCalled();
    });
});
