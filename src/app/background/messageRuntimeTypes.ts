/**
 * @file src/app/background/messageRuntimeTypes.ts
 * 文件职责：集中声明后台消息装配使用的共享上下文与启动选项。
 * 主要内容：组合各 handler 的来源上下文，声明标签状态、页面状态回调与浏览器能力注入契约。
 * 模块边界：仅包含类型，不注册监听器、不读取浏览器全局，也不持有业务或文档生命周期状态。
 */
import type {MaterialBackgroundContext, VocabularyBackgroundContext} from './handlers/vocabulary';
import type {AreaTranslationBackgroundContext} from './handlers/areaTranslation';
import type {ConfigPersistenceContext} from './handlers/configPersistence';
import type {FullPageBackgroundContext, QQMailFrameBackgroundContext} from './handlers/fullPageTranslationState';
import type {NeteaseMailFrameBackgroundContext} from '@/src/features/full-page-translation/background/neteaseMailFrameHandlers';
import type {EmbeddedFrameBackgroundContext} from '@/src/features/full-page-translation/background/embeddedFrameHandlers';
import type {PopupContext} from './popupNavigation';
import type {SelectionTtsContext} from './handlers/selectionTts';
import type {TabTranslationStateStore} from './tabTranslationState';
import type {BrowserCapabilities} from '@/src/platform/browser/capabilities';

export type BackgroundRuntimeContext = QQMailFrameBackgroundContext & NeteaseMailFrameBackgroundContext
    & EmbeddedFrameBackgroundContext & ConfigPersistenceContext & VocabularyBackgroundContext & SelectionTtsContext
    & FullPageBackgroundContext & AreaTranslationBackgroundContext & PopupContext & MaterialBackgroundContext;

export interface BackgroundMessageRuntimeOptions {
    tabTranslationStates: TabTranslationStateStore;
    onFullPageStateChanged(tabId: number): void;
    capabilities?: BrowserCapabilities;
}
