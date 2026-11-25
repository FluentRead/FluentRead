/**
 * @file src/app/content/optionalFeatures.ts
 * 文件职责：管理内容页按需挂载的输入框翻译、段落复制与局部翻译入口的配置驱动生命周期。
 * 主要内容：为三个低频 feature 创建受 activation signal 所有的子控制器，按总开关、站点禁用和各自配置增删监听器，局部翻译入口只随总开关与站点状态挂载，并在页面销毁时统一释放。
 * 模块边界：这里只编排 content 生命周期，不实现输入触发算法、段落解析、区域选择或配置持久化；具体行为分别属于 input-translation、paragraph-copy、section-translation 与 config store。
 */
import type {InputTranslationContentFeature} from '@/src/features/input-translation/content';
import {normalizeCustomInputBoxTranslationHotkey} from '@/src/core/config/inputTranslation';

export interface OptionalContentFeatureConfig {
    on?: boolean;
    inputBoxTranslationTrigger?: string;
    customInputBoxTranslationHotkey?: string;
    paragraphCopyEnabled?: boolean;
}

type SiteAwareContentFeatureMount = (options: {isSiteDisabled: () => boolean}, signal: AbortSignal) => void;

export interface OptionalContentFeatureDependencies {
    activationSignal: AbortSignal;
    config: OptionalContentFeatureConfig;
    isSiteDisabled: () => boolean;
    inputTranslationFeature: InputTranslationContentFeature;
    mountParagraphCopyContentFeature: SiteAwareContentFeatureMount;
    /** 局部翻译入口：Popup 按钮随时可用，快捷键由功能内部按配置判断，因此只随总开关与站点状态挂载。 */
    mountSectionTranslationContentFeature: SiteAwareContentFeatureMount;
}

export interface OptionalContentFeatureRuntime {
    sync(): void;
    dispose(): void;
}

export function createOptionalContentFeatureRuntime(
    dependencies: OptionalContentFeatureDependencies,
): OptionalContentFeatureRuntime {
    let inputFeatureController: AbortController | null = null;
    let paragraphCopyFeatureController: AbortController | null = null;
    let sectionTranslationFeatureController: AbortController | null = null;
    let disposed = false;

    const createChildController = (): AbortController => {
        const child = new AbortController();
        if (dependencies.activationSignal.aborted) {
            child.abort();
            return child;
        }
        const abortChild = (): void => child.abort();
        dependencies.activationSignal.addEventListener('abort', abortChild, {once: true});
        child.signal.addEventListener('abort', () => {
            dependencies.activationSignal.removeEventListener('abort', abortChild);
        }, {once: true});
        return child;
    };

    const inputFeatureEnabled = (): boolean => dependencies.config.on !== false
        && !dependencies.isSiteDisabled()
        && dependencies.config.inputBoxTranslationTrigger !== 'disabled'
        && (dependencies.config.inputBoxTranslationTrigger !== 'custom'
            || Boolean(normalizeCustomInputBoxTranslationHotkey(dependencies.config.customInputBoxTranslationHotkey)));
    const paragraphCopyFeatureEnabled = (): boolean => dependencies.config.on === true
        && !dependencies.isSiteDisabled()
        && dependencies.config.paragraphCopyEnabled === true;
    const sectionTranslationFeatureEnabled = (): boolean => dependencies.config.on === true
        && !dependencies.isSiteDisabled();

    const sync = (): void => {
        if (disposed || dependencies.activationSignal.aborted) return;
        if (inputFeatureEnabled()) {
            if (!inputFeatureController) {
                inputFeatureController = createChildController();
                if (!inputFeatureController.signal.aborted) {
                    dependencies.inputTranslationFeature.mount(inputFeatureController.signal);
                }
            }
        } else if (inputFeatureController) {
            inputFeatureController.abort();
            inputFeatureController = null;
            dependencies.inputTranslationFeature.invalidate();
        }

        if (paragraphCopyFeatureEnabled()) {
            if (!paragraphCopyFeatureController) {
                paragraphCopyFeatureController = createChildController();
                if (!paragraphCopyFeatureController.signal.aborted) {
                    dependencies.mountParagraphCopyContentFeature(
                        {isSiteDisabled: dependencies.isSiteDisabled},
                        paragraphCopyFeatureController.signal,
                    );
                }
            }
        } else if (paragraphCopyFeatureController) {
            paragraphCopyFeatureController.abort();
            paragraphCopyFeatureController = null;
        }

        if (sectionTranslationFeatureEnabled()) {
            if (!sectionTranslationFeatureController) {
                sectionTranslationFeatureController = createChildController();
                if (!sectionTranslationFeatureController.signal.aborted) {
                    dependencies.mountSectionTranslationContentFeature(
                        {isSiteDisabled: dependencies.isSiteDisabled},
                        sectionTranslationFeatureController.signal,
                    );
                }
            }
        } else if (sectionTranslationFeatureController) {
            sectionTranslationFeatureController.abort();
            sectionTranslationFeatureController = null;
        }
    };

    const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        inputFeatureController?.abort();
        paragraphCopyFeatureController?.abort();
        sectionTranslationFeatureController?.abort();
        inputFeatureController = null;
        paragraphCopyFeatureController = null;
        sectionTranslationFeatureController = null;
        dependencies.inputTranslationFeature.invalidate();
    };

    return {sync, dispose};
}
