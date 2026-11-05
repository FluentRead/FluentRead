import {describe, expect, it, vi} from 'vitest';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {normalizePrivateTranslation, supportsPrivateTranslationService} from '@/src/core/config/privateTranslation';
import {resolvePrivateTranslation} from '@/src/services/translation/privateRouting';
import {attachTranslationGlossaryContext, attachTranslationProviderConfig, createTranslationProviderConfigSnapshot,
    getTranslationProviderConfig, translationPrivacyContext} from '@/src/services/translation/requestSnapshot';
import type {TranslationRequestMessage} from '@/src/services/translation/types';

function config() {
    const value = new Config();
    value.service = 'microsoft';
    value.privateTranslation = {enabled: true, service: 'openai', model: 'private-model'};
    value.customBody.openai = '';
    value.customBody.microsoft = '{"unused":true}';
    value.token.openai = 'test-private-key';
    return createTranslationProviderConfigSnapshot(value);
}
function privateRequest(): TranslationRequestMessage {
    return attachTranslationGlossaryContext({origin: 'Hello', serviceOverride: 'microsoft', modelOverride: 'normal'}, {privateContext: true});
}
describe('private translation configuration and trusted per-request routing', () => {
    it.each(['chrome', 'firefox'])('preserves the %s trusted privacy three-state contract', browser => {
        vi.stubEnv('BROWSER', browser);
        try {
            const current = config();
            const normal = attachTranslationGlossaryContext({origin: 'Hello'}, {privateContext: false});
            expect(resolvePrivateTranslation(current, normal)).toEqual({config: current, request: normal});
            expect(resolvePrivateTranslation(current, privateRequest()).request.modelOverride).toBe('private-model');
            expect(() => resolvePrivateTranslation(current, {origin: 'Hello'})).toThrow('无法确认窗口隐私身份');
        } finally {vi.unstubAllEnvs();}
    });
    it('fails closed in a userscript target even for a synthetic internal privacy symbol', () => {
        vi.stubEnv('BROWSER', 'userscript');
        try {
            const current = config();
            for (const privateContext of [undefined, false, true]) {
                const request = attachTranslationGlossaryContext({origin: 'Hello'}, {privateContext});
                expect(() => resolvePrivateTranslation(current, request)).toThrow('无法确认窗口隐私身份');
                const disabled = {...current, privateTranslation: {...current.privateTranslation!, enabled: false}};
                expect(resolvePrivateTranslation(disabled, request)).toEqual({config: disabled, request});
            }
        } finally {vi.unstubAllEnvs();}
    });
    it('defaults off, normalizes bounded values and preserves unavailable enabled choices', () => {
        expect(new Config().privateTranslation).toEqual({enabled: false, service: '', model: ''});
        for (const value of [undefined, null, false, 3, '', {}]) expect(normalizePrivateTranslation(value)).toEqual({enabled: false, service: '', model: ''});
        expect(normalizePrivateTranslation({enabled: 'true', service: false, model: 1})).toEqual({enabled: false, service: '', model: ''});
        expect(normalizePrivateTranslation({enabled: true, service: ' x ', model: ' y '})).toEqual({enabled: true, service: 'x', model: 'y'});
        expect(normalizePrivateTranslation({service: 'a'.repeat(129), model: 'b'.repeat(257)})).toMatchObject({service: '', model: ''});
        expect(normalizeConfig({...new Config(), privateTranslation: {enabled: true, service: 'deleted', model: 'old'}}).privateTranslation)
            .toEqual({enabled: true, service: 'deleted', model: 'old'});
    });
    it('accepts only configured AI connections and rejects composite or plan routes', () => {
        for (const service of ['', 'microsoft', 'freeTranslation', 'composite:test', 'chatgptPlan', 'custom:missing']) {
            expect(supportsPrivateTranslationService(service, undefined)).toBe(false);
        }
        expect(supportsPrivateTranslationService('openai', undefined)).toBe(true);
        expect(supportsPrivateTranslationService('custom:present', [{id: 'custom:present', name: 'Test', endpoint: 'https://test.invalid/v1', models: []}])).toBe(true);
        expect(supportsPrivateTranslationService('custom:missing', [])).toBe(false);
    });
    it('rejects unknown enabled identity, ignores spoofed payload and preserves explicit normal or disabled behavior', () => {
        const current = config();
        for (const request of [{origin: 'Hello', privateContext: true, incognito: true},
            attachTranslationGlossaryContext({origin: 'Hello'}, {})]) {
            expect(() => resolvePrivateTranslation(current, request)).toThrow('无法确认窗口隐私身份');
        }
        const normal = attachTranslationGlossaryContext({origin: 'Hello', privateContext: true}, {privateContext: false});
        expect(resolvePrivateTranslation(current, normal)).toEqual({config: current, request: normal});
        const request = privateRequest();
        for (const selected of [undefined, {...current.privateTranslation!, enabled: false}]) {
            const disabled = {...current, privateTranslation: selected};
            expect(resolvePrivateTranslation(disabled, request)).toEqual({config: disabled, request});
            const unknown = {origin: 'Unknown'};
            expect(resolvePrivateTranslation(disabled, unknown)).toEqual({config: disabled, request: unknown});
        }
        expect(translationPrivacyContext({sender: {tab: {incognito: 'true'}}})).toEqual({});
    });
    it('uses a distinct frozen config and overrides frozen request fields without mutating global state', () => {
        const current = config();
        const request = Object.freeze(attachTranslationProviderConfig(privateRequest(), current));
        const result = resolvePrivateTranslation(current, request);
        expect(result.request).toMatchObject({serviceOverride: 'openai', modelOverride: 'private-model'});
        expect(result.config).toMatchObject({service: 'openai', useCache: false, model: {openai: 'private-model'}, customModel: {openai: 'private-model'}, customBody: {openai: ''}, token: {openai: 'test-private-key'}});
        expect(Object.isFrozen(result.config)).toBe(true);expect(Object.isFrozen(result.config.model)).toBe(true);
        expect(current.service).toBe('microsoft');expect(current.customBody.microsoft).toContain('unused');
        expect(request.serviceOverride).toBe('microsoft');
        expect(getTranslationProviderConfig(result.request, result.config)).toBe(result.config);
    });
    it('fails closed for missing service or model without normal fallback', () => {
        for (const service of ['', 'deleted', 'microsoft', 'chatgptPlan']) {
            expect(() => resolvePrivateTranslation({...config(), privateTranslation: {enabled: true, service, model: 'x'}}, privateRequest())).toThrow('不会回退');
        }
        expect(() => resolvePrivateTranslation({...config(), privateTranslation: {enabled: true, service: 'openai', model: '  '}}, privateRequest())).toThrow('配置无痕专用翻译模型');
        expect(() => resolvePrivateTranslation({...config(), customBody: {openai: '{"temperature":0}'}}, privateRequest())).toThrow('标准请求体');
        expect(() => resolvePrivateTranslation({...config(), proxy: {openai: 'not a URL'}}, privateRequest())).toThrow('连接地址无效');
        expect(resolvePrivateTranslation({...config(), customBody: {}}, privateRequest()).config.service).toBe('openai');
    });
    it('rejects model aliases that the actual compatible transport would rewrite', () => {
        const current = config();
        expect(() => resolvePrivateTranslation({...current,
            privateTranslation: {enabled: true, service: 'openai', model: 'private（label）'},
        }, privateRequest())).toThrow('最终模型编号');
        expect(() => resolvePrivateTranslation({...current, proxy: {openai: 'https://api.xiaomimimo.com/v1/chat/completions'},
            privateTranslation: {enabled: true, service: 'openai', model: 'mimo-v2.5-pro'},
        }, privateRequest())).toThrow('最终模型编号');
        expect(resolvePrivateTranslation({...current,
            privateTranslation: {enabled: true, service: 'openai', model: 'mimo-v2.5-pro'},
        }, privateRequest()).request.modelOverride).toBe('mimo-v2.5-pro');
    });
    it('freezes private settings independently from source edits' , () => {
        const source = new Config(); source.privateTranslation = {enabled: true, service: 'openai', model: 'first'};
        const snapshot = createTranslationProviderConfigSnapshot(source);
        source.privateTranslation.model = 'later';
        expect(snapshot.privateTranslation?.model).toBe('first');expect(Object.isFrozen(snapshot.privateTranslation)).toBe(true);
    });
});
