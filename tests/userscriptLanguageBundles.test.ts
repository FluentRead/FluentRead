import {mimoRetirementSource, mimoRetirementLegacyText} from '@/src/core/i18n/messages/mimoRetirement';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
// 脚本发布的语言资源不含智能高亮文案；摘要必须按脚本实际使用的投影计算。
import {UI_LANGUAGE_BUNDLES, currentUserscriptLanguageBundle, createUserscriptLanguageUpdate, userscriptPageMessages, zhCNMessages} from '../userscript/languageBundles';
import {gzipUserscriptBuildData} from '../userscript/buildGzip';
import {UI_LANGUAGE_BUNDLES as extensionBundles} from '@/src/core/i18n/bundles';
import {aiRequestTimeoutMessages} from '@/src/core/i18n/messages/aiRequestTimeout';
import {ungzip} from 'pako';
import {packKeyColumn, unpackKeyColumn, packLanguageUpdates, unpackLanguageUpdates, packMessageCatalog, packUiLanguageBundle, unpackMessageCatalog, unpackUiLanguageBundle} from '@/userscript/languageData';
import userscriptConfig from '../userscript/vite.config';

const languageDir = resolve(process.cwd(), 'userscript/languages');
const digest = createHash('sha256').update(JSON.stringify(UI_LANGUAGE_BUNDLES['fr-FR'])).digest('hex').slice(0, 16);
const fileName = `fr-FR.${digest}.json`;
const source = readFileSync(resolve(languageDir, fileName), 'utf8');
const resourceCommit = '70d3d901033a579e32a5bf5e6af14555f0d140bb';

