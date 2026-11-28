/**
 * @file src/core/i18n/messages/toolbarAction.ts
 * 文件职责：提供浏览器工具栏图标悬停提示文案在八种界面语言下的模块化静态目录，区分默认快捷面板模式与一键翻译模式。
 * 主要内容：聚合 toolbar-action 目录下的简体中文与其余七语 JSON 文案资源，分别导出中文常量与按 UiLanguage 索引的只读映射对象。
 * 模块边界：仅封装静态界面文案常量，不访问浏览器 action API、不读取或持久化用户配置，也不包含动态资源加载逻辑。
 */
import type {UiLanguage} from '../types';
import chinese from './toolbar-action/zh-CN.json';
import traditionalChinese from './toolbar-action/zh-TW.json';
import english from './toolbar-action/en-US.json';
import japanese from './toolbar-action/ja-JP.json';
import korean from './toolbar-action/ko-KR.json';
import french from './toolbar-action/fr-FR.json';
import russian from './toolbar-action/ru-RU.json';
import spanish from './toolbar-action/es-ES.json';

export const toolbarActionChineseMessages = chinese;
export const toolbarActionMessages: Readonly<Record<UiLanguage, Readonly<Record<string, string>>>> = {
    'zh-CN': chinese,
    'zh-TW': traditionalChinese,
    'en-US': english,
    'ja-JP': japanese,
    'ko-KR': korean,
    'fr-FR': french,
    'ru-RU': russian,
    'es-ES': spanish,
};
