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
import {showPageNotice} from '@/src/features/page-notice/public';
import {config} from '@/src/services/config/store';
import {
    buildDefaultCommandCatalog,
    recordRecentCommand,
    type CommandPaletteActionId,
} from '../core';
import CommandPalette, {type CommandPaletteOpenPayload} from '../ui/CommandPalette.vue';

export type CommandPaletteActionResult = boolean | void | Promise<boolean | void>;

export interface CommandPaletteActionPorts {
    readonly isFullPageActive: () => boolean;
    readonly toggleFullPage: () => CommandPaletteActionResult;
    readonly switchDisplayMode: () => CommandPaletteActionResult;
    readonly switchVideoSubtitleMode?: () => CommandPaletteActionResult;
    readonly startSectionTranslation: () => CommandPaletteActionResult;
    readonly startAreaTranslation: () => CommandPaletteActionResult;
    readonly openSidepanel: () => CommandPaletteActionResult;
    readonly openDocumentTranslation: () => CommandPaletteActionResult;
    readonly openLearningCenter: () => CommandPaletteActionResult;
    readonly openSettings: () => CommandPaletteActionResult;
    readonly toggleFloatingBall: () => CommandPaletteActionResult;
    readonly toggleSmartHighlight: () => CommandPaletteActionResult;
    readonly isSmartHighlightActive: () => boolean;
    readonly toggleWritingAssistant: () => CommandPaletteActionResult;
    readonly canAreaTranslate: () => boolean;
    readonly canOpenSidepanel: () => boolean;
    readonly canOpenDocument: () => boolean;
    readonly canSmartHighlight: () => boolean;
    readonly canSwitchVideoSubtitleMode?: () => boolean;
    readonly getVideoSubtitleModeLabel?: () => string | undefined;
    readonly shortcuts?: () => Partial<{
        readonly fullPage: string;
        readonly section: string;
        readonly area: string;
        readonly smartHighlight: string;
        readonly videoSubtitleMode: string;
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
let activePorts: CommandPaletteActionPorts | null = null;
let recentCommands: CommandPaletteActionId[] = [];
let generation = 0;
let openPending = false;
let desiredOpen = false;

function paletteInstance(): PaletteInstance | null {
    return (ui?.mounted?.instance as PaletteInstance | null) ?? null;
}

export function isCommandPaletteMounted(): boolean {
    return Boolean(controller && !controller.signal.aborted);
}

function isEditableInputTarget(event: KeyboardEvent): boolean {
    if (event.ctrlKey || event.metaKey) return false;
    return event.composedPath().some((node) => (
        node instanceof HTMLElement
        && (node.isContentEditable || node.matches('input,textarea,select'))
    ));
}

function notifyCommandFailed(): void {
    const uiLanguage = normalizeUiLanguage(config.uiLanguage);
    showPageNotice(translate('commandPalette.notice.actionFailed', uiLanguage), 'error', {
        key: 'command-palette',
    });
}

async function ensurePalette(): Promise<PaletteInstance | null> {
    if (ui && !ui.shadowHost.isConnected) {
        const detached = ui;
        ui = null;
        detached.remove();
    }
    if (!controller || !context || context.isInvalid || config.on === false) return null;
    if (ui) return paletteInstance();
    const current = generation;
    const created = await createVueShadowUi(context, {
        name: 'fluent-read-command-palette-ui',
        hostId: HOST_ID,
        component: CommandPalette,
        mode: 'closed',
    });
    if (current !== generation || !controller || context?.isInvalid || (config.on as boolean) === false) {
        created.remove();
        return null;
    }
    ui = created;
    return paletteInstance();
}

function executePortAction(id: CommandPaletteActionId, ports: CommandPaletteActionPorts): CommandPaletteActionResult {
    switch (id) {
        case 'toggle-full-page':
            return ports.toggleFullPage();
        case 'switch-display-mode':
            return ports.switchDisplayMode();
        case 'switch-video-subtitle-mode':
            return ports.switchVideoSubtitleMode?.();
        case 'start-section-translation':
            return ports.startSectionTranslation();
        case 'start-area-translation':
            return ports.startAreaTranslation();
        case 'open-sidepanel':
            return ports.openSidepanel();
        case 'open-document-translation':
            return ports.openDocumentTranslation();
        case 'open-learning-center':
            return ports.openLearningCenter();
        case 'open-settings':
            return ports.openSettings();
        case 'toggle-floating-ball':
            return ports.toggleFloatingBall();
        case 'toggle-smart-highlight':
            return ports.toggleSmartHighlight();
        case 'toggle-writing-assistant':
            return ports.toggleWritingAssistant();
    }
}

async function runCommandAction(id: CommandPaletteActionId, ports: CommandPaletteActionPorts): Promise<void> {
    recentCommands = recordRecentCommand(recentCommands, id);
    try {
        const result = await executePortAction(id, ports);
        if (result === false) notifyCommandFailed();
    } catch {
        notifyCommandFailed();
    }
}

export async function openCommandPalette(): Promise<void> {
    if (!controller || !activePorts || config.on === false) return;
    const current = generation;
    const ports = activePorts;
    const existing = paletteInstance();
    if (existing?.isOpen()) {
        desiredOpen = false;
        existing.close();
        return;
    }
    if (openPending) {
        desiredOpen = !desiredOpen;
        return;
    }
    openPending = true;
    desiredOpen = true;
    let palette: PaletteInstance | null;
    try {
        palette = await ensurePalette();
    } finally {
        openPending = false;
    }
    if (!desiredOpen || !palette || current !== generation || !controller || (config.on as boolean) === false || context?.isInvalid) return;
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
        canSwitchVideoSubtitleMode: ports.canSwitchVideoSubtitleMode?.() === true,
        videoSubtitleModeLabel: ports.getVideoSubtitleModeLabel?.(),
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
    desiredOpen = false;
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
        if (!event.isTrusted || event.repeat || event.isComposing || event.keyCode === 229) return;
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
    openPending = false;
    desiredOpen = false;
    controller?.abort();
    controller = null;
    context = null;
    activePorts = null;
    const previous = ui;
    ui = null;
    previous?.remove();
}
