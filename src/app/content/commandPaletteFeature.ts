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

type ConfigPatchSender = NonNullable<Parameters<typeof requestConfigPatch>[1]>;

const sendConfigMessage: ConfigPatchSender = (message) => (
    browser.runtime.sendMessage(message) as ReturnType<ConfigPatchSender>
);

async function sendNavigationMessage(message: Record<string, unknown>): Promise<boolean> {
    const response = await browser.runtime.sendMessage(message) as {success?: boolean} | undefined;
    return response?.success !== false;
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
                await requestConfigPatch({display: config.display === 1 ? 0 : 1}, sendConfigMessage);
            },
            startSectionTranslation: () => startSectionTranslationPicker(),
            startAreaTranslation: () => startAreaTranslationFromContextMenu(),
            openSidepanel: () => sendNavigationMessage({type: 'openTranslationSidepanel'}),
            openDocumentTranslation: () => sendNavigationMessage({type: 'openDocumentWorkspace'}),
            openLearningCenter: () => sendNavigationMessage({type: 'openOptionsPage', section: 'settings-vocabulary'}),
            openSettings: () => sendNavigationMessage({type: 'openOptionsPage'}),
            toggleFloatingBall: async () => {
                await requestConfigPatch({disableFloatingBall: config.disableFloatingBall !== true}, sendConfigMessage);
            },
            toggleSmartHighlight: () => {
                if (!informationHighlight) return false;
                informationHighlight.setEnabled(!informationHighlight.getState().enabled);
                return true;
            },
            isSmartHighlightActive: () => informationHighlight?.getState().enabled === true,
            toggleWritingAssistant: async () => {
                const nextWriting = {...config.writing, enabled: config.writing?.enabled !== true};
                await requestConfigPatch({writing: nextWriting}, sendConfigMessage);
            },
            canAreaTranslate: () => capabilities.areaTranslation && config.selectionAreaEnabled === true,
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
