/**
 * @file src/core/i18n/index.ts
 *
 * 文件职责：提供与 UI 框架无关的界面语言目录、归一化和翻译函数。
 * 主要内容：支持中文、English、日本語、한국어、Français、Русский 与 Español，提供稳定的语言配置值、参数插值、中文旧文案迁移
 * 适配和可扩展资源目录。旧文案适配仅用于扩展自己的 UI，不会翻译网页内容或用户输入。
 * 模块边界：本文件不读写 browser.storage，也不依赖 Vue；配置模型只调用这里的纯归一化
 * 规则，Vue 响应式与持久化由 src/ui/i18n.ts 负责。
 */

import {enUSLegacyText, enUSMessages} from './messages/en-US';
import {esESLegacyText, esESMessages} from './messages/es-ES';
import {frFRLegacyText, frFRMessages} from './messages/fr-FR';
import {jaJPLegacyText, jaJPMessages} from './messages/ja-JP';
import {koKRLegacyText, koKRMessages} from './messages/ko-KR';
import {ruRULegacyText, ruRUMessages} from './messages/ru-RU';
import {zhCNMessages} from './messages/zh-CN';
import {translateLegacyPattern} from './messages/legacy-patterns';
import {
    DEFAULT_UI_LANGUAGE,
} from './language';
import type {MessageCatalog, TranslationParams, UiLanguage} from './types';

export * from './types';
export * from './language';

const catalogs: Record<UiLanguage, MessageCatalog> = {
    'zh-CN': zhCNMessages,
    'en-US': enUSMessages,
    'ja-JP': jaJPMessages,
    'ko-KR': koKRMessages,
    'fr-FR': frFRMessages,
    'ru-RU': ruRUMessages,
    'es-ES': esESMessages,
};

const legacyCatalogs: Record<UiLanguage, Readonly<Record<string, string>>> = {
    'zh-CN': {},
    'en-US': enUSLegacyText,
    'ja-JP': jaJPLegacyText,
    'ko-KR': koKRLegacyText,
    'fr-FR': frFRLegacyText,
    'ru-RU': ruRULegacyText,
    'es-ES': esESLegacyText,
};

/** 稳定资源中的中文文案也可供旧模板精确复用，避免同时维护两份相同译文。 */
const messageLegacyCatalogs = Object.fromEntries(
    Object.entries(catalogs).map(([language, catalog]) => [language, Object.fromEntries(
        Object.entries(zhCNMessages).map(([key, source]) => [source, catalog[key] ?? source]),
    )]),
) as Record<UiLanguage, Readonly<Record<string, string>>>;

function formatMessage(template: string, params?: TranslationParams): string {
    if (!params) return template;
    return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (placeholder, name: string) => {
        const value = params[name];
        return value === undefined || value === null ? placeholder : String(value);
    });
}

/** 翻译稳定资源 key；English 缺失时回退到中文，再缺失时返回 key 便于发现漏翻。 */
export function translate(key: string, language: UiLanguage, params?: TranslationParams): string {
    const template = catalogs[language][key] ?? catalogs[DEFAULT_UI_LANGUAGE][key] ?? key;
    return formatMessage(template, params);
}

function preserveWhitespace(value: string, translated: string): string {
    const leading = value.match(/^\s*/u)?.[0] || '';
    const trailing = value.match(/\s*$/u)?.[0] || '';
    const start = leading.length;
    const end = trailing.length > 0 ? value.length - trailing.length : value.length;
    return `${leading}${translated}${end > start ? trailing : ''}`;
}

