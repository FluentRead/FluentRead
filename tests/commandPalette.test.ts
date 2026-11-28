import {parseHTML} from 'linkedom';
import * as Vue from 'vue';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {extractConfigCredentials, sanitizeConfigCredentials} from '@/src/core/config/credentials';
import {createConfigApplication} from '@/src/services/config/application';
import {createConfigPersistenceHandler} from '@/src/app/background/handlers/configPersistence';
import type {ConfigStoragePort} from '@/src/platform/storage/configStorage';
import {
    COMMAND_PALETTE_HOTKEY_OPTIONS,
    commandPaletteHotkeyDisplayName,
    DEFAULT_COMMAND_PALETTE_ENABLED,
    DEFAULT_COMMAND_PALETTE_HOTKEY,
    matchesCommandPaletteHotkey,
    normalizeCommandPaletteEnabled,
    normalizeCommandPaletteHotkey,
    normalizeCustomCommandPaletteHotkey,
    resolveCommandPaletteHotkey,
} from '@/src/core/config/commandPalette';
import {task7LegacyText, task7Messages} from '@/src/core/i18n/messages/task7Features';
import {UI_LANGUAGE_OPTIONS} from '@/src/core/i18n/language';
import {
    buildDefaultCommandCatalog,
    filterAndGroupCommands,
    MAX_RECENT_COMMANDS,
    recordRecentCommand,
    resolvePaletteKeyAction,
    scoreCommandMatch,
    type CommandPaletteActionId,
    type CommandPaletteItem,
} from '@/src/features/command-palette/core';
import {createCommandPaletteNavigationHandlers} from '@/src/app/background/commandPaletteNavigation';

const {
    elMessageMock,
    elMessageWarning,
    createVueShadowUiMock,
    sendMessageMock,
    requestConfigPatchMock,
    autoTranslateMock,
    restoreOriginalMock,
    isFullPageActiveMock,
    startSectionMock,
    startAreaMock,
    showPageNoticeMock,
} = vi.hoisted(() => ({
    elMessageMock: vi.fn(),
    elMessageWarning: vi.fn(),
    createVueShadowUiMock: vi.fn(),
    sendMessageMock: vi.fn(),
    requestConfigPatchMock: vi.fn(),
    autoTranslateMock: vi.fn(),
    restoreOriginalMock: vi.fn(),
    isFullPageActiveMock: vi.fn(() => false),
    startSectionMock: vi.fn(() => true),
    startAreaMock: vi.fn(async () => true),
    showPageNoticeMock: vi.fn(),
}));

vi.mock('@/src/features/page-notice/public', () => ({
    showPageNotice: showPageNoticeMock,
}));

vi.mock('@/src/features/image-translation/ui/public', () => ({
    ImageOcrSettings: {render: () => null},
}));

vi.mock('@/src/features/settings/ui/services/useVisionProbeStatus', () => ({
    useVisionProbeStatus: () => ({result: Vue.ref({capability: 'unknown'})}),
}));

vi.mock('@/src/features/settings/ui/services/PromptTemplateEditor.vue', () => ({
    default: {render: () => null},
}));

vi.mock('@/src/ui/components/GlossaryLibrarySelect.vue', () => ({
    default: {render: () => null},
}));

vi.mock('@/src/ui/components/ServiceIcon.vue', () => ({
    default: {render: () => null},
}));

vi.mock('element-plus', () => ({
    ElMessage: Object.assign(elMessageMock, {
        warning: elMessageWarning,
        success: vi.fn(),
        info: vi.fn(),
    }),
    ElTooltip: {render: () => null},
    ElPopover: {render: () => null},
}));

vi.mock('@/src/platform/shadow-ui', () => ({
    createVueShadowUi: createVueShadowUiMock,
}));

vi.mock('webextension-polyfill', () => ({
    default: {
        runtime: {
            sendMessage: sendMessageMock,
        },
    },
}));

vi.mock('@/src/services/config/store', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/src/services/config/store')>();
    return {
        ...actual,
        requestConfigPatch: requestConfigPatchMock,
    };
});

vi.mock('@/src/app/content/features', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/src/app/content/features')>();
    return {
        ...actual,
        autoTranslateEnglishPage: autoTranslateMock,
        restoreOriginalContent: restoreOriginalMock,
        isFullPageTranslationActive: isFullPageActiveMock,
        startSectionTranslationPicker: startSectionMock,
        startAreaTranslationFromContextMenu: startAreaMock,
    };
});

describe('commandPalette 配置规则与 task7 多语言目录', () => {
    it('默认启用且快捷键为 Alt+K，安全归一化预设与自定义组合键', () => {
        expect(DEFAULT_COMMAND_PALETTE_ENABLED).toBe(true);
        expect(DEFAULT_COMMAND_PALETTE_HOTKEY).toBe('Alt+K');
        expect(COMMAND_PALETTE_HOTKEY_OPTIONS.map((item) => item.value)).toContain('Alt+K');

        expect(normalizeCommandPaletteEnabled(false)).toBe(false);
        expect(normalizeCommandPaletteEnabled(true)).toBe(true);
        expect(normalizeCommandPaletteEnabled('false')).toBe(true);

        expect(normalizeCommandPaletteHotkey('custom')).toBe('custom');
        expect(normalizeCommandPaletteHotkey('alt+p')).toBe('Alt+P');
        expect(normalizeCommandPaletteHotkey('Ctrl+Alt+K')).toBe('Ctrl+Alt+K');
        expect(normalizeCommandPaletteHotkey('Alt+Z')).toBe('Alt+K');
        expect(normalizeCommandPaletteHotkey(null)).toBe('Alt+K');

        expect(normalizeCustomCommandPaletteHotkey('ctrl+shift+p')).toBe('Ctrl+Shift+P');
        expect(normalizeCustomCommandPaletteHotkey(123)).toBe('');

        expect(resolveCommandPaletteHotkey('Alt+P', 'Ctrl+Shift+P')).toBe('Alt+P');
        expect(resolveCommandPaletteHotkey('custom', 'ctrl+shift+p')).toBe('Ctrl+Shift+P');
        expect(resolveCommandPaletteHotkey('custom', '')).toBe('Alt+K');

        expect(commandPaletteHotkeyDisplayName('Alt+K', '')).toMatch(/K/u);

        const matchEvent = {
            key: 'k',
            code: 'KeyK',
            altKey: true,
            ctrlKey: false,
            shiftKey: false,
            metaKey: false,
        } as KeyboardEvent;
        const wrongEvent = {
            key: 'k',
            code: 'KeyK',
            altKey: false,
            ctrlKey: true,
            shiftKey: false,
            metaKey: false,
        } as KeyboardEvent;
        expect(matchesCommandPaletteHotkey(matchEvent, 'Alt+K', '')).toBe(true);
        expect(matchesCommandPaletteHotkey(wrongEvent, 'Alt+K', '')).toBe(false);
    });

    it('task7Features 覆盖全部八种语言且占位符与旧文案表完整', () => {
        const baseKeys = Object.keys(task7Messages['zh-CN']).sort();
        for (const {value: lang} of UI_LANGUAGE_OPTIONS) {
            expect(Object.keys(task7Messages[lang]).sort(), lang).toEqual(baseKeys);
            if (lang !== 'zh-CN') {
                expect(Object.keys(task7LegacyText[lang]).length, lang).toBeGreaterThan(0);
            }
        }
    });
});

