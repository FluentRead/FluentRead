/**
 * @file src/providers/translation/free-translation.ts
 * 文件职责：按冻结的用户设置编排免费翻译，并接入有界请求、取消和跨段冷却。
 * 主要内容：装配免密钥服务、冻结匿名请求配置与批量预算，生成匿名连接身份；仅为全部启用微软/谷歌的高槽批次构造 owner 内有界小组，混合或非原生池保留逐槽 attempt；复用原槽协议及原生数组传输，逐槽验证质量、在候选获胜前检查术语标记并对损坏标记局部换线、保留空白；在多线路请求中跳过 Apertium 已确认不支持的语言方向，为连接检查提供不换线的单服务调用，统一拒绝原文回显和错语种，把翻译线路的结果与耗时上报给调用方观察器。
 * 模块边界：只装配已有 provider；健康状态与并发调度由 freeFallback 服务持有。
 */
import {sha256Hex} from '@/src/shared/function/sha256';
import {validateGlossaryProtectedTokens} from '@/src/core/glossary';
import {translateMicrosoftTexts} from './microsoft';
import {translateGoogleText, translateGoogleOwnerTexts} from './google';
import {translateFreeWebText} from './free-web';
import {translateFreeChineseWebText} from './free-chinese-web';
import {translateExtraFreeWebText, isKnownUnsupportedApertiumDirection} from './free-extra-web';
import {translateOfficialFreeWebProvider} from './free-official-web';
import myMemory from './mymemory';
import {translateBilibiliFree} from './bilibili-free';
import {services} from '@/src/core/config/catalog';
import {urls} from '@/src/core/config/constants';
import {DEFAULT_DEEPLX_ENDPOINT} from '@/src/core/config/deeplx';
import {
    FREE_TRANSLATION_PROVIDERS,
    FREE_TRANSLATION_TOTAL_TIMEOUT_MS,
    isFreeTranslationProviderId,
    normalizeFreeTranslationOrder,
    normalizeFreeTranslationTimeoutMs,
    normalizeFreeTranslationCooldownMs,
    normalizeFreeTranslationMode,
} from '@/src/core/config/freeTranslation';
import {config} from '@/src/services/config/store';
import {abortErrorFromSignal} from '@/src/platform/http/runtime';
import {freeTranslationHealthStorage} from '@/src/platform/storage/freeTranslationHealthStorage';
import {createFreeFallbackRunner, UntranslatedFreeResultError, WrongLanguageFreeResultError, type FreeFallbackCandidate} from '@/src/services/translation/freeFallback';
import {isClearlyWrongLanguageResponse, isLikelyUntranslatedResponse} from '@/src/core/translation/resultValidation';
import {parseTranslationSlots, serializeTranslationSlots} from '@/src/core/translation/slotProtocol';
import {calculateFreeTranslationWeightSnapshot, type FreeTranslationWeightSnapshot} from '@/src/services/translation/freeWeights';
import {
    attachTranslationProviderConfig,
    createTranslationProviderConfigSnapshot,
    getTranslationProviderConfig,
    reportTranslationRoute,
    type TranslationProviderRequest,
} from '@/src/services/translation/requestSnapshot';
import type {TranslationProviderConfigSnapshot} from '@/src/services/translation/types';

type FreeTranslationRequest = Omit<TranslationProviderRequest<string>, 'origin'>;
const FREE_TRANSLATION_DEADLINE = Symbol('free-translation-deadline');
type PreparedRequest = FreeTranslationRequest & {readonly [FREE_TRANSLATION_DEADLINE]?: number};
type FreeProviderId = typeof FREE_TRANSLATION_PROVIDERS[number]['id'];