const legacyPatterns: ReadonlyArray<readonly [RegExp, (match: RegExpExecArray) => string]> = [
    [/^最多 (\d+) 字符$/u, (match) => `Up to ${match[1]} characters`],
    [/^没有找到“(.+)”相关设置$/u, (match) => `No settings found for “${match[1]}”`],
    [/^没有找到包含“(.+)”的服务或模型$/u, (match) => `No service or model contains “${match[1]}”`],
    [/^已完成 (\d+) 次翻译$/u, (match) => `${match[1]} translations completed`],
    [/^已完成 (\d+) 个词条$/u, (match) => `${match[1]} word entries`],
    [/^(\d+) 项$/u, (match) => `${match[1]} items`],
    [/^(\d+) 个模型，点击切换$/u, (match) => `${match[1]} models · click to switch`],
    [/^已达到 (\d+) 个模型上限$/u, (match) => `The limit of ${match[1]} models has been reached`],
    [/^最多只能保存 (\d+) 个自定义服务$/u, (match) => `You can save up to ${match[1]} custom services`],
    [/^自定义服务已达到 (\d+) 个上限$/u, (match) => `The ${match[1]} custom-service limit has been reached`],
    [/^当前：(.+)$/u, (match) => `Current: ${match[1]}`],
    [/^已保存 (.+)，启用插件后生效$/u, (match) => `Saved ${match[1]}; enable the extension for it to take effect`],
    [/^已保存 (.+)，当前网页请刷新后重试$/u, (match) => `Saved ${match[1]}; refresh the current page and try again`],
    [/^已保存 (.+)；(.+)$/u, (match) => `Saved ${match[1]}; ${match[2]}`],
    [/^已关闭 (.+) 的始终翻译，当前网页保持不变$/u, (match) => `Always-translate was disabled for ${match[1]}; the current page is unchanged`],
    [/^已开启 (.+) 的始终翻译$/u, (match) => `Always-translate was enabled for ${match[1]}`],
    [/^已在 (.+) 禁用扩展$/u, (match) => `The extension was disabled on ${match[1]}`],
    [/^已恢复 (.+) 的扩展$/u, (match) => `The extension was restored on ${match[1]}`],
    [/^当前已在 (.+) 禁用扩展，请先恢复扩展$/u, (match) => `The extension is disabled on ${match[1]}; restore it first`],
    [/^恢复 (.+) 的扩展$/u, (match) => `Restore the extension on ${match[1]}`],
    [/^始终翻译 (.+)$/u, (match) => `Always translate ${match[1]}`],
    [/^在 (.+) 禁用扩展$/u, (match) => `Disable the extension on ${match[1]}`],
    [/^所有网站自动翻译已开启，(.+) 会自动翻译$/u, (match) => `Automatic translation is enabled; ${match[1]} will be translated`],
    [/^所有网站自动翻译已开启，请在完整设置中关闭全局开关$/u, () => 'Automatic translation for all websites is enabled. Disable it in full settings first.'],
    [/^当前浏览器暂不支持(.+)$/u, (match) => `This browser does not currently support ${match[1]}`],
    [/^点击开启 · YouTube$/u, () => 'Click to enable · YouTube'],
    [/^(.+) · YouTube$/u, (match) => `${match[1]} · YouTube`],
    [/^(.+) \+ 鼠标悬停$/u, (match) => `${match[1]} + hover`],
    [/^翻译服务：(.+)，当前模型：(.+)$/u, (match) => `Translation service: ${match[1]}, current model: ${match[2]}`],
    [/^翻译服务：(.+)$/u, (match) => `Translation service: ${match[1]}`],
    [/^不支持的按键:\s*(.*)$/u, (match) => `Unsupported key: ${match[1]}`],
    [/^不支持的修饰键:\s*(.*)$/u, (match) => `Unsupported modifier: ${match[1]}`],
    [/^与系统快捷键冲突:\s*(.+)$/u, (match) => `Conflicts with system shortcut: ${translateLegacyText(match[1], 'en-US')}`],
    [/^当前快捷键为 (.+)$/u, (match) => `Current shortcut: ${match[1]}`],
    [/^(.+) 需要 API Key（访问令牌），当前尚未配置；请先在设置中填写，再开始翻译。$/u, (match) => `${translateLegacyText(match[1], 'en-US')} requires an API key (access token), which is not configured. Add it in settings before translating.`],
    [/^(.+) 需要 App Key 和 App Secret，当前尚未完整配置；请先在设置中填写，再开始翻译。$/u, (match) => `${translateLegacyText(match[1], 'en-US')} requires an App Key and App Secret, which are not fully configured. Add them in settings before translating.`],
    [/^(.+) 需要 SecretId 和 SecretKey，当前尚未完整配置；请先在设置中填写，再开始翻译。$/u, (match) => `${translateLegacyText(match[1], 'en-US')} requires a SecretId and SecretKey, which are not fully configured. Add them in settings before translating.`],
    [/^正在播放(原文|单词|译文)$/u, (match) => `Playing ${match[1] === '原文' ? 'original' : match[1] === '单词' ? 'word' : 'translation'}`],
    [/^快捷键已设置为: (.+)$/u, (match) => `Shortcut set to: ${match[1]}`],
    [/^划词翻译快捷键已设置为: (.+)$/u, (match) => `Selection shortcut set to: ${match[1]}`],
    [/^并发数量已更新为 (.+)$/u, (match) => `Concurrency updated to ${match[1]}`],
    [/^已完成真实翻译请求（(.+) ms）。$/u, (match) => `A real translation request completed (${match[1]} ms).`],
    [/^你的请求频率过高，被【(.+)】拒绝了，请稍后再试吧~$/u, (match) => `Your request was rate-limited by ${match[1]}. Try again later.`],
    [/^网络连接失败：(.+)$/u, (match) => `Network connection failed: ${match[1]}`],
    [/^第 (\d+) 条字幕译文$/u, (match) => `Translation for subtitle ${match[1]}`],
    [/^(\d+) 条网站规则$/u, (match) => `${match[1]} website rules`],
    [/^已选 (\d+) 个服务 · 右侧卡片可拖动排序$/u, (match) => `${match[1]} services selected · drag the cards on the right to reorder`],
    [/^(\d+) 个翻译服务$/u, (match) => `${match[1]} translation services`],
    [/^已翻译 (\d+) 次$/u, (match) => `Translated ${match[1]} times`],
    [/^正在请求 (.+)…$/u, (match) => `Requesting ${match[1]}…`],
    [/^分 (\d+) 秒$/u, (match) => `${match[1]} seconds`],
    [/^第 (\d+) \/ (\d+) 页$/u, (match) => `Page ${match[1]} / ${match[2]}`],
    [/^第 (\d+)–(\d+) 条，共 (\d+) 条$/u, (match) => `${match[1]}–${match[2]} of ${match[3]}`],
    [/^查看全部 (\d+) 项$/u, (match) => `View all ${match[1]} items`],
    [/^开始复习 (\d+) 个$/u, (match) => `Review ${match[1]} items`],
    [/^复习 (\d+) 个 · 记得 (\d+) 个 · 忘了 (\d+) 个$/u, (match) => `Reviewed ${match[1]} · remembered ${match[2]} · forgot ${match[3]}`],
    [/^(\d+) 次收藏记录$/u, (match) => `${match[1]} save records`],
    [/^(\d+) 分钟后$/u, (match) => `In ${match[1]} minutes`],
    [/^(\d+) 小时后$/u, (match) => `In ${match[1]} hours`],
    [/^第 (\d+) \/ (\d+) 页 · 共 (\d+) 个$/u, (match) => `Page ${match[1]} / ${match[2]} · ${match[3]} total`],
    [/^(.+) 已标记为掌握$/u, (match) => `${match[1]} marked as mastered`],
    [/^(.+) 已回到学习队列$/u, (match) => `${match[1]} returned to the learning queue`],
    [/^已删除 (.+)$/u, (match) => `Deleted ${match[1]}`],
    [/^确认删除“(.+)”及其复习记录吗？$/u, (match) => `Delete “${match[1]}” and its review records?`],
    [/^已导出 (\d+) 个 Anki 词条$/u, (match) => `Exported ${match[1]} Anki entries`],
    [/^已恢复刚才删除的词条$/u, () => 'The deleted entry was restored'],
    [/^开始记录于 (.+)$/u, (match) => `Recording started ${match[1]}`],
    [/^更新于 (.+)$/u, (match) => `Updated ${match[1]}`],
    [/^用量趋势，共 (.+) Token$/u, (match) => `Usage trend, ${match[1]} tokens`],
    [/^完整数值：(.+) Token$/u, (match) => `Exact value: ${match[1]} tokens`],
    [/^双语 · (.+)$/u, (match) => `Bilingual · ${match[1]}`],
    [/^第 (\d+) 页$/u, (match) => `Page ${match[1]}`],
    [/^(.+) 个可翻译片段$/u, (match) => `${match[1]} translatable segments`],
    [/^(.+) 个片段$/u, (match) => `${match[1]} segments`],
    [/^(.+) 个文本片段$/u, (match) => `${match[1]} text segments`],
    [/^当前展示前 (\d+) 个片段，下载时会包含完整文件。$/u, (match) => `Showing the first ${match[1]} segments; the complete file is included in the download.`],
    [/^文件大小超过 (.+)，请先拆分文件后再翻译。$/u, (match) => `The file is larger than ${match[1]}. Split the file before translating.`],
    [/^下载(双语|译文)文件$/u, (match) => `Download ${match[1] === '双语' ? 'bilingual' : 'translated'} file`],
    [/^第 (\d+) 页第 (\d+) 个文本块译文$/u, (match) => `Translation for text block ${match[2]} on page ${match[1]}`],
    [/^第 (\d+) 个文本片段译文$/u, (match) => `Translation for text segment ${match[1]}`],
    [/^第 (\d+) 段译文$/u, (match) => `Translation for paragraph ${match[1]}`],
    [/^(.+) 项将在滚动到附近时翻译$/u, (match) => `${match[1]} items will be translated as you scroll nearby`],
    [/^最多同时处理 (\d+) 个翻译任务，(.+)；失败后最多重试 (\d+) 次，退避从 (.+) 逐步增加到最多 (.+)。$/u,
        (match) => `Up to ${match[1]} translation tasks run at once, ${match[2]}; failed requests retry up to ${match[3]} times, backing off from ${match[4]} to ${match[5]}.`],
    [/^(.+)不限速$/u, (match) => `${match[1]} unlimited`],
    [/^(.+)最多 (\d+) 次$/u, (match) => `${match[1]} up to ${match[2]} requests`],
    [/^(.+)（当前浏览器不可用）$/u, (match) => `${match[1]} (unavailable in this browser)`],
];

