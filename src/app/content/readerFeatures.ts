/**
 * @file src/app/content/readerFeatures.ts
 * 文件职责：为内容脚本组装阅读翻译界面的静态功能定义。
 * 主要内容：按既有顺序接入悬浮球、划词、区域、图片、漫画与翻译进度的能力门控、配置判定和公开挂载端口。
 * 模块边界：仅声明注册表输入；启停和挂载所有权由注册表负责，界面与翻译行为仍由各自功能实现。
 */
import type {ContentScriptContext} from 'wxt/utils/content-script-context';
import type {Config} from '@/src/core/config/model';
import type {ContentFeatureDefinition} from './featureRegistry';
import {
    isAreaTranslatorMounted,
    isFloatingBallAllowedOnPage,
    isImageTranslatorNeeded,
    isMangaReaderPage,
    mountAreaTranslator,
    mountFloatingBall,
    mountImageTranslator,
    mountMangaEntry,
    mountSelectionTranslator,
    mountTranslationProgressPanel,
    startAreaTranslationFromContextMenu,
    unmountAreaTranslator,
    unmountFloatingBall,
    unmountImageTranslator,
    unmountMangaEntry,
    unmountSelectionTranslator,
    unmountTranslationProgressPanel,
} from './features';

export function createReaderContentFeatures(ctx: ContentScriptContext, config: Config): ContentFeatureDefinition[] {
    return [
        {
            id: 'floating-ball',
            isEnabled: () => config.on && config.disableFloatingBall !== true && isFloatingBallAllowedOnPage(),
            mount: () => mountFloatingBall(ctx),
            unmount: unmountFloatingBall,
            isMounted: () => Boolean(document.getElementById('fluent-read-floating-ball-container')),
        },
        {
            id: 'selection-translator',
            isEnabled: () => config.on && config.disableSelectionTranslator !== true && config.selectionTranslatorMode !== 'disabled',
            mount: () => mountSelectionTranslator(ctx),
            unmount: unmountSelectionTranslator,
            isMounted: () => Boolean(document.getElementById('fluent-read-selection-translator-container')),
        },
        {
            id: 'selection-area-translator',
            requiredCapability: 'areaTranslation',
            isEnabled: () => config.on && config.selectionAreaEnabled === true,
            mount: () => mountAreaTranslator(ctx),
            unmount: unmountAreaTranslator,
            isMounted: isAreaTranslatorMounted,
        },
        {id: 'image-translator', requiredCapability: 'imageTranslation', isEnabled: isImageTranslatorNeeded,
            mount: () => mountImageTranslator(), unmount: unmountImageTranslator},
        {id: 'manga-entry', requiredCapability: 'imageTranslation',
            isEnabled: () => config.on && config.imageTranslationMangaEnabled && isMangaReaderPage(),
            mount: () => mountMangaEntry(ctx, {startAreaTranslation: startAreaTranslationFromContextMenu}), unmount: unmountMangaEntry},
        {
            id: 'translation-progress-panel',
            isEnabled: () => config.on && config.translationProgressPanelEnabled === true,
            mount: () => mountTranslationProgressPanel(ctx),
            unmount: unmountTranslationProgressPanel,
            isMounted: () => Boolean(document.getElementById('fluent-read-translation-status-container')),
        },
    ];
}
