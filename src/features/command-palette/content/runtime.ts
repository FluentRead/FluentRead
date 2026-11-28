/**
 * @file src/features/command-palette/content/runtime.ts
 * 文件职责：管理网页内容脚本中的全局命令面板生命周期、快捷键监听、封闭 Shadow DOM 惰性挂载与命令动作分派。
 * 主要内容：监听已配置的命令面板快捷键（默认 Alt+K）并在输入框无修饰键时避让宿主输入，首次触发才创建 Shadow UI，复用纯领域目录构建与最近命令排序，卸载或停用时完整释放监听器、代次与挂载节点。
 * 模块边界：本运行时不直接导入其他业务 feature 的内部实现，所有翻译、切换与导航动作均由调用方通过 CommandPaletteActionPorts 注入；配置读取走共享 config store。
 */
import type {ContentScriptContext} from 'wxt/utils/content-script-context';
import type {ShadowRootContentScriptUi} from 'wxt/utils/content-script-ui/shadow-root';
import {createVueShadowUi, type VueShadowMount} from '@/src/platform/shadow-ui';
import {
    commandPaletteHotkeyDisplayName,
    matchesCommandPaletteHotkey,
} from '@/src/core/config/commandPalette';
import {normalizeUiLanguage, translate} from '@/src/core/i18n';
import {config} from '@/src/services/config/store';
import {
    buildDefaultCommandCatalog,
    recordRecentCommand,
    type CommandPaletteActionId,
} from '../core';
import CommandPalette, {type CommandPaletteOpenPayload} from '../ui/CommandPalette.vue';

export interface CommandPaletteActionPorts {
    readonly isFullPageActive: () => boolean;
    readonly toggleFullPage: () => void;
    readonly switchDisplayMode: () => void | Promise<void>;
    readonly startSectionTranslation: () => void;
    readonly startAreaTranslation: () => void | Promise<void>;
    readonly openSidepanel: () => void | Promise<void>;
    readonly openDocumentTranslation: () => void | Promise<void>;
    readonly openLearningCenter: () => void | Promise<void>;
    readonly openSettings: () => void | Promise<void>;
    readonly toggleFloatingBall: () => void | Promise<void>;
    readonly toggleSmartHighlight: () => void;
    readonly isSmartHighlightActive: () => boolean;
    readonly toggleWritingAssistant: () => void | Promise<void>;
    readonly canAreaTranslate: () => boolean;
    readonly canOpenSidepanel: () => boolean;
    readonly canOpenDocument: () => boolean;
    readonly canSmartHighlight: () => boolean;
    readonly shortcuts?: () => Partial<{
        readonly fullPage: string;
        readonly section: string;
        readonly area: string;
        readonly smartHighlight: string;
    }>;
}

interface PaletteInstance {
    open(payload: CommandPaletteOpenPayload): void;
    close(): void;
    isOpen(): boolean;
}

const HOST_ID = 'fluent-read-command-palette-container';
let context: ContentScriptContext | null = null;
let controller: AbortController | null = null;
let ui: ShadowRootContentScriptUi<VueShadowMount> | null = null;
let pending: Promise<PaletteInstance | null> | null = null;
let activePorts: CommandPaletteActionPorts | null = null;
let recentCommands: CommandPaletteActionId[] = [];
let generation = 0;

function paletteInstance(): PaletteInstance | null {
    return (ui?.mounted?.instance as PaletteInstance | null) ?? null;
}

export function isCommandPaletteMounted(): boolean {
    return Boolean(controller && !controller.signal.aborted);
}

function isEditableInputTarget(event: KeyboardEvent): boolean {
    if (event.ctrlKey || event.metaKey) return false;
    const target = event.composedPath()[0] as Element | undefined;
    return Boolean(target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])'));
}