const esLegacyPatterns: ReadonlyArray<readonly [RegExp, (match: RegExpExecArray) => string]> = [
    [/^最多 (\d+) 字符$/u, (match) => `Máximo ${match[1]} caracteres`],
    [/^没有找到“(.+)”相关设置$/u, (match) => `No se encontraron ajustes relacionados con “${match[1]}”`],
    [/^没有找到包含“(.+)”的服务或模型$/u, (match) => `Ningún servicio o modelo contiene “${match[1]}”`],
    [/^已完成 (\d+) 次翻译$/u, (match) => `${match[1]} traducciones completadas`],
    [/^已完成 (\d+) 个词条$/u, (match) => `${match[1]} entradas de vocabulario`],
    [/^(\d+) 项$/u, (match) => `${match[1]} elementos`],
    [/^(\d+) 个模型，点击切换$/u, (match) => `${match[1]} modelos · haz clic para cambiar`],
    [/^当前：(.+)$/u, (match) => `Actual: ${match[1]}`],
    [/^点击开启 · YouTube$/u, () => 'Haz clic para activar · YouTube'],
    [/^(.+) · YouTube$/u, (match) => `${match[1]} · YouTube`],
    [/^(.+) \+ 鼠标悬停$/u, (match) => `${match[1]} + pasar el ratón`],
    [/^翻译服务：(.+)，当前模型：(.+)$/u, (match) => `Servicio de traducción: ${match[1]}, modelo actual: ${match[2]}`],
    [/^翻译服务：(.+)$/u, (match) => `Servicio de traducción: ${match[1]}`],
    [/^不支持的按键:\s*(.*)$/u, (match) => `Tecla no compatible: ${match[1]}`],
    [/^不支持的修饰键:\s*(.*)$/u, (match) => `Modificador no compatible: ${match[1]}`],
    [/^与系统快捷键冲突:\s*(.+)$/u, (match) => `Conflicto con un atajo del sistema: ${translateLegacyText(match[1], 'es-ES')}`],
    [/^当前快捷键为 (.+)$/u, (match) => `Atajo actual: ${match[1]}`],
    [/^(.+) 需要 API Key（访问令牌），当前尚未配置；请先在设置中填写，再开始翻译。$/u, (match) => `${translateLegacyText(match[1], 'es-ES')} requiere una clave API (token de acceso), que no está configurada. Añádela en los ajustes antes de traducir.`],
    [/^(.+) 需要 App Key 和 App Secret，当前尚未完整配置；请先在设置中填写，再开始翻译。$/u, (match) => `${translateLegacyText(match[1], 'es-ES')} requiere App Key y App Secret, que no están configurados por completo. Añádelos en los ajustes antes de traducir.`],
    [/^(.+) 需要 SecretId 和 SecretKey，当前尚未完整配置；请先在设置中填写，再开始翻译。$/u, (match) => `${translateLegacyText(match[1], 'es-ES')} requiere SecretId y SecretKey, que no están configurados por completo. Añádelos en los ajustes antes de traducir.`],
    [/^快捷键已设置为: (.+)$/u, (match) => `Atajo configurado como: ${match[1]}`],
    [/^划词翻译快捷键已设置为: (.+)$/u, (match) => `Atajo de selección configurado como: ${match[1]}`],
    [/^并发数量已更新为 (.+)$/u, (match) => `Concurrencia actualizada a ${match[1]}`],
    [/^正在请求 (.+)…$/u, (match) => `Solicitando ${match[1]}…`],
    [/^已翻译 (\d+) 次$/u, (match) => `Traducido ${match[1]} veces`],
    [/^双语 · (.+)$/u, (match) => `Bilingüe · ${match[1]}`],
    [/^第 (\d+) 页$/u, (match) => `Página ${match[1]}`],
    [/^第 (\d+) \/ (\d+) 页$/u, (match) => `Página ${match[1]} / ${match[2]}`],
    [/^第 (\d+) 条字幕译文$/u, (match) => `Traducción del subtítulo ${match[1]}`],
    [/^(\d+) 条网站规则$/u, (match) => `${match[1]} reglas de sitios web`],
    [/^(.+)（当前浏览器不可用）$/u, (match) => `${match[1]} (no disponible en este navegador)`],
];