describe('embedded language columns', () => {
    it('roundtrips shared update columns, missing keys, empty values, patterns and legacy object format',()=>{
        const updates={
          'ja-JP':{messages:{a:'',b:'日本語'},legacyText:{x:'旧'},legacyPatterns:{early:[['same','一'],['same','二']],late:[]},patternOrder:{early:[1,-1]}},
          'fr-FR':{messages:{b:'français',c:'autre'},legacyText:{y:''},legacyPatterns:{early:[],late:[]}},
        } as const;
        const packed=JSON.parse(JSON.stringify(packLanguageUpdates(updates)));
        expect(unpackLanguageUpdates(packed)).toEqual(updates);expect(unpackLanguageUpdates(updates)).toBe(updates);
        expect(()=>unpackLanguageUpdates({...packed,rows:{bad:[['wrong'],[],{},null]}})).toThrow(TypeError);
        expect(()=>unpackLanguageUpdates({...packed,messages:[2]})).toThrow(TypeError);
        expect(()=>unpackLanguageUpdates([])).toThrow(TypeError);
        expect(()=>unpackLanguageUpdates({...packed,rows:{bad:[]}})).toThrow(TypeError);
    });
    it('roundtrips prefix keys including duplicate, long and non-BMP strings without changing ordering', () => {
        const keys = ['', '__proto__', 'repeat', 'repeat', '😀a', '😀b', 'x'.repeat(120), 'x'.repeat(120)+'tail', 'constructor'];
        expect(unpackKeyColumn(JSON.parse(JSON.stringify(packKeyColumn(keys))))).toEqual(keys);
        const values=keys.map((_,index)=>`value${index}`);
        expect(unpackMessageCatalog([packKeyColumn(keys),values])).toEqual(Object.fromEntries(keys.map((key,index)=>[key,values[index]])));
        for(const invalid of [{p:['']},{p:['!oops']},{p:[1]},{p:[],extra:true},{p:'bad'}]) expect(()=>unpackKeyColumn(invalid)).toThrow(TypeError);
    });
    it.each(Object.keys(UI_LANGUAGE_BUNDLES))('preserves the complete %s bundle when legacy keys are prefix encoded', language => {
        const bundle=UI_LANGUAGE_BUNDLES[language as keyof typeof UI_LANGUAGE_BUNDLES];
        const keys=packMessageCatalog(bundle.messages)[0];
        const packed=packUiLanguageBundle(bundle,keys,true);
        expect(unpackUiLanguageBundle(JSON.parse(JSON.stringify(packed)),keys)).toEqual(bundle);
        expect(unpackUiLanguageBundle(JSON.parse(JSON.stringify(packUiLanguageBundle(bundle))))).toEqual(bundle);
    });
    it('retains exact ordered prefix keys in the shared default catalog, even with repeated and numeric keys',async()=>{
        vi.resetModules();const provider=await import('@/userscript/defaultMessageData');
        const keys=['1','10','2','repeat','repeat','__proto__','😀'];const values=keys.map((_,index)=>String(index));
        expect(provider.restoreDefaultMessageColumns([packKeyColumn(keys),values])).toEqual(Object.fromEntries(keys.map((key,index)=>[key,values[index]])));
        expect(provider.readDefaultMessageKeys()).toEqual(keys);
    });
    it('roundtrips sorted catalogs and preserves duplicate patterns and optional captures', () => {
        const bundle = {messages: {z: '末尾', a: 'first'}, legacyText: {'旧文案': 'legacy'}, legacyPatterns: {
            early: [], late: [['^same$', 'localized'], ['^same$', 'fallback', []], ['^(.+)$', '{1}', [1]]],
        }} as const;
        const packed = packUiLanguageBundle(bundle);
        expect(packed).toEqual([[['a', 'z'], ['旧文案']], [[], [], []],
            [['^same$', '^same$', '^(.+)$'], ['localized', 'fallback', '{1}'], [null, [], [1]]], [['first', '末尾'], ['legacy']]]);
        expect(unpackUiLanguageBundle(JSON.parse(JSON.stringify(packed)))).toEqual(bundle);
        expect(unpackUiLanguageBundle(bundle)).toBe(bundle);
        expect(packUiLanguageBundle({...bundle, messages: {a: 'first', z: '末尾'}})).toEqual(packed);
    });

    it('shares only an identical ordered message-key vector and falls back to complete columns otherwise', () => {
        const bundle = {messages: {z: '🌏末尾', a: '{name} first'}, legacyText: {'旧文案': 'legacy'}, legacyPatterns: {
            early: [['^same$', 'localized'], ['^same$', 'fallback', []]], late: [['^(.+)$', '{1}', [1]]],
        }} as const;
        const original = JSON.stringify(bundle);
        const shared = packUiLanguageBundle(bundle, ['a', 'z']);
        expect(shared[0][0]).toBeNull();
        expect(unpackUiLanguageBundle(JSON.parse(JSON.stringify(shared)), ['a', 'z'])).toEqual(bundle);
        for (const keys of [[], ['a'], ['z', 'a'], ['a', 'other'], ['a', 'z', 'extra']]) {
            expect(packUiLanguageBundle(bundle, keys)).toEqual(packUiLanguageBundle(bundle));
        }
        expect(unpackUiLanguageBundle(bundle)).toBe(bundle);
        expect(unpackUiLanguageBundle(packUiLanguageBundle(bundle))).toEqual(bundle);
        expect(JSON.stringify(bundle)).toBe(original);
    });

    it.each([undefined, [], ['a'], ['a', 'z', 'extra'], ['a', 2]].map(keys => ({keys})))('rejects missing or malformed shared keys: $keys', ({keys}) => {
        const packed = packUiLanguageBundle({messages: {a: 'A', z: 'Z'}, legacyText: {}, legacyPatterns: {early: [], late: []}}, ['a', 'z']);
        expect(() => unpackUiLanguageBundle(packed, keys as readonly string[] | undefined)).toThrow(TypeError);
    });

    it('preserves duplicate and special keys with Object.fromEntries semantics', () => {
        const keys = ['constructor', '__proto__', 'toString', 'repeat', 'repeat'];
        const texts = ['构造', '原型', '字符串', '旧值', '新值🌏'];
        const result = unpackMessageCatalog([keys, texts]);
        expect(result).toEqual(Object.fromEntries(keys.map((key, index) => [key, texts[index]])));
        expect(Object.keys(result)).toEqual(['constructor', '__proto__', 'toString', 'repeat']);
        expect(Object.hasOwn(result, '__proto__')).toBe(true);
        expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
        expect(unpackMessageCatalog(packMessageCatalog(result))).toEqual(result);
    });

    it('distinguishes a valid shared empty catalog from an uninitialized provider', () => {
        const bundle = {messages: {}, legacyText: {}, legacyPatterns: {early: [], late: []}};
        const packed = packUiLanguageBundle(bundle, []);
        expect(packed[0][0]).toBeNull();
        expect(unpackUiLanguageBundle(packed, [])).toEqual(bundle);
        expect(() => unpackUiLanguageBundle(packed)).toThrow(TypeError);
    });

    it.each([null, {}, [], [['key']], [['key'], ['text'], []], ['keys', ['text']], [['key'], 'texts'],
        [['key'], []], [['key'], ['text', 'extra']], [[1], ['text']], [['key'], [null]],
        [Array(1), ['text']], [['key'], Array(1)]].map(value => ({value})))('rejects malformed catalog columns: $value', ({value}) => {
        expect(() => unpackMessageCatalog(value)).toThrow(TypeError);
    });
});

