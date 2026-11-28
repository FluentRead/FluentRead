/**
 * @file src/core/i18n/messages/onboarding.ts
 * 文件职责：提供首启引导直接使用的最小中英文文案，避免欢迎页等待完整英文资源包。
 * 主要内容：集中维护欢迎、选择、确认、保存和菜单加载反馈；完整中文与英文目录复用同一份文案，独立轻量品牌映射按预览语言展示各语言现有产品名称。
 * 模块边界：本文件只有静态界面资源，不加载语言包、不访问配置或浏览器，也不注册部分语言包。
 */
import type {UiLanguage} from '../types';

/** 首启不等待完整资源包；独立维护现有品牌名，避免改变原中英文目录的展开顺序。 */
export const onboardingProductNames = {
    'zh-CN': '流畅阅读',
    'zh-TW': '流暢閱讀',
    'en-US': 'FluentRead',
    'ja-JP': 'FluentRead',
    'ko-KR': 'FluentRead',
    'fr-FR': 'FluentRead',
    'ru-RU': 'FluentRead',
    'es-ES': 'FluentRead',
} as const satisfies Readonly<Record<UiLanguage, string>>;

export const onboardingChineseMessages = {
    'language.saveFailed': '未能切换界面语言，请重试。',
    'language.onboardingWelcomeEyebrow': '欢迎使用',
    'language.onboardingWelcomeNext': '设置界面语言',
    'language.onboardingBack': '返回',
    'language.onboardingTitle': '选择界面语言',
    'language.onboardingLabel': '语言',
    'language.onboardingConfirm': '确认',
    'language.onboardingSuccessEyebrow': '准备好了',
    'common.loading': '加载中…',
    'common.retry': '重试',
} as const;

export type OnboardingMessageKey = keyof typeof onboardingChineseMessages;

export const onboardingEnglishMessages: Readonly<Record<OnboardingMessageKey, string>> = {
    'language.saveFailed': 'Could not change the interface language. Try again.',
    'language.onboardingWelcomeEyebrow': 'Welcome',
    'language.onboardingWelcomeNext': 'Set interface language',
    'language.onboardingBack': 'Back',
    'language.onboardingTitle': 'Choose interface language',
    'language.onboardingLabel': 'Language',
    'language.onboardingConfirm': 'Confirm',
    'language.onboardingSuccessEyebrow': 'You’re all set',
    'common.loading': 'Loading…',
    'common.retry': 'Retry',
};

/** 引导切换失败仍使用同一中英文呈现，不依赖尚未加载的主菜单目录。 */
export const onboardingLoadError = {
    'zh-CN': '菜单加载失败，请重试。',
    'en-US': 'The menu could not be loaded. Please retry.',
} as const;