const jaLegacyPatterns: ReadonlyArray<readonly [RegExp, (match: RegExpExecArray) => string]> = [
    [/^最多 (\d+) 字符$/u, (match) => `最大 ${match[1]} 文字`],
    [/^没有找到“(.+)”相关设置$/u, (match) => `「${match[1]}」に一致する設定が見つかりません`],
    [/^没有找到包含“(.+)”的服务或模型$/u, (match) => `「${match[1]}」を含むサービスやモデルはありません`],
    [/^已完成 (\d+) 次翻译$/u, (match) => `${match[1]} 件の翻訳が完了しました`],
    [/^(\d+) 项$/u, (match) => `${match[1]} 件`],
    [/^当前：(.+)$/u, (match) => `現在：${match[1]}`],
    [/^点击开启 · YouTube$/u, () => 'クリックして有効化 · YouTube'],
    [/^(.+) · YouTube$/u, (match) => `${match[1]} · YouTube`],
    [/^(.+) \+ 鼠标悬停$/u, (match) => `${match[1]} + ホバー`],
    [/^翻译服务：(.+)，当前模型：(.+)$/u, (match) => `翻訳サービス：${match[1]}、現在のモデル：${match[2]}`],
    [/^翻译服务：(.+)$/u, (match) => `翻訳サービス：${match[1]}`],
    [/^不支持的按键:\s*(.*)$/u, (match) => `サポートされていないキー：${match[1]}`],
    [/^不支持的修饰键:\s*(.*)$/u, (match) => `サポートされていない修飾キー：${match[1]}`],
    [/^与系统快捷键冲突:\s*(.+)$/u, (match) => `システムショートカットと競合：${translateLegacyText(match[1], 'ja-JP')}`],
    [/^当前快捷键为 (.+)$/u, (match) => `現在のショートカット：${match[1]}`],
    [/^(.+) 需要 API Key（访问令牌），当前尚未配置；请先在设置中填写，再开始翻译。$/u, (match) => `${translateLegacyText(match[1], 'ja-JP')} には API キー（アクセストークン）が必要ですが、まだ設定されていません。翻訳前に設定してください。`],
    [/^(.+) 需要 App Key 和 App Secret，当前尚未完整配置；请先在设置中填写，再开始翻译。$/u, (match) => `${translateLegacyText(match[1], 'ja-JP')} には App Key と App Secret が必要ですが、まだ完全には設定されていません。翻訳前に設定してください。`],
    [/^(.+) 需要 SecretId 和 SecretKey，当前尚未完整配置；请先在设置中填写，再开始翻译。$/u, (match) => `${translateLegacyText(match[1], 'ja-JP')} には SecretId と SecretKey が必要ですが、まだ完全には設定されていません。翻訳前に設定してください。`],
    [/^已翻译 (\d+) 次$/u, (match) => `${match[1]} 回翻訳しました`],
    [/^正在请求 (.+)…$/u, (match) => `${match[1]} をリクエスト中…`],
    [/^第 (\d+) 条字幕译文$/u, (match) => `字幕 ${match[1]} の翻訳`],
    [/^(\d+) 条网站规则$/u, (match) => `${match[1]} 件のサイトルール`],
    [/^第 (\d+) \/ (\d+) 页$/u, (match) => `${match[1]} / ${match[2]} ページ`],
    [/^(.+)（当前浏览器不可用）$/u, (match) => `${match[1]}（このブラウザーでは利用できません）`],
];