export const FREE_TRANSLATION_BATCH_CONCURRENCY = 6;
const FREE_TRANSLATION_GROUP_MAX_SLOTS = 8;
const FREE_TRANSLATION_GROUP_MAX_CHARACTERS = 2_000;
const runFallback = createFreeFallbackRunner(FREE_TRANSLATION_BATCH_CONCURRENCY, {persistence: freeTranslationHealthStorage});
const providerTranslators: Record<FreeProviderId, (request: TranslationProviderRequest<string>) => Promise<unknown>> = {
    microsoft: async request => {
        const results = await translateMicrosoftTexts([request.origin], request.sourceLanguage!, request.targetLanguage!, request.abortSignal);
        return results[0];
    },
    google: request => translateGoogleText(request.origin, request.sourceLanguage!, request.targetLanguage!, request.abortSignal),
    myMemory,
    bilibiliFree: translateBilibiliFree,
    transmart: request => translateFreeWebText('transmart', request.origin, request.sourceLanguage!, request.targetLanguage!, request.abortSignal),
    yandexFree: request => translateFreeWebText('yandexFree', request.origin, request.sourceLanguage!, request.targetLanguage!, request.abortSignal),
    volcengineFree: request => translateFreeWebText('volcengineFree', request.origin, request.sourceLanguage!, request.targetLanguage!, request.abortSignal),
    youdaoFree: request => translateFreeChineseWebText('youdaoFree', request.origin, request.sourceLanguage!, request.targetLanguage!, request.abortSignal),
    icibaFree: request => translateFreeChineseWebText('icibaFree', request.origin, request.sourceLanguage!, request.targetLanguage!, request.abortSignal),
    sogouFree: request => translateExtraFreeWebText('sogouFree', request.origin, request.sourceLanguage!, request.targetLanguage!, request.abortSignal),
    reversoFree: request => translateExtraFreeWebText('reversoFree', request.origin, request.sourceLanguage!, request.targetLanguage!, request.abortSignal),
    apertiumFree: request => translateExtraFreeWebText('apertiumFree', request.origin, request.sourceLanguage!, request.targetLanguage!, request.abortSignal),
    alibabaFree: request => translateOfficialFreeWebProvider('alibabaFree', request),
    modernMtFree: request => translateOfficialFreeWebProvider('modernMtFree', request),
    laraFree: request => translateOfficialFreeWebProvider('laraFree', request),
    lingvanexFree: request => translateOfficialFreeWebProvider('lingvanexFree', request),
};

async function translateProviderText(id: FreeProviderId, message: TranslationProviderRequest<string>): Promise<unknown> {
    const result = await providerTranslators[id]({...message, serviceOverride: id});
    validateProtectedResult(message.origin, result, message);
    if (typeof result === 'string' && isLikelyUntranslatedResponse(message.origin, result, message.targetLanguage!)) {
        throw new UntranslatedFreeResultError();
    }
    if (typeof result === 'string' && isClearlyWrongLanguageResponse(message.origin, result, message.targetLanguage!)) {
        throw new WrongLanguageFreeResultError();
    }
    return result;
}

/** 文本级协议不兼容只让本段换线，不暂停正常文字在同一服务上的翻译。 */
function validateProtectedResult(origin: string, result: unknown, message: TranslationProviderRequest<string>): void {
    try {
        validateGlossaryProtectedTokens(origin, result, getTranslationProviderConfig(message, config).glossaryProtectedTokens);
    } catch (error) {
        throw Object.assign(error as Error, {freeFailure: 'request'});
    }
}

/** 格式只属于本组，不因单槽空值、错位或类型异常暂停其他文本的正常线路。 */
class InvalidFreeGroupResultError extends Error {
    readonly freeFailure = 'request';
    constructor() { super('免费翻译分组返回格式或译文数量异常'); }
}

async function translateNativeProviderGroup(
    id: 'microsoft' | 'google', message: TranslationProviderRequest<string>, sources: readonly string[],
): Promise<string> {
    const packet = serializeTranslationSlots(sources);
    // 只接原生数组 transport；不把文本适配器的串行 HTTP 压进同一 attempt。
    const result = id === 'microsoft'
        ? await translateMicrosoftTexts([...sources], message.sourceLanguage!, message.targetLanguage!, message.abortSignal)
        : await translateGoogleOwnerTexts(sources, message.sourceLanguage!, message.targetLanguage!, message.abortSignal!);
    if (!Array.isArray(result) || result.length !== sources.length) throw new InvalidFreeGroupResultError();
    const translations = sources.map((source, index) => {
        const value: unknown = result[index];
        if (typeof value !== 'string' || !value.trim()) throw new InvalidFreeGroupResultError();
        validateProtectedResult(source, value, message);
        if (isLikelyUntranslatedResponse(source, value, message.targetLanguage!)) throw new UntranslatedFreeResultError();
        if (isClearlyWrongLanguageResponse(source, value, message.targetLanguage!)) throw new WrongLanguageFreeResultError();
        // provider 的边缘空白不能吞掉源槽缩进；纯空白槽已在 owner 本地保留。
        const content = source.trim();
        const prefix = source.slice(0, source.indexOf(content));
        const suffix = source.slice(prefix.length + content.length);
        return prefix + value.trim() + suffix;
    });
    const nonce = packet.starts[0]!.slice('___FLUENTREAD_'.length, -'_0_BEGIN___'.length);
    const translatedPacket = serializeTranslationSlots(translations, nonce).payload;
    // 返回值仍使用同一槽协议；译文夹带本包标记时须在 candidate 内拒绝，才能按原池换线。
    if (!parseTranslationSlots(packet, translatedPacket)) throw new InvalidFreeGroupResultError();
    return translatedPacket;
}