describe('commandPalette 纯领域搜索、分组、最近记录与键盘导航', () => {
    const sampleCatalog = buildDefaultCommandCatalog({
        translate: (key) => task7Messages['zh-CN'][key as keyof typeof task7Messages['zh-CN']] ?? key,
        fullPageActive: false,
        displayMode: 1,
        floatingBallEnabled: true,
        smartHighlightEnabled: false,
        writingAssistantEnabled: false,
        canAreaTranslate: true,
        canOpenSidepanel: true,
        canOpenDocument: true,
        canSmartHighlight: true,
        shortcuts: {fullPage: 'Alt+T', section: 'Alt+S', area: 'Alt+A', smartHighlight: 'Alt+H'},
    });

    it('构建默认目录并准确反映全文状态、双语模式、开关状态和能力可用性', () => {
        expect(sampleCatalog).toHaveLength(11);
        expect(sampleCatalog.find((c) => c.id === 'toggle-full-page')?.title).toBe('翻译当前网页');
        expect(sampleCatalog.find((c) => c.id === 'toggle-full-page')?.badge).toBeUndefined();
        expect(sampleCatalog.find((c) => c.id === 'switch-display-mode')?.title).toBe('切换为仅译文模式');
        expect(sampleCatalog.find((c) => c.id === 'switch-display-mode')?.badge).toBe('双语');
        expect(sampleCatalog.find((c) => c.id === 'toggle-floating-ball')?.badge).toBe('已开启');
        expect(sampleCatalog.find((c) => c.id === 'toggle-smart-highlight')?.badge).toBe('已关闭');

        const flipped = buildDefaultCommandCatalog({
            translate: (key) => task7Messages['en-US'][key as keyof typeof task7Messages['en-US']] ?? key,
            fullPageActive: true,
            displayMode: 0,
            floatingBallEnabled: false,
            smartHighlightEnabled: true,
            writingAssistantEnabled: true,
            canAreaTranslate: false,
            canOpenSidepanel: false,
            canOpenDocument: false,
            canSmartHighlight: false,
        });
        expect(flipped.find((c) => c.id === 'toggle-full-page')?.title).toBe('Restore original page');
        expect(flipped.find((c) => c.id === 'toggle-full-page')?.badge).toBe('Translated');
        expect(flipped.find((c) => c.id === 'switch-display-mode')?.title).toBe('Switch to bilingual mode');
        expect(flipped.find((c) => c.id === 'switch-display-mode')?.badge).toBe('Translation only');
        expect(flipped.find((c) => c.id === 'toggle-floating-ball')?.badge).toBe('Off');
        expect(flipped.find((c) => c.id === 'toggle-smart-highlight')?.badge).toBe('On');
        expect(flipped.find((c) => c.id === 'toggle-writing-assistant')?.badge).toBe('On');
        expect(flipped.find((c) => c.id === 'start-area-translation')?.available).toBe(false);
    });

    it('支持中文、英文、拼音、快捷键、子序列模糊与多词 AND 匹配及空字段边界', () => {
        const docItem = sampleCatalog.find((item) => item.id === 'open-document-translation')!;
        expect(scoreCommandMatch(docItem, '')).toBe(1);
        expect(scoreCommandMatch(docItem, '文档翻译')).toBeGreaterThan(80);
        expect(scoreCommandMatch(docItem, 'wendangfanyi')).toBeGreaterThan(80);
        expect(scoreCommandMatch(docItem, 'doc')).toBeGreaterThan(40);
        expect(scoreCommandMatch(docItem, 'wd fy')).toBeGreaterThan(0);
        expect(scoreCommandMatch(docItem, 'doc nonexistent')).toBe(0);

        const areaItem = sampleCatalog.find((item) => item.id === 'start-area-translation')!;
        expect(scoreCommandMatch(areaItem, 'Alt+A')).toBeGreaterThan(60);
        expect(scoreCommandMatch(areaItem, 'alta')).toBeGreaterThan(60);

        const sparse: CommandPaletteItem = {
            id: 'open-settings',
            category: 'workspace',
            title: '   ',
            description: 'abcd',
            keywords: ['a-b-c-d'],
        };
        expect(scoreCommandMatch(sparse, 'ad')).toBeGreaterThan(0);
        expect(scoreCommandMatch(sparse, 'abcdefg')).toBe(0);
        expect(scoreCommandMatch(sparse, 'zzz')).toBe(0);
    });

    it('按最近使用与分类稳定分组，并在搜索时按分值、最近记录与原序排序', () => {
        const emptyNoRecent = filterAndGroupCommands(sampleCatalog, '');
        expect(emptyNoRecent.groups.map((g) => g.category)).toEqual(['translate', 'workspace', 'toggle']);
        expect(emptyNoRecent.flatItems).toHaveLength(11);

        const withRecent = filterAndGroupCommands(sampleCatalog, '', ['open-settings', 'toggle-full-page']);
        expect(withRecent.groups[0]).toEqual({
            category: 'recent',
            items: [
                sampleCatalog.find((i) => i.id === 'open-settings'),
                sampleCatalog.find((i) => i.id === 'toggle-full-page'),
            ],
        });
        expect(withRecent.flatItems).toHaveLength(11);

        // 当某分类全部进入 recent 或不可用时该分类不输出空组
        const onlyTranslate = sampleCatalog
            .filter((i) => i.id === 'toggle-full-page')
            .concat({
                ...sampleCatalog.find((i) => i.id === 'start-area-translation')!,
                available: false,
            });
        const allInRecent = filterAndGroupCommands(onlyTranslate, '', ['toggle-full-page']);
        expect(allInRecent.groups.map((g) => g.category)).toEqual(['recent']);

        // 有查询词时按得分降序，同分时最近优先，再按原始顺序
        const twinCommands: CommandPaletteItem[] = [
            {id: 'open-settings', category: 'workspace', title: 'Alpha', description: 'same', keywords: []},
            {id: 'open-learning-center', category: 'workspace', title: 'Alpha', description: 'same', keywords: []},
            {id: 'open-document-translation', category: 'workspace', title: 'Alpha', description: 'same', keywords: []},
        ];
        const searchResult = filterAndGroupCommands(twinCommands, 'alpha', ['open-document-translation']);
        expect(searchResult.groups).toHaveLength(1);
        expect(searchResult.groups[0].category).toBe('results');
        expect(searchResult.flatItems.map((i) => i.id)).toEqual([
            'open-document-translation',
            'open-settings',
            'open-learning-center',
        ]);

        const noMatches = filterAndGroupCommands(sampleCatalog, 'zzzz-no-hit-xxxx');
        expect(noMatches.groups).toEqual([]);
        expect(noMatches.flatItems).toEqual([]);
    });

    it('recordRecentCommand 去重置顶并遵守上限，resolvePaletteKeyAction 覆盖全按键转移', () => {
        let recent: CommandPaletteActionId[] = [];
        for (const id of ['open-settings', 'open-document-translation', 'open-learning-center', 'open-sidepanel', 'toggle-full-page'] as const) {
            recent = recordRecentCommand(recent, id);
        }
        expect(recent).toHaveLength(MAX_RECENT_COMMANDS);
        expect(recent[0]).toBe('toggle-full-page');
        expect(recordRecentCommand(recent, 'open-learning-center', 0)).toEqual(['open-learning-center']);

        expect(resolvePaletteKeyAction('Escape', 0, 0)).toEqual({type: 'close'});
        expect(resolvePaletteKeyAction('ArrowDown', 0, 0)).toEqual({type: 'noop'});
        expect(resolvePaletteKeyAction('ArrowDown', -1, 3)).toEqual({type: 'move', nextIndex: 0});
        expect(resolvePaletteKeyAction('ArrowDown', 2, 3)).toEqual({type: 'move', nextIndex: 0});
        expect(resolvePaletteKeyAction('ArrowUp', -1, 3)).toEqual({type: 'move', nextIndex: 2});
        expect(resolvePaletteKeyAction('ArrowUp', 0, 3)).toEqual({type: 'move', nextIndex: 2});
        expect(resolvePaletteKeyAction('Home', 2, 3)).toEqual({type: 'move', nextIndex: 0});
        expect(resolvePaletteKeyAction('End', 0, 3)).toEqual({type: 'move', nextIndex: 2});
        expect(resolvePaletteKeyAction('Enter', 1, 3)).toEqual({type: 'execute', index: 1});
        expect(resolvePaletteKeyAction('Enter', -1, 3)).toEqual({type: 'noop'});
        expect(resolvePaletteKeyAction('Tab', 0, 3)).toEqual({type: 'noop'});
    });
});