const koLegacyPatterns: ReadonlyArray<readonly [RegExp, (match: RegExpExecArray) => string]> = [
    [/^最多 (\d+) 字符$/u, (match) => `최대 ${match[1]}자`],
    [/^没有找到“(.+)”相关设置$/u, (match) => `“${match[1]}” 관련 설정이 없습니다`],
    [/^没有找到包含“(.+)”的服务或模型$/u, (match) => `“${match[1]}”을(를) 포함하는 서비스 또는 모델이 없습니다`],
    [/^已完成 (\d+) 次翻译$/u, (match) => `번역 ${match[1]}회 완료`],
    [/^(\d+) 项$/u, (match) => `${match[1]}개 항목`],
    [/^当前：(.+)$/u, (match) => `현재: ${match[1]}`],
    [/^点击开启 · YouTube$/u, () => '클릭하여 사용 · YouTube'],
    [/^(.+) · YouTube$/u, (match) => `${match[1]} · YouTube`],
    [/^(.+) \+ 鼠标悬停$/u, (match) => `${match[1]} + 마우스 오버`],
    [/^翻译服务：(.+)，当前模型：(.+)$/u, (match) => `번역 서비스: ${match[1]}, 현재 모델: ${match[2]}`],
    [/^翻译服务：(.+)$/u, (match) => `번역 서비스: ${match[1]}`],
    [/^不支持的按键:\s*(.*)$/u, (match) => `지원되지 않는 키: ${match[1]}`],
    [/^不支持的修饰键:\s*(.*)$/u, (match) => `지원되지 않는 수정 키: ${match[1]}`],
    [/^与系统快捷键冲突:\s*(.+)$/u, (match) => `시스템 단축키와 충돌: ${translateLegacyText(match[1], 'ko-KR')}`],
    [/^当前快捷键为 (.+)$/u, (match) => `현재 단축키: ${match[1]}`],
    [/^(.+) 需要 API Key（访问令牌），当前尚未配置；请先在设置中填写，再开始翻译。$/u, (match) => `${translateLegacyText(match[1], 'ko-KR')}에는 API 키(액세스 토큰)가 필요하지만 아직 설정되지 않았습니다. 번역 전에 설정에서 입력하세요.`],
    [/^(.+) 需要 App Key 和 App Secret，当前尚未完整配置；请先在设置中填写，再开始翻译。$/u, (match) => `${translateLegacyText(match[1], 'ko-KR')}에는 App Key와 App Secret이 필요하지만 아직 모두 설정되지 않았습니다. 번역 전에 설정에서 입력하세요.`],
    [/^(.+) 需要 SecretId 和 SecretKey，当前尚未完整配置；请先在设置中填写，再开始翻译。$/u, (match) => `${translateLegacyText(match[1], 'ko-KR')}에는 SecretId와 SecretKey가 필요하지만 아직 모두 설정되지 않았습니다. 번역 전에 설정에서 입력하세요.`],
    [/^已翻译 (\d+) 次$/u, (match) => `${match[1]}회 번역됨`],
    [/^正在请求 (.+)…$/u, (match) => `${match[1]} 요청 중…`],
    [/^第 (\d+) 条字幕译文$/u, (match) => `자막 ${match[1]}번 번역`],
    [/^(\d+) 条网站规则$/u, (match) => `웹사이트 규칙 ${match[1]}개`],
    [/^第 (\d+) \/ (\d+) 页$/u, (match) => `${match[1]} / ${match[2]}페이지`],
    [/^(.+)（当前浏览器不可用）$/u, (match) => `${match[1]} (이 브라우저에서는 사용할 수 없음)`],
];

