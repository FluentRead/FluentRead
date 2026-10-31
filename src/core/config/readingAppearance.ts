/**
 * @file src/core/config/readingAppearance.ts
 * 文件职责：定义阅读外观字体选项和用户主动保存的网站偏好。
 * 主要内容：只接受原站与系统字体，复用网站基础域规范化，丢弃无效或继承的配置数据。
 * 模块边界：只处理配置数据，不读取页面、不写存储、不下载字体；当前页选择不进入此模型。
 */
import {getSiteBaseDomain} from '@/src/core/site-rules/domain';
export type ReadingFont = 'original' | 'system';
export type ReadingAppearanceSites = Record<string, ReadingFont>;
export function normalizeReadingAppearanceSites(value: unknown): ReadingAppearanceSites {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).flatMap(([key, font]) => {
        const domain = getSiteBaseDomain(key);
        return domain && (font === 'original' || font === 'system') ? [[domain, font]] : [];
    }));
}
