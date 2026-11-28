/**
 * @file src/core/i18n/messages/dictionaryWorkspace.ts
 * 文件职责：提供高级词典与学习卡设置、操作反馈和划词导出的七语言文案。
 * 主要内容：以稳定键维护来源编辑、离线导入、字段映射、模板预览和本地 Anki 的界面文字。
 * 模块边界：静态界面资源，不查询词典、不加载脚本、不读取用户配置。
 */
import type {UiLanguage} from '../types';
import chinese from './dictionary-workspace/zh-CN.json';
import traditionalChinese from './dictionary-workspace/zh-TW.json';
import english from './dictionary-workspace/en-US.json';
import japanese from './dictionary-workspace/ja-JP.json';
import korean from './dictionary-workspace/ko-KR.json';
import french from './dictionary-workspace/fr-FR.json';
import russian from './dictionary-workspace/ru-RU.json';
import spanish from './dictionary-workspace/es-ES.json';
export const dictionaryWorkspaceChineseMessages = chinese;
export const dictionaryWorkspaceMessages: Readonly<Record<UiLanguage, Readonly<Record<string, string>>>> = {'zh-CN': chinese, 'zh-TW': traditionalChinese, 'en-US': english, 'ja-JP': japanese, 'ko-KR': korean, 'fr-FR': french, 'ru-RU': russian, 'es-ES': spanish};
