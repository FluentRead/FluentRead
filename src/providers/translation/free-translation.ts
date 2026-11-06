/**
 * @file src/providers/translation/free-translation.ts
 * 服务启用：冻结配置中的全局关闭项不参与权重、自动候选或单路检查，原免费池选择与健康记录保留。
 * 文件职责：按冻结的用户设置编排免费翻译，并接入有界请求、取消和跨段冷却。
 * 主要内容：冻结匿名请求配置和共享预算；Safari 每次请求读取临时域授权集合，未授权候选不入池、不计健康，单服务检查同样拦截；文档合批保留完整混合池，原生候选消费有界全组、其他候选只消费首段并继续余槽，普通调用沿用原分组条件和冻结的服务合批偏好；逐槽验证术语、文档标签、语言和原文回显，图片文字的内部策略接受有效原样结果且不继续换线，保持线路健康、间隔、取消及真实字符统计；向免费池与子服务传递真实在途租约，使取消后的迟到传输继续受候选、总池和后台并发约束；单服务检查不换线，跳过多线路中已确认不支持的语言方向。
 * 模块边界：只装配已有 provider；健康状态与并发调度由 freeFallback 服务持有。
 */
import {sha256Hex} from '@/src/shared/function/sha256';
import {validateGlossaryProtectedTokens} from '@/src/core/glossary';
import {validateDocumentTranslationResult} from '@/src/services/translation/glossaryProtection';
import {translateMicrosoftTexts} from './microsoft';
import {translateGoogleText, translateGoogleOwnerTexts} from './google';
import {translateFreeWebText} from './free-web';
import {translateFreeChineseWebText} from './free-chinese-web';
import {translateExtraFreeWebText, isKnownUnsupportedApertiumDirection} from './free-extra-web';
import {translateOfficialFreeWebProvider} from './free-official-web';
import myMemory from './mymemory';
import {translateBilibiliFree} from './bilibili-free';
import {translateDoubaoWeb} from './doubao-web';
import {services} from '@/src/core/config/catalog';
import {isNativeTranslationBatchEnabled} from '@/src/core/config/nativeBatch';
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
import {abortErrorFromSignal} from '@/src/platform/http/runtime';
import {isTranslationServiceDisabled, TRANSLATION_SERVICE_DISABLED_MESSAGE} from '@/src/core/config/serviceAvailability';
import {isFreeProviderAllowed, readFreePoolAccess, requireFreeProviderAccess, type FreePoolAccess} from '@/src/platform/browser/freeProviderPermissions';
import {freeTranslationHealthStorage} from '@/src/platform/storage/freeTranslationHealthStorage';
import {createFreeFallbackRunner, UntranslatedFreeResultError, WrongLanguageFreeResultError, type FreeFallbackCandidate, type FreeFallbackLease} from '@/src/services/translation/freeFallback';
import {isClearlyWrongLanguageResponse, isLikelyUntranslatedResponse, isUnchangedTranslationResponse} from '@/src/core/translation/resultValidation';
import {hasTranslationContent} from '@/src/core/translation/result';
import {parseTranslationSlots, serializeTranslationSlots} from '@/src/core/translation/slotProtocol';
import {calculateFreeTranslationWeightSnapshot, type FreeTranslationWeightSnapshot} from '@/src/services/translation/freeWeights';
import {
    attachTranslationProviderConfig,
    attachTranslationRequestScheduler,
    createTranslationProviderConfigSnapshot,
    requireTranslationProviderConfig,
    getTranslationRequestScheduler,
    reportTranslationRoute,
    isUnchangedTranslationResultAllowed,
} from '@/src/services/translation/requestSnapshot';
import type {TranslationProviderRequest} from '@/src/services/translation/types';
import type {TranslationProviderConfigSnapshot} from '@/src/services/translation/types';
import {documentFreeAttemptCharacters, runDocumentFreeNativeCandidate, serializeDocumentFreeFirstSlot, translateDocumentFreeGroups} from './documentFreeBatch';

