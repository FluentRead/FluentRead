/**
 * @file src/features/settings/model/sitePreferences.ts
 * 文件职责：将自动翻译、禁用扩展、隐藏悬浮球和仅译文网站名单组合成可编辑偏好与可解释的生效状态。
 * 主要内容：按主域去重展示、生成仅涉及目标网站的更新、保留重叠偏好，并复用运行时自动翻译判定解释优先级。
 * 模块边界：不持久化、不读取标签页、不请求网址；数据来自现有配置，禁用扩展优先于自动翻译且不清除其他偏好。
 */
import {getSiteBaseDomain, normalizeSiteDomains, resolveSiteTranslationDisplay, shouldAutoTranslatePage} from '@/src/core/site-rules/domain';

export interface SitePreferences {
    on: boolean;
    autoTranslate: boolean;
    disableFloatingBall: boolean;
    alwaysTranslateDomains: string[];
    disabledExtensionDomains: string[];
    floatingBallDisabledDomains: string[];
    translationOnlyDomains?: string[];
    display?: number;
}
export type SitePreferenceLists = Pick<SitePreferences, 'alwaysTranslateDomains' | 'disabledExtensionDomains' | 'floatingBallDisabledDomains' | 'translationOnlyDomains'>;
export interface SitePreferenceRow {
    domain: string;
    alwaysTranslate: boolean;
    extensionDisabled: boolean;
    floatingBallHidden: boolean;
    translationOnly: boolean;
}

/** 同一网站只出现一行，不改变存储格式或悄悄消除用户的重叠偏好。 */
export function listSitePreferences(config: SitePreferenceLists): SitePreferenceRow[] {
    const always = new Set(normalizeSiteDomains(config.alwaysTranslateDomains));
    const disabled = new Set(normalizeSiteDomains(config.disabledExtensionDomains));
    const hidden = new Set(normalizeSiteDomains(config.floatingBallDisabledDomains));
    const single = new Set(normalizeSiteDomains(config.translationOnlyDomains));
    return [...new Set([...always, ...disabled, ...hidden, ...single])]
        .sort((a, b) => a.localeCompare(b)).map(domain => ({domain, alwaysTranslate: always.has(domain),
            extensionDisabled: disabled.has(domain), floatingBallHidden: hidden.has(domain), translationOnly: single.has(domain)}));
}

/** 添加、修改、删除与撤销均只重建网站名单，绝不写入全局开关或适配包。 */
export function updateSitePreference(config: SitePreferenceLists, input: string, row: Omit<SitePreferenceRow, 'domain'> | null): SitePreferenceLists | null {
    const domain = getSiteBaseDomain(input);
    if (!domain) return null;
    const update = (values: string[] | undefined, included: boolean) => {
        const result = normalizeSiteDomains(values).filter(value => value !== domain);
        if (included) result.push(domain);
        return result;
    };
    return {
        alwaysTranslateDomains: update(config.alwaysTranslateDomains, row?.alwaysTranslate === true),
        disabledExtensionDomains: update(config.disabledExtensionDomains, row?.extensionDisabled === true),
        floatingBallDisabledDomains: update(config.floatingBallDisabledDomains, row?.floatingBallHidden === true),
        translationOnlyDomains: update(config.translationOnlyDomains, row?.translationOnly === true),
    };
}

/** 只接受完整 HTTP(S) 网址；未识别公共后缀名单不影响全局自动翻译的既有语义。 */
export function previewSitePreferences(input: string, config: SitePreferences): null | {
    url: string; domain: string | null; extension: 'paused' | 'disabled' | 'enabled';
    translation: 'paused' | 'disabled' | 'global' | 'site' | 'manual';
    floatingBall: 'paused' | 'disabled' | 'hidden-global' | 'hidden-site' | 'visible';
    display: 'bilingual' | 'single';
} {
    let url: URL;
    try { url = new URL(input.trim()); } catch { return null; }
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const domain = getSiteBaseDomain(url);
    const extension = !config.on ? 'paused' : domain && normalizeSiteDomains(config.disabledExtensionDomains).includes(domain) ? 'disabled' : 'enabled';
    return {
        url: url.href, domain, extension,
        display: resolveSiteTranslationDisplay({...config, display: config.display ?? 1}, url) === 0 ? 'single' : 'bilingual',
        translation: extension !== 'enabled' ? extension : shouldAutoTranslatePage(url, config)
            ? config.autoTranslate ? 'global' : 'site' : 'manual',
        floatingBall: extension !== 'enabled' ? extension : config.disableFloatingBall ? 'hidden-global'
            : domain && normalizeSiteDomains(config.floatingBallDisabledDomains).includes(domain) ? 'hidden-site' : 'visible',
    };
}