describe('standalone default message provider', () => {
    afterEach(() => vi.resetModules());

    it('starts uninitialized while old objects and complete language columns remain usable', async () => {
        vi.resetModules();
        const provider = await import('@/userscript/defaultMessageData');
        expect(provider.readDefaultMessageKeys()).toBeUndefined();
        const bundle = {messages: {key: '文案'}, legacyText: {}, legacyPatterns: {early: [], late: []}};
        expect(unpackUiLanguageBundle(bundle, provider.readDefaultMessageKeys())).toBe(bundle);
        expect(unpackUiLanguageBundle(packUiLanguageBundle(bundle), provider.readDefaultMessageKeys())).toEqual(bundle);
        expect(() => unpackUiLanguageBundle(packUiLanguageBundle(bundle, ['key']), provider.readDefaultMessageKeys())).toThrow(TypeError);
    });

    it('publishes an immutable ordered key copy only after complete restoration succeeds', async () => {
        vi.resetModules();
        const provider = await import('@/userscript/defaultMessageData');
        expect(() => provider.restoreDefaultMessageColumns([['bad'], [false]])).toThrow(TypeError);
        expect(provider.readDefaultMessageKeys()).toBeUndefined();
        const keys = ['__proto__', 'repeat', 'repeat', 'constructor'];
        const texts = ['🌏原型', 'first', 'last', '{name}'];
        expect(provider.restoreDefaultMessageColumns([keys, texts])).toEqual(Object.fromEntries(keys.map((key, index) => [key, texts[index]])));
        const published = provider.readDefaultMessageKeys();
        expect(published).toEqual(keys);
        expect(Object.isFrozen(published)).toBe(true);
        keys[0] = 'changed';
        expect(published?.[0]).toBe('__proto__');
        expect(() => provider.restoreDefaultMessageColumns([['new'], []])).toThrow(TypeError);
        expect(provider.readDefaultMessageKeys()).toBe(published);
        provider.restoreDefaultMessageColumns([['next'], ['next text']]);
        expect(provider.readDefaultMessageKeys()).toEqual(['next']);
        provider.restoreDefaultMessageColumns([[], []]);
        expect(provider.readDefaultMessageKeys()).toEqual([]);
    });
});

