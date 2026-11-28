/**
 * @file src/core/config/catalog/prompts.ts
 *
 * 文件职责：定义默认翻译提示词、历史默认提示词迁移清单与基础配置默认值，供配置模型与请求模板共同引用。
 * 主要内容：导出 LEGACY_DEFAULT_USER_ROLES 与 defaultOption，维护默认开关、语言、样式、快捷键、默认翻译服务与默认 system_role/user_role 模板文本。
 * 模块边界：仅依赖 ./services 中的默认服务标识，不引入模型清单、界面选项、地域白名单或语言标签数据。
 */

import {services} from './services';

/**
 * 历史默认用户提示词。“If translation is unnecessary … return the original text”
 * 会被较弱的模型理解为可以整句保留原文，导致译文中夹杂明显应当翻译的源语言
 * （Issue #54）。这里保留原文本，供配置归一化把未被用户改写的默认值升级到当前
 * 提示词；用户自定义的提示词不受影响。
 */
export const LEGACY_DEFAULT_USER_ROLES: readonly string[] = Object.freeze([
    `Translate the following text into {{to}}, If translation is unnecessary (e.g. proper nouns, codes, etc.), return the original text. NO explanations. NO notes:

{{origin}}`,
]);

export const defaultOption = {
    on: true,
    uiLanguage: "zh-CN" as const,
    from: "auto",
    to: "zh-Hans",
    style: 1,
    display: 1,
    hotkey: "Control",
    service: services.freeTranslation,
    custom: "http://localhost:11434/v1/chat/completions",
    deeplx: "",
    system_role:
        "You are a professional, authentic machine translation engine.",
    user_role: `Translate the following text into {{to}}. Translate every sentence, clause and phrase in full; no part of the source text may stay in its original language. Keep only code, URLs, and proper nouns that have no established {{to}} form, and keep them inline inside the translated sentence. Return the translation only. NO explanations. NO notes:

{{origin}}`,
    count: 0,
    useCache: true,
    floatingBallHotkey: "Alt+T", // 默认悬浮球快捷键
    inputBoxTranslationTrigger: "disabled", // 默认关闭输入框翻译
    inputBoxTranslationTarget: "en", // 默认翻译成英文
};
