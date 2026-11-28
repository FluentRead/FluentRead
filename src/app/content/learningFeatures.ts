/**
 * @file src/app/content/learningFeatures.ts
 * 文件职责：组装页面内词汇重遇、材料续读、个人校订、写作与分享入口的静态功能定义。
 * 主要内容：按既有顺序将配置、浏览器能力、无痕状态和 WXT context 接入公开挂载所有权；写作助手按需动态加载以减少普通网页启动解析开销，材料续读持有独立清理函数，油猴构建排除材料与校订登记，词汇重遇仍遵守能力及无痕门控，分享工作台保留独立挂载状态。
 * 模块边界：只组织 feature 公开生命周期；句子听读与收藏统一由主动划词后的卡片承接，不为普通悬停挂载句子工具条，不处理编辑器、存储或学习数据。
 */
import type {ContentScriptContext} from 'wxt/utils/content-script-context';
import type {Config} from '@/src/core/config/model';
import type {BrowserCapabilities} from '@/src/platform/browser/capabilities';
import {isWritingPage} from '@/src/core/config/writing';
import type {ContentFeatureDefinition} from './featureRegistry';
import {mountPersonalCorrectionContent, unmountPersonalCorrectionContent} from './personalCorrections';
import browser from 'webextension-polyfill';
import {mountMaterialContent} from '@/src/features/vocabulary/material/content/public';
import {mountVocabularyReencounter, unmountVocabularyReencounter} from '@/src/features/vocabulary/content/public';
import {mountShareCard, unmountShareCard, isShareCardMounted} from '@/src/features/share-card/public';

type WritingAssistantPublic = typeof import('@/src/features/writing-assistant/public');
let loadedWritingAssistant: WritingAssistantPublic | null = null;
let writingAssistantLoadGeneration = 0;

/** 未首次加载写作模块时直接返回 false，避免在普通网页启动期解析写作 UI 与编辑器脚本。 */
export function isLazyWritingAssistantMounted(): boolean {
    return loadedWritingAssistant?.isWritingAssistantMounted() === true;
}

/** 仅在受支持写作页或用户主动触发快捷键时按需导入写作助手模块，并在卸载或失效时取消迟到挂载。 */
export async function mountLazyWritingAssistant(ctx: ContentScriptContext): Promise<void> {
    const generation = ++writingAssistantLoadGeneration;
    const mod = loadedWritingAssistant ?? (loadedWritingAssistant = await import('@/src/features/writing-assistant/public'));
    if (generation !== writingAssistantLoadGeneration || ctx.isInvalid) return;
    await mod.mountWritingAssistant(ctx);
}

export function unmountLazyWritingAssistant(): void {
    writingAssistantLoadGeneration += 1;
    loadedWritingAssistant?.unmountWritingAssistant();
}

export function createLearningContentFeatures(ctx: ContentScriptContext, config: Config, capabilities: BrowserCapabilities): ContentFeatureDefinition[] {
    let unmountMaterial = () => {};
    return [
        {id: 'vocabulary-reencounter', isEnabled: () => capabilities.browser !== 'userscript' && config.vocabularyReencounterEnabled === true && !browser.extension.inIncognitoContext, mount: runtime => mountVocabularyReencounter(runtime.ctx, runtime.signal), unmount: unmountVocabularyReencounter},
        ...(import.meta.env.BROWSER === 'userscript' ? [] : [
            {id: 'material-resume', isEnabled: () => capabilities.browser !== 'userscript' && config.on && browser.extension?.inIncognitoContext !== true,
                mount: ({signal}) => {unmountMaterial = mountMaterialContent(document, signal, () => config.on);}, unmount: () => unmountMaterial()} satisfies ContentFeatureDefinition,
            {id: 'personal-corrections', isEnabled: () => capabilities.browser !== 'userscript' && config.on && config.personalCorrectionsEnabled === true,
                mount: ({signal}) => mountPersonalCorrectionContent(ctx, signal), unmount: unmountPersonalCorrectionContent} satisfies ContentFeatureDefinition,
        ]),
        {id: 'writing-assistant', isEnabled: () => capabilities.browser !== 'userscript' && config.on && config.writing.enabled && (isWritingPage(window.location.href) || isLazyWritingAssistantMounted()),
            mount: () => mountLazyWritingAssistant(ctx), unmount: unmountLazyWritingAssistant, isMounted: isLazyWritingAssistantMounted},
        {id: 'share-card', isEnabled: () => config.on, mount: () => mountShareCard(ctx), unmount: unmountShareCard, isMounted: isShareCardMounted},
    ];
}