async function ensurePalette(): Promise<PaletteInstance | null> {
    if (ui && !ui.shadowHost.isConnected) {
        const detached = ui;
        ui = null;
        detached.remove();
    }
    if (!controller || !context || context.isInvalid || config.on === false) return null;
    if (ui) return paletteInstance();
    if (!pending) {
        const current = generation;
        const task = createVueShadowUi(context, {
            name: 'fluent-read-command-palette-ui',
            hostId: HOST_ID,
            component: CommandPalette,
            mode: 'closed',
        }).then((created) => {
            if (current !== generation || !controller || context?.isInvalid || config.on === false) {
                created.remove();
                return null;
            }
            ui = created;
            return paletteInstance();
        }).finally(() => {
            if (pending === task) pending = null;
        });
        pending = task;
    }
    return pending;
}

async function runCommandAction(id: CommandPaletteActionId, ports: CommandPaletteActionPorts): Promise<void> {
    recentCommands = recordRecentCommand(recentCommands, id);
    switch (id) {
        case 'toggle-full-page':
            ports.toggleFullPage();
            return;
        case 'switch-display-mode':
            await ports.switchDisplayMode();
            return;
        case 'start-section-translation':
            ports.startSectionTranslation();
            return;
        case 'start-area-translation':
            await ports.startAreaTranslation();
            return;
        case 'open-sidepanel':
            await ports.openSidepanel();
            return;
        case 'open-document-translation':
            await ports.openDocumentTranslation();
            return;
        case 'open-learning-center':
            await ports.openLearningCenter();
            return;
        case 'open-settings':
            await ports.openSettings();
            return;
        case 'toggle-floating-ball':
            await ports.toggleFloatingBall();
            return;
        case 'toggle-smart-highlight':
            ports.toggleSmartHighlight();
            return;
        case 'toggle-writing-assistant':
            await ports.toggleWritingAssistant();
            return;
    }
}

export async function openCommandPalette(): Promise<void> {
    if (!controller || !activePorts || config.on === false) return;
    const current = generation;
    const ports = activePorts;
    const existing = paletteInstance();
    if (existing?.isOpen()) {
        existing.close();
        return;
    }
    const palette = await ensurePalette();
    if (!palette || current !== generation || !controller || (config.on as boolean) === false || context?.isInvalid) return;
    const uiLanguage = normalizeUiLanguage(config.uiLanguage);
    const commands = buildDefaultCommandCatalog({
        translate: (key) => translate(key, uiLanguage),
        fullPageActive: ports.isFullPageActive(),
        displayMode: config.display,
        floatingBallEnabled: config.disableFloatingBall !== true,
        smartHighlightEnabled: ports.isSmartHighlightActive(),
        writingAssistantEnabled: config.writing?.enabled === true,
        canAreaTranslate: ports.canAreaTranslate(),
        canOpenSidepanel: ports.canOpenSidepanel(),
        canOpenDocument: ports.canOpenDocument(),
        canSmartHighlight: ports.canSmartHighlight(),
        shortcuts: ports.shortcuts?.(),
    });
    palette.open({
        commands,
        recentIds: recentCommands,
        shortcutHint: commandPaletteHotkeyDisplayName(config.commandPaletteHotkey, config.customCommandPaletteHotkey),
        onExecute: (id) => runCommandAction(id, ports),
    });
}

export function closeCommandPalette(): void {
    paletteInstance()?.close();
}

export function mountCommandPalette(
    ctx: ContentScriptContext,
    ports: CommandPaletteActionPorts,
): void {
    if (controller || ctx.isInvalid) return;
    context = ctx;
    activePorts = ports;
    const abortController = new AbortController();
    controller = abortController;
    document.addEventListener('keydown', (event) => {
        if (!event.isTrusted || event.repeat) return;
        if (config.on === false || config.commandPaletteEnabled === false) return;
        if (!matchesCommandPaletteHotkey(event, config.commandPaletteHotkey, config.customCommandPaletteHotkey)) return;
        if (isEditableInputTarget(event)) return;
        event.preventDefault();
        event.stopPropagation();
        void openCommandPalette();
    }, {capture: true, signal: abortController.signal});
}

export function unmountCommandPalette(): void {
    generation += 1;
    controller?.abort();
    controller = null;
    context = null;
    activePorts = null;
    pending = null;
    const previous = ui;
    ui = null;
    previous?.remove();
}
