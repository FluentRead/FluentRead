import type {TranslationProviderRequest} from '@/src/services/translation/types';
/**
 * @file tests/documentLiteralProtection.test.ts
 * 文件职责：验证真实文档中行内语法、根号标识、URL、邮箱、代码式专名及 GNMT+RL 的自动原样保护边界。
 * 主要内容：回放真实 guide 空行内节点失败，验证单段/数组/slot、嵌套和重复编号的可见正文数量；检验 HTML、根号、希腊变量和专名保护；原文回显覆盖实际目标语言及用户英文译法；内部 g 原样送翻并校验结构，强调文字可译；覆盖无效结果不缓存、文档 v3 与上一策略和网页缓存隔离。
 * 模块边界：纯规则及保护链测试，实际免费服务结果由隔离浏览器测试另行验证。
 */
import {describe, expect, it, vi} from 'vitest';
import {DocumentInlineMarkerError, documentInlineMarkerRanges, findDocumentLiteralTerms, normalizeDocumentInlineMarkers, serializeTranslationSlots, validateDocumentInlineMarkers} from '@/src/core/translation/public';
import {validateGlossaryProtectedTokens} from '@/src/core/glossary';
import {Config} from '@/src/core/config/model';
import {resolveConfiguredModel, servicesType} from '@/src/core/config/catalog';
import {createTranslationBroker} from '@/src/services/translation/broker';
import {prepareGlossaryRequest, getGlossaryProtectionEntries, isGlossaryOnlyResult, validateDocumentTranslationResult} from '@/src/services/translation/glossaryProtection';
import {createTranslationProviderConfigSnapshot, getTranslationGlossaryTerms, getTranslationProviderConfig} from '@/src/services/translation/requestSnapshot';
import type {TranslationRequestMessage} from '@/src/services/translation/types';
import {parseDocument, renderDocument} from '@/src/features/document-translation/core/document';
import {isLikelyUntranslatedInlineResponse, isLikelyUntranslatedResponse} from '@/src/core/translation/resultValidation';

vi.mock('@/src/services/config/store', () => ({config: {to: 'zh-Hans'}}));

const documentConfig = () => ({...createTranslationProviderConfigSnapshot(new Config()),
    glossaryMatchContext: {context: 'document' as const, sourceLanguage: 'en', targetLanguage: 'zh-hans'}});

