/**
 * @file src/core/config/shareCard.ts
 * 文件职责：定义双语分享卡片可持久化的外观偏好与稳定默认值。
 * 主要内容：限定八套风格、自适应或方形尺寸、字号、双语顺序及来源和署名开关，并兼容旧配置与非法输入。
 * 模块边界：只归一化外观，不保存摘录、网页标题、URL 或生成的图片，不访问浏览器和 Vue。
 */
export const SHARE_CARD_THEMES = ['coral', 'sky', 'prism', 'pearl', 'moss', 'linen', 'sunset', 'blueprint'] as const;
export type ShareCardTheme = typeof SHARE_CARD_THEMES[number];
export interface ShareCardPreferences {
    theme: ShareCardTheme;
    format: 'auto' | 'square';
    fontSize: 'small' | 'medium' | 'large';
    translationFirst: boolean;
    showSource: boolean;
    showBrand: boolean;
}
export function normalizeShareCardPreferences(value?: unknown): ShareCardPreferences {
    const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const legacyThemes: Record<string, ShareCardTheme> = {paper: 'coral', minimal: 'pearl', night: 'prism', dusk: 'sky', vermilion: 'coral', cobalt: 'sky', aurora: 'prism', noir: 'pearl'};
    const theme = typeof source.theme === 'string' && Object.hasOwn(legacyThemes, source.theme) ? legacyThemes[source.theme] : source.theme;
    return {
        theme: SHARE_CARD_THEMES.includes(theme as ShareCardTheme) ? theme as ShareCardTheme : 'coral',
        format: source.format === 'square' ? 'square' : 'auto',
        fontSize: source.fontSize === 'small' || source.fontSize === 'large' ? source.fontSize : 'medium',
        translationFirst: source.translationFirst === true,
        showSource: source.showSource !== false,
        showBrand: false,
    };
}