describe('userscript remote UI language data', () => {
    it('keeps the complete settings notice aligned with the shared locale source', () => {
        const component = readFileSync(resolve(process.cwd(), 'src/features/settings/ui/services/ServiceConfiguration.vue'), 'utf8');
        expect(component).toContain("translateLegacy('" + mimoRetirementSource + "')");
        expect(component).toContain('data-mimo-retirement-note');
    });

    beforeEach(() => {
        const defines = (userscriptConfig as {define: Record<string, string>}).define;
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_DATA__', undefined);
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_LANGUAGE_UPDATES__', JSON.parse(defines.__FLUENTREAD_USERSCRIPT_LANGUAGE_UPDATES__));
        vi.stubGlobal('DecompressionStream', undefined);
        vi.stubGlobal('pako', {ungzip});
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.resetModules();
        globalThis.GM = undefined;
    });

    it.each(['current', 'legacy'] as const)('registers the %s English data resource without a network request or mutating its source', async version => {
        for (const bundle of Object.values(UI_LANGUAGE_BUNDLES)) {
            expect(bundle.messages).not.toHaveProperty('popup.compact.translate');
            expect(bundle.messages).not.toHaveProperty('popup.compact.restore');
            expect(Object.keys(bundle.messages).some(key => key.startsWith('popup.displayMode.'))).toBe(false);
            expect(Object.keys(bundle.messages).some(key => key.startsWith('popup.pageFont.'))).toBe(false);
            expect(Object.keys(bundle.messages).some(key => key.startsWith('safari.freePool.'))).toBe(false);
            expect(Object.keys(bundle.messages).some(key => key.startsWith('learning.collection.speech') && key !== 'learning.collection.speechFailed')).toBe(false);
            expect(bundle.messages['learning.collection.speechFailed']).toBeTruthy();
            expect(bundle.messages['popup.translateCurrentPage']).toBeTruthy();
        }
        const requests: string[] = [];
        globalThis.GM = {
            xmlHttpRequest(details) { requests.push(details.url); throw new Error('unexpected request'); },
        };
        const pinned = runInNewContext(readFileSync(resolve(process.cwd(), 'userscript/resources/fluentread-data.v1.js'), 'utf8'), {}, {timeout: 5000});
        if (version === 'legacy') {
            delete pinned.english.messages['settings.services.deeplx.defaultRoute'];
            pinned.english.messages['settings.services.deeplx.endpointHelp'] = 'Legacy endpoint route help';
        }
        const englishUpdate = createUserscriptLanguageUpdate(currentUserscriptLanguageBundle('en-US'), pinned.english);
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_LANGUAGE_UPDATES__', gzipUserscriptBuildData(Buffer.from(JSON.stringify({'en-US': englishUpdate}))).toString('base64'));
        const original = JSON.stringify(pinned.english);
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_DATA__', pinned);
        // data 优先于压缩资源；旧资源缺失或过期的两条文案也必须在注册时修复。
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_LANGUAGE_BUNDLES__', {'en-US': 'invalid-if-selected'});
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_REMOTE_LANGUAGES__', {});

        const {hasUiLanguageBundle, translate, translateLegacyText} = await import('@/src/core/i18n');
        expect(hasUiLanguageBundle('en-US')).toBe(false);
        const loader = await import('@/userscript/uiLanguageBundles');
        await expect(loader.ensureUiLanguageBundle('en-US')).resolves.toBe(true);
        expect(hasUiLanguageBundle('en-US')).toBe(true);
        expect(translateLegacyText(mimoRetirementSource, 'en-US')).toBe(extensionBundles['en-US'].legacyText[mimoRetirementSource]);
        for (const [key, text] of Object.entries(currentUserscriptLanguageBundle('en-US').messages)) expect(translate(key, 'en-US')).toBe(text);
        expect(JSON.stringify(pinned.english)).toBe(original);
        expect(requests).toEqual([]);
    });

    it('registers the actual compressed English define without a GM request and preserves retained copy', async () => {
        const requests: string[] = [];
        globalThis.GM = {
            xmlHttpRequest(details) { requests.push(details.url); throw new Error('unexpected request'); },
        };
        const defines = (userscriptConfig as {define: Record<string, string>}).define;
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_DATA__', undefined);
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_LANGUAGE_BUNDLES__', JSON.parse(defines.__FLUENTREAD_USERSCRIPT_LANGUAGE_BUNDLES__));
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_REMOTE_LANGUAGES__', JSON.parse(defines.__FLUENTREAD_USERSCRIPT_REMOTE_LANGUAGES__));
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_RESOURCE_COMMIT__', JSON.parse(defines.__FLUENTREAD_USERSCRIPT_RESOURCE_COMMIT__));
        // 确定走现有 pako fallback；此处不要求测试 DOM 环境提供浏览器原生 gzip stream。
        vi.stubGlobal('DecompressionStream', undefined);
        vi.stubGlobal('pako', {ungzip});
        const original = UI_LANGUAGE_BUNDLES['en-US'];
        const messages = Object.fromEntries(Object.entries(original.messages).filter(([key]) => !key.startsWith('document.') && !key.startsWith('translationStats.')));
        const expected = {...original, messages, legacyText: {...original.legacyText, ...mimoRetirementLegacyText['en-US']}};
        const core = await import('@/src/core/i18n');
        expect(core.hasUiLanguageBundle('en-US')).toBe(false);
        const register = vi.spyOn(core, 'registerUiLanguageBundle');
        try {
            const loader = await import('@/userscript/uiLanguageBundles');
            await expect(loader.ensureUiLanguageBundle('en-US')).resolves.toBe(true);
            expect(core.hasUiLanguageBundle('en-US')).toBe(true);
            expect(core.translateLegacyText(mimoRetirementSource, 'en-US')).toBe(extensionBundles['en-US'].legacyText[mimoRetirementSource]);
            expect(register).toHaveBeenCalledTimes(1);
            expect(register).toHaveBeenCalledWith('en-US', expected);
            // 对实际注册后的每一条保留稳定 key 使用核心翻译入口，包含参数占位文案。
            for (const [key, value] of Object.entries(messages)) expect(core.translate(key, 'en-US')).toBe(value);
            expect(original.legacyText['配置服务']).toBeTruthy();
            expect(core.translateLegacyText('配置服务', 'en-US')).toBe(original.legacyText['配置服务']);
            expect(core.translateLegacyText('翻译连接：Google；自定义服务：2；凭据和地址已隐藏', 'en-US'))
                .toBe('Connection: Google; custom services: 2; credentials and addresses hidden');
            await expect(loader.ensureUiLanguageBundle('en-US')).resolves.toBe(true);
            expect(register).toHaveBeenCalledTimes(1);
            expect(requests).toEqual([]);
        } finally {
            register.mockRestore();
        }
    });

    // The actual standalone configuration compresses catalogs in workers before this assertion.
    it('feeds the actual standalone Chinese virtual module to core and shares its provider with the actual English define', async () => {
        vi.stubEnv('FLUENTREAD_USERSCRIPT_STANDALONE', '1');
        vi.resetModules();
        try {
            const {default: standalone, createUserscriptCatalogCompressionPlugin: createPlugin} = await import('@/userscript/vite.config');
            const {transformWithEsbuild} = await import('vite');
            const provider = await import('@/userscript/defaultMessageData');
            const encoding = await import('@/userscript/dataEncoding');
            expect(provider.readDefaultMessageKeys()).toBeUndefined();
            const plugin = createPlugin() as unknown as {resolveId: (source: string, importer: string) => string; load: (id: string) => Promise<string>};
            const generated = await plugin.load(plugin.resolveId('./messages/zh-CN', resolve(process.cwd(), 'src/core/i18n/index.ts')));
            const compiled = await transformWithEsbuild(generated, 'standalone-default-messages.js', {format: 'cjs', target: 'es2018'});
            const realm = {module: {exports: {} as {zhCNMessages: Record<string, string>}}, require: (id: string) => {
                if (id === '@/userscript/pakoRuntime') return {inflateWithPako: (bytes: Uint8Array) => ungzip(bytes, {to: 'string'})};
                if (id === '@/userscript/dataEncoding') return encoding;
                if (id === '@/userscript/defaultMessageData') return provider;
                throw new Error(`Unexpected generated import: ${id}`);
            }};
            runInNewContext(compiled.code, realm, {timeout: 5000});
            const chinese = realm.module.exports.zhCNMessages;
            const expectedChinese = userscriptPageMessages(zhCNMessages);
            expect(chinese).toEqual(expectedChinese);
            expect(provider.readDefaultMessageKeys()).toEqual(packMessageCatalog(expectedChinese)[0]);
            // 核心消费真实虚拟模块输出；不能用未投影 raw 中文目录补足省略的键。
            vi.doMock('@/src/core/i18n/messages/zh-CN', () => ({zhCNMessages: chinese}));
            const core = await import('@/src/core/i18n');
            for (const [key, text] of Object.entries(expectedChinese)) expect(core.translate(key, 'zh-CN')).toBe(text);
            expect(core.translate('document.config.offline.help', 'zh-CN')).toBe('document.config.offline.help');
            const defines = (standalone as {define: Record<string, string>}).define;
            const compressed = JSON.parse(defines.__FLUENTREAD_USERSCRIPT_LANGUAGE_BUNDLES__);
            const packedEnglish = JSON.parse(ungzip(encoding.decodeUserscriptData(compressed['en-US']), {to: 'string'}) as string);
            expect(packedEnglish[0][0]).toBeNull();
            vi.stubGlobal('__FLUENTREAD_USERSCRIPT_LANGUAGE_BUNDLES__', compressed);
            vi.stubGlobal('__FLUENTREAD_USERSCRIPT_REMOTE_LANGUAGES__', JSON.parse(defines.__FLUENTREAD_USERSCRIPT_REMOTE_LANGUAGES__));
            vi.stubGlobal('__FLUENTREAD_USERSCRIPT_LANGUAGE_UPDATES__', JSON.parse(defines.__FLUENTREAD_USERSCRIPT_LANGUAGE_UPDATES__));
            const requests: string[] = [];
            globalThis.GM = {xmlHttpRequest(details) {requests.push(details.url); throw new Error('unexpected request');}};
            const register = vi.spyOn(core, 'registerUiLanguageBundle');
            try {
                const loader = await import('@/userscript/uiLanguageBundles');
                await expect(loader.ensureUiLanguageBundle('en-US')).resolves.toBe(true);
                const expected = {...UI_LANGUAGE_BUNDLES['en-US'], messages: userscriptPageMessages(UI_LANGUAGE_BUNDLES['en-US'].messages)};
                expect(register).toHaveBeenCalledTimes(1);
                expect(register).toHaveBeenCalledWith('en-US', expected);
                for (const [key, text] of Object.entries(expected.messages)) expect(core.translate(key, 'en-US')).toBe(text);
                expect(core.translateLegacyText('翻译连接：Google；自定义服务：2；凭据和地址已隐藏', 'en-US'))
                    .toBe('Connection: Google; custom services: 2; credentials and addresses hidden');
                expect(requests).toEqual([]);
            } finally {register.mockRestore();}
        } finally {
            vi.doUnmock('@/src/core/i18n/messages/zh-CN');
            vi.unstubAllEnvs();
        }
    }, 30_000);

    it('rejects uninitialized shared columns through the loader and retries after valid provider initialization', async () => {
        vi.resetModules();
        const bundle = {messages: {key: 'English 🌏 {name}'}, legacyText: {}, legacyPatterns: {early: [], late: []}};
        const compressed = gzipUserscriptBuildData(Buffer.from(JSON.stringify(packUiLanguageBundle(bundle, ['key'])))).toString('base64');
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_LANGUAGE_BUNDLES__', {'en-US': compressed});
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_REMOTE_LANGUAGES__', {});
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const provider = await import('@/userscript/defaultMessageData');
        const core = await import('@/src/core/i18n');
        const register = vi.spyOn(core, 'registerUiLanguageBundle');
        try {
            const loader = await import('@/userscript/uiLanguageBundles');
            await expect(loader.ensureUiLanguageBundle('en-US')).resolves.toBe(false);
            expect(provider.readDefaultMessageKeys()).toBeUndefined();
            expect(register).not.toHaveBeenCalled();
            provider.restoreDefaultMessageColumns([['key'], ['中文']]);
            await expect(loader.ensureUiLanguageBundle('en-US')).resolves.toBe(true);
            expect(register).toHaveBeenCalledTimes(1);
            expect(register).toHaveBeenCalledWith('en-US', bundle);
            expect(core.translate('key', 'en-US', {name: 'Alice'})).toBe('English 🌏 Alice');
            expect(warning).toHaveBeenCalledTimes(1);
        } finally {register.mockRestore();warning.mockRestore();}
    });

    it('downloads a generated language resource once and loads it from private GM cache next time', async () => {
        const values = new Map<string, unknown>();
        const requests: string[] = [];
        globalThis.GM = {
            async getValue(key, fallback) { return values.get(key) ?? fallback; },
            async setValue(key, value) { values.set(key, value); },
            xmlHttpRequest(details) {
                requests.push(details.url);
                return Promise.resolve({status: 200, statusText: 'OK', responseText: source});
            },
        };
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_LANGUAGE_BUNDLES__', {});
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_REMOTE_LANGUAGES__', {'fr-FR': fileName});
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_RESOURCE_COMMIT__', resourceCommit);

        const first = await import('@/userscript/uiLanguageBundles');
        await expect(first.ensureUiLanguageBundle('fr-FR')).resolves.toBe(true);
        expect(requests).toEqual([
            `https://cdn.jsdelivr.net/gh/FluentRead/FluentRead@${resourceCommit}/userscript/languages/${fileName}`,
        ]);
        expect(values.has(`fluentread:ui-language:${fileName}`)).toBe(true);

        vi.resetModules();
        globalThis.GM.xmlHttpRequest = () => { throw new Error('offline'); };
        const cached = await import('@/userscript/uiLanguageBundles');
        await expect(cached.ensureUiLanguageBundle('fr-FR')).resolves.toBe(true);
        expect(requests).toHaveLength(1);
    });

    it('tries raw GitHub when the CDN is unavailable', async () => {
        const requests: string[] = [];
        globalThis.GM = {
            async getValue(_key, fallback) { return fallback; },
            async setValue() {},
            xmlHttpRequest(details) {
                requests.push(details.url);
                return requests.length === 1
                    ? Promise.reject(new Error('CDN unavailable'))
                    : Promise.resolve({status: 200, statusText: 'OK', responseText: source});
            },
        };
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_LANGUAGE_BUNDLES__', {});
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_REMOTE_LANGUAGES__', {'fr-FR': fileName});
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_RESOURCE_COMMIT__', resourceCommit);

        const loader = await import('@/userscript/uiLanguageBundles');
        await expect(loader.ensureUiLanguageBundle('fr-FR')).resolves.toBe(true);
        expect(requests).toEqual([
            `https://cdn.jsdelivr.net/gh/FluentRead/FluentRead@${resourceCommit}/userscript/languages/${fileName}`,
            `https://raw.githubusercontent.com/FluentRead/FluentRead/${resourceCommit}/userscript/languages/${fileName}`,
        ]);
    });

    it.each(['ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const)('localizes recovery, DeepLX and MiMo copy after loading pinned %s data and after an offline cache reload', async language => {
        const digest = createHash('sha256').update(JSON.stringify(UI_LANGUAGE_BUNDLES[language])).digest('hex').slice(0, 16);
        const remoteFile = `${language}.${digest}.json`;
        const remoteSource = readFileSync(resolve(languageDir, remoteFile), 'utf8');
        const original = JSON.parse(remoteSource);
        expect(original.legacyText).not.toHaveProperty(mimoRetirementSource);
        expect(extensionBundles[language].legacyText[mimoRetirementSource]).toBeTruthy();
        expect(extensionBundles[language].legacyText[mimoRetirementSource]).not.toBe(mimoRetirementSource);
        expect(original.messages).not.toHaveProperty('sectionTranslation.picker.dragging');
        expect(original.messages).not.toHaveProperty('sectionTranslation.scope.selected');
        expect(original.messages).not.toHaveProperty('learning.panelLoadError');
        expect(original.messages).not.toHaveProperty('learning.reloadPage');
        expect(original.messages).not.toHaveProperty('settings.services.deeplx.defaultRoute');
        expect(original.messages['settings.services.deeplx.endpointHelp']).not.toBe(extensionBundles[language].messages['settings.services.deeplx.endpointHelp']);
        for (const key of Object.keys(aiRequestTimeoutMessages[language])) expect(original.messages).not.toHaveProperty(key);
        const values = new Map<string, unknown>();
        const requests: string[] = [];
        globalThis.GM = {
            async getValue(key, fallback) { return values.get(key) ?? fallback; },
            async setValue(key, value) { values.set(key, value); },
            xmlHttpRequest(details) {
                requests.push(details.url);
                return Promise.resolve({status: 200, statusText: 'OK', responseText: remoteSource});
            },
        };
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_LANGUAGE_BUNDLES__', {});
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_REMOTE_LANGUAGES__', {[language]: remoteFile});
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_RESOURCE_COMMIT__', resourceCommit);
        const current = currentUserscriptLanguageBundle(language);
        const assertCurrentCopy = async () => {
            const core = await import('@/src/core/i18n');
            for (const [key, text] of Object.entries(current.messages)) expect(core.translate(key, language), `${language}: ${key}`).toBe(text);
            for (const [source, text] of Object.entries(current.legacyText)) expect(core.translateLegacyText(source, language), `${language}: ${source}`).toBe(text);
        };
        async function assertLocalizedRegistration() {
            const core = await import('@/src/core/i18n');
            const register = vi.spyOn(core, 'registerUiLanguageBundle');
            try {
                const loader = await import('@/userscript/uiLanguageBundles');
                await expect(loader.ensureUiLanguageBundle(language)).resolves.toBe(true);
                await assertCurrentCopy();
                expect(core.translateLegacyText(mimoRetirementSource, language)).toBe(extensionBundles[language].legacyText[mimoRetirementSource]);
                expect(register).toHaveBeenCalledTimes(1);
                const registered = register.mock.calls[0][1];
                for (const [key, text] of Object.entries(current.messages)) expect(registered.messages[key]).toBe(text);
                for (const [source, text] of Object.entries(current.legacyText)) expect(registered.legacyText[source]).toBe(text);
                for (const phase of ['early', 'late'] as const) {
                    expect(registered.legacyPatterns[phase]).toEqual(current.legacyPatterns[phase]);
                }
                expect(registered.legacyText['服务优先顺序']).toBe(original.legacyText['服务优先顺序']);
                await expect(loader.ensureUiLanguageBundle(language)).resolves.toBe(true);
                await assertCurrentCopy();
                expect(core.translateLegacyText(mimoRetirementSource, language)).toBe(extensionBundles[language].legacyText[mimoRetirementSource]);
                expect(register).toHaveBeenCalledTimes(1);
            } finally { register.mockRestore(); }
        }
        await assertLocalizedRegistration();
        expect(requests).toHaveLength(1);
        expect(values.get(`fluentread:ui-language:${remoteFile}`)).toBe(JSON.stringify(original));
        // 注册补充不写回固定资源或GM缓存；离线读取同一旧资源也应本地化。
        vi.resetModules();
        globalThis.GM.xmlHttpRequest = () => { throw new Error('offline'); };
        await assertLocalizedRegistration();
        expect(requests).toHaveLength(1);
        expect(values.get(`fluentread:ui-language:${remoteFile}`)).toBe(JSON.stringify(original));
        expect(readFileSync(resolve(languageDir, remoteFile), 'utf8')).toBe(remoteSource);
    });

    it('uses current source copy over stale cached recovery messages without mutating the cache', async () => {
        const original = JSON.parse(source);
        const messages = {...original.messages,
            'learning.panelLoadError': 'Remote section recovery', 'learning.reloadPage': 'Remote reload'};
        const supplied = {...original, messages};
        globalThis.GM = {
            async getValue() { return supplied; },
            xmlHttpRequest() { throw new Error('unexpected request'); },
        };
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_LANGUAGE_BUNDLES__', {});
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_REMOTE_LANGUAGES__', {'fr-FR': fileName});
        const core = await import('@/src/core/i18n');
        const register = vi.spyOn(core, 'registerUiLanguageBundle');
        try {
            const loader = await import('@/userscript/uiLanguageBundles');
            await expect(loader.ensureUiLanguageBundle('fr-FR')).resolves.toBe(true);
            expect(register).toHaveBeenCalledTimes(1);
            const registered = register.mock.calls[0][1];
            const current = currentUserscriptLanguageBundle('fr-FR');
            for (const [key, text] of Object.entries(current.messages)) expect(registered.messages[key]).toBe(text);
            expect(core.translate('learning.panelLoadError', 'fr-FR')).toBe(current.messages['learning.panelLoadError']);
            expect(core.translate('learning.reloadPage', 'fr-FR')).toBe(current.messages['learning.reloadPage']);
            expect(supplied.messages).toEqual(messages);
        } finally { register.mockRestore(); }
    });

    it('retries a failed local increment decode using the unchanged cached remote resource', async () => {
        const original = JSON.parse(source), before = JSON.stringify(original);
        globalThis.GM = {async getValue() {return original;}, xmlHttpRequest() {throw new Error('offline');}};
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_LANGUAGE_BUNDLES__', {});
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_REMOTE_LANGUAGES__', {'fr-FR': fileName});
        vi.stubGlobal('pako', {ungzip: vi.fn().mockImplementationOnce(() => {throw new Error('temporary decompression failure');}).mockImplementation(ungzip)});
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const core = await import('@/src/core/i18n');
            const loader = await import('@/userscript/uiLanguageBundles');
            await expect(loader.ensureUiLanguageBundle('fr-FR')).resolves.toBe(false);
            expect(core.hasUiLanguageBundle('fr-FR')).toBe(false);
            await expect(loader.ensureUiLanguageBundle('fr-FR')).resolves.toBe(true);
            expect(core.translate('settings.floatingBall.hoverDelayHelp', 'fr-FR')).toBe(extensionBundles['fr-FR'].messages['settings.floatingBall.hoverDelayHelp']);
            expect(JSON.stringify(original)).toBe(before);
        } finally {warn.mockRestore();}
    });

    it('reconstructs duplicate regex entries, reordering and changed captures without changing the baseline', async () => {
        const baseline = {messages: {'sample': 'old'}, legacyText: {}, legacyPatterns: {early: [], late: [
            ['^same (.+)$', 'localized {1}', [1]], ['^same (.+)$', 'fallback {1}'], ['^removed$', 'removed'],
        ]}} as const;
        const current = {messages: {'sample': 'new'}, legacyText: {}, legacyPatterns: {early: [['^early$', 'new early']], late: [
            baseline.legacyPatterns.late[1], ['^same (.+)$', 'updated {1}', [1]], baseline.legacyPatterns.late[0],
        ]}} as const;
        const update = createUserscriptLanguageUpdate(current, baseline);
        expect(createUserscriptLanguageUpdate(current, baseline)).toEqual(update);
        expect(update.legacyPatterns.late).toEqual([current.legacyPatterns.late[1]]);
        expect(update.patternOrder?.late).toEqual([1, -1, 0]);
        expect(createUserscriptLanguageUpdate(current, current)).toEqual({messages: {}, legacyText: {}, legacyPatterns: {early: [], late: []}});
        const before = JSON.stringify(baseline);
        globalThis.GM = {async getValue() {return baseline;}, xmlHttpRequest() {throw new Error('unexpected request');}};
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_LANGUAGE_BUNDLES__', {});
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_REMOTE_LANGUAGES__', {'fr-FR': fileName});
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_LANGUAGE_UPDATES__', gzipUserscriptBuildData(Buffer.from(JSON.stringify({'fr-FR': update}))).toString('base64'));
        const core = await import('@/src/core/i18n'), register = vi.spyOn(core, 'registerUiLanguageBundle');
        try {
            const loader = await import('@/userscript/uiLanguageBundles');
            await expect(loader.ensureUiLanguageBundle('fr-FR')).resolves.toBe(true);
            expect(register).toHaveBeenCalledWith('fr-FR', current);
            expect(JSON.stringify(baseline)).toBe(before);
        } finally {register.mockRestore();}
    });

    it.each([
        {messages: null},
        {patternOrder: {early: 'invalid'}},
        {patternOrder: {early: [0.5]}},
        {patternOrder: {early: [999999]}},
        {patternOrder: {early: [-999999]}},
    ])('rejects malformed local update %j without registering or changing the baseline', async invalid => {
        const original = JSON.parse(source), before = JSON.stringify(original);
        const update = {messages: {}, legacyText: {}, legacyPatterns: {early: [], late: []}, ...invalid};
        globalThis.GM = {async getValue() {return original;}, xmlHttpRequest() {throw new Error('unexpected request');}};
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_LANGUAGE_BUNDLES__', {});
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_REMOTE_LANGUAGES__', {'fr-FR': fileName});
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_LANGUAGE_UPDATES__', gzipUserscriptBuildData(Buffer.from(JSON.stringify({'fr-FR': update}))).toString('base64'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const core = await import('@/src/core/i18n');
            const loader = await import('@/userscript/uiLanguageBundles');
            await expect(loader.ensureUiLanguageBundle('fr-FR')).resolves.toBe(false);
            expect(core.hasUiLanguageBundle('fr-FR')).toBe(false);
            expect(JSON.stringify(original)).toBe(before);
        } finally {warn.mockRestore();}
    });

    it('keeps baseline compatibility when an older build has no local increment define', async () => {
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_LANGUAGE_UPDATES__', undefined);
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_LANGUAGE_BUNDLES__', {});
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_REMOTE_LANGUAGES__', {'fr-FR': fileName});
        globalThis.GM = {async getValue() {return JSON.parse(source);}, xmlHttpRequest() {throw new Error('unexpected request');}};
        const core = await import('@/src/core/i18n'), register = vi.spyOn(core, 'registerUiLanguageBundle');
        try {
            const loader = await import('@/userscript/uiLanguageBundles');
            await expect(loader.ensureUiLanguageBundle('fr-FR')).resolves.toBe(true);
            expect(register).toHaveBeenCalledWith('fr-FR', JSON.parse(source));
        } finally {register.mockRestore();}
    });

    it('shares concurrent loads and rerenders once after availability, while unsupported languages render once', async () => {
        let resolveCache!: (value: unknown) => void;
        globalThis.GM = {async getValue() {return new Promise(resolve => {resolveCache = resolve;});}, xmlHttpRequest() {throw new Error('unexpected request');}};
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_LANGUAGE_BUNDLES__', {});
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_REMOTE_LANGUAGES__', {'fr-FR': fileName});
        const loader = await import('@/userscript/uiLanguageBundles');
        const render = vi.fn();
        loader.renderWithUiLanguageBundle('fr-FR', render);
        expect(render).toHaveBeenCalledTimes(1);
        const first = loader.ensureUiLanguageBundle('fr-FR');
        expect(loader.ensureUiLanguageBundle('fr-FR')).toBe(first);
        resolveCache(JSON.parse(source));
        await expect(first).resolves.toBe(true);
        expect(render).toHaveBeenCalledTimes(2);
        loader.renderWithUiLanguageBundle('fr-FR', render);
        expect(render).toHaveBeenCalledTimes(3);
        const unsupported = vi.fn();
        loader.renderWithUiLanguageBundle('ko-KR', unsupported);
        await expect(loader.ensureUiLanguageBundle('ko-KR')).resolves.toBe(false);
        expect(unsupported).toHaveBeenCalledTimes(1);
    });

    it.each(['http', 'invalid-resource', 'invalid-compressed'] as const)('rejects %s resources without registering them', async kind => {
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_LANGUAGE_BUNDLES__', kind === 'invalid-compressed'
            ? {'fr-FR': gzipUserscriptBuildData(Buffer.from('null')).toString('base64')} : {});
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_REMOTE_LANGUAGES__', {'fr-FR': fileName});
        vi.stubGlobal('__FLUENTREAD_USERSCRIPT_RESOURCE_COMMIT__', resourceCommit);
        const requests: string[] = [];
        globalThis.GM = {
            async getValue() {throw new Error('cache unavailable');},
            xmlHttpRequest(details) {requests.push(details.url);return Promise.resolve({status: kind === 'http' ? 503 : 200, statusText: '', responseText: 'null'});},
        };
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const core = await import('@/src/core/i18n'), loader = await import('@/userscript/uiLanguageBundles');
            await expect(loader.ensureUiLanguageBundle('fr-FR')).resolves.toBe(false);
            expect(core.hasUiLanguageBundle('fr-FR')).toBe(false);
            expect(requests).toHaveLength(kind === 'invalid-compressed' ? 0 : 2);
        } finally {warn.mockRestore();}
    });

});