const frLegacyPatterns: ReadonlyArray<readonly [RegExp, (match: RegExpExecArray) => string]> = [
    [/^最多 (\d+) 字符$/u, (match) => `${match[1]} caractères maximum`],
    [/^没有找到“(.+)”相关设置$/u, (match) => `Aucun réglage trouvé pour « ${match[1]} »`],
    [/^没有找到包含“(.+)”的服务或模型$/u, (match) => `Aucun service ou modèle ne contient « ${match[1]} »`],
    [/^已完成 (\d+) 次翻译$/u, (match) => `${match[1]} traductions terminées`],
    [/^(\d+) 项$/u, (match) => `${match[1]} éléments`],
    [/^当前：(.+)$/u, (match) => `Actuel : ${match[1]}`],
    [/^点击开启 · YouTube$/u, () => 'Cliquer pour activer · YouTube'],
    [/^(.+) · YouTube$/u, (match) => `${match[1]} · YouTube`],
    [/^(.+) \+ 鼠标悬停$/u, (match) => `${match[1]} + survol`],
    [/^翻译服务：(.+)，当前模型：(.+)$/u, (match) => `Service de traduction : ${match[1]}, modèle actuel : ${match[2]}`],
    [/^翻译服务：(.+)$/u, (match) => `Service de traduction : ${match[1]}`],
    [/^不支持的按键:\s*(.*)$/u, (match) => `Touche non prise en charge : ${match[1]}`],
    [/^不支持的修饰键:\s*(.*)$/u, (match) => `Touche de modification non prise en charge : ${match[1]}`],
    [/^与系统快捷键冲突:\s*(.+)$/u, (match) => `Conflit avec un raccourci système : ${translateLegacyText(match[1], 'fr-FR')}`],
    [/^当前快捷键为 (.+)$/u, (match) => `Raccourci actuel : ${match[1]}`],
    [/^(.+) 需要 API Key（访问令牌），当前尚未配置；请先在设置中填写，再开始翻译。$/u, (match) => `${translateLegacyText(match[1], 'fr-FR')} nécessite une clé API (jeton d’accès), qui n’est pas configurée. Ajoutez-la dans les réglages avant de traduire.`],
    [/^(.+) 需要 App Key 和 App Secret，当前尚未完整配置；请先在设置中填写，再开始翻译。$/u, (match) => `${translateLegacyText(match[1], 'fr-FR')} nécessite une App Key et un App Secret, qui ne sont pas entièrement configurés. Ajoutez-les dans les réglages avant de traduire.`],
    [/^(.+) 需要 SecretId 和 SecretKey，当前尚未完整配置；请先在设置中填写，再开始翻译。$/u, (match) => `${translateLegacyText(match[1], 'fr-FR')} nécessite un SecretId et une SecretKey, qui ne sont pas entièrement configurés. Ajoutez-les dans les réglages avant de traduire.`],
    [/^已翻译 (\d+) 次$/u, (match) => `${match[1]} traductions effectuées`],
    [/^正在请求 (.+)…$/u, (match) => `Requête ${match[1]}…`],
    [/^第 (\d+) 条字幕译文$/u, (match) => `Traduction du sous-titre ${match[1]}`],
    [/^(\d+) 条网站规则$/u, (match) => `${match[1]} règles de sites`],
    [/^第 (\d+) \/ (\d+) 页$/u, (match) => `Page ${match[1]} / ${match[2]}`],
    [/^(.+)（当前浏览器不可用）$/u, (match) => `${match[1]} (indisponible dans ce navigateur)`],
];

