import productDescriptions from '../src/core/i18n/messages/product-descriptions.json';

export interface UserscriptMetadataOptions {
    version: string;
    iconDataUrl?: string;
    requires?: readonly string[];
}
const grants = [
    'GM_getValue',
    'GM_setValue',
    'GM_deleteValue',
    'GM_listValues',
    'GM_xmlhttpRequest',
    'GM_registerMenuCommand',
    'GM_openInTab',
    'GM_addStyle',
    'GM.getValue',
    'GM.setValue',
    'GM.deleteValue',
    'GM.listValues',
    'GM.xmlHttpRequest',
    'GM.openInTab',
];

export function createUserscriptMetadata({version, iconDataUrl, requires = []}: UserscriptMetadataOptions): string {
    const lines = [
        '// ==UserScript==',
        // Keep the original name/namespace identity for existing manager installations.
        '// @name         FluentRead-流畅阅读',
        '// @name:zh-CN   流畅阅读',
        '// @name:zh-TW   流暢閱讀',
        '// @name:zh      流畅阅读',
        '// @name:en      FluentRead',
        '// @name:ja      FluentRead',
        '// @name:ko      FluentRead',
        '// @name:fr      FluentRead',
        '// @name:ru      FluentRead',
        '// @name:es      FluentRead',
        '// @namespace    https://fr.unmeta.cn/',
        `// @version      ${version}`,
        `// @description  ${productDescriptions['en-US']}`,
        `// @description:zh ${productDescriptions['zh-CN']}`,
        ...Object.entries(productDescriptions).map(([language, description]) =>
            `// @description:${language === 'zh-CN' || language === 'zh-TW' ? language : language.split('-')[0]} ${description}`),
        '// @author       ThinkStu',
        '// @license      GPL-3.0-only',
        '// @homepageURL  https://github.com/FluentRead/FluentRead',
        '// @supportURL   https://github.com/FluentRead/FluentRead/issues/220',
        '// @match        http://*/*',
        '// @match        https://*/*',
        '// @run-at       document-start',
        '// @inject-into  content',
        '// @noframes',
        '// @connect      *',
        ...requires.map((url) => `// @require      ${url}`),
        ...grants.map((grant) => `// @grant        ${grant}`),
        ...(iconDataUrl ? [`// @icon         ${iconDataUrl}`] : []),
        '// ==/UserScript==',
    ];
    return `${lines.join('\n')}\n`;
}
