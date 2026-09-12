/**
 * @file src/app/content/siteAdaptationRuntime.ts
 * 文件职责：装配当前文档的网站适配会话，并把属于候选发现的网页翻译偏好发布给共享核心。
 * 主要内容：初始化规则与路由身份，将规则发布给共享核心，允许邮件子页面注入自身会话清理；另把最少字符数与侧边栏翻译开关注入核心，范围变化时由核心重建缓存，下次翻译生效。
 * 模块边界：只连接核心与现有公开生命周期能力，不实现候选算法、配置存储或额外监听器。
 */
import {builtinSiteRulePack} from '@/src/core/site-adaptation/catalog';
import {createSiteAdaptationSession, type SiteAdaptationSession} from '@/src/core/site-adaptation/session';
import {setCurrentTranslationAdapters, setCurrentTranslationSidebarRegions} from '@/src/core/translation/current';
import {setMinimumTranslationTextLength} from '@/src/core/translation/text';
import type {Config} from '@/src/core/config/model';
import {restoreOriginalContent} from '@/src/features/full-page-translation/public';
import {cancelAllTranslations} from '@/src/app/translation/client';
import {resetPageTranslationContextCache} from '@/src/services/translation/context';

let appliedMinimumLength: number | null = null;
let appliedSidebarRegions: boolean | null = null;

function invalidatePageTranslation(): void {
    restoreOriginalContent();
    cancelAllTranslations();
    resetPageTranslationContextCache();
}

/**
 * 把候选发现相关的网页翻译偏好注入共享核心。已渲染的译文保持不变，
 * 新阈值和范围在下一次发现时生效；返回值说明本次是否真的改变了取值。
 */
export function applyCoreTranslationPreferences(source: Config): boolean {
    const minimumLength = setMinimumTranslationTextLength(source.minTranslationTextLength);
    const sidebarRegions = source.sidebarTranslationEnabled === true;
    setCurrentTranslationSidebarRegions(sidebarRegions);
    const changed = appliedMinimumLength !== minimumLength || appliedSidebarRegions !== sidebarRegions;
    appliedMinimumLength = minimumLength;
    appliedSidebarRegions = sidebarRegions;
    return changed;
}

export function createContentSiteAdaptationRuntime(
    initialSettings: unknown,
    url: URL,
    invalidate: () => void = invalidatePageTranslation,
): SiteAdaptationSession {
    const session = createSiteAdaptationSession(builtinSiteRulePack, {
        apply: setCurrentTranslationAdapters, invalidate,
    });
    session.update(initialSettings);
    session.routeChanged(url);
    return session;
}