const ruLegacyPatterns: ReadonlyArray<readonly [RegExp, (match: RegExpExecArray) => string]> = [
    [/^最多 (\d+) 字符$/u, (match) => `Не более ${match[1]} символов`],
    [/^没有找到“(.+)”相关设置$/u, (match) => `Настройки для «${match[1]}» не найдены`],
    [/^没有找到包含“(.+)”的服务或模型$/u, (match) => `Сервисов или моделей с «${match[1]}» не найдено`],
    [/^已完成 (\d+) 次翻译$/u, (match) => `Переводов завершено: ${match[1]}`],
    [/^(\d+) 项$/u, (match) => `${match[1]} элементов`],
    [/^当前：(.+)$/u, (match) => `Текущее: ${match[1]}`],
    [/^点击开启 · YouTube$/u, () => 'Нажмите, чтобы включить · YouTube'],
    [/^(.+) · YouTube$/u, (match) => `${match[1]} · YouTube`],
    [/^(.+) \+ 鼠标悬停$/u, (match) => `${match[1]} + наведение`],
    [/^翻译服务：(.+)，当前模型：(.+)$/u, (match) => `Сервис перевода: ${match[1]}, текущая модель: ${match[2]}`],
    [/^翻译服务：(.+)$/u, (match) => `Сервис перевода: ${match[1]}`],
    [/^不支持的按键:\s*(.*)$/u, (match) => `Неподдерживаемая клавиша: ${match[1]}`],
    [/^不支持的修饰键:\s*(.*)$/u, (match) => `Неподдерживаемая клавиша-модификатор: ${match[1]}`],
    [/^与系统快捷键冲突:\s*(.+)$/u, (match) => `Конфликт с системным сочетанием: ${translateLegacyText(match[1], 'ru-RU')}`],
    [/^当前快捷键为 (.+)$/u, (match) => `Текущее сочетание: ${match[1]}`],
    [/^(.+) 需要 API Key（访问令牌），当前尚未配置；请先在设置中填写，再开始翻译。$/u, (match) => `Для ${translateLegacyText(match[1], 'ru-RU')} требуется API-ключ (токен доступа), но он не настроен. Укажите его в настройках перед переводом.`],
    [/^(.+) 需要 App Key 和 App Secret，当前尚未完整配置；请先在设置中填写，再开始翻译。$/u, (match) => `Для ${translateLegacyText(match[1], 'ru-RU')} требуются App Key и App Secret, но они настроены не полностью. Укажите их в настройках перед переводом.`],
    [/^(.+) 需要 SecretId 和 SecretKey，当前尚未完整配置；请先在设置中填写，再开始翻译。$/u, (match) => `Для ${translateLegacyText(match[1], 'ru-RU')} требуются SecretId и SecretKey, но они настроены не полностью. Укажите их в настройках перед переводом.`],
    [/^已翻译 (\d+) 次$/u, (match) => `Переведено раз: ${match[1]}`],
    [/^正在请求 (.+)…$/u, (match) => `Запрос ${match[1]}…`],
    [/^第 (\d+) 条字幕译文$/u, (match) => `Перевод субтитра ${match[1]}`],
    [/^(\d+) 条网站规则$/u, (match) => `Правил сайтов: ${match[1]}`],
    [/^第 (\d+) \/ (\d+) 页$/u, (match) => `Страница ${match[1]} / ${match[2]}`],
    [/^(.+)（当前浏览器不可用）$/u, (match) => `${match[1]} (недоступно в этом браузере)`],
];

