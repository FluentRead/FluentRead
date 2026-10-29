import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import ts from 'typescript';
import {describe, expect, it, vi} from 'vitest';
import * as Vue from 'vue';
import {compileTemplate, parse} from 'vue/compiler-sfc';
import {renderToString} from 'vue/server-renderer';
import {parseHTML} from 'linkedom';
import {translateLegacyText} from '@/src/core/i18n';
import {registerAllUiLanguageBundles} from './helpers/uiLanguageBundles';
import {learningMaterialLegacyText} from '@/src/core/i18n/messages/learningMaterials';
import {createUiI18nPlugin} from '@/src/ui/i18n';
import {MaterialBackupExportError} from '@/src/features/vocabulary/materialBackupExportClient';

vi.mock('@/src/services/config/store', () => ({
    config: {uiLanguage: 'en-US'}, configReady: Promise.resolve(), getConfigRevision: () => 0,
    subscribeConfig: () => () => {}, requestConfigPatch: async () => {},
}));
vi.mock('@/src/platform/i18n/uiLanguageBundles', () => ({ensureUiLanguageBundle: async () => true}));
vi.mock('webextension-polyfill', () => ({default: {runtime: {sendMessage: async () => ({success: true})}}}));

registerAllUiLanguageBundles();
const languages = ['en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const;

describe('学习材料旧模板本地化', () => {
    it('六种词典完整接入运行时，界面与恢复错误均有实际译文', () => {
        const sources = Object.keys(learningMaterialLegacyText['en-US']);
        expect(sources.length).toBeGreaterThan(100);
        for (const language of languages) {
            const catalog: Readonly<Record<string, string>> = learningMaterialLegacyText[language];
            expect(Object.keys(catalog).sort(), language).toEqual([...sources].sort());
            for (const source of sources) {
                const translated = translateLegacyText(source, language);
                expect(catalog[source].trim(), `${language}: ${source}`).not.toBe('');
                expect(translated, `${language}: ${source}`).toBe(catalog[source]);
                expect(translated, `${language}: ${source}`).not.toBe(source);
                if (language !== 'ja-JP') expect(translated).not.toMatch(/[\u3400-\u9fff]/u);
            }
        }
    });

    it('材料模型、仓库、后台与客户端抛出的中文错误没有遗漏', () => {
        const errors = new Set<string>();
        for (const file of ['materialModel.ts', 'materialRepository.ts', 'materialBackground.ts', 'materialClient.ts', 'materialContent.ts']) {
            const path = join(process.cwd(), 'src/features/vocabulary', file);
            const ast = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
            const visit = (node: ts.Node) => {
                if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)
                    && ['MaterialError', 'MaterialClientError', 'Error'].includes(node.expression.text)) {
                    const message = node.arguments?.[node.expression.text === 'Error' ? 0 : 1];
                    if (message && ts.isStringLiteral(message) && /[\u3400-\u9fff]/u.test(message.text)) errors.add(message.text);
                }
                ts.forEachChild(node, visit);
            };
            visit(ast);
        }
        expect(errors.size).toBeGreaterThan(35);
        for (const error of errors) {
            for (const language of languages) {
                const catalog: Readonly<Record<string, string>> = learningMaterialLegacyText[language];
                expect(catalog[error], `${language}: ${error}`).toBeTruthy();
                expect(translateLegacyText(error, language), `${language}: ${error}`).toBe(catalog[error]);
            }
        }
    });

    it('分页读取和隐私备份错误在每种界面语言中均有译文', () => {
        const messages = [
            '材料已发生变化，请重新读取。', '材料筛选或分页无效。', '材料读取繁忙，请稍后重试。',
            '材料内容或数量超出当前读取限制。', '本地材料暂时不可用，请重试。', '这份材料已不存在。',
            '材料分页数据无效，请重试。', '材料分页数据过大，请重试。', '无痕窗口不读取学习材料。',
            '无法在隐私浏览或无法确认隐私状态时使用材料备份，请稍后重试',
        ];
        const pageSource = readFileSync('src/features/vocabulary/materialPageClient.ts', 'utf8');
        for (const message of messages.slice(0, -1)) expect(pageSource).toContain(`'${message}'`);
        expect(readFileSync('src/features/vocabulary/materialBackupBrowserSave.ts', 'utf8')).toContain(`'${messages.at(-1)}'`);
        for (const language of languages) for (const message of messages) {
            const translated = translateLegacyText(message, language);
            expect(translated, `${language}: ${message}`).toBe((learningMaterialLegacyText[language] as Readonly<Record<string, string>>)[message]);
            expect(translated).not.toBe(message);
            if (language !== 'ja-JP') expect(translated).not.toMatch(/[\u3400-\u9fff]/u);
        }
    });

    it('备份导出的公开错误和传输诊断均有六种译文', () => {
        const messages = [
            '材料在导出期间已发生变化，请重试', '材料备份导出失败，请重试', '材料备份统计无效',
            '材料备份传输包含多余数据', '材料备份传输不完整', '材料备份传输格式无效',
            '材料备份分片长度无效', '材料备份过大', '材料备份错误代码无效',
        ];
        const source = readFileSync('src/features/vocabulary/materialBackupExportClient.ts', 'utf8');
        for (const message of messages) {
            expect(source).toContain(`'${message}'`);
            for (const language of languages) {
                const translated = translateLegacyText(message, language);
                expect(translated, `${language}: ${message}`).not.toBe(message);
                if (language !== 'ja-JP') expect(translated).not.toMatch(/[\u3400-\u9fff]/u);
            }
        }
    });

    it('数量、页码、时间和导入汇总使用真实参数，不固定扫描器的数字占位', () => {
        for (const language of languages) {
            for (const count of [0, 1, 12, 125]) {
                const sources = [
                    `${count} 条学习内容`,
                    `显示更多材料（${count} / 527）`,
                    `继续第 ${count} 页`,
                    `上次看到 ${count}:09`,
                    `没有恢复材料，跳过 ${count} 条无效、冲突或较旧的记录。`,
                    `已恢复 ${count} 份材料（新增 3 · 更新 17 · 跳过 29）。`,
                ];
                for (const source of sources) {
                    const translated = translateLegacyText(source, language);
                    expect(translated, `${language}: ${source}`).not.toBe(source);
                    expect(translated.match(/\d+/gu), `${language}: ${source}`).toEqual(source.match(/\d+/gu));
                    expect(translated).not.toMatch(/\{\d+\}/u);
                    if (language !== 'ja-JP') expect(translated).not.toMatch(/[\u3400-\u9fff]/u);
                }
            }
        }
    });

    it('不以材料关键词或数字猜测改写未登记的用户正文', () => {
        for (const language of languages) {
            for (const source of ['我的材料研究标题 125', '阅读这份材料让我想到下一步计划', '上次看到的原文是第 12 页的一段话', '笔记：已恢复 3 份材料']) {
                expect(translateLegacyText(source, language)).toBe(source);
            }
        }
    });

    it.each([
        ['stale-operation', 'Materials changed during export. Try again.'],
        ['storage-error', 'Could not export the material backup. Try again.'],
    ] as const)('实际错误提示模板在英文界面翻译导出错误 %s', async (code, expected) => {
        const filename = 'src/features/vocabulary/ui/MaterialWorkspace.vue';
        const {descriptor} = parse(readFileSync(filename, 'utf8'), {filename});
        const feedback = descriptor.template!.content.match(/<p v-if="error"[\s\S]*?<\/p>/u)![0];
        const compiled = compileTemplate({source: `<div>${feedback}</div>`, filename, id: 'material-export-feedback-i18n', compilerOptions: {mode: 'function'}});
        expect(compiled.errors).toEqual([]);
        const render = new Function('Vue', compiled.code)(Vue), error = new MaterialBackupExportError(code).message;
        const html = await renderToString(Vue.h({setup: () => ({error, busy: false, reload: () => {}}), render}));
        const {document, window} = parseHTML(`<html><body>${html}</body></html>`);
        const root = document.body.firstElementChild as unknown as HTMLElement;
        for (const [name, value] of Object.entries({document, Node: window.Node, MutationObserver: window.MutationObserver, NodeFilter: {SHOW_TEXT: 4}})) vi.stubGlobal(name, value);
        let directive: any;
        const app = {config: {globalProperties: {}}, provide: () => {}, directive: (_name: string, value: unknown) => {directive = value;}, mixin: () => {}, unmount: () => {}};
        const plugin = createUiI18nPlugin();
        if (typeof plugin.install !== 'function') throw new Error('UI i18n plugin must expose install');
        try {
            plugin.install(app as any); directive.mounted(root);
            await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.firstChild?.textContent?.trim()).toBe(expected));
            expect(root.querySelector('button')?.textContent).toBe('Retry');
        } finally {app.unmount(); vi.unstubAllGlobals();}
    });

    it('实际材料模板与共享指令翻译位置、来源回退和问答标签，同时保留用户原文、章节和问题', async () => {
        const filename = 'src/features/vocabulary/ui/MaterialWorkspace.vue';
        const {descriptor} = parse(readFileSync(filename, 'utf8'), {filename});
        const template = descriptor.template!.content;
        const quote = template.match(/<blockquote v-if="selected\.locator\?\.quote"[\s\S]*?<\/blockquote>/u)![0];
        const summary = template.match(/<summary><span v-if="turn\.question"[\s\S]*?<\/summary>/u)![0];
        const detailSource = template.match(/<div class="fr-material-meta">[\s\S]*?<\/div>/u)![0];
        const listSource = template.match(/<span :title="item\.sourceUrl"[\s\S]*?<\/span>/u)![0];
        const compiled = compileTemplate({source: `<div>${quote}${summary}<aside>${detailSource}</aside><nav>${listSource}</nav></div>`, filename, id: 'material-i18n-boundaries', compilerOptions: {mode: 'function'}});
        expect(compiled.errors).toEqual([]);
        const render = new Function('Vue', compiled.code)(Vue);
        const script = ts.createSourceFile(filename + '.ts', descriptor.scriptSetup!.content, ts.ScriptTarget.Latest, true);
        const functions = script.statements.filter(node => ts.isFunctionDeclaration(node)
            ? ['positionLabel', 'sourceLabel'].includes(node.name!.text)
            : ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === 'kindLabel'))
            .map(node => node.getText(script)).join('\n');
        const labels = new Function(ts.transpileModule(functions + '\nreturn {positionLabel,sourceLabel,kindLabel};', {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText)();
        for (const [kind, source, locator, position, sourceText] of [
            ['article', {url: 'https://example.test/original'}, {kind: 'text'}, 'Last read passage', 'example.test/original'],
            ['video', {url: 'https://example.test/video'}, {kind: 'video', startMs: 129000}, 'Last watched at 2:09', 'example.test/video'],
            ['document', {}, {kind: 'document', page: 7, section: '阅读材料'}, 'Page 7', 'Local file'],
            ['article', {url: 'invalid source'}, {kind: 'text'}, 'Last read passage', 'Source needs recovery'],
        ] as const) {
            for (const question of ['', '删除笔记']) {
                const selected = {kind, source, locator: {...locator, quote: '加入学习材料'}};
                const item = {kind, sourceUrl: 'url' in source ? source.url : undefined};
                const html = await renderToString(Vue.h({setup: () => ({selected, item, turn: {question}, ...labels}), render}));
                const {document, window} = parseHTML(`<html><body>${html}</body></html>`);
                const root = document.body.firstElementChild as unknown as HTMLElement;
                for (const [name, value] of Object.entries({document, Node: window.Node, MutationObserver: window.MutationObserver, NodeFilter: {SHOW_TEXT: 4}})) vi.stubGlobal(name, value);
                let directive: any;
                const app = {config: {globalProperties: {}}, provide: () => {}, directive: (_name: string, value: unknown) => {directive = value;}, mixin: () => {}, unmount: () => {}};
                const plugin = createUiI18nPlugin();
                if (typeof plugin.install !== 'function') throw new Error('UI i18n plugin must expose install');
                try {
                    plugin.install(app as any); directive.mounted(root);
                    await vi.waitFor(() => expect(root.querySelector('footer')?.firstChild?.textContent).toBe(position));
                    expect(root.querySelector('.fr-material-quote > span')?.textContent).toBe('加入学习材料');
                    if (kind === 'document') expect(root.querySelector('footer > span')?.textContent).toBe(' · 阅读材料');
                    expect(root.querySelector('summary')?.textContent).toBe(question || 'Reading explanation');
                    expect(root.querySelector('aside .fr-material-meta > span:first-child')?.textContent).toBe({article: 'Article', video: 'Video', document: 'Document'}[kind]);
                    expect(root.querySelector('aside .fr-material-meta > span:last-child')?.textContent).toBe(sourceText);
                    expect(root.querySelector('nav > span')?.textContent).toBe(sourceText);
                    expect(root.querySelector('aside .fr-material-meta > span:last-child')?.hasAttribute('data-i18n-ignore')).toBe(sourceText.startsWith('example.test/'));
                    const walker = document.createTreeWalker(root as any, 4);
                    let node = walker.nextNode();
                    while (node) {
                        if (!node.parentElement?.closest('[data-i18n-ignore]')) expect(node.textContent).not.toMatch(/[\u3400-\u9fff]/u);
                        node = walker.nextNode();
                    }
                } finally {app.unmount(); vi.unstubAllGlobals();}
            }
        }
    });
});
