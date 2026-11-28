/**
 * @file src/core/i18n/messages/videoSubtitleShortcut.ts
 * 文件职责：提供视频字幕显示模式快捷键优化、听力练习模式、本地媒体盲听提示及命令面板切换入口的八语言模块化界面文案资源。
 * 主要内容：聚合 video-subtitle-shortcut 目录下八套语言 JSON，导出 videoSubtitleShortcutChineseMessages 与强类型 videoSubtitleShortcutMessages 映射表，供各语言主目录统一展开，覆盖切换方式、热键冲突提示、菜单徽标与命令面板说明。
 * 模块边界：仅封装静态国际化文本与类型约束，不读取用户配置、不执行键盘匹配、不操作 DOM 或发起网络请求；热键规则与运行时编排分别由 core/config/videoSubtitleShortcut 与 features/video-subtitle 承担。
 */
import type {UiLanguage} from '../types';
import chinese from './video-subtitle-shortcut/zh-CN.json';
import traditionalChinese from './video-subtitle-shortcut/zh-TW.json';
import english from './video-subtitle-shortcut/en-US.json';
import japanese from './video-subtitle-shortcut/ja-JP.json';
import korean from './video-subtitle-shortcut/ko-KR.json';
import french from './video-subtitle-shortcut/fr-FR.json';
import russian from './video-subtitle-shortcut/ru-RU.json';
import spanish from './video-subtitle-shortcut/es-ES.json';

export const videoSubtitleShortcutChineseMessages = chinese;
export const videoSubtitleShortcutMessages: Readonly<Record<UiLanguage, Readonly<Record<string, string>>>> = {
    'zh-CN': chinese,
    'zh-TW': traditionalChinese,
    'en-US': english,
    'ja-JP': japanese,
    'ko-KR': korean,
    'fr-FR': french,
    'ru-RU': russian,
    'es-ES': spanish,
};