const legacyPatternCatalog: Partial<Record<UiLanguage, ReadonlyArray<readonly [RegExp, (match: RegExpExecArray) => string]>>> = {
    'en-US': legacyPatterns,
    'ja-JP': jaLegacyPatterns,
    'ko-KR': koLegacyPatterns,
    'fr-FR': frLegacyPatterns,
    'ru-RU': ruLegacyPatterns,
    'es-ES': esLegacyPatterns,
};

/**
 * 将尚未完成 key 化的扩展 UI 文案翻译成 English。
 *
 * 这个适配器是有边界的迁移工具：调用方必须只把扩展自己的文本节点/属性传入，
 * 并且 UI directive 会跳过 textarea、pre、code 和用户内容，避免误伤网页正文或译文。
 */
export function translateLegacyText(value: string, language: UiLanguage): string {
    if (language === 'zh-CN' || !value.trim()) return value;
    const trimmed = value.trim();
    const exact = legacyCatalogs[language]?.[trimmed] ?? messageLegacyCatalogs[language]?.[trimmed];
    if (exact) return preserveWhitespace(value, exact);

    const dynamic = translateLegacyPattern(trimmed, language, (fragment) => fragment.split('；').map((part) => translateLegacyText(part, language)).join('；'));
    if (dynamic !== undefined) return preserveWhitespace(value, dynamic);

    for (const separator of [' · ', ' → ']) {
        const compound = trimmed.split(separator);
        if (compound.length <= 1) continue;
        const translatedCompound = compound.map((part) => translateLegacyText(part, language)).join(separator);
        if (translatedCompound !== trimmed) return preserveWhitespace(value, translatedCompound);
    }

    const patterns = legacyPatternCatalog[language] || legacyPatterns;
    for (const [pattern, resolver] of patterns) {
        const match = pattern.exec(trimmed);
        if (match) return preserveWhitespace(value, resolver(match));
    }

    // 复合状态和当前语言的动态模板必须先于 English 回退处理，否则只漏掉一个
    // 词时会把整行降级为 English，形成例如「オフ · Show icon」的混合界面。
    if (language !== 'en-US') {
        const englishFallback = enUSLegacyText[trimmed];
        if (englishFallback) return preserveWhitespace(value, englishFallback);
        for (const [pattern, resolver] of legacyPatterns) {
            const match = pattern.exec(trimmed);
            if (match) return preserveWhitespace(value, resolver(match));
        }
    }
    return value;
}

export {
    enUSMessages,
    enUSLegacyText,
    esESMessages,
    esESLegacyText,
    frFRMessages,
    jaJPMessages,
    koKRMessages,
    ruRUMessages,
    zhCNMessages,
};