describe('document literal protection', () => {
    it('restores numeric scripts alongside an OCR trademark-like symbol in the same serialized batch', () => {
        const original = serializeTranslationSlots(['Scientific counts range from 10⁴ to 10⁵ samples.', 'An exponent x™" needs source review.'], 'scanned_scripts').payload;
        const request = prepareGlossaryRequest({origin: original}, documentConfig());
        const translated = (request.message.origin as string).replace(/(___FLUENTREAD_([a-z0-9_-]+)_(\d+)_BEGIN___)([\s\S]*?)(___FLUENTREAD_\2_\3_END___)/giu,
            (_match, begin, _nonce, _index, text, end) => `${begin}本地测试译文：此段保留经过检查的数学与原文符号。${[...text.matchAll(/__FRTERM_[a-z0-9_]+?__/giu)].map(match => match[0]).join(' ')}${end}`);
        const result = request.restore(translated) as string;
        expect(result).toContain('10⁴'); expect(result).toContain('10⁵'); expect(result).toContain('™');
        expect(() => request.restore(`${translated}__FRTERM_foreign`)).toThrow('未完整保留术语');
    });
    it('protects scientific powers and subscripts through provider output while keeping ordinary prose translatable', () => {
        const current = documentConfig(), source = 'The method estimates 10⁴ samples and x₂ values at 25°C (note ²).';
        const request = prepareGlossaryRequest({origin: source}, current);
        const wire = request.message.origin as string;
        expect(wire).toContain('The method'); expect(wire).toContain('estimates'); expect(wire).toContain('25°C');
        expect(wire).not.toContain('10⁴'); expect(wire).not.toContain('x₂'); expect(wire).not.toContain('²');
        const translated = wire.replace('The method', '方法').replace('estimates', '估算').replace('samples and', '个样本和').replace('values at', '的值，温度为');
        expect(request.restore(translated)).toBe('方法 估算 10⁴ 个样本和 x₂ 的值，温度为 25°C (note ²).');
        const token = getTranslationProviderConfig(request.message, current).glossaryProtectedTokens![0];
        expect(() => request.restore(translated.replace(token, ''))).toThrow('未完整保留术语');
    });
    it('coalesces automatic math separately in each native array packet and keeps serialized ownership unchanged', () => {
        const current = documentConfig();
        const origins = ['The relation 𝑓 ≃𝑆 𝑔 holds.', 'And 𝛾 ≃𝑆 𝛾′.'];
        const request = prepareGlossaryRequest({origin: origins}, current);
        const protectedOrigins = request.message.origin as string[];
        const tokens = getTranslationProviderConfig(request.message, current).glossaryProtectedTokens!;
        expect(tokens).toHaveLength(2); expect(Object.isFrozen(tokens)).toBe(true);
        expect(request.restore(protectedOrigins)).toEqual(origins);
        expect(request.restore([protectedOrigins[0].replace('The relation', '关系').replace('holds.', '成立。'),
            protectedOrigins[1].replace('And', '以及')])).toEqual(['关系 𝑓 ≃𝑆 𝑔 成立。', '以及 𝛾 ≃𝑆 𝛾′.']);
        expect(() => request.restore([protectedOrigins[0].replace(tokens[0], tokens[1]), protectedOrigins[1]]))
            .toThrow('未完整保留术语');
        const slotOrigin = serializeTranslationSlots(origins, 'math_array').payload;
        const slotRequest = prepareGlossaryRequest({origin: slotOrigin}, current);
        expect(getTranslationProviderConfig(slotRequest.message, current).glossaryProtectedTokens!.length).toBeGreaterThan(2);
        expect(slotRequest.restore(slotRequest.message.origin)).toBe(slotOrigin);
    });

    it('omits unsupported userscript document paths while preserving ordinary page user glossary behavior', () => {
        vi.stubEnv('BROWSER', 'userscript');
        try {
            const current = documentConfig();
            const source = 'The relation 𝑓 ≃𝑆 𝑔 contains <g1>words</g1>.';
            expect(getGlossaryProtectionEntries(current, source)).toEqual([]);
            expect(prepareGlossaryRequest({origin: source}, current).message.origin).toBe(source);
            expect(validateDocumentTranslationResult(current, source, '普通译文')).toBe('普通译文');
            const user = {...current, glossaryTerms: [{source: 'API', target: '接口'}],
                glossaryLibraries: [{id: 'user', name: 'User', enabled: true, sourceLanguage: '', targetLanguage: 'zh-hans', domains: [],
                    entries: [{id: 'api', source: 'API', target: '接口', caseSensitive: true}]}],
                glossaryMatchContext: {...current.glossaryMatchContext, context: 'page' as const}};
            const request = prepareGlossaryRequest({origin: 'Read API documentation.'}, user);
            expect(request.restore(request.message.origin)).toBe('Read 接口 documentation.');
            expect(isGlossaryOnlyResult(user, 'API', '接口')).toBe(true);
        } finally {vi.unstubAllEnvs();}
    });

    it('rejects the exact live guide paragraph 31 whose translated menu labels were moved outside empty paired nodes', () => {
        const source = 'PDFs default to the <g1>Original layout</g1>, side by side: each translated paragraph is placed back at the position and size of its source paragraph and appears as it arrives, while waiting paragraphs show the loading style chosen in your interface settings. Formulas, figures and numeric table cells stay as they are; table headers, text cells and captions are translated. Hover a long translation to expand it; hovering also highlights the matching source paragraph (switch it off under <g2>Translation style</g2>). Translation starts from the page you are reading, retries automatically for up to two minutes when a service is briefly unavailable, and reports the reason if it still fails. Switch to <g3>Reflowed text</g3> for complete paragraphs at a fixed size. The toolbar also offers <g4>Search</g4> across source and translation, an <g5>Outline</g5> in the sidebar, and <g6>Focus reading</g6>.';
        const returned = 'PDF默认为<g1>原始布局</g1>，并排：每个翻译后的段落会被放回其源段落的位置和大小，并在到达时显示，而等待段落会显示在界面设置中选择的加载样式。公式，数字和数字表格单元格保持原样;表格标题，文本单元格和标题会被翻译。悬停长翻译以展开它;悬停还会突出显示匹配的源段落（在翻译样式下关闭它<g2></g2>）。翻译从您正在阅读的页面开始，在服务暂时不可用时自动重试最多两分钟，如果仍然失败，则报告原因。切换到<g3>“回流文本</g3>”以获取固定大小的完整段落。工具栏还提供<g4></g4>跨源和翻译的搜索、侧<g5></g5>边栏中的大纲以及<g6>聚焦阅读</g6>。';
        const restored = returned.replace('在翻译样式下关闭它<g2></g2>', '在<g2>翻译样式</g2>下关闭它')
            .replace('<g4></g4>跨源和翻译的搜索', '跨源和翻译的<g4>搜索</g4>').replace('侧<g5></g5>边栏中的大纲', '侧边栏中的<g5>大纲</g5>');
        const current = documentConfig();
        const origins = [source, '<g1/>'], targets = [returned, '<g1/>'], valid = [restored, '<g1/>'];
        for (const [origin, invalid, translated] of [[source, returned, restored], [origins, targets, valid],
            [serializeTranslationSlots(origins, 'guide_31').payload, serializeTranslationSlots(targets, 'guide_31').payload, serializeTranslationSlots(valid, 'guide_31').payload]] as const) {
            const message: TranslationRequestMessage = Array.isArray(origin) ? {origin} : {origin};
            const request = prepareGlossaryRequest(message, current);
            expect(() => request.restore(invalid)).toThrow(DocumentInlineMarkerError);
            expect(request.restore(translated)).toEqual(translated);
        }
        expect(validateDocumentInlineMarkers(source, returned)).toBe(returned);
        const page = {...current, glossaryMatchContext: {...current.glossaryMatchContext, context: 'page' as const}};
        expect(validateDocumentTranslationResult(page, source, returned)).toBe(returned);
    });

    it('requires visible text before glossary or target-language exemptions, without changing candidate text', () => {
        const source = 'Choose <g1>Search</g1>.', token = '__FRTERM_123456789abc_0__';
        const contexts = [{targetLanguage: 'zh-Hans'}, {targetLanguage: 'en'}, {targetLanguage: 'auto'}, {targetLanguage: 'zh-Hans', protectedTokens: [token]}];
        for (const context of contexts) for (const empty of ['', ' \t\r\n\u00a0', '\0\u0001\u007f', '\u200b\u200c\u200d\u2060\ufeff\ufe0f', '&nbsp;&#160;&#x00A0;&#8203;&#x200D;']) {
            expect(() => validateDocumentInlineMarkers(source, `搜索<g1>${empty}</g1>。`, context)).toThrow(DocumentInlineMarkerError);
        }
        expect(() => validateDocumentInlineMarkers(`<g1>${token}</g1>`, `${token}<g1></g1>`, contexts[3])).toThrow(DocumentInlineMarkerError);
        for (const target of ['<g1>搜索</g1>', '<g1> \u200b搜索\u200d </g1>', `<g1>${token}</g1>`, '<g1>😀\ufe0f</g1>', '<g1>&#65;</g1>', '<g1>&#x0041;</g1>', '<g1>&#99999999999999999999;</g1>']) {
            expect(validateDocumentInlineMarkers('<g1>Search</g1>', target, contexts[3])).toBe(target);
        }
        for (const empty of ['', ' \u200b', '&nbsp;&#x200b;']) {
            expect(validateDocumentInlineMarkers(`<g1>${empty}</g1>`, '<g1></g1>', contexts[0])).toBe('<g1></g1>');
        }
        expect(validateDocumentInlineMarkers('<g1/>', '<g1> \t</g1>', contexts[0])).toBe('<g1/>');
        expect(validateDocumentInlineMarkers(source, '搜索<g1></g1>。')).toBe('搜索<g1></g1>。');
    });

    it('recognizes named whitespace/invisible entities without decoding visible or unknown entity spellings', () => {
        const context = {targetLanguage: 'zh-Hans'};
        for (const empty of ['&ensp;&emsp;&emsp13;&emsp14;&numsp;&puncsp;', '&thinsp;&hairsp;&shy;&ZeroWidthSpace;',
            '&NonBreakingSpace;&Tab;&NewLine;&ThinSpace;&VeryThinSpace;&MediumSpace;&ThickSpace;',
            '&NegativeVeryThinSpace;&NegativeThinSpace;&NegativeMediumSpace;&NegativeThickSpace;',
            '&zwnj;&zwj;&lrm;&rlm;&NoBreak;&ApplyFunction;&af;&InvisibleTimes;&it;&InvisibleComma;&ic;']) {
            expect(() => validateDocumentInlineMarkers('<g1>Search</g1>', `<g1>${empty}</g1>`, context)).toThrow(DocumentInlineMarkerError);
            expect(validateDocumentInlineMarkers(`<g1>${empty}</g1>`, '<g1></g1>', context)).toBe('<g1></g1>');
        }
        // HTML 命名实体区分大小写；未知实体及被转义的实体仍有可见字面正文。
        for (const text of ['&unknown;', '&THINSP;', '&amp;nbsp;', '&amp;', '&#65;'])
            expect(validateDocumentInlineMarkers('<g1>Search</g1>', `<g1>${text}</g1>`, context)).toBe(`<g1>${text}</g1>`);
    });

    it('counts visible paired occurrences by structural identity for nested and repeated ids', () => {
        const context = {targetLanguage: 'zh-Hans'};
        for (const [source, valid, invalid] of [
            ['<g1>outer <g2>bold</g2></g1>', '<g1><g2>粗体</g2></g1>', '<g1>粗体<g2></g2></g1>'],
            ['<g1><g2>bold</g2></g1>', '<g1><g2>粗体</g2></g1>', '<g1><g2>\u200b</g2></g1>粗体'],
            ['<g1>first</g1><g1>second</g1>', '<g1>第二</g1><g1>第一</g1>', '<g1>第一和第二</g1><g1></g1>'],
            ['<g1><g3>first</g3></g1><g2><g3></g3></g2>', '<g2><g3></g3></g2><g1><g3>第一</g3></g1>', '<g1><g3></g3></g1><g2><g3>第一</g3></g2>'],
            ['<g1><g1>first</g1></g1>', '<g1><g1>第一</g1></g1>', '<g1>第一<g1></g1></g1>'],
            ['<g1>first<g2/></g1>', '<g1>第一<g2/></g1>', '第一<g1><g2/></g1>'],
        ]) {
            expect(validateDocumentInlineMarkers(source, valid, context)).toBe(valid);
            expect(() => validateDocumentInlineMarkers(source, invalid, context)).toThrow(DocumentInlineMarkerError);
        }
        // 空源对仍能重排/获得文字；对子节点没有可见正文的父节点也无需凭空增加文字。
        expect(validateDocumentInlineMarkers('<g1>first</g1><g1></g1>', '<g1></g1><g1>第一</g1>', context)).toBe('<g1></g1><g1>第一</g1>');
        expect(validateDocumentInlineMarkers('<g1><g2/></g1>', '<g1><g2/></g1>', context)).toBe('<g1><g2/></g1>');
        expect(validateDocumentInlineMarkers('<g1></g1>', '<g1>新增</g1>', context)).toBe('<g1>新增</g1>');
    });

    it('validates a large inline-node paragraph while retaining repeated-id and empty-node protection', () => {
        const rows = Array.from({length: 512}, (_, index) => index + 1);
        const source = rows.map(id => `<g${id}>Readable source</g${id}>`).join(' ') + '<g1>Repeated source</g1>';
        const translated = rows.map(id => `<g${id}>可读译文</g${id}>`).join(' ') + '<g1>重复译文</g1>';
        expect(validateDocumentInlineMarkers(source, translated, {targetLanguage: 'zh-Hans'})).toBe(translated);
        expect(() => validateDocumentInlineMarkers(source, translated.replace('<g512>可读译文</g512>', '<g512></g512>'),
            {targetLanguage: 'zh-Hans'})).toThrow(DocumentInlineMarkerError);
    });

    it('rejects the real English menu-label echo only with the document paragraph evidence and actual Chinese target', () => {
        const source = 'For an online PDF, open the extension menu and choose <g1>Open PDF reader</g1> or <g2>Document translation</g2>.';
        const echoed = '对于在线PDF，打开扩展菜单选择 <g1>Open PDF reader</g1> 或 <g2>Document translation</g2>。';
        expect(isLikelyUntranslatedResponse('Document translation', 'Document translation', 'zh-Hans')).toBe(false);
        expect(isLikelyUntranslatedResponse('Open PDF reader', 'Open PDF reader', 'zh-Hans')).toBe(false);
        expect(() => validateDocumentInlineMarkers(source, echoed, {targetLanguage: 'zh-Hans'}))
            .toThrow('未翻译文档行内正文：Open PDF reader');
        expect(() => validateDocumentInlineMarkers(source, echoed.replace('Open PDF reader', '打开PDF阅读器'), {targetLanguage: 'zh-Hans'}))
            .toThrow('未翻译文档行内正文：Document translation');
        expect(validateDocumentInlineMarkers(source, echoed.replace('Open PDF reader', '打开PDF阅读器').replace('Document translation', '文档翻译'), {targetLanguage: 'zh-Hans'}))
            .toBe('对于在线PDF，打开扩展菜单选择 <g1>打开PDF阅读器</g1> 或 <g2>文档翻译</g2>。');
        expect(validateDocumentInlineMarkers(source, echoed, {targetLanguage: 'en'})).toBe(echoed);
        expect(validateDocumentInlineMarkers(source, echoed)).toBe(echoed);
        const current = documentConfig();
        expect(() => prepareGlossaryRequest({origin: source}, current).restore(echoed)).toThrow('未翻译文档行内正文');
        expect(prepareGlossaryRequest({origin: source, targetLanguage: ' en '}, current).restore(echoed)).toBe(echoed);
        expect(() => prepareGlossaryRequest({origin: source, targetLanguage: ' '}, current).restore(echoed)).toThrow();
        const englishConfig = {...current, to: 'en'};
        expect(() => prepareGlossaryRequest({origin: source, targetLanguage: 'zh-CN'}, englishConfig).restore(echoed)).toThrow();
        expect(prepareGlossaryRequest({origin: source}, englishConfig).restore(echoed)).toBe(echoed);
    });

    it('keeps proper names, technical nodes, same-language text, nested and repeated ids conservative', () => {
        const paragraph = 'The user should open the extension menu and read the document.';
        expect(isLikelyUntranslatedInlineResponse('The reader opens the complete document.', 'The reader opens the complete document.', 'zh-Hans', paragraph)).toBe(true);
        for (const [origin, result, target, context] of [
            ['Document translation', '文档翻译', 'zh-Hans', paragraph],
            ['Document translation', 'Document translation', 'zh-Hans', '请打开文档翻译页面。'],
            ['Document translation', 'Document translation', 'en', '这是中文正文，标签已经是目标英文。'],
            ['New York', 'New York', 'zh-Hans', paragraph],
            ['van Gogh', 'van Gogh', 'zh-Hans', paragraph],
            ['Jean-Luc Picard', 'Jean-Luc Picard', 'zh-Hans', paragraph],
            ['Document Translation', 'Document Translation', 'zh-Hans', paragraph],
            ['Open', 'Open', 'zh-Hans', paragraph],
            ['234 + 567', '234 + 567', 'zh-Hans', paragraph],
            ['API v1', 'API v1', 'zh-Hans', paragraph],
        ] as const) expect(isLikelyUntranslatedInlineResponse(origin, result, target, context), origin).toBe(false);
        for (const markers of ['<g1>New York</g1>', '<g1>van Gogh</g1>', '<g1>Jean-Luc Picard</g1>', '<g1/>',
            '<g1>outer <g2>Document translation</g2></g1>', '<g1>Document translation</g1><g1>Document translation</g1>']) {
            const source = `${paragraph} ${markers}`;
            expect(validateDocumentInlineMarkers(source, `用户应打开扩展菜单。${markers}`, {targetLanguage: 'zh-Hans'})).toBe(`用户应打开扩展菜单。${markers}`);
        }
    });

    it('exempts explicit user-English terms in paired nodes without letting an unrelated protected name hide ordinary echo', () => {
        const source = 'The reader should choose <g1>Document translation</g1> before importing the document.';
        const current = {...documentConfig(), glossaryEnabled: true, glossaryTerms: [{source: 'Document translation', target: 'Document translation'}],
            glossaryLibraries: [{id: 'user', name: 'User', enabled: true, sourceLanguage: '', targetLanguage: 'zh-hans', domains: [],
                entries: [{id: 'label', source: 'Document translation', target: 'Document translation', caseSensitive: true}]}]};
        const packet = prepareGlossaryRequest({origin: source}, current);
        expect(packet.message.origin).not.toContain('Document translation');
        expect(packet.restore(String(packet.message.origin).replace('The reader should choose', '读者应选择').replace('before importing the document.', '再导入文档。')))
            .toBe('读者应选择 <g1>Document translation</g1> 再导入文档。');
        const token = '__FRTERM_123456789abc_0__';
        const protectedSource = source.replace('Document translation', token), protectedTarget = `读者应选择 <g1>${token}</g1>。`;
        expect(validateDocumentInlineMarkers(protectedSource, protectedTarget, {targetLanguage: 'zh-Hans', protectedTokens: [token]})).toBe(protectedTarget);
        expect(validateDocumentInlineMarkers(source, protectedTarget, {targetLanguage: 'zh-Hans', protectedTokens: [token]})).toBe(protectedTarget);
        expect(() => validateDocumentInlineMarkers(source, '读者应选择 <g1>Document translation</g1>。', {targetLanguage: 'zh-Hans', protectedTokens: [token]})).toThrow();
        const targets = ['读者应选择 <g1>Document translation</g1>。', '<g2/>'];
        expect(() => validateDocumentTranslationResult(documentConfig(), [source, '<g2/>'], targets, 'zh-Hans')).toThrow();
        expect(validateDocumentTranslationResult(documentConfig(), [source, '<g2/>'], targets, 'en')).toEqual(targets);
        const slotSource = serializeTranslationSlots([source, '<g2/>'], 'inline_language');
        const slotTarget = serializeTranslationSlots(targets, 'inline_language');
        expect(() => validateDocumentTranslationResult(documentConfig(), slotSource.payload, slotTarget.payload, 'zh-Hans')).toThrow();
        expect(validateDocumentTranslationResult(documentConfig(), slotSource.payload, slotTarget.payload, 'en')).toBe(slotTarget.payload);
    });

    it('preserves spaced model combinations and Greek-ASCII variables exactly while respecting user terms and boundaries', () => {
        for (const source of ['GNMT + RL', 'GNMT\u00a0+\u00a0RL', 'GNMT\t+\tRL', 'GNMT\n+\nRL', 'ϵls', 'θmodel', 'αbeta'])
            expect(findDocumentLiteralTerms(`${source} [38]`)).toEqual([{source, target: source, caseSensitive: true}]);
        expect(findDocumentLiteralTerms('GNMT + RL', [{source: 'RL', target: '用户译法', caseSensitive: true}])).toEqual([]);
        expect(findDocumentLiteralTerms('ϵls', [{source: 'ϵls', target: '用户符号', caseSensitive: true}])).toEqual([]);
        expect(findDocumentLiteralTerms('ϵ + ϵls', [{source: 'ϵ', target: '用户符号', caseSensitive: true}]))
            .toEqual([{source: 'ϵls', target: 'ϵls', caseSensitive: true}]);
        for (const source of ['A + b', 'xGNMT + RL', 'καbeta', 'αλφα', 'αβ', 'xαbeta', 'xϵls', 'ϵlsSuffixα']) expect(findDocumentLiteralTerms(source), source).toEqual([]);
    });

    it('keeps paired, nested and self-closing syntax exactly while leaving the words between tags translatable', () => {
        const tag = `<details title="1 > 0" data-kind='a > b'>`;
        const source = `${tag}Expand <g1>nested <g2>bold</g2></g1><g3/> now.</details>`;
        const syntax = [tag, '</details>'];
        expect(findDocumentLiteralTerms(source).map(term => term.source)).toEqual(syntax);
        expect(findDocumentLiteralTerms('a < b > c; unclosed <summary title="not closed; <!-- comment -->')).toEqual([]);
        const current = documentConfig();
        const packet = prepareGlossaryRequest({origin: source}, current);
        expect(packet.message.origin).not.toMatch(/<\/?details/u);
        expect(packet.message.origin).toContain('<g1>nested <g2>bold</g2></g1><g3/>');
        expect(packet.message.origin).toContain('nested');
        expect(packet.restore(String(packet.message.origin).replace('Expand', '展开').replace('nested', '嵌套').replace('bold', '粗体')))
            .toBe(`${tag}展开 <g1>嵌套 <g2>粗体</g2></g1><g3/> now.</details>`);
        expect(getTranslationGlossaryTerms(current, source)).toEqual(syntax.map(source => ({source, target: source})));
        const page = {...current, glossaryMatchContext: {...current.glossaryMatchContext, context: 'page' as const}};
        expect(getGlossaryProtectionEntries(page, source)).toEqual([]);
        expect(prepareGlossaryRequest({origin: source}, page).message.origin).toBe(source);
    });

    it('does not let short glossary words change tag syntax, but still applies those words in prose', () => {
        const current = {...documentConfig(), glossaryEnabled: true, glossaryTerms: [{source: 'g1', target: '用户编号'}, {source: 'summary', target: '摘要'}],
            glossaryLibraries: [{id: 'user', name: 'User', enabled: true, sourceLanguage: '', targetLanguage: 'zh-hans', domains: [],
                entries: [{id: 'g', source: 'g1', target: '用户编号', caseSensitive: false}, {id: 'summary', source: 'summary', target: '摘要', caseSensitive: false}]}]};
        const source = '<summary><g1>g1 summary</g1></summary>';
        const entries = getGlossaryProtectionEntries(current, source);
        expect(entries.filter(entry => entry.source.startsWith('<')).map(entry => entry.source))
            .toEqual(['<summary>', '</summary>']);
        const packet = prepareGlossaryRequest({origin: source}, current);
        expect(packet.restore(packet.message.origin)).toBe('<summary><g1>用户编号 摘要</g1></summary>');
        expect(getTranslationGlossaryTerms(current, source)).toEqual(entries.map(({source, target}) => ({source, target})));
    });

    it('preserves radical identifiers and the standalone radical while allowing explicit user spelling', () => {
        expect(findDocumentLiteralTerms('Multiply by √dmodel, √dk and √hidden_2; √2 + 3 stays mathematical prose.').map(term => term.source))
            .toEqual(['√dmodel', '√dk', '√hidden_2', '√']);
        const source = 'Multiply by √dmodel.';
        const packet = prepareGlossaryRequest({origin: source}, documentConfig());
        expect(packet.message.origin).not.toContain('dmodel');
        expect(packet.restore(String(packet.message.origin).replace('Multiply by', '乘以'))).toBe('乘以 √dmodel.');
        expect(findDocumentLiteralTerms(source, [{source: 'dmodel', target: '用户符号', caseSensitive: true}])).toEqual([]);
    });

    it('restores Markdown emphasis/code/links and nested HTML after the same protected translation chain', () => {
        const markdown = parseDocument('sample.md', 'Read **bold**, use `npm install`, and [link](https://example.com).', {markdownSentences: true});
        const html = parseDocument('sample.html', '<p>Read <strong><em>bold</em></strong> now.</p>');
        for (const [document, replacements, expected] of [
            [markdown, [['Read', '阅读'], ['bold', '粗体'], ['use', '运行'], ['and', '并看'], ['link', '链接']], '阅读 **粗体**, 运行 `npm install`, 并看 [链接](https://example.com).'],
            [html, [['Read', '阅读'], ['bold', '粗体'], ['now.', '。']], '<p>阅读 <strong><em>粗体</em></strong> 。</p>'],
        ] as const) {
            const packet = prepareGlossaryRequest({origin: document.segments[0].source}, documentConfig());
            expect(String(packet.message.origin)).toMatch(/<g1>/u);
            let translated = String(packet.message.origin);
            for (const [source, target] of replacements) translated = translated.replace(source, target);
            expect(renderDocument(document, [packet.restore(translated) as string], 'translated')).toBe(expected);
        }
    });

    it('gives every HTML occurrence its own token and rejects lost, repeated and foreign paragraph syntax', () => {
        const origins = ['<summary>More</summary> then <summary>Again</summary>', '<details>Expand</details><g2/>'];
        const packet = prepareGlossaryRequest({origin: origins}, documentConfig());
        const protectedOrigins = packet.message.origin as string[];
        const tokens = getTranslationProviderConfig(packet.message, documentConfig()).glossaryProtectedTokens!;
        expect(tokens).toHaveLength(6);
        expect(packet.restore(protectedOrigins)).toEqual(origins);
        for (const first of [protectedOrigins[0].replace(tokens[0], ''), protectedOrigins[0] + tokens[0], protectedOrigins[0] + tokens[4]]) {
            expect(() => validateGlossaryProtectedTokens(protectedOrigins[0], first, tokens)).toThrow('未完整保留术语');
            expect(() => packet.restore([first, protectedOrigins[1]])).toThrow('未完整保留术语');
        }
    });

    it('normalizes only document marker spellings and preserves pairing, parent relationships and sibling reordering', () => {
        const source = 'Read <g1>outer <g2>bold</g2></g1>, then <g3/> and <g4>link</g4>.';
        const translated = '先 <g3></g3>，再（Ｇ４）链接（／g４）与 &lt; G1 &gt;外层&#60;g2&#62;粗体&#x3c;/g2&#x3e;&lt;/g1&gt;。';
        expect(validateDocumentInlineMarkers(source, translated)).toBe('先 <g3/>，再<g4>链接</g4>与 <g1>外层<g2>粗体</g2></g1>。');
        expect(normalizeDocumentInlineMarkers('正文 &amp; &lt;summary&gt; ＜g１／＞'))
            .toBe('正文 &amp; &lt;summary&gt; <g1/>');
        expect(documentInlineMarkerRanges('x<g1>bold</g1><g2/>')).toEqual([{start: 1, end: 5}, {start: 9, end: 14}, {start: 14, end: 19}]);
        expect(documentInlineMarkerRanges('plain <summary>')).toEqual([]);
        expect(validateDocumentInlineMarkers('<g1>literal unclosed', null)).toBeNull();
        expect(validateDocumentInlineMarkers('Plain words.', 3)).toBe(3);
        expect(validateDocumentInlineMarkers('<g1>one</g1><g1>two</g1>', '<g1>一</g1><g1>二</g1>'))
            .toBe('<g1>一</g1><g1>二</g1>');
        expect(validateDocumentInlineMarkers('<g1>bold</g1>', '<g1></g1>')).toBe('<g1></g1>');
    });

    it('rejects missing, repeated, foreign, wrongly paired and reparented markers before accepting a candidate', () => {
        const source = '<g1>outer <g2>bold</g2></g1> and <g3/>.';
        for (const result of [null, '无标签', '<g1>外层<g2>粗体</g1></g2><g3/>',
            '<g1>外层</g1><g2>粗体</g2><g3/>', '<g2>粗体<g1>外层</g1></g2><g3/>',
            '<g1>外层<g2>粗体</g2></g1><g3/><g3/>', '<g1>外层<g2>粗体</g2></g1><g4/>',
            '<g1>外层<g2>粗体</g2></g1><g3>被修改的代码</g3>', '<g1>外层<g2>粗体</g2></g1></g3/>',
            '<g1>外层<g2>粗体</g2></g1><g3/><g0/>', '<g1>外层<g2>粗体</g2></g1><g3/></g9>',
            '<g1>外层<g2>粗体</g2></g1><g3/><g99>未闭合'])
            expect(() => validateDocumentInlineMarkers(source, result), String(result)).toThrow('未完整保留文档行内格式');
        expect(() => validateDocumentInlineMarkers('<g1>first</g1>', '<g2>串槽</g2>')).toThrow();
        // 两槽恰好使用相同编号和结构时，标签本身无法验证正文所属位置；数组/slot 协议负责位置。
        expect(validateDocumentInlineMarkers('<g1>first</g1>', '<g1>另一槽文字</g1>')).toBe('<g1>另一槽文字</g1>');
        expect(validateDocumentInlineMarkers('</g1/> literal', '普通译文')).toBe('普通译文');
        expect(validateDocumentInlineMarkers('<g0>literal</g0>', '普通译文')).toBe('普通译文');
    });

    it('validates document-only arrays and serialized slots during every provider restore, including g-only requests', () => {
        const current = documentConfig();
        const originals = ['Keep <g1>bold</g1>.', 'Run <g2/>.'];
        const packet = prepareGlossaryRequest({origin: originals}, current);
        expect(getTranslationProviderConfig(packet.message, current).glossaryMatchContext?.context).toBe('document');
        expect(packet.restore(['保留&lt;g1&gt;粗体&lt;/g1&gt;。', '运行＜g2／＞。']))
            .toEqual(['保留<g1>粗体</g1>。', '运行<g2/>。']);
        for (const result of [null, ['少一槽'], ['丢失粗体', '运行<g2/>。']]) expect(() => packet.restore(result)).toThrow('未完整保留文档行内格式');
        expect(() => prepareGlossaryRequest({origin: originals[0]}, current).restore('丢掉标签')).toThrow();
        const sources = ['Keep <g1>bold</g1>.', 'Keep <g2>link</g2>.'];
        const sourcePacket = serializeTranslationSlots(sources, 'custom_nested_BEGIN_nonce');
        const request = prepareGlossaryRequest({origin: sourcePacket.payload}, current);
        const target = serializeTranslationSlots(['保留&lt;g1&gt;粗体&lt;/g1&gt;。', '保留（g2）链接（/g2）。'], 'custom_nested_BEGIN_nonce');
        expect(request.restore(target.payload)).toBe(serializeTranslationSlots(['保留<g1>粗体</g1>。', '保留<g2>链接</g2>。'], 'custom_nested_BEGIN_nonce').payload);
        expect(() => request.restore(serializeTranslationSlots(['保留<g2>链接</g2>。', '保留<g1>粗体</g1>。'], 'custom_nested_BEGIN_nonce').payload)).toThrow();
        for (const result of [null, '<g1>粗体</g1><g2>链接</g2>']) expect(() => request.restore(result)).toThrow();
        const plain = serializeTranslationSlots(['First.', 'Second.']);
        expect(validateDocumentTranslationResult(current, plain.payload, '普通译文')).toBe('普通译文');
        const page = {...current, glossaryMatchContext: {...current.glossaryMatchContext, context: 'page' as const}};
        expect(validateDocumentTranslationResult(page, sourcePacket.payload, '网页结果不改变')).toBe('网页结果不改变');
    });

    it('retains explicit glossary selection and empty summary handling without weakening non-document array validation', () => {
        const current = {...documentConfig(), glossaryTerms: [{source: 'API', target: '接口'}],
            glossaryMatchContext: {context: 'page' as const, sourceLanguage: 'en', targetLanguage: 'zh-hans', glossaryIds: ['user']},
            glossaryLibraries: [{id: 'user', name: 'User', enabled: true, sourceLanguage: '', targetLanguage: 'zh-hans', domains: [],
                entries: [{id: 'api', source: 'API', target: '接口', caseSensitive: true}]}]};
        expect(getGlossaryProtectionEntries({...current, glossaryMatchContext: undefined}, 'API')).toEqual([]);
        expect(getGlossaryProtectionEntries({...current, glossaryLibraries: undefined}, 'API')).toEqual([]);
        const emptySummary = {origin: ['API'], summaryPrompt: ''};
        const packet = prepareGlossaryRequest(emptySummary, current);
        expect(packet.restore(packet.message.origin)).toEqual(['接口']);
        for (const result of [null, []]) expect(() => packet.restore(result)).toThrow('未完整保留术语');
        const summaryRequest = {origin: 'API', summaryPrompt: 'Summarize'};
        const summary = prepareGlossaryRequest(summaryRequest, current);
        expect(summary.message.origin).toBe('API');
        expect(summary.restore('摘要')).toBe('摘要');
    });

    it('caches translated inline words with raw g identity, without reusing earlier FRTERM identity results', async () => {
        const config = Object.assign(new Config(), {service: 'microsoft', from: 'en', to: 'zh-Hans', useCache: true});
        const cache = new Map<string, string>(), identities: Record<string, unknown>[] = [];
        const origin = 'Translate this paragraph and keep <g1>bold</g1> text.';
        const provider = vi.fn(async (message: TranslationProviderRequest) => {
            expect(message.origin).toBe(origin);
            expect(getTranslationProviderConfig(message, createTranslationProviderConfigSnapshot(config)).glossaryProtectedTokens).toBeUndefined();
            return '翻译这一段，并保留&lt;g1&gt;粗体&lt;/g1&gt;文本。';
        });
        const broker = createTranslationBroker({ready: Promise.resolve(), getConfig: () => config, providers: {microsoft: provider},
            cache: {get: async key => cache.get(key) ?? null, set: async (key, value) => {cache.set(key, value); return true;}, clear: async () => {cache.clear();}, cleanup: async () => {}},
            serviceTypes: servicesType, resolveConfiguredModel, getMissingCredentialMessage: () => null,
            endpointResolver: {resolveOpenAICompatibleEndpoint: () => ({endpoint: 'https://fixture.invalid/v1'}), aiSdkTransportProfile: 'fixture'},
            promptBuilder: {buildPageSummaryPrompt: text => text, buildPageSummarySystemPrompt: () => ''},
            getTranslationLanguages: () => ({sourceLanguage: 'en', targetLanguage: 'zh-Hans'}),
            buildTranslationCacheKey: identity => {
                identities.push(identity);
                const oldTerms = ['<g1>', '</g1>'].map(source => ({source, target: source}));
                const oldIdentity = {...identity, glossaryTerms: oldTerms, glossaryProtection: {version: 1, entries: oldTerms.map(term => ({...term, caseSensitive: true}))}};
                cache.set(JSON.stringify(oldIdentity), '旧译文：保留<g1>bold</g1>文本。');
                return JSON.stringify(identity);
            }, logger: {warn: vi.fn()},
        });
        await expect(broker.translateWithCache({origin, glossaryContext: 'document'})).resolves.toBe('翻译这一段，并保留<g1>粗体</g1>文本。');
        await expect(broker.translateWithCache({origin, glossaryContext: 'document'})).resolves.toBe('翻译这一段，并保留<g1>粗体</g1>文本。');
        expect(provider).toHaveBeenCalledOnce();
        expect(identities[0].glossaryTerms ?? []).toEqual([]);
        expect(cache.size).toBe(2);
        config.glossaryEnabled = true;
        const userSource = 'The developer improves the documentation for this project.';
        config.glossaryLibraries = [{id: 'user', name: 'User', enabled: true, sourceLanguage: '', targetLanguage: 'zh-hans', domains: [],
            entries: [{id: 'developer', source: userSource, target: userSource, caseSensitive: true}]}];
        provider.mockImplementation(async (message: TranslationProviderRequest) => String(message.origin));
        const emphasized = `<g1>${userSource}</g1>`;
        await expect(broker.translateWithCache({origin: emphasized, glossaryContext: 'document'})).resolves.toBe(emphasized);
        await expect(broker.translateWithCache({origin: emphasized, glossaryContext: 'document'})).resolves.toBe(emphasized);
        expect(provider).toHaveBeenCalledTimes(2);
        const current = {...createTranslationProviderConfigSnapshot(config), glossaryTerms: [{source: userSource, target: userSource}],
            glossaryMatchContext: {context: 'document' as const, sourceLanguage: 'en', targetLanguage: 'zh-hans'}};
        expect(isGlossaryOnlyResult(current, emphasized, emphasized)).toBe(true);
        expect(isGlossaryOnlyResult(current, `<g1>${userSource} extra</g1>`, `<g1>${userSource} extra</g1>`)).toBe(false);
        expect(isGlossaryOnlyResult({...current, glossaryMatchContext: {...current.glossaryMatchContext, context: 'page'}}, emphasized, emphasized)).toBe(false);
    });

    it.each([false, true])('never caches empty inline candidates or reuses policy-v2 document entries, array=%s', async array => {
        const config = Object.assign(new Config(), {service: 'microsoft', from: 'en', to: 'zh-Hans', useCache: true});
        const source = 'The reader should choose <g1>Search</g1> before importing the document.';
        const invalid = '读者应选择搜索<g1></g1>再导入文档。', valid = '读者应选择<g1>搜索</g1>再导入文档。';
        const cache = new Map<string, string>(), writes = vi.fn(async (key: string, value: string) => {cache.set(key, value); return true;});
        const identities: Record<string, unknown>[] = [], oldKeys = new Set<string>();
        const provider = vi.fn().mockResolvedValueOnce(array ? [invalid] : invalid).mockResolvedValue(array ? [valid] : valid);
        const broker = createTranslationBroker({ready: Promise.resolve(), getConfig: () => config, providers: {microsoft: provider},
            cache: {get: async key => cache.get(key) ?? null, set: writes, clear: async () => {cache.clear();}, cleanup: async () => {}},
            serviceTypes: servicesType, resolveConfiguredModel, getMissingCredentialMessage: () => null,
            endpointResolver: {resolveOpenAICompatibleEndpoint: () => ({endpoint: 'https://fixture.invalid/v1'}), aiSdkTransportProfile: 'fixture'},
            promptBuilder: {buildPageSummaryPrompt: text => text, buildPageSummarySystemPrompt: () => ''},
            getTranslationLanguages: () => ({sourceLanguage: 'en', targetLanguage: 'zh-Hans'}),
            buildTranslationCacheKey: identity => {
                identities.push(identity);
                const oldKey = JSON.stringify({...identity, documentTranslationPolicy: {version: 2}});
                cache.set(oldKey, array ? JSON.stringify([invalid]) : invalid); oldKeys.add(oldKey);
                return JSON.stringify(identity);
            }, logger: {warn: vi.fn()},
        });
        const origin = array ? [source] : source;
        const request: TranslationRequestMessage = Array.isArray(origin)
            ? {origin, glossaryContext: 'document'} : {origin, glossaryContext: 'document'};
        await expect(broker.translateWithCache(request)).rejects.toThrow(DocumentInlineMarkerError);
        expect(writes).not.toHaveBeenCalled(); expect(provider).toHaveBeenCalledOnce();
        await expect(broker.translateWithCache(request)).resolves.toEqual(array ? [valid] : valid);
        expect(writes).toHaveBeenCalledOnce(); expect(provider).toHaveBeenCalledTimes(2);
        await expect(broker.translateWithCache(request)).resolves.toEqual(array ? [valid] : valid);
        expect(provider).toHaveBeenCalledTimes(2);
        expect(identities.every(identity => JSON.stringify(identity.documentTranslationPolicy) === '{"version":3}')).toBe(true);
        for (const oldKey of oldKeys) expect(cache.get(oldKey)).toBe(array ? JSON.stringify([invalid]) : invalid);
    });

    it('keeps URLs, emails, code-style product names and compound model names with exact spelling', () => {
        const terms = findDocumentLiteralTerms('Use FluentRead with GNMT+RL and https://github.com/tensorflow/tensor2tensor. Email ai+docs@example.org!');
        expect(terms.map(term => term.source)).toEqual(['FluentRead', 'GNMT+RL', 'https://github.com/tensorflow/tensor2tensor', 'ai+docs@example.org']);
        expect(terms.every(term => term.target === term.source && term.caseSensitive)).toBe(true);
        expect(findDocumentLiteralTerms('访问 https://example.com。请继续翻译后面的说明。参阅（https://example.org）后继续。'))
            .toEqual(['https://example.com', 'https://example.org'].map(source => ({source, target: source, caseSensitive: true})));
        expect(findDocumentLiteralTerms('https://example.com、下一项需要翻译'))
            .toEqual([{source: 'https://example.com', target: 'https://example.com', caseSensitive: true}]);
    });
    it('deduplicates repeated literals across paragraphs and leaves normal prose and incomplete identifiers alone', () => {
        expect(findDocumentLiteralTerms(['FluentRead and DeepSeek', 'FluentRead again', 'ABSTRACT Transformer line structure snake_case', 'GNMT+ and no@address']))
            .toEqual(['FluentRead', 'DeepSeek'].map(source => ({source, target: source, caseSensitive: true})));
        expect(findDocumentLiteralTerms([])).toEqual([]);
        expect(findDocumentLiteralTerms('')).toEqual([]);
    });
    it('rejects missing, duplicate, unknown and foreign paragraph tokens before a free route wins', () => {
        const token = '__FRTERM_123456789abc_0__', other = '__FRTERM_123456789abc_1__';
        expect(() => validateGlossaryProtectedTokens('plain', null)).not.toThrow();
        expect(() => validateGlossaryProtectedTokens('plain', null, [])).not.toThrow();
        expect(() => validateGlossaryProtectedTokens(token, `译文${token}`, [token, other])).not.toThrow();
        for (const result of [null, '丢失', `${token}${token}`, `${token}${other}`, `${token}__FRTERM_unknown_0__`])
            expect(() => validateGlossaryProtectedTokens(token, result, [token, other])).toThrow('未完整保留术语');
        expect(() => validateGlossaryProtectedTokens(`${token} __FRTERM_literal_0__`, `${token} __FRTERM_literal_0__`, [token])).not.toThrow();
    });
    it('protects only document requests and gives provider and cache the same identity terms without global glossary changes', () => {
        const current = documentConfig();
        const origin = 'Use FluentRead and GNMT+RL at https://github.com/tensorflow/tensor2tensor.';
        const entries = getGlossaryProtectionEntries(current, origin);
        expect(entries).toEqual(findDocumentLiteralTerms(origin));
        expect(getTranslationGlossaryTerms(current, origin)).toEqual(entries.map(({source, target}) => ({source, target})));
        const packet = prepareGlossaryRequest({origin}, current);
        expect(packet.message.origin).not.toContain('tensorflow');
        expect(packet.restore(packet.message.origin)).toBe(origin);
        expect(() => packet.restore('模型名称已经丢失')).toThrow('未完整保留术语');
        expect(getGlossaryProtectionEntries({...current, glossaryMatchContext: {...current.glossaryMatchContext, context: 'page'}}, origin)).toEqual([]);
        expect(getTranslationGlossaryTerms({...current, glossaryMatchContext: {...current.glossaryMatchContext, context: 'page'}}, origin)).toEqual([]);
    });

    it('lets explicit short user terms win over automatic long names with the same boundaries, case and NFC rules', () => {
        const term = {source: 'GNMT', target: '用户译法', caseSensitive: true};
        expect(findDocumentLiteralTerms('GNMT+RL GNMT+RL FluentRead', [term]))
            .toEqual([{source: 'FluentRead', target: 'FluentRead', caseSensitive: true}]);
        expect(findDocumentLiteralTerms('GNMT+RL', [{...term, source: 'gnmt', caseSensitive: false}])).toEqual([]);
        for (const source of ['gnmt', 'NMT', 'unrelated'])
            expect(findDocumentLiteralTerms('GNMT+RL', [{...term, source}]))
                .toEqual([{source: 'GNMT+RL', target: 'GNMT+RL', caseSensitive: true}]);
        expect(findDocumentLiteralTerms('GNMT+RL model GNMT+RL', [{...term, source: 'model'}]))
            .toEqual([{source: 'GNMT+RL', target: 'GNMT+RL', caseSensitive: true}]);
        expect(findDocumentLiteralTerms('https://example.com/Cafe\u0301', [{source: 'Café', target: '用户拼写', caseSensitive: true}])).toEqual([]);
        expect(findDocumentLiteralTerms('https://example.com/Café', [{source: 'Cafe\u0301', target: '用户拼写', caseSensitive: true}])).toEqual([]);
        expect(findDocumentLiteralTerms('https://example.com/Cafe\u0301', [{source: 'different', target: '', caseSensitive: true}]))
            .toEqual([{source: 'https://example.com/Cafe\u0301', target: 'https://example.com/Cafe\u0301', caseSensitive: true}]);
    });

    it('restores GNMT user spelling through broker, provider tokens and cache without changing page requests', async () => {
        const config = Object.assign(new Config(), {service: 'microsoft', from: 'en', to: 'zh-Hans', useCache: true, glossaryEnabled: true,
            glossaryLibraries: [{id: 'user', name: 'User terms', enabled: true, sourceLanguage: '', targetLanguage: 'zh-hans', domains: [],
                entries: [{id: 'gnmt', source: 'GNMT', target: '用户译法', caseSensitive: true}]}]});
        const before = JSON.stringify(config.glossaryLibraries);
        const cache = new Map<string, string>(), identities: Record<string, unknown>[] = [];
        const provider = vi.fn(async (message: TranslationProviderRequest) => {
            const snapshot = getTranslationProviderConfig(message, createTranslationProviderConfigSnapshot(config));
            expect(snapshot.glossaryProtectedTokens).toHaveLength(2);
            expect(message.origin).not.toContain('GNMT'); expect(message.origin).not.toContain('FluentRead');
            expect(message.origin).toContain('+RL');
            return `译文:${message.origin}`;
        });
        const broker = createTranslationBroker({ready: Promise.resolve(), getConfig: () => config, providers: {microsoft: provider},
            cache: {get: async key => cache.get(key) ?? null, set: async (key, value) => {cache.set(key, value); return true;}, clear: async () => {cache.clear();}, cleanup: async () => {}},
            serviceTypes: servicesType, resolveConfiguredModel, getMissingCredentialMessage: () => null,
            endpointResolver: {resolveOpenAICompatibleEndpoint: () => ({endpoint: 'https://fixture.invalid/v1'}), aiSdkTransportProfile: 'fixture'},
            promptBuilder: {buildPageSummaryPrompt: text => text, buildPageSummarySystemPrompt: () => ''},
            getTranslationLanguages: request => ({sourceLanguage: request?.sourceLanguage ?? 'en', targetLanguage: request?.targetLanguage ?? 'zh-Hans'}),
            buildTranslationCacheKey: identity => {identities.push(identity); return JSON.stringify(identity);}, logger: {warn: vi.fn()},
        });
        const origin = 'Use GNMT+RL with FluentRead.';
        await expect(broker.translateWithCache({origin, glossaryContext: 'document'})).resolves.toBe('译文:Use 用户译法+RL with FluentRead.');
        expect(identities[0]).toMatchObject({glossaryTerms: [{source: 'GNMT', target: '用户译法'}, {source: 'FluentRead', target: 'FluentRead'}],
            glossaryProtection: {entries: [{source: 'GNMT', target: '用户译法', caseSensitive: true}, {source: 'FluentRead', target: 'FluentRead', caseSensitive: true}]}});
        await expect(broker.translateWithCache({origin, glossaryContext: 'document'})).resolves.toBe('译文:Use 用户译法+RL with FluentRead.');
        expect(provider).toHaveBeenCalledOnce();
        expect(JSON.stringify(config.glossaryLibraries)).toBe(before);

        const current = {...documentConfig(), glossaryTerms: [{source: 'GNMT', target: 'GNMT'}],
            glossaryLibraries: [{...config.glossaryLibraries[0], entries: [{id: 'gnmt', source: 'GNMT', target: '', caseSensitive: true}]}]};
        const entries = getGlossaryProtectionEntries(current, origin);
        expect(entries.map(entry => entry.source)).toEqual(['GNMT', 'FluentRead']);
        expect(getTranslationGlossaryTerms(current, origin)).toEqual(entries.map(({source, target}) => ({source, target: target || source})));
        const packet = prepareGlossaryRequest({origin}, current);
        expect(packet.restore(packet.message.origin)).toBe(origin);
    });
});