type FreeTranslationRequest = Omit<TranslationProviderRequest<string>, 'origin'>;
const FREE_TRANSLATION_DEADLINE = Symbol('free-translation-deadline');
const FREE_TRANSLATION_ACCESS = /* @__PURE__ */ Symbol('free-translation-access');
// 所有内部调用均先经过 prepareRequest；分组与恢复沿用必填的同一截止时间。
type FrozenRequest = FreeTranslationRequest & {readonly [FREE_TRANSLATION_DEADLINE]: number};
// 非 Safari 不创建权限快照；Safari 的唯一入口在查询成功后附加授权集合。
type PreparedRequest = FrozenRequest & {readonly [FREE_TRANSLATION_ACCESS]?: FreePoolAccess};
type FreeProviderId = typeof FREE_TRANSLATION_PROVIDERS[number]['id'];

export const FREE_TRANSLATION_BATCH_CONCURRENCY = 6;
const FREE_TRANSLATION_GROUP_MAX_SLOTS = 8;
const FREE_TRANSLATION_GROUP_MAX_CHARACTERS = 2_000;
const runFallback = createFreeFallbackRunner(FREE_TRANSLATION_BATCH_CONCURRENCY, {persistence: freeTranslationHealthStorage});
const providerTranslators: Record<FreeProviderId, (request: TranslationProviderRequest<string>, lease?: FreeFallbackLease) => Promise<unknown>> = {
    microsoft: async (request, lease) => {
        const results = await translateMicrosoftTexts([request.origin], request.sourceLanguage!, request.targetLanguage!, request.abortSignal,
            true, lease ?? getTranslationRequestScheduler(request)?.lease);
        return results[0];
    },
    google: (request, lease) => {
        const current = requireTranslationProviderConfig(request);
        // 文档逐段和已降级的槽必须保持真正单项，避免收集窗重新拼成刚被拒绝的协议批次。
        const documentSingle = import.meta.env.BROWSER !== 'userscript' && request.enableNativeBatch === false
            && (request.documentBatch === true || current.glossaryMatchContext?.context === 'document');
        return translateGoogleText(request.origin, request.sourceLanguage!, request.targetLanguage!, request.abortSignal,
            !documentSingle && isNativeTranslationBatchEnabled(services.google, current.nativeBatchTranslationEnabled), request.requestTimeoutMs,
            lease ?? getTranslationRequestScheduler(request)?.lease);
    },
    myMemory,
    bilibiliFree: translateBilibiliFree,
    doubaoWeb: translateDoubaoWeb,
    transmart: request => translateFreeWebText('transmart', request.origin, request.sourceLanguage!, request.targetLanguage!, request.abortSignal),
    yandexFree: request => translateFreeWebText('yandexFree', request.origin, request.sourceLanguage!, request.targetLanguage!, request.abortSignal),
    volcengineFree: request => translateFreeWebText('volcengineFree', request.origin, request.sourceLanguage!, request.targetLanguage!, request.abortSignal),
    youdaoFree: request => translateFreeChineseWebText('youdaoFree', request.origin, request.sourceLanguage!, request.targetLanguage!, request.abortSignal),
    icibaFree: request => translateFreeChineseWebText('icibaFree', request.origin, request.sourceLanguage!, request.targetLanguage!, request.abortSignal),
    reversoFree: request => translateExtraFreeWebText('reversoFree', request.origin, request.sourceLanguage!, request.targetLanguage!, request.abortSignal),
    apertiumFree: request => translateExtraFreeWebText('apertiumFree', request.origin, request.sourceLanguage!, request.targetLanguage!, request.abortSignal),
    alibabaFree: request => translateOfficialFreeWebProvider('alibabaFree', request),
    modernMtFree: request => translateOfficialFreeWebProvider('modernMtFree', request),
    laraFree: request => translateOfficialFreeWebProvider('laraFree', request),
    lingvanexFree: request => translateOfficialFreeWebProvider('lingvanexFree', request),
};