describe('commandPaletteNavigation 后台消息路由', () => {
    it('校验发送者身份并处理文档工作台与侧边栏打开及回退逻辑', async () => {
        const openDocumentWorkspace = vi.fn(async () => undefined);
        const openSidepanel = vi.fn(async () => true);
        const openTranslationCenterFallback = vi.fn(async () => undefined);

        const handlers = createCommandPaletteNavigationHandlers({
            extensionId: 'ext-123',
            openDocumentWorkspace,
            openSidepanel,
            openTranslationCenterFallback,
        });
        const docHandler = handlers.find((h) => h.type === 'openDocumentWorkspace')!;
        const sidepanelHandler = handlers.find((h) => h.type === 'openTranslationSidepanel')!;

        expect(await docHandler.handle({type: 'openDocumentWorkspace'}, {sender: {id: 'other'}})).toEqual({success: false});
        expect(await docHandler.handle({type: 'openDocumentWorkspace'}, {sender: {id: 'ext-123', tab: {windowId: 7}}})).toEqual({success: true});
        expect(openDocumentWorkspace).toHaveBeenCalledWith(7);

        expect(await sidepanelHandler.handle({type: 'openTranslationSidepanel'}, {sender: {id: 'other'}})).toEqual({success: false});
        expect(await sidepanelHandler.handle({type: 'openTranslationSidepanel'}, {sender: {id: 'ext-123', tab: {id: 11, windowId: 7}}})).toEqual({success: true});
        expect(openSidepanel).toHaveBeenCalledWith(11, 7);
        expect(openTranslationCenterFallback).not.toHaveBeenCalled();

        // 原生侧边栏不可用 -> 回退翻译中心
        openSidepanel.mockResolvedValueOnce(false);
        expect(await sidepanelHandler.handle({type: 'openTranslationSidepanel'}, {sender: {id: 'ext-123', tab: {id: 11, windowId: 7}}})).toEqual({success: true});
        expect(openTranslationCenterFallback).toHaveBeenCalledTimes(1);

        // 原生侧边栏抛错（缺少手势）-> 捕获并回退翻译中心
        openSidepanel.mockRejectedValueOnce(new Error('user gesture required'));
        expect(await sidepanelHandler.handle({type: 'openTranslationSidepanel'}, {sender: {id: 'ext-123'}})).toEqual({success: true});
        expect(openTranslationCenterFallback).toHaveBeenCalledTimes(2);
    });
});

