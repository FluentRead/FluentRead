/**
 * @file src/core/i18n/messages/sectionTranslationRulesLegacy.ts
 * 文件职责：补齐区域记忆在配置预览和同步反馈中沿用的中文源文映射。
 * 主要内容：为六种非中文界面提供区域名称、提醒模式和停用后缀的精确译文，由各语言旧文案目录合并，覆盖源文扫描与 Google Drive 配置摘要。
 * 模块边界：仅声明静态资源，不读取同步数据、不改变规则状态，也不代替稳定消息键目录。
 */
import type {RegisteredUiLanguage} from '../types';

type SectionRuleLegacySource = '记住的翻译区域' | '提醒' | '· 已停用';

export const sectionTranslationRulesLegacyText = {
    'zh-TW': {
        '记住的翻译区域': '記住的翻譯區域',
        '提醒': '提醒',
        '· 已停用': '· 已停用',
    },
    'en-US': {
        '记住的翻译区域': 'Remembered translation areas',
        '提醒': 'Reminder',
        '· 已停用': '· Disabled',
    },
    'ja-JP': {
        '记住的翻译区域': '保存した翻訳範囲',
        '提醒': 'リマインダー',
        '· 已停用': '· 無効',
    },
    'ko-KR': {
        '记住的翻译区域': '저장한 번역 영역',
        '提醒': '알림',
        '· 已停用': '· 사용 안 함',
    },
    'fr-FR': {
        '记住的翻译区域': 'Zones de traduction mémorisées',
        '提醒': 'Rappel',
        '· 已停用': '· Désactivée',
    },
    'ru-RU': {
        '记住的翻译区域': 'Сохранённые области перевода',
        '提醒': 'Напоминание',
        '· 已停用': '· Отключено',
    },
    'es-ES': {
        '记住的翻译区域': 'Zonas de traducción guardadas',
        '提醒': 'Recordatorio',
        '· 已停用': '· Desactivada',
    },
} as const satisfies Readonly<Record<RegisteredUiLanguage, Readonly<Record<SectionRuleLegacySource, string>>>>;