async function translateProviderText(id: FreeProviderId, message: TranslationProviderRequest<string>, lease?: FreeFallbackLease): Promise<unknown> {
    const request = {...message, serviceOverride: id};
    const translated = id === services.google || id === services.microsoft ? await providerTranslators[id](request, lease)
        : await providerTranslators[id](request);
    const result = validateProtectedResult(message.origin, translated, message);
    if (typeof result === 'string' && hasTranslationContent(result)
        && isUnchangedTranslationResultAllowed(message) && isUnchangedTranslationResponse(message.origin, result)) return result;
    if (typeof result === 'string' && isLikelyUntranslatedResponse(message.origin, result, message.targetLanguage!)) {
        throw new UntranslatedFreeResultError();
    }
    if (typeof result === 'string' && isClearlyWrongLanguageResponse(message.origin, result, message.targetLanguage!)) {
        throw new WrongLanguageFreeResultError();
    }
    return result;
}

/** 文本级协议不兼容只让本段换线，不暂停正常文字在同一服务上的翻译。 */
function validateProtectedResult(origin: string, result: unknown, message: TranslationProviderRequest<string>): unknown {
    try {
        const current = requireTranslationProviderConfig(message);
        validateGlossaryProtectedTokens(origin, result, current.glossaryProtectedTokens);
        return validateDocumentTranslationResult(current, origin, result, message.targetLanguage);
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
    lease?: FreeFallbackLease,
): Promise<string> {
    const packet = serializeTranslationSlots(sources);
    // 只接原生数组 transport；不把文本适配器的串行 HTTP 压进同一 attempt。
    const result = id === 'microsoft'
        ? await translateMicrosoftTexts([...sources], message.sourceLanguage!, message.targetLanguage!, message.abortSignal, true, lease)
        : await translateGoogleOwnerTexts(sources, message.sourceLanguage!, message.targetLanguage!, message.abortSignal!, lease);
    if (!Array.isArray(result) || result.length !== sources.length) throw new InvalidFreeGroupResultError();
    const translations = sources.map((source, index) => {
        const value = validateProtectedResult(source, result[index], message);
        if (typeof value !== 'string' || !value.trim()) throw new InvalidFreeGroupResultError();
        if (!isUnchangedTranslationResultAllowed(message) || !isUnchangedTranslationResponse(source, value)) {
            if (isLikelyUntranslatedResponse(source, value, message.targetLanguage!)) throw new UntranslatedFreeResultError();
            if (isClearlyWrongLanguageResponse(source, value, message.targetLanguage!)) throw new WrongLanguageFreeResultError();
        }
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
    const origin = message.origin;
    const frozen = prepareRequest(message);
    if (isTranslationServiceDisabled(requireTranslationProviderConfig(frozen).disabledTranslationServices, providerId)) throw new Error(TRANSLATION_SERVICE_DISABLED_MESSAGE);
    const prepared = import.meta.env.BROWSER === 'safari'
        ? await prepareAuthorizedRequest(frozen, [providerId], providerId) : frozen;
    return translateProviderText(providerId, {...prepared, origin});
}

function prepareRequest(message: FreeTranslationRequest): FrozenRequest {
    // provider 直调也在第一次 await 之前冻结；批量中的所有文本共享该副本与截止时间。
    if (message.abortSignal?.aborted) throw abortErrorFromSignal(message.abortSignal);
    const current = createTranslationProviderConfigSnapshot({
        ...requireTranslationProviderConfig(message),
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

async function prepareAuthorizedRequest(message: FrozenRequest, order: readonly string[], providerId?: FreeProviderId): Promise<PreparedRequest> {
    const access = await readFreePoolAccess(order, {signal: message.abortSignal, deadline: message[FREE_TRANSLATION_DEADLINE]});
    if (message.abortSignal?.aborted) throw abortErrorFromSignal(message.abortSignal);
    requireFreeProviderAccess(access, providerId);
    return {...message, [FREE_TRANSLATION_ACCESS]: access};
}

function providerIdentity(id: string, current: TranslationProviderConfigSnapshot): string {
    // 微软/谷歌 ID 唯一对应固定匿名接口；只哈希公共端点及 MyMemory 可选邮箱。
    // 已保存的 Key、代理和独立 DeepLX 地址均不能改变免费链的连接或冷却身份。
    const connection = id === services.myMemory ? [urls[id], current.myMemoryEmail] : [id];
    return `${id}:${sha256Hex(JSON.stringify(connection))}`;
}

function enabledFreeProviders(current: TranslationProviderConfigSnapshot): string[] {
    return normalizeFreeTranslationOrder(current.freeTranslationOrder)
        .filter(id => !isTranslationServiceDisabled(current.disabledTranslationServices, id));
}

/** 为设置页提供实际可用池权重；关闭项与 Safari 未授权项不入池，保留健康记录与用户配置。 */
export async function getFreeTranslationWeightSnapshot(current: TranslationProviderConfigSnapshot, now = Date.now()): Promise<FreeTranslationWeightSnapshot> {
    const enabled = enabledFreeProviders(current);
    const enabledProviderIds = import.meta.env.BROWSER === 'safari'
        ? (await readFreePoolAccess(enabled)).grantedIds : enabled;
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

function candidatesFor(text: string, message: PreparedRequest, groupSources?: readonly string[], scalarProviders?: Set<string>): {
    candidates: FreeFallbackCandidate[];
    routeByIdentity: Map<string, string>;
} {
    const current = requireTranslationProviderConfig(message);
    const routeByIdentity = new Map<string, string>();
    const enabled = enabledFreeProviders(current);
    const allowed = import.meta.env.BROWSER === 'safari'
        ? enabled.filter(id => isFreeProviderAllowed(message[FREE_TRANSLATION_ACCESS]!, id as FreeProviderId)) : enabled;
    // 单线路仍让 provider 返回准确的语言方向错误；多线路不反复消费已证实无效的候选。
    const candidates = allowed.filter(id => enabled.length === 1 || id !== 'apertiumFree'
        || !isKnownUnsupportedApertiumDirection(message.sourceLanguage!, message.targetLanguage!)).map(id => {
        const provider = FREE_TRANSLATION_PROVIDERS.find(item => item.id === id)!;
        const identity = providerIdentity(id, current);
        routeByIdentity.set(identity, id);
        return {
            identity,
            label: provider.label,
            weight: provider.defaultWeight,
            maxConcurrency: id === 'microsoft' ? 2 : 1,
            minIntervalMs: id === 'microsoft' ? 100 : id === 'myMemory' || id === 'laraFree' || id === 'lingvanexFree' || id === 'doubaoWeb' ? 1000 : 300,
            translate: (signal: AbortSignal, lease: FreeFallbackLease) => {
                let request = {...message, origin: text, abortSignal: signal};
                const schedulerContext = getTranslationRequestScheduler(message);
                if (schedulerContext) request = attachTranslationRequestScheduler(
                    request, schedulerContext.scheduler, schedulerContext.identity, lease,
                );
                if (groupSources && (provider.id === 'microsoft' || provider.id === 'google')
                    && !(import.meta.env.BROWSER !== 'userscript' && message.documentBatch === true && scalarProviders?.has(provider.id))) {
                    const translate = () => translateNativeProviderGroup(provider.id as 'microsoft' | 'google', request, groupSources, lease);
                    return import.meta.env.BROWSER !== 'userscript' && message.documentBatch === true
                        ? runDocumentFreeNativeCandidate(provider.id, signal, scalarProviders!, translate) : translate();
                }
                if (import.meta.env.BROWSER !== 'userscript' && message.documentBatch === true && groupSources) {
                    return translateProviderText(provider.id, {...request, origin: groupSources[0]!, enableNativeBatch: false}, lease).then(result => {
                        if (signal.aborted) throw abortErrorFromSignal(signal);
                        return serializeDocumentFreeFirstSlot(groupSources, result);
                    });
                }
                return translateProviderText(provider.id, request, lease);
            },
        };
    });
    return {candidates, routeByIdentity};
}

async function translatePreparedText(text: string, message: PreparedRequest, groupSources?: readonly string[], scalarProviders?: Set<string>): Promise<string> {
    const current = requireTranslationProviderConfig(message);
    const {candidates, routeByIdentity} = candidatesFor(text, message, groupSources, scalarProviders);
    const scalarBeforeAttempt = import.meta.env.BROWSER !== 'userscript' && message.documentBatch === true ? new Set(scalarProviders) : undefined;
    return runFallback(candidates, {
        signal: message.abortSignal,
        lease: getTranslationRequestScheduler(message)?.lease,
        // 每条线路的真实表现只按标识与耗时上报，供设置页比较免费服务。
        onAttempt: attempt => reportTranslationRoute(message, {
            route: routeByIdentity.get(attempt.identity)!,
            outcome: attempt.outcome,
            durationMs: attempt.durationMs,
            chars: import.meta.env.BROWSER !== 'userscript' && message.documentBatch === true && groupSources
                ? documentFreeAttemptCharacters(routeByIdentity.get(attempt.identity)!, groupSources, scalarBeforeAttempt!)
                : groupSources ? groupSources.reduce((total, source) => total + source.length, 0) : text.length,
        }),
        timeoutMs: normalizeFreeTranslationTimeoutMs(current.freeTranslationTimeoutMs),
        cooldownMs: normalizeFreeTranslationCooldownMs(current.freeTranslationCooldownMs),
        mode: normalizeFreeTranslationMode(current.freeTranslationMode),
        deadline: message[FREE_TRANSLATION_DEADLINE],
    });
}

interface FreeSlotGroup { indexes: number[]; sources: string[]; characters: number; }

/** 合批只由冻结的完整启用池决定，不用临时权限或健康过滤提升混合池。 */
function usesNativeFreeGroups(length: number, message: FrozenRequest): boolean {
    const current = requireTranslationProviderConfig(message);
    const enabled = enabledFreeProviders(current);
    return length > FREE_TRANSLATION_GROUP_MAX_SLOTS
        && enabled.every(id => (id === 'microsoft' || id === 'google')
            && isNativeTranslationBatchEnabled(id, current.nativeBatchTranslationEnabled));
}

function groupFreeSlots(texts: readonly string[]): FreeSlotGroup[] {
    const groups: FreeSlotGroup[] = [];
    texts.forEach((text, index) => {
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
    if (import.meta.env.BROWSER !== 'userscript' && message.documentBatch === true) {
        return translateDocumentFreeGroups(texts, groupFreeSlots(texts), FREE_TRANSLATION_BATCH_CONCURRENCY, message.abortSignal,
            async (sources, signal, scalarProviders) => {
                const previousFailures = scalarProviders.size;
                const translate = () => translatePreparedText(serializeTranslationSlots(sources).payload, {...message, abortSignal: signal}, sources, scalarProviders);
                try {
                    return await translate();
                } catch (error) {
                    // 本轮全池失败且新发现原生协议不兼容时，重入一次原调度器实施已记录的逐段降级。
                    // 第二轮直接传播失败，不延长预算、不绕过线路间隔，也不重跑没有新标记的 HTTP 错误。
                    if (signal.aborted || scalarProviders.size <= previousFailures
                        || Date.now() >= message[FREE_TRANSLATION_DEADLINE]) throw error;
                    return translate();
                }
            });
    }
    // 按冻结的完整启用池决定；不能借健康/方向过滤把混合池提升为原生分组池。
    const grouped = usesNativeFreeGroups(texts.length, message);
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
    // 权限查询之前冻结调用方数组；异步期间的外部修改不能改变本次段落与槽位。
    const origin = Array.isArray(message.origin) ? [...message.origin] : message.origin;
    if (typeof origin !== 'string' && !Array.isArray(origin)
        || Array.isArray(origin) && origin.some(text => typeof text !== 'string')) throw new Error('免费翻译服务仅支持文本输入');
    const frozen = prepareRequest(message);
    if (Array.isArray(origin)) {
        // 只提前返回原本没有候选工作的路径；普通小批次/混合池的逐段策略保持原样。
        if (origin.length === 0 || ((import.meta.env.BROWSER !== 'userscript' && message.documentBatch === true
            || usesNativeFreeGroups(origin.length, frozen)) && origin.every(text => !text.trim()))) return origin;
    }
    const prepared = import.meta.env.BROWSER === 'safari'
        ? await prepareAuthorizedRequest(frozen, enabledFreeProviders(requireTranslationProviderConfig(frozen))) : frozen;
    if (typeof origin === 'string') return translatePreparedText(origin, prepared);
    return translateFreeBatch(origin, prepared);
}
