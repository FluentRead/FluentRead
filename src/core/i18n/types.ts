/**
 * @file src/core/i18n/types.ts
 *
 * 文件职责：定义 FluentRead 界面语言的稳定领域类型，不依赖 Vue、浏览器或配置存储。
 * 主要内容：声明支持的语言标识、翻译参数、资源目录和按需加载的语言资源包结构，供配置归一化、
 * UI 适配器、构建期资源生成和可测试的纯翻译函数共同使用。
 * 模块边界：这里只描述 i18n 数据契约；语言选择的持久化由配置服务负责，Vue 响应式由
 * src/ui/i18n.ts 负责，内容翻译请求不得复用这些界面语言标识。
 */

export type UiLanguage = 'zh-CN' | 'zh-TW' | 'en-US' | 'ja-JP' | 'ko-KR' | 'fr-FR' | 'ru-RU' | 'es-ES';

export type TranslationValue = string | number | boolean;

export type TranslationParams = Record<string, TranslationValue | null | undefined>;

export type MessageCatalog = Readonly<Record<string, string>>;

/** 旧文案模板：正则源码（运行时统一以 u 标志编译）、以 {n} 引用捕获组的译文，以及仍需按界面语言翻译的捕获组序号。 */
export type LegacyPatternEntry = readonly [pattern: string, template: string, localizedCaptures?: readonly number[]];

/** early 在复合状态拆分前匹配，late 在拆分后兜底；两组都按数组顺序取第一条命中的模板。 */
export interface LegacyPatternSet {
    readonly early: readonly LegacyPatternEntry[];
    readonly late: readonly LegacyPatternEntry[];
}

export type RegisteredUiLanguage = Exclude<UiLanguage, 'zh-CN'>;

/** 构建期模板源数据：正则源码统一以 u 标志编译；English 可省略，省略时 English 界面只使用拆分后的兜底模板。 */
export interface LocalizedLegacyPattern {
    readonly pattern: string;
    readonly localizedCaptures: readonly number[];
    readonly messages: Readonly<Record<Exclude<RegisteredUiLanguage, 'en-US'>, string>> & {readonly 'en-US'?: string};
}

/** 除中文默认目录外，每种界面语言的完整资源包；构建期序列化为 JSON，运行时按需注册。 */
export interface UiLanguageBundle {
    readonly messages: MessageCatalog;
    readonly legacyText: MessageCatalog;
    readonly legacyPatterns: LegacyPatternSet;
}