/** 逐服务检查复用免费池的匿名配置和结果验证，不受启用列表、冷却或自动换线影响。 */
export async function translateFreeTranslationProvider(providerId: string, message: TranslationProviderRequest<string>): Promise<unknown> {
    if (!isFreeTranslationProviderId(providerId)) throw new Error('无效的免费翻译服务');
    return translateProviderText(providerId, {...prepareRequest(message), origin: message.origin});
}

function prepareRequest(message: FreeTranslationRequest): PreparedRequest {
    // provider 直调也在第一次 await 之前冻结；批量中的所有文本共享该副本与截止时间。
    const current = createTranslationProviderConfigSnapshot({
        ...getTranslationProviderConfig(message, config),
        // 免费链仅使用匿名公共服务，不能沿用独立 provider 已保存的 Key 或代理。
        // 独立服务的凭据和代理不进入免费池，DeepLX 只保留独立服务用途。
        token: {},
        secret: {},
        customHeaders: {},
        proxy: {},
        requireApiKey: {},
        youdaoAppKey: '',
        youdaoAppSecret: '',
        tencentSecretId: '',
        tencentSecretKey: '',
        deeplx: DEFAULT_DEEPLX_ENDPOINT,
    });
    const budget = message.requestTimeoutMs;
    return attachTranslationProviderConfig({
        ...message,
        sourceLanguage: message.sourceLanguage || current.from,
        targetLanguage: message.targetLanguage || current.to,
        [FREE_TRANSLATION_DEADLINE]: typeof budget === 'number' && Number.isFinite(budget)
            ? Date.now() + Math.min(FREE_TRANSLATION_TOTAL_TIMEOUT_MS, Math.max(0, budget))
            : Date.now() + FREE_TRANSLATION_TOTAL_TIMEOUT_MS,
    }, current);
}

function providerIdentity(id: string, current: TranslationProviderConfigSnapshot): string {
    // 微软/谷歌 ID 唯一对应固定匿名接口；只哈希公共端点及 MyMemory 可选邮箱。
    // 已保存的 Key、代理和独立 DeepLX 地址均不能改变免费链的连接或冷却身份。
    const connection = id === services.myMemory ? [urls[id], current.myMemoryEmail] : [id];
    return `${id}:${sha256Hex(JSON.stringify(connection))}`;
}

/** 为设置页提供当前免费服务权重；只暴露服务 ID 与健康状态，不暴露连接身份哈希。 */
export async function getFreeTranslationWeightSnapshot(now = Date.now()): Promise<FreeTranslationWeightSnapshot> {
    const current = getTranslationProviderConfig(undefined, config);
    const enabledProviderIds = normalizeFreeTranslationOrder(current.freeTranslationOrder);
    const healthByIdentity = new Map((await runFallback.getHealthSnapshot()).map(entry => [entry.identity, entry]));
    const health = enabledProviderIds.flatMap(providerId => {
        const entry = healthByIdentity.get(providerIdentity(providerId, current));
        return entry ? [{
            providerId,
            retryAt: entry.retryAt,
            failures: entry.failures,
            category: entry.category,
            ...(entry.performance ? {performance: {...entry.performance}} : {}),
        }] : [];
    });
    return calculateFreeTranslationWeightSnapshot(enabledProviderIds, health, now);
}

function candidatesFor(text: string, message: PreparedRequest, groupSources?: readonly string[]): {
    candidates: FreeFallbackCandidate[];
    routeByIdentity: Map<string, string>;
} {
    const current = getTranslationProviderConfig(message, config);
    const routeByIdentity = new Map<string, string>();
    const enabled = normalizeFreeTranslationOrder(current.freeTranslationOrder);
    // 单线路仍让 provider 返回准确的语言方向错误；多线路不反复消费已证实无效的候选。
    const candidates = enabled.filter(id => enabled.length === 1 || id !== 'apertiumFree'
        || !isKnownUnsupportedApertiumDirection(message.sourceLanguage!, message.targetLanguage!)).map(id => {
        const provider = FREE_TRANSLATION_PROVIDERS.find(item => item.id === id)!;
        const identity = providerIdentity(id, current);
        routeByIdentity.set(identity, id);
        return {
            identity,
            label: provider.label,
            weight: provider.defaultWeight,
            maxConcurrency: id === 'microsoft' ? 2 : 1,
            minIntervalMs: id === 'microsoft' ? 100 : id === 'myMemory' || id === 'laraFree' || id === 'lingvanexFree' ? 1000 : 300,
            translate: (signal: AbortSignal) => groupSources && (provider.id === 'microsoft' || provider.id === 'google')
                ? translateNativeProviderGroup(provider.id, {...message, origin: text, abortSignal: signal}, groupSources)
                : translateProviderText(provider.id, {...message, origin: text, abortSignal: signal}),
        };
    });
    return {candidates, routeByIdentity};
}

