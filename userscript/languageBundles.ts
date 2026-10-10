/**
 * @file userscript/languageBundles.ts
 * 文件职责：在构建期保留 userscript 可呈现的界面文案，维持已发布语言资源的固定内容。
 * 主要内容：剔除没有扩展 popup 和本地模型后端的信息高亮文案，以及没有原生右键菜单发送者的操作失败通知；其余菜单、设置、旧文案与模板完整保留。
 * 模块边界：只投影静态字典，不改变扩展词典、资源提交号或运行时语言装载协议。
 */
import {UI_LANGUAGE_BUNDLES as extensionBundles} from '../src/core/i18n/bundles';
import {zhCNMessages as extensionChinese} from '../src/core/i18n/messages/zh-CN';
export function userscriptMessages<T extends Record<string, string>>(messages: T): T {
    return Object.fromEntries(Object.entries(messages).filter(([key]) => !key.startsWith('informationHighlight.')
        && !key.startsWith('contextMenu.notice.'))) as T;
}
export const zhCNMessages = userscriptMessages(extensionChinese);
export const UI_LANGUAGE_BUNDLES = Object.fromEntries(Object.entries(extensionBundles).map(([language, bundle]) =>
    [language, {...bundle, messages: userscriptMessages(bundle.messages)}])) as typeof extensionBundles;
