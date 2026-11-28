/**
 * @file src/app/content/commandPaletteFeature.ts
 * 文件职责：为内容脚本组合根构建全局命令面板的注册表定义与动作桥接端口，将面板命令映射到既有全文翻译、局部翻译、圈选、页面导航和开关动作。
 * 主要内容：实现 createCommandPaletteContentFeature，集中装配快捷键展示、配置补丁提交、后台页面打开请求和当前页智能高亮切换，让命令面板 feature 不直接依赖其他业务 feature 的内部实现。
 * 模块边界：本文件属于 app/content 组合层，只通过各 feature 的 public 契约与 config store 组装动作，不实现 UI 渲染或搜索算法。
 */
import browser from 'webextension-polyfill';
import type {ContentScriptContext} from 'wxt/utils/content-script-context';
import type {Config} from '@/src/core/config/model';
import {parseHotkey, resolveConfiguredHotkey} from '@/src/core/hotkey';
import {areaTranslationHotkeyDisplayName} from '@/src/core/config/areaTranslation';
import {sectionTranslationHotkeyDisplayName} from '@/src/core/config/sectionTranslation';
import type {BrowserCapabilities} from '@/src/platform/browser/capabilities';
import {requestConfigPatch} from '@/src/services/config/store';
import type {ContentFeatureDefinition} from './featureRegistry';
import type {InformationHighlightContentRuntime} from './informationHighlight';
import {
    autoTranslateEnglishPage,
    isCommandPaletteMounted,
    isFullPageTranslationActive,
    mountCommandPalette,
    restoreOriginalContent,
    startAreaTranslationFromContextMenu,
    startSectionTranslationPicker,
    unmountCommandPalette,
} from './features';

function formatConfiguredShortcut(hotkey: string | undefined, customHotkey: string | undefined): string | undefined {
    const resolved = resolveConfiguredHotkey(hotkey, customHotkey);
    if (!resolved || resolved === 'none') return undefined;
    const parsed = parseHotkey(resolved);
    return parsed.isValid ? parsed.displayName : resolved;
}

export function createCommandPaletteContentFeature(
    ctx: ContentScriptContext,
    config: Config,
    capabilities: BrowserCapabilities,
    informationHighlight?: Pick<InformationHighlightContentRuntime, 'getState' | 'setEnabled'>,
): ContentFeatureDefinition {
    return {
        id: 'command-palette',
        isEnabled: () => capabilities.browser !== 'userscript' && config.on !== false && config.commandPaletteEnabled !== false,
        mount: () => mountCommandPalette(ctx, {
            isFullPageActive: () => isFullPageTranslationActive(),
            toggleFullPage: () => {
                if (isFullPageTranslationActive()) restoreOriginalContent();
                else autoTranslateEnglishPage();
            },
            switchDisplayMode: async () => {
                const nextDisplay = config.display === 1 ? 0 : 1;
                config.display = nextDisplay;
                await requestConfigPatch({display: nextDisplay}).catch(() => undefined);
            },
            startSectionTranslation: () => {
                startSectionTranslationPicker();
            },
            startAreaTranslation: async () => {
                await startAreaTranslationFromContextMenu();
            },
            openSidepanel: async () => {
                await browser.runtime.sendMessage({type: 'openTranslationSidepanel'}).catch(() => undefined);
            },
            openDocumentTranslation: async () => {
                await browser.runtime.sendMessage({type: 'openDocumentWorkspace'}).catch(() => undefined);
            },
            openLearningCenter: async () => {
                await browser.runtime.sendMessage({type: 'openOptionsPage', section: 'settings-vocabulary'}).catch(() => undefined);
            },
            openSettings: async () => {
                await browser.runtime.sendMessage({type: 'openOptionsPage'}).catch(() => undefined);
            },
            toggleFloatingBall: async () => {
                const nextDisabled = config.disableFloatingBall !== true;
                config.disableFloatingBall = nextDisabled;
                await requestConfigPatch({disableFloatingBall: nextDisabled}).catch(() => undefined);
            },
            toggleSmartHighlight: () => {
                if (!informationHighlight) return;
                informationHighlight.setEnabled(!informationHighlight.getState().enabled);
            },
            isSmartHighlightActive: () => informationHighlight?.getState().enabled === true,
            toggleWritingAssistant: async () => {
                const nextWriting = {...config.writing, enabled: config.writing?.enabled !== true};
                config.writing = nextWriting;
                await requestConfigPatch({writing: nextWriting}).catch(() => undefined);
            },
            canAreaTranslate: () => capabilities.areaTranslation && config.selectionAreaEnabled !== false,
            canOpenSidepanel: () => capabilities.browser !== 'userscript',
            canOpenDocument: () => capabilities.browser !== 'userscript',
            canSmartHighlight: () => Boolean(informationHighlight),
            shortcuts: () => ({
                fullPage: formatConfiguredShortcut(config.floatingBallHotkey, config.customFloatingBallHotkey),
                section: config.sectionTranslationHotkeyEnabled
                    ? sectionTranslationHotkeyDisplayName(config.sectionTranslationHotkey, config.customSectionTranslationHotkey)
                    : undefined,
                area: config.selectionAreaEnabled
                    ? areaTranslationHotkeyDisplayName(config.selectionAreaHotkey, config.customSelectionAreaHotkey)
                    : undefined,
                smartHighlight: config.informationHighlight?.hotkeyEnabled
                    ? formatConfiguredShortcut('custom', config.informationHighlight.hotkey)
                    : undefined,
            }),
        }),
        unmount: unmountCommandPalette,
        isMounted: isCommandPaletteMounted,
    };
}
