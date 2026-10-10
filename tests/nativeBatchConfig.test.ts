import {describe, expect, it} from 'vitest';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {
    DEFAULT_NATIVE_BATCH_TRANSLATION_ENABLED,
    NATIVE_BATCH_TRANSLATION_SERVICES,
    isNativeBatchTranslationService,
    isNativeTranslationBatchEnabled,
    normalizeNativeBatchTranslationEnabled,
} from '@/src/core/config/nativeBatch';
import {supportsNativeTranslationBatch} from '@/src/services/translation/capabilities';

describe('原生翻译按服务合批偏好', () => {
    it('只有五个原生协议服务支持开关，协议能力与用户关闭偏好保持独立', () => {
        expect(NATIVE_BATCH_TRANSLATION_SERVICES).toEqual([
            'google', 'microsoft', 'deepL', 'azureTranslator', 'googleCloudTranslation',
        ]);
        for (const service of NATIVE_BATCH_TRANSLATION_SERVICES) {
            expect(isNativeBatchTranslationService(service)).toBe(true);
            expect(supportsNativeTranslationBatch(service)).toBe(true);
            expect(isNativeTranslationBatchEnabled(service, {[service]: false})).toBe(false);
        }
        for (const service of ['bilibili', 'freeTranslation', 'openai', 'bing', 'custom:fixture', '']) {
            expect(isNativeBatchTranslationService(service)).toBe(false);
            expect(supportsNativeTranslationBatch(service)).toBe(false);
            expect(isNativeTranslationBatchEnabled(service, {[service]: true})).toBe(false);
        }
    });

    it('新配置与旧配置缺项默认全部开启，AI 多段开关继续默认关闭', () => {
        for (const config of [new Config(), normalizeConfig({}), normalizeConfig(null)]) {
            expect(config.nativeBatchTranslationEnabled).toEqual(DEFAULT_NATIVE_BATCH_TRANSLATION_ENABLED);
            expect(config.enableAIMultiSegment).toBe(false);
        }
        const first = new Config();
        const second = new Config();
        first.nativeBatchTranslationEnabled.google = false;
        expect(second.nativeBatchTranslationEnabled.google).toBe(true);
        expect(DEFAULT_NATIVE_BATCH_TRANSLATION_ENABLED.google).toBe(true);
    });

    it('只有自有显式 false 关闭，损坏类型、数组及继承属性不改变默认值', () => {
        const inherited = Object.create({google: false});
        const malformed = [undefined, null, false, true, 0, '', 'false', [], [false], inherited];
        for (const value of malformed) {
            expect(normalizeNativeBatchTranslationEnabled(value)).toEqual(DEFAULT_NATIVE_BATCH_TRANSLATION_ENABLED);
            expect(isNativeTranslationBatchEnabled('google', value)).toBe(true);
        }
        for (const value of [undefined, null, 0, '', 'false', [], {}]) {
            expect(normalizeConfig({nativeBatchTranslationEnabled: {google: value}}).nativeBatchTranslationEnabled.google).toBe(true);
        }
        expect(isNativeTranslationBatchEnabled('google', {google: true})).toBe(true);
        expect(isNativeTranslationBatchEnabled('google', {google: false})).toBe(false);
    });

    it('服务偏好独立，忽略不支持服务与未知字段，并保持归一化幂等和输入不可变', () => {
        const source = {google: false, microsoft: true, deepL: false, openai: false, unknown: true};
        const normalized = normalizeNativeBatchTranslationEnabled(source);
        expect(normalized).toEqual({
            google: false, microsoft: true, deepL: false, azureTranslator: true, googleCloudTranslation: true,
        });
        expect(normalizeNativeBatchTranslationEnabled(normalized)).toEqual(normalized);
        expect(normalizeConfig({nativeBatchTranslationEnabled: source}).nativeBatchTranslationEnabled).toEqual(normalized);
        normalized.microsoft = false;
        expect(source.microsoft).toBe(true);
        expect(source).toHaveProperty('openai', false);
    });
});