describe('CommandPalette.vue 真实组件、runtime 与 commandPaletteFeature 集成', () => {
    let app: Vue.App | undefined;
    let document: Document;
    let win: any;
    let focused: Element | null;
    let events: Map<Element, Record<string, any>>;

    async function settle() {
        await Vue.nextTick();
        await Promise.resolve();
        await Vue.nextTick();
    }

    beforeEach(() => {
        vi.clearAllMocks();
        events = new Map();
        const parsed = parseHTML('<html><body><div id="app"></div><button id="host-trigger">Trigger</button><input id="host-input" /></body></html>');
        win = parsed.window;
        document = win.document;
        focused = document.getElementById('host-trigger');
        Object.defineProperty(document, 'activeElement', {configurable: true, get: () => focused});
        vi.stubGlobal('document', document);
        vi.stubGlobal('window', win);
        vi.stubGlobal('HTMLElement', win.HTMLElement);
        vi.stubGlobal('Node', win.Node);
        vi.stubGlobal('Event', win.Event);
    });

    afterEach(async () => {
        app?.unmount();
        app = undefined;
        const runtime = await import('@/src/features/command-palette/content/runtime');
        runtime.unmountCommandPalette();
        await settle();
        vi.unstubAllGlobals();
    });

    async function mountPaletteComponent() {
        const Component = (await import('@/src/features/command-palette/ui/CommandPalette.vue')).default;
        let exposed: any = null;
        const renderer = Vue.createRenderer({
            patchProp(el: any, key: string, _prev: any, next: any) {
                if (/^on[A-Z]/u.test(key)) {
                    const handlers = events.get(el) || {};
                    handlers[key] = next;
                    events.set(el, handlers);
                    return;
                }
                if (key === 'class') { el.className = next ?? ''; return; }
                if (key === 'value') { el.value = next ?? ''; return; }
                if (next === undefined || next === null || (next === false && !/^(?:aria-|data-)/u.test(key))) {
                    el.removeAttribute(key);
                } else {
                    el.setAttribute(key, String(next));
                }
            },
            insert: (child: any, parent: any, anchor: any = null) => parent.insertBefore(child, anchor),
            remove: (child: any) => child.parentNode?.removeChild(child),
            createElement: (tag: string) => {
                const el = Vue.markRaw(document.createElement(tag)) as any;
                el.focus = () => { focused = el; };
                return el;
            },
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
        app = renderer.createApp({
            setup: () => () => Vue.h(Component as Vue.Component, {
                ref: (vm: any) => { if (vm) exposed = vm; },
            }),
        });
        app.config.warnHandler = () => {};
        app.mount(document.getElementById('app')!);
        await settle();
        return exposed;
    }

    it('CommandPalette.vue 打开聚焦、搜索过滤、键盘导航、鼠标悬停执行、关闭归还焦点及边界分支', async () => {
        const trigger = document.getElementById('host-trigger') as HTMLElement;
        const focusCalls: unknown[] = [];
        trigger.focus = ((opts?: FocusOptions) => {
            focusCalls.push(opts);
            focused = trigger;
        }) as typeof trigger.focus;
        focused = trigger;

        const exposed = await mountPaletteComponent();
        expect(exposed.isOpen()).toBe(false);
        // 关闭态调用 close 是空操作
        exposed.close();

        const commands = buildDefaultCommandCatalog({
            translate: (key) => task7Messages['zh-CN'][key as keyof typeof task7Messages['zh-CN']] ?? key,
            fullPageActive: false,
            displayMode: 1,
            floatingBallEnabled: true,
            smartHighlightEnabled: false,
            writingAssistantEnabled: false,
            canAreaTranslate: true,
            canOpenSidepanel: true,
            canOpenDocument: true,
            canSmartHighlight: true,
            shortcuts: {fullPage: 'Alt+T'},
        });
        const onExecute = vi.fn();

        // 打开后聚焦输入框
        exposed.open({commands, recentIds: ['open-settings'], shortcutHint: 'Alt+K', onExecute});
        await settle();
        expect(exposed.isOpen()).toBe(true);
        const dialog = document.querySelector('[data-testid="command-palette-dialog"]')!;
        const input = document.querySelector('[data-testid="command-palette-input"]') as HTMLInputElement;
        expect(focused).toBe(input);

        // 重复打开（已打开状态）不会覆盖 previousFocused，且传空命令列表将 activeIndex 置 -1
        exposed.open({commands: [], recentIds: [], shortcutHint: '', onExecute});
        await settle();
        expect(document.querySelector('[data-testid="command-palette-empty"]')).not.toBeNull();

        // 重新打开完整目录
        exposed.open({commands, recentIds: ['open-settings'], shortcutHint: 'Alt+K', onExecute});
        await settle();

        // 键盘导航：ArrowDown / ArrowUp / Home / End / noop / IME 组合输入保护 / Enter
        const keydown = events.get(dialog)!.onKeydown;
        const makeKey = (key: string, extra: Record<string, unknown> = {}) => ({
            key,
            isComposing: false,
            keyCode: 0,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
            ...extra,
        });
        // IME 组合输入期间的 Enter / Escape 必须忽略
        const imeEnter = makeKey('Enter', {isComposing: true});
        keydown(imeEnter);
        expect(imeEnter.preventDefault).not.toHaveBeenCalled();
        expect(exposed.isOpen()).toBe(true);
        const ime229Esc = makeKey('Escape', {keyCode: 229});
        keydown(ime229Esc);
        expect(ime229Esc.preventDefault).not.toHaveBeenCalled();
        expect(exposed.isOpen()).toBe(true);

        // keyup 与 keypress 同样阻止冒泡
        const keyupEv = {stopPropagation: vi.fn()};
        const keypressEv = {stopPropagation: vi.fn()};
        events.get(dialog)!.onKeyup(keyupEv);
        events.get(dialog)!.onKeypress(keypressEv);
        expect(keyupEv.stopPropagation).toHaveBeenCalledOnce();
        expect(keypressEv.stopPropagation).toHaveBeenCalledOnce();

        const downEv = makeKey('ArrowDown');
        keydown(downEv);
        expect(downEv.preventDefault).toHaveBeenCalledOnce();
        keydown(makeKey('End'));
        keydown(makeKey('Home'));
        const noopEv = makeKey('Tab');
        keydown(noopEv);
        expect(noopEv.preventDefault).not.toHaveBeenCalled();

        // 输入过滤 -> 无结果 -> 清空恢复
        input.value = 'zzzz-no-match';
        input.dispatchEvent(new win.Event('input', {bubbles: true}));
        await settle();
        expect(document.querySelector('[data-testid="command-palette-empty"]')).not.toBeNull();

        input.value = '文档';
        input.dispatchEvent(new win.Event('input', {bubbles: true}));
        await settle();
        const docBtn = document.querySelector('[data-command-id="open-document-translation"]')!;
        expect(docBtn).not.toBeNull();

        // 鼠标悬停高亮 + Enter 执行 + 归还焦点
        events.get(docBtn)!.onMouseenter();
        await settle();
        keydown(makeKey('Enter'));
        await settle();
        expect(onExecute).toHaveBeenCalledWith('open-document-translation');
        expect(exposed.isOpen()).toBe(false);
        expect(focusCalls).toHaveLength(1);
        expect(focused).toBe(trigger);

        // preventScroll 抛错时回退无参 focus()；并且测试点击按钮、backdrop 与 Esc
        let firstThrow = true;
        trigger.focus = ((opts?: FocusOptions) => {
            if (opts && firstThrow) {
                firstThrow = false;
                throw new Error('unsupported options');
            }
            focusCalls.push(opts);
            focused = trigger;
        }) as typeof trigger.focus;

        // 立即打开后同步关闭（覆盖 nextTick 中 !opened.value 分支）
        exposed.open({commands, recentIds: [], shortcutHint: 'Alt+K', onExecute});
        exposed.close();
        await settle();
        expect(focusCalls).toHaveLength(2);

        // 非 HTMLElement 的 activeElement + Escape 关闭
        focused = null;
        exposed.open({commands, recentIds: [], shortcutHint: 'Alt+K', onExecute});
        await settle();
        const backdrop = document.querySelector('[data-testid="command-palette-backdrop"]')!;
        events.get(backdrop)?.onPointerdown?.({stopPropagation: vi.fn()});
        events.get(backdrop)?.onWheelPassive?.({stopPropagation: vi.fn()});
        events.get(document.querySelector('[data-testid="command-palette-dialog"]')!)!.onKeydown(makeKey('Escape'));
        await settle();
        expect(exposed.isOpen()).toBe(false);

        // 点击命令项（含异步拒绝安全兜底）& 点击关闭按钮 & 点击背景
        const rejectingExecute = vi.fn(async () => { throw new Error('command failed'); });
        exposed.open({commands, recentIds: [], shortcutHint: 'Alt+K', onExecute: rejectingExecute});
        await settle();
        events.get(document.querySelector('[data-command-id="open-settings"]')!)!.onClick();
        await settle();
        expect(rejectingExecute).toHaveBeenLastCalledWith('open-settings');

        exposed.open({commands, recentIds: [], shortcutHint: 'Alt+K', onExecute});
        await settle();
        events.get(document.querySelector('[data-testid="command-palette-close"]')!)!.onClick();
        await settle();
        expect(exposed.isOpen()).toBe(false);

        // 点击背景 self 关闭 + 点击 dialog 内不关闭
        exposed.open({commands, recentIds: [], shortcutHint: 'Alt+K', onExecute});
        await settle();
        const bd = document.querySelector('[data-testid="command-palette-backdrop"]')!;
        events.get(document.querySelector('[data-testid="command-palette-dialog"]')!)!.onClick({stopPropagation: vi.fn()});
        expect(exposed.isOpen()).toBe(true);
        events.get(bd)!.onClick({target: bd, currentTarget: bd});
        await settle();
        expect(exposed.isOpen()).toBe(false);

        // 卸载清理
        app?.unmount();
        app = undefined;
    });

    it('runtime 快捷键避让输入框、惰性 Shadow 挂载、11 项动作执行与卸载清理', async () => {
        const {config} = await import('@/src/services/config/store');
        const runtime = await import('@/src/features/command-palette/content/runtime');
        config.on = true;
        config.commandPaletteEnabled = true;
        config.commandPaletteHotkey = 'Alt+K';
        config.customCommandPaletteHotkey = '';
        config.uiLanguage = 'zh-CN';
        config.display = 1;
        config.disableFloatingBall = false;
        config.writing = {...config.writing, enabled: false};

        let lastPayload: any = null;
        let isOpenState = false;
        const removeMock = vi.fn();
        const shadowHost = {isConnected: true};
        const fakeUi = {
            shadowHost,
            remove: removeMock,
            mounted: {
                instance: {
                    open: vi.fn((payload: any) => { lastPayload = payload; isOpenState = true; }),
                    close: vi.fn(() => { isOpenState = false; }),
                    isOpen: vi.fn(() => isOpenState),
                },
            },
        };
        createVueShadowUiMock.mockResolvedValue(fakeUi);

        const ports = {
            isFullPageActive: vi.fn(() => false),
            toggleFullPage: vi.fn(),
            switchDisplayMode: vi.fn(),
            startSectionTranslation: vi.fn(),
            startAreaTranslation: vi.fn(),
            openSidepanel: vi.fn(),
            openDocumentTranslation: vi.fn(),
            openLearningCenter: vi.fn(),
            openSettings: vi.fn(),
            toggleFloatingBall: vi.fn(),
            toggleSmartHighlight: vi.fn(),
            isSmartHighlightActive: vi.fn(() => false),
            toggleWritingAssistant: vi.fn(),
            canAreaTranslate: vi.fn(() => true),
            canOpenSidepanel: vi.fn(() => true),
            canOpenDocument: vi.fn(() => true),
            canSmartHighlight: vi.fn(() => true),
            shortcuts: vi.fn(() => ({fullPage: 'Alt+T'})),
        };

        // 未挂载时 openCommandPalette / closeCommandPalette 安全空操作
        await runtime.openCommandPalette();
        runtime.closeCommandPalette();
        expect(runtime.isCommandPaletteMounted()).toBe(false);

        // 无效 ctx 不挂载
        runtime.mountCommandPalette({isInvalid: true} as any, ports);
        expect(runtime.isCommandPaletteMounted()).toBe(false);

        // 正常挂载 & 重复挂载幂等
        const validCtx = {isInvalid: false} as any;
        runtime.mountCommandPalette(validCtx, ports);
        runtime.mountCommandPalette(validCtx, ports);
        expect(runtime.isCommandPaletteMounted()).toBe(true);

        // 通过 document keydown 触发：先测忽略条件（非 trusted / repeat / IME / disabled / 非匹配键 / 输入框及 Shadow DOM 可编辑元素）
        const dispatchKey = (props: Record<string, any>, path: EventTarget[] = [document.body]) => {
            const {isTrusted = true, ...rest} = props;
            const ev: any = new win.Event('keydown', {bubbles: true, cancelable: true});
            Object.defineProperty(ev, 'isTrusted', {value: isTrusted, configurable: true});
            Object.assign(ev, {
                key: 'k', code: 'KeyK', altKey: true, ctrlKey: false, shiftKey: false, metaKey: false,
                repeat: false, isComposing: false, keyCode: 0,
                ...rest,
            });
            ev.composedPath = () => path;
            ev.preventDefault = vi.fn();
            ev.stopPropagation = vi.fn();
            document.dispatchEvent(ev);
            return ev;
        };

        dispatchKey({isTrusted: false});
        dispatchKey({repeat: true});
        dispatchKey({isComposing: true});
        dispatchKey({keyCode: 229});
        config.commandPaletteEnabled = false;
        dispatchKey({});
        config.commandPaletteEnabled = true;
        dispatchKey({key: 'x', code: 'KeyX'});
        dispatchKey({}, [document.getElementById('host-input')!]);
        // Shadow DOM 内嵌 contenteditable 节点通过 composedPath() 识别并避让
        const editableDiv = document.createElement('div');
        Object.defineProperty(editableDiv, 'isContentEditable', {value: true, configurable: true});
        const nonElementNode = document.createTextNode('typing');
        dispatchKey({}, [nonElementNode, editableDiv, document.body]);
        expect(createVueShadowUiMock).not.toHaveBeenCalled();

        // 使用 Ctrl+Shift+K 在输入框内允许触发（覆盖 isEditableInputTarget 中 ctrlKey 返回 false）
        config.commandPaletteHotkey = 'Ctrl+Shift+K';
        const ctrlEv = dispatchKey({altKey: false, ctrlKey: true, shiftKey: true}, [document.getElementById('host-input')!]);
        expect(ctrlEv.preventDefault).toHaveBeenCalledOnce();
        await vi.waitFor(() => expect(isOpenState).toBe(true));
        expect(createVueShadowUiMock).toHaveBeenCalledTimes(1);

        // 命令动作抛错或返回 false 时安全捕获并弹出 showPageNotice，不产生未处理拒绝
        ports.startSectionTranslation.mockReturnValueOnce(false as any);
        await lastPayload.onExecute('start-section-translation');
        expect(showPageNoticeMock).toHaveBeenCalledTimes(1);
        ports.openSettings.mockRejectedValueOnce(new Error('bg down'));
        await lastPayload.onExecute('open-settings');
        expect(showPageNoticeMock).toHaveBeenCalledTimes(2);
        ports.startSectionTranslation.mockClear();
        ports.openSettings.mockClear();
        showPageNoticeMock.mockClear();

        // 执行全部 11 项命令动作
        const allIds: CommandPaletteActionId[] = [
            'toggle-full-page',
            'switch-display-mode',
            'start-section-translation',
            'start-area-translation',
            'open-sidepanel',
            'open-document-translation',
            'open-learning-center',
            'open-settings',
            'toggle-floating-ball',
            'toggle-smart-highlight',
            'toggle-writing-assistant',
        ];
        for (const id of allIds) {
            await lastPayload.onExecute(id);
        }
        expect(ports.toggleFullPage).toHaveBeenCalledOnce();
        expect(ports.switchDisplayMode).toHaveBeenCalledOnce();
        expect(ports.startSectionTranslation).toHaveBeenCalledOnce();
        expect(ports.startAreaTranslation).toHaveBeenCalledOnce();
        expect(ports.openSidepanel).toHaveBeenCalledOnce();
        expect(ports.openDocumentTranslation).toHaveBeenCalledOnce();
        expect(ports.openLearningCenter).toHaveBeenCalledOnce();
        expect(ports.openSettings).toHaveBeenCalledOnce();
        expect(ports.toggleFloatingBall).toHaveBeenCalledOnce();
        expect(ports.toggleSmartHighlight).toHaveBeenCalledOnce();
        expect(ports.toggleWritingAssistant).toHaveBeenCalledOnce();

        // 已打开状态下再次 openCommandPalette 会切换关闭
        await runtime.openCommandPalette();
        expect(isOpenState).toBe(false);

        // 已挂载但关闭状态再次 openCommandPalette 直接复用已挂载 UI（覆盖 ensurePalette 缓存命中）
        await runtime.openCommandPalette();
        expect(isOpenState).toBe(true);
        expect(createVueShadowUiMock).toHaveBeenCalledTimes(1);
        runtime.closeCommandPalette();
        expect(isOpenState).toBe(false);

        // shadowHost 脱离文档时自动重建
        shadowHost.isConnected = false;
        await runtime.openCommandPalette();
        expect(removeMock).toHaveBeenCalledTimes(1);
        expect(createVueShadowUiMock).toHaveBeenCalledTimes(2);
        shadowHost.isConnected = true;

        // closeCommandPalette 显式关闭
        runtime.closeCommandPalette();
        expect(isOpenState).toBe(false);

        // 快速连按两次 Alt+K（在 createVueShadowUi 完成前）：第二次取消打开，不闪现面板
        runtime.unmountCommandPalette();
        let resolveDoublePress!: (value: any) => void;
        createVueShadowUiMock.mockImplementationOnce(() => new Promise((r) => { resolveDoublePress = r; }));
        runtime.mountCommandPalette(validCtx, ports);
        const firstOpen = runtime.openCommandPalette();
        const secondCancel = runtime.openCommandPalette();
        const doublePressOpen = vi.fn();
        resolveDoublePress({
            shadowHost: {isConnected: true},
            remove: vi.fn(),
            mounted: {instance: {open: doublePressOpen, close: vi.fn(), isOpen: () => false}},
        });
        await Promise.all([firstOpen, secondCancel]);
        expect(doublePressOpen).not.toHaveBeenCalled();

        // 卸载后在异步 createVueShadowUi 返回时自动清理滞后 UI
        runtime.unmountCommandPalette();
        let resolveLate!: (value: any) => void;
        createVueShadowUiMock.mockImplementationOnce(() => new Promise((r) => { resolveLate = r; }));
        runtime.mountCommandPalette(validCtx, ports);
        const lateOpen = runtime.openCommandPalette();
        runtime.unmountCommandPalette();
        const lateRemove = vi.fn();
        resolveLate({shadowHost: {isConnected: true}, remove: lateRemove, mounted: {instance: fakeUi.mounted.instance}});
        await lateOpen;
        expect(lateRemove).toHaveBeenCalledOnce();

        // 再次挂载后，ctx.isInvalid=true 时 ensurePalette 返回 null
        const invalidatingCtx = {isInvalid: false} as any;
        runtime.mountCommandPalette(invalidatingCtx, ports);
        invalidatingCtx.isInvalid = true;
        await runtime.openCommandPalette();
        expect(runtime.isCommandPaletteMounted()).toBe(true);
        runtime.unmountCommandPalette();
    });

    it('createCommandPaletteContentFeature 完整连接 11 个动作、开关与快捷键显示', async () => {
        const {createCommandPaletteContentFeature} = await import('@/src/app/content/commandPaletteFeature');
        const runtime = await import('@/src/features/command-palette/content/runtime');
        const config = new Config();
        config.on = true;
        config.commandPaletteEnabled = true;
        config.display = 1;
        config.floatingBallHotkey = 'Alt+T';
        config.sectionTranslationHotkeyEnabled = true;
        config.selectionAreaEnabled = true;
        config.informationHighlight = {...config.informationHighlight, hotkeyEnabled: true, hotkey: 'Alt+H'};

        const infoHighlightState = {enabled: false};
        const infoHighlight = {
            getState: vi.fn(() => infoHighlightState),
            setEnabled: vi.fn((val: boolean) => { infoHighlightState.enabled = val; }),
        };

        const capabilities = {browser: 'chrome', areaTranslation: true} as any;
        const feature = createCommandPaletteContentFeature({isInvalid: false} as any, config, capabilities, infoHighlight as any);
        expect(feature.id).toBe('command-palette');
        expect(feature.isEnabled()).toBe(true);

        let openedPayload: any = null;
        createVueShadowUiMock.mockResolvedValue({
            shadowHost: {isConnected: true},
            remove: vi.fn(),
            mounted: {
                instance: {
                    open: (payload: any) => { openedPayload = payload; },
                    close: vi.fn(),
                    isOpen: () => false,
                },
            },
        });
        requestConfigPatchMock.mockImplementation(async (patch: Partial<Config>, sender?: (msg: unknown) => Promise<unknown>) => {
            expect(typeof sender).toBe('function');
            // 验证传入的 sender 指向 browser.runtime.sendMessage，且调用前未原地预改 config
            await sender!({type: '__probe__'});
            Object.assign(config, patch);
        });
        sendMessageMock.mockResolvedValue({success: true});

        feature.mount({} as any);
        expect(feature.isMounted!()).toBe(true);
        await runtime.openCommandPalette();
        expect(openedPayload.commands.find((c: any) => c.id === 'toggle-full-page')?.shortcut).toMatch(/T/u);
        expect(openedPayload.commands.find((c: any) => c.id === 'start-section-translation')?.shortcut).toBeTruthy();
        expect(openedPayload.commands.find((c: any) => c.id === 'start-area-translation')?.shortcut).toBeTruthy();
        expect(openedPayload.commands.find((c: any) => c.id === 'toggle-smart-highlight')?.shortcut).toMatch(/H/u);

        // 全文翻译 & 恢复
        isFullPageActiveMock.mockReturnValueOnce(false).mockReturnValueOnce(true);
        await openedPayload.onExecute('toggle-full-page');
        expect(autoTranslateMock).toHaveBeenCalledOnce();
        await openedPayload.onExecute('toggle-full-page');
        expect(restoreOriginalMock).toHaveBeenCalledOnce();

        // 双语 <-> 仅译文切换（不预改 config，经 requestConfigPatch + sendMessage 提交）
        let displayBeforePatch: number | undefined;
        requestConfigPatchMock.mockImplementationOnce(async (patch: Partial<Config>, sender?: (msg: unknown) => Promise<unknown>) => {
            displayBeforePatch = config.display;
            expect(typeof sender).toBe('function');
            await sender!({type: '__probe__'});
            Object.assign(config, patch);
        });
        await openedPayload.onExecute('switch-display-mode');
        expect(displayBeforePatch).toBe(1);
        expect(config.display).toBe(0);
        await openedPayload.onExecute('switch-display-mode');
        expect(config.display).toBe(1);

        // 局部翻译 / 圈选 / 四个后台页面消息（含返回 false 与失败通知）
        await openedPayload.onExecute('start-section-translation');
        expect(startSectionMock).toHaveBeenCalledOnce();
        await openedPayload.onExecute('start-area-translation');
        expect(startAreaMock).toHaveBeenCalledOnce();

        await openedPayload.onExecute('open-sidepanel');
        await openedPayload.onExecute('open-document-translation');
        await openedPayload.onExecute('open-learning-center');
        await openedPayload.onExecute('open-settings');
        expect(sendMessageMock).toHaveBeenCalledWith({type: 'openTranslationSidepanel'});
        expect(sendMessageMock).toHaveBeenCalledWith({type: 'openDocumentWorkspace'});
        expect(sendMessageMock).toHaveBeenCalledWith({type: 'openOptionsPage', section: 'settings-vocabulary'});
        expect(sendMessageMock).toHaveBeenCalledWith({type: 'openOptionsPage'});

        // 后台返回 {success: false} 时触发用户可见提示
        sendMessageMock.mockResolvedValueOnce({success: false});
        showPageNoticeMock.mockClear();
        await openedPayload.onExecute('open-sidepanel');
        expect(showPageNoticeMock).toHaveBeenCalledOnce();

        // 悬浮球 / 智能高亮 / 写作助手切换（验证调用前未预改 config）
        config.disableFloatingBall = false;
        let ballBeforePatch: boolean | undefined;
        requestConfigPatchMock.mockImplementationOnce(async (patch: Partial<Config>, sender?: (msg: unknown) => Promise<unknown>) => {
            ballBeforePatch = config.disableFloatingBall;
            expect(typeof sender).toBe('function');
            Object.assign(config, patch);
        });
        await openedPayload.onExecute('toggle-floating-ball');
        expect(ballBeforePatch).toBe(false);
        expect(config.disableFloatingBall).toBe(true);
        await openedPayload.onExecute('toggle-floating-ball');
        expect(config.disableFloatingBall).toBe(false);
        await openedPayload.onExecute('toggle-smart-highlight');
        expect(infoHighlight.setEnabled).toHaveBeenCalledWith(true);
        config.writing = {...config.writing, enabled: false};
        await openedPayload.onExecute('toggle-writing-assistant');
        expect(config.writing.enabled).toBe(true);
        await openedPayload.onExecute('toggle-writing-assistant');
        expect(config.writing.enabled).toBe(false);

        feature.unmount!();
        expect(feature.isMounted!()).toBe(false);

        // canAreaTranslate 必须严格要求 selectionAreaEnabled === true（undefined/false 均为不可用）
        config.selectionAreaEnabled = undefined as unknown as boolean;
        const undefinedAreaFeature = createCommandPaletteContentFeature({isInvalid: false} as any, config, capabilities);
        undefinedAreaFeature.mount({} as any);
        await runtime.openCommandPalette();
        expect(openedPayload.commands.find((c: any) => c.id === 'start-area-translation')?.available).toBe(false);
        undefinedAreaFeature.unmount!();

        // 无 informationHighlight + 关闭各类快捷键/无效快捷键 + userscript 禁用边界
        config.floatingBallHotkey = 'none';
        config.sectionTranslationHotkeyEnabled = false;
        config.selectionAreaEnabled = false;
        config.informationHighlight = {...config.informationHighlight, hotkeyEnabled: false, hotkey: 'invalid++key'};
        const noHighlightFeature = createCommandPaletteContentFeature({isInvalid: false} as any, config, capabilities);
        noHighlightFeature.mount({} as any);
        await runtime.openCommandPalette();
        await openedPayload.onExecute('toggle-smart-highlight');
        expect(openedPayload.commands.find((c: any) => c.id === 'toggle-smart-highlight')?.available).toBe(false);
        noHighlightFeature.unmount!();

        // formatConfiguredShortcut 的 invalid key 分支覆盖
        config.floatingBallHotkey = 'custom';
        config.customFloatingBallHotkey = 'NotAValidKey';
        const invalidShortcutFeature = createCommandPaletteContentFeature({isInvalid: false} as any, config, capabilities);
        invalidShortcutFeature.mount({} as any);
        await runtime.openCommandPalette();
        expect(openedPayload.commands.find((c: any) => c.id === 'toggle-full-page')?.shortcut).toBe('NotAValidKey');
        invalidShortcutFeature.unmount!();

        const userscriptFeature = createCommandPaletteContentFeature({isInvalid: false} as any, config, {browser: 'userscript', areaTranslation: false} as any);
        expect(userscriptFeature.isEnabled()).toBe(false);
    });

    it('真实 createConfigApplication 集成：命令面板三项配置开关持久化并触发 subscribeConfig', async () => {
        const {createCommandPaletteContentFeature} = await import('@/src/app/content/commandPaletteFeature');
        const runtime = await import('@/src/features/command-palette/content/runtime');
        const initial = normalizeConfig({
            display: 1,
            disableFloatingBall: false,
            writing: {...new Config().writing, enabled: false},
        });
        const records = new Map<string, unknown>([
            ['local:config', {...sanitizeConfigCredentials(initial), __fluentConfigRevision: 2}],
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
        const contentApp = createConfigApplication({storage: {...storage, writeOwner: false}, trustedContext: false});
        await Promise.all([authorityApp.start(), contentApp.start()]);
        const persistHandler = createConfigPersistenceHandler({
            ready: authorityApp.configReady,
            getCurrentConfig: () => authorityApp.config,
            prepareConfigSaveRequest: authorityApp.prepareConfigSaveRequest,
            prepareConfigPatchRequest: authorityApp.prepareConfigPatchRequest,
            saveConfig: authorityApp.saveConfig,
            getCurrentRevision: authorityApp.getConfigRevision,
            isExtensionUrl: (url) => url.startsWith('chrome-extension://ext-palette/'),
        });
        sendMessageMock.mockImplementation(async (message: unknown) => persistHandler.handle(
            JSON.parse(JSON.stringify(message)),
            {sender: {url: 'https://example.com/article'}},
        ));
        requestConfigPatchMock.mockImplementation((patch: Partial<Config>, sender?: (msg: unknown) => Promise<unknown>) => contentApp.requestConfigPatch(patch, sender as any));

        let openedPayload: any = null;
        createVueShadowUiMock.mockResolvedValue({
            shadowHost: {isConnected: true},
            remove: vi.fn(),
            mounted: {
                instance: {
                    open: (payload: any) => { openedPayload = payload; },
                    close: vi.fn(),
                    isOpen: () => false,
                },
            },
        });
        const notified = vi.fn();
        const unsubscribe = contentApp.subscribeConfig(notified);
        const feature = createCommandPaletteContentFeature({isInvalid: false} as any, contentApp.config, {browser: 'chrome', areaTranslation: true} as any);
        feature.mount({} as any);
        await runtime.openCommandPalette();

        await openedPayload.onExecute('switch-display-mode');
        await openedPayload.onExecute('toggle-floating-ball');
        await openedPayload.onExecute('toggle-writing-assistant');

        expect(contentApp.config.display).toBe(0);
        expect(contentApp.config.disableFloatingBall).toBe(true);
        expect(contentApp.config.writing.enabled).toBe(true);
        expect((records.get('local:config') as Record<string, unknown>).display).toBe(0);
        expect((records.get('local:config') as Record<string, unknown>).disableFloatingBall).toBe(true);
        expect(notified).toHaveBeenCalled();

        feature.unmount!();
        unsubscribe();
        await Promise.all([authorityApp.flushConfigHistory(), contentApp.flushConfigHistory()]);
    });
});

describe('CommandPaletteSettings 真实 Vue 组件行为与快捷键冲突校验', () => {
    let app: Vue.App | undefined;
    let document: Document;
    let events: Map<Element, Record<string, any>>;
    let capturedCustomHotkeyProps: any;

    async function settle() {
        await Vue.nextTick();
        await Promise.resolve();
        await Vue.nextTick();
    }

    beforeEach(() => {
        vi.clearAllMocks();
        events = new Map();
        capturedCustomHotkeyProps = null;
        const parsed = parseHTML('<html><body><div id="app"></div></body></html>');
        document = parsed.window.document;
        vi.stubGlobal('document', document);
        vi.stubGlobal('window', parsed.window);
        vi.stubGlobal('HTMLElement', parsed.window.HTMLElement);
        vi.stubGlobal('Node', parsed.window.Node);
        vi.stubGlobal('Event', parsed.window.Event);
    });

    afterEach(async () => {
        app?.unmount();
        app = undefined;
        await settle();
        vi.unstubAllGlobals();
    });

    it('开关控制、预设切换、冲突提示、自定义快捷键确认与取消', async () => {
        const Component = (await import('@/src/features/settings/ui/CommandPaletteSettings.vue')).default;
        const config = Vue.reactive(new Config());
        config.commandPaletteEnabled = true;
        config.commandPaletteHotkey = 'Alt+K';
        config.floatingBallHotkey = 'Alt+P';
        config.quickTranslationProfiles = [{
            id: 'qp-1',
            enabled: true,
            action: 'hover',
            hotkey: 'Shift+Alt+K',
            service: 'default',
            model: '',
            to: 'zh-Hans',
            display: 'default',
            range: 'default',
        } as any];

        const renderer = Vue.createRenderer({
            patchProp(el: any, key: string, _prev: any, next: any) {
                if (/^on[A-Z]/u.test(key)) {
                    const handlers = events.get(el) || {};
                    handlers[key] = next;
                    events.set(el, handlers);
                    return;
                }
                if (key === 'class') { el.className = next ?? ''; return; }
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

        let state: any = null;
        const activeRef = Vue.ref(true);
        app = renderer.createApp({
            setup: () => () => Vue.h(Component as Vue.Component, {
                config,
                active: activeRef.value,
                ref: (vm: any) => { if (vm) state = vm.$.setupState; },
            }),
        });
        for (const name of ['ElSwitch', 'ElSelect', 'ElOption', 'ElButton', 'ElIcon']) {
            app.component(name, Vue.defineComponent({
                inheritAttrs: false,
                emits: ['change', 'click'],
                setup(_, {attrs, slots, emit}) {
                    return () => Vue.h('div', {
                        ...attrs,
                        onChange: (val: unknown) => emit('change', val),
                        onClick: (ev: unknown) => emit('click', ev),
                    }, slots.default?.());
                },
            }));
        }
        app.config.warnHandler = () => {};
        app.mount(document.getElementById('app')!);
        await settle();

        // 切换到冲突的预设 Alt+P（与全文翻译冲突）-> 弹出警告且保持原值
        const selectEl = document.querySelector('[data-testid="command-palette-hotkey"]')!;
        events.get(selectEl)!.onChange('Alt+P');
        expect(elMessageWarning).toHaveBeenCalledTimes(1);
        expect(config.commandPaletteHotkey).toBe('Alt+K');

        // 切换到与快捷翻译方案冲突的 Shift+Alt+K -> 弹出警告
        events.get(selectEl)!.onChange('Shift+Alt+K');
        expect(elMessageWarning).toHaveBeenCalledTimes(2);
        expect(config.commandPaletteHotkey).toBe('Alt+K');

        // 切换到无冲突预设 Ctrl+Shift+K -> 更新成功
        events.get(selectEl)!.onChange('Ctrl+Shift+K');
        await settle();
        expect(config.commandPaletteHotkey).toBe('Ctrl+Shift+K');

        // 选择 custom（无已存自定义键）-> 打开录制弹窗
        events.get(selectEl)!.onChange('custom');
        await settle();
        expect(state.showCustomHotkeyDialog).toBe(true);

        // 确认有效自定义快捷键
        state.handleCustomHotkeyConfirm('Ctrl+Alt+J');
        await settle();
        expect(config.commandPaletteHotkey).toBe('custom');
        expect(config.customCommandPaletteHotkey).toBe('Ctrl+Alt+J');
        expect(elMessageMock).toHaveBeenCalledTimes(1);

        // 取消录制弹窗
        state.openCustomHotkeyDialog();
        state.handleCustomHotkeyCancel();
        expect(state.showCustomHotkeyDialog).toBe(false);

        // 关闭开关 -> 停用后再打开（无冲突）
        const switchEl = document.querySelector('[data-testid="command-palette-enabled"]')!;
        events.get(switchEl)!.onChange(false);
        expect(config.commandPaletteEnabled).toBe(false);

        // 设置冲突后再尝试启用 -> 阻止启用并警告
        config.floatingBallHotkey = 'custom';
        config.customFloatingBallHotkey = 'Ctrl+Alt+J';
        events.get(switchEl)!.onChange(true);
        expect(config.commandPaletteEnabled).toBe(false);
        expect(elMessageWarning).toHaveBeenCalledTimes(3);

        // 解除冲突后成功启用
        config.customFloatingBallHotkey = 'Alt+T';
        events.get(switchEl)!.onChange(true);
        expect(config.commandPaletteEnabled).toBe(true);
        expect(capturedCustomHotkeyProps).toBeNull();
    });

    it('双向快捷键冲突校验：其他设置组件绑定 Alt+K 时可识别全局命令面板占用', async () => {
        const config = Vue.reactive(new Config());
        config.commandPaletteEnabled = true;
        config.commandPaletteHotkey = 'Alt+K';
        config.sectionTranslationHotkeyEnabled = true;
        config.paragraphCopyEnabled = true;

        const renderer = Vue.createRenderer({
            patchProp(el: any, key: string, _prev: any, next: any) {
                if (/^on[A-Z]/u.test(key)) return;
                if (key === 'class') { el.className = next ?? ''; return; }
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

        const checkComponent = async (loader: () => Promise<{default: Vue.Component}>, extraProps: Record<string, unknown>, check: (setupState: any) => string) => {
            const Comp = {...(await loader()).default, render: () => null} as Vue.Component;
            let state: any = null;
            const localApp = renderer.createApp({
                setup: () => () => Vue.h(Comp, {
                    config,
                    active: true,
                    ...extraProps,
                    ref: (vm: any) => { if (vm) state = vm.$.setupState; },
                }),
            });
            for (const name of ['ElSwitch', 'ElSelect', 'ElOption', 'ElButton', 'ElIcon', 'ElDialog', 'ElInput', 'ElPopover', 'ElInputNumber']) {
                localApp.component(name, Vue.defineComponent({
                    inheritAttrs: false,
                    setup(_, {slots}) { return () => Vue.h('div', slots.default?.()); },
                }));
            }
            localApp.config.warnHandler = () => {};
            const container = document.createElement('div');
            document.body.appendChild(container);
            localApp.mount(container);
            await settle();
            const message = check(state);
            localApp.unmount();
            container.remove();
            return message;
        };

        expect(await checkComponent(
            () => import('@/src/features/settings/ui/SectionTranslationSettings.vue'),
            {},
            (s) => s.findHotkeyConflict('Alt+K'),
        )).toBeTruthy();

        expect(await checkComponent(
            () => import('@/src/features/settings/ui/AreaTranslationSettings.vue'),
            {enabled: true, showOcr: false, serviceOptions: []},
            (s) => s.findHotkeyConflict('Alt+K'),
        )).toBeTruthy();

        expect(await checkComponent(
            () => import('@/src/features/settings/ui/ParagraphCopySettings.vue'),
            {},
            (s) => s.findHotkeyConflict('Alt+K'),
        )).toBeTruthy();

        expect(await checkComponent(
            () => import('@/src/features/settings/ui/InputTranslationSettings.vue'),
            {serviceOptions: []},
            (s) => s.findHotkeyConflict('Alt+K'),
        )).toBeTruthy();

        expect(await checkComponent(
            () => import('@/src/features/settings/ui/QuickTranslationProfiles.vue'),
            {action: 'hover', profiles: []},
            (s) => s.validateProfileHotkey('Alt+K', ''),
        )).toBeTruthy();

        config.writing = {...config.writing, enabled: true, writingHotkey: 'Alt+Shift+W'};
        expect(await checkComponent(
            () => import('@/src/features/settings/ui/CommandPaletteSettings.vue'),
            {},
            (s) => s.findHotkeyConflict('Alt+Shift+W'),
        )).toBeTruthy();
        expect(await checkComponent(
            () => import('@/src/features/settings/ui/WritingSettings.vue'),
            {},
            (s) => s.findWritingHotkeyConflict('Alt+K'),
        )).toBeTruthy();
    });

    it('normalizeConfig 与 buildConfigDiff 完整覆盖自定义空值回退、停用释放与格式化标签', async () => {
        const {normalizeConfig} = await import('@/src/core/config/model');
        const {buildConfigDiff} = await import('@/src/core/config/diff');

        const fallback = normalizeConfig({
            commandPaletteEnabled: false,
            commandPaletteHotkey: 'custom',
            customCommandPaletteHotkey: '',
        });
        expect(fallback.commandPaletteEnabled).toBe(false);
        expect(fallback.commandPaletteHotkey).toBe('Alt+K');

        const base = normalizeConfig({commandPaletteHotkey: 'Alt+K', customCommandPaletteHotkey: ''});
        const custom = normalizeConfig({commandPaletteHotkey: 'custom', customCommandPaletteHotkey: 'Alt+Shift+K'});
        const diff = buildConfigDiff(base, custom);
        const hotkeyEntry = diff.groups.flatMap((g) => g.changes).find((entry) => entry.key === 'commandPaletteHotkey');
        expect(hotkeyEntry?.before).toBe('Alt+K');
        expect(hotkeyEntry?.after).toBe('自定义快捷键');
    });
});