async function translatePreparedText(text: string, message: PreparedRequest, groupSources?: readonly string[]): Promise<string> {
    if (typeof text !== 'string') throw new Error('免费翻译服务仅支持文本输入');
    const current = getTranslationProviderConfig(message, config);
    const {candidates, routeByIdentity} = candidatesFor(text, message, groupSources);
    return runFallback(candidates, {
        signal: message.abortSignal,
        // 每条线路的真实表现只按标识与耗时上报，供设置页比较免费服务。
        onAttempt: attempt => reportTranslationRoute(message, {
            route: routeByIdentity.get(attempt.identity)!,
            outcome: attempt.outcome,
            durationMs: attempt.durationMs,
            chars: groupSources ? groupSources.reduce((total, source) => total + source.length, 0) : text.length,
        }),
        timeoutMs: normalizeFreeTranslationTimeoutMs(current.freeTranslationTimeoutMs),
        cooldownMs: normalizeFreeTranslationCooldownMs(current.freeTranslationCooldownMs),
        mode: normalizeFreeTranslationMode(current.freeTranslationMode),
        deadline: message[FREE_TRANSLATION_DEADLINE],
    });
}

interface FreeSlotGroup { indexes: number[]; sources: string[]; characters: number; }

function groupFreeSlots(texts: readonly string[]): FreeSlotGroup[] {
    const groups: FreeSlotGroup[] = [];
    texts.forEach((text, index) => {
        if (typeof text !== 'string') throw new Error('免费翻译服务仅支持文本输入');
        if (!text.trim()) return;
        // 按最坏 HTML 实体长度计量，含已有 Google <pre> 的固定成本，不另造协议包装。
        const characters = text.replace(/[&<>"']/gu, '&quot;').length + 11;
        let group = groups[groups.length - 1];
        if (!group || group.sources.length >= FREE_TRANSLATION_GROUP_MAX_SLOTS
            || group.characters + characters > FREE_TRANSLATION_GROUP_MAX_CHARACTERS) {
            group = {indexes: [], sources: [], characters: 0};
            groups.push(group);
        }
        group.indexes.push(index);
        group.sources.push(text);
        group.characters += characters;
    });
    return groups;
}

async function translateFreeBatch(texts: string[], message: PreparedRequest): Promise<string[]> {
    if (message.abortSignal?.aborted) throw abortErrorFromSignal(message.abortSignal);
    const enabled = normalizeFreeTranslationOrder(getTranslationProviderConfig(message, config).freeTranslationOrder);
    // 按冻结的完整启用池决定；不能借健康/方向过滤把混合池提升为原生分组池。
    const grouped = texts.length > FREE_TRANSLATION_GROUP_MAX_SLOTS
        && enabled.every(id => id === 'microsoft' || id === 'google');
    const translations = [...texts];
    const groups = grouped ? groupFreeSlots(texts)
        : texts.map((source, index) => ({indexes: [index], sources: [source], characters: 0}));
    const batchController = new AbortController();
    const onCallerAbort = () => batchController.abort(message.abortSignal?.reason);
    // 上面的入口检查与这里之间没有异步边界，已取消请求在入口拒绝。
    message.abortSignal?.addEventListener('abort', onCallerAbort, {once: true});
    const batchMessage = {...message, abortSignal: batchController.signal};
    let nextIndex = 0;
    let stopped = false;

    const worker = async () => {
        while (!stopped) {
            if (batchController.signal.aborted) throw abortErrorFromSignal(batchController.signal);
            const index = nextIndex++;
            if (index >= groups.length) return;
            const group = groups[index]!;
            try {
                if (grouped) {
                    const packet = serializeTranslationSlots(group.sources);
                    const translated = await translatePreparedText(packet.payload, batchMessage, group.sources);
                    // 每个 candidate 已严格验证同一 packet；这里仅按原始索引回填。
                    const values = parseTranslationSlots(packet, translated)!;
                    group.indexes.forEach((slot, ordinal) => { translations[slot] = values[ordinal]!; });
                } else {
                    translations[group.indexes[0]!] = await translatePreparedText(group.sources[0]!, batchMessage);
                }
            } catch (error) {
                stopped = true;
                if (!batchController.signal.aborted) batchController.abort(error);
                throw error;
            }
        }
    };
    try {
        await Promise.all(Array.from({length: Math.min(FREE_TRANSLATION_BATCH_CONCURRENCY, groups.length)}, () => worker()));
        return translations;
    } finally {
        message.abortSignal?.removeEventListener('abort', onCallerAbort);
    }
}

export default async function freeTranslation(message: TranslationProviderRequest) {
    const prepared = prepareRequest(message);
    if (typeof message.origin === 'string') return translatePreparedText(message.origin, prepared);
    if (Array.isArray(message.origin)) return translateFreeBatch([...message.origin], prepared);
    throw new Error('免费翻译服务仅支持文本输入');
}
