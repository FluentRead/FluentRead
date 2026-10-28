/**
 * @file src/services/translation/visionProbe.ts
 * 文件职责：结合手动设置、有效探测缓存与内置规则决定当前模型识图能力，并复用共享翻译链路探测未知模型。
 * 主要内容：冻结配置与严格测试提示词，生成随机 PNG，发送受信图片请求；缓存加载与探测共用调用者预算，取消和超时不写能力结论，只有匹配答案或明确图片输入拒绝落盘，缓存仅保存身份摘要与时间。
 * 模块边界：通过注入的翻译和存储端口执行副作用；消息名称由同层 types.ts 纯契约提供，本实现不再导出消息名称；不实现厂商协议、不读取页面图片、不改写用户配置或提示词。
 */
import {resolveAreaRecognitionRoute, resolveModelVisionCapability, supportsVisionTransport, type AreaRecognitionRouteInput} from '@/src/core/config/vision';
import {createVisionProbeIdentity, matchesVisionProbeAnswer, normalizeVisionProbeRecords, VISION_PROBE_TIMEOUT_MS,
    type VisionProbeRecord, type VisionProbeResult} from '@/src/core/config/visionProbe';
import {createVisionProbeImage} from '@/src/core/translation/visionProbeImage';
import {
    attachTranslationImageInput,
    attachTranslationProviderConfig,
    attachTranslationRequestControl,
    createTranslationProviderConfigSnapshot,
    markTranslationRemainingBudget,
} from './requestSnapshot';
import type {TranslationConfigSource, TranslationRequestMessage} from './types';

export interface VisionProbeConfig extends TranslationConfigSource {modelVision?: Record<string, Record<string, boolean>>;}
export interface VisionProbePersistence {load(): Promise<unknown>; save(records: VisionProbeRecord[]): Promise<void>;}
export interface VisionProbeOptions {force?: boolean; probeUnknown?: boolean; signal?: AbortSignal; timeoutMs?: number;}

export function freezeVisionProbeConfig(source: VisionProbeConfig): VisionProbeConfig {
    return {...createTranslationProviderConfigSnapshot(source), modelVision: Object.fromEntries(
        Object.entries(source.modelVision ?? {}).map(([service, models]) => [service, {...models}]))};
}
/** 在任何等待前冻结圈选身份，未知模型先测试，失败传播到原事务且不改用 OCR。 */
export function prepareModelVisionRoute(source: VisionProbeConfig & AreaRecognitionRouteInput,
    resolve: (config: VisionProbeConfig, service: string, model: string, options: VisionProbeOptions) => Promise<VisionProbeResult>) {
    const frozen = {...freezeVisionProbeConfig(source), areaRecognitionMode: source.areaRecognitionMode,
        areaTranslationService: source.areaTranslationService};
    const route = resolveAreaRecognitionRoute(frozen);
    return async (options: VisionProbeOptions) => {
        if (frozen.areaRecognitionMode !== 'prefer-vision') return route;
        const result = await resolve(frozen, route.service, route.model, {...options, probeUnknown: true});
        return result.capability === 'supported' ? {mode: 'vision' as const}
            : {mode: 'ocr' as const, fallback: result.capability === 'unsupported' ? 'unsupported' as const : 'unknown' as const};
    };
}

interface ActiveVisionProbe {controller: AbortController; users: number; promise: Promise<VisionProbeResult>;}

export function createModelVisionProbe(deps: {
    translate(request: TranslationRequestMessage): Promise<string | string[]>;
    storage: VisionProbePersistence;
    now?: () => number;
    random?: () => Uint8Array;
}) {
    const now = deps.now ?? Date.now;
    let records: VisionProbeRecord[] = [];
    let loaded: Promise<void> | undefined;
    let writes = Promise.resolve();
    const active = new Map<string, ActiveVisionProbe>();
    const invalidated = new Set<string>();
    const load = () => loaded ??= deps.storage.load().then(value => { records = normalizeVisionProbeRecords(value, now()); })
        .catch(error => { loaded = undefined; throw error; });
    const updateRecords = (update: (current: VisionProbeRecord[]) => VisionProbeRecord[], signal?: AbortSignal, committedIdentity?: string) => {
        const write = writes.catch(() => undefined).then(async () => {
            signal?.throwIfAborted();
            const previous = normalizeVisionProbeRecords(records.filter(item => !invalidated.has(item.identity)), now());
            const snapshot = normalizeVisionProbeRecords(update(previous), now());
            await deps.storage.save(snapshot);
            signal?.throwIfAborted();
            if (committedIdentity) invalidated.delete(committedIdentity);
            records = snapshot;
            for (const identity of invalidated) {
                if (!records.some(record => record.identity === identity)) invalidated.delete(identity);
            }
        });
        writes = write;
        return write;
    };
    const cached = (identity: string): VisionProbeResult | undefined => {
        // 强制探测启动后，等待清除落盘时也不能继续使用旧结果。
        if (invalidated.has(identity) || active.has(identity)) return undefined;
        records = normalizeVisionProbeRecords(records, now());
        const record = records.find(item => item.identity === identity);
        return record ? {capability: record.capability, source: 'probe', checkedAt: record.checkedAt} : undefined;
    };
    async function resolve(source: VisionProbeConfig, service: string, model: string, options: VisionProbeOptions = {}): Promise<VisionProbeResult> {
        options = {...options};
        options.signal?.throwIfAborted();
        const frozen = createTranslationProviderConfigSnapshot(source);
        const explicit = source.modelVision?.[service]?.[model];
        const identity = createVisionProbeIdentity(frozen, service, model);
        const rule = resolveModelVisionCapability(service, model, source.modelVision);
        if (!supportsVisionTransport(service, model)) return {capability: 'unsupported', source: 'rule'};
        if (!options.force && typeof explicit === 'boolean') return {capability: rule, source: 'override'};
        const budget = Math.min(VISION_PROBE_TIMEOUT_MS, Math.max(1, options.timeoutMs ?? VISION_PROBE_TIMEOUT_MS));
        let timer: ReturnType<typeof setTimeout>;
        let onAbort: () => void;
        const interrupted = new Promise<never>((_, reject) => {
            onAbort = () => reject(new DOMException('识图检测已取消', 'AbortError'));
            options.signal?.addEventListener('abort', onAbort, {once: true});
            timer = setTimeout(() => reject(new Error('识图检测超时，请重试')), budget);
        });
        let current: ActiveVisionProbe | undefined;
        try {
            await Promise.race([load(), interrupted]);
            options.signal?.throwIfAborted();
            if (!options.force) {
                const result = cached(identity);
                if (result) return result;
                if (rule !== 'unknown') return {capability: rule, source: 'rule'};
                if (!options.probeUnknown) return {capability: 'unknown', source: 'unknown'};
            }
            let entry = active.get(identity);
            if (!entry) {
                const controller = new AbortController();
                const promise = execute(frozen, service, model, identity, controller.signal);
                entry = {controller, users: 0, promise};
                active.set(identity, entry);
                void promise.finally(() => { if (active.get(identity)?.promise === promise) active.delete(identity); }).catch(() => undefined);
            }
            entry.users++;
            current = entry;
            return await Promise.race([current.promise, interrupted]);
        } finally {
            clearTimeout(timer!);
            options.signal?.removeEventListener('abort', onAbort!);
            if (current && --current.users === 0) {
                current.controller.abort();
                if (active.get(identity) === current) active.delete(identity);
            }
        }
    }
    async function execute(source: TranslationConfigSource, service: string, model: string, identity: string, signal: AbortSignal): Promise<VisionProbeResult> {
        if (records.some(item => item.identity === identity)) invalidated.add(identity);
        await updateRecords(current => current.filter(item => item.identity !== identity), signal);
        signal.throwIfAborted();
        const random = deps.random ? deps.random() : crypto.getRandomValues(new Uint8Array(3));
        const challenge = createVisionProbeImage(random);
        const prompt = 'Read the six hexadecimal characters visible in the image, from left to right. Reply with exactly those six characters, with no other text. If you cannot read the image, reply UNKNOWN. Do not guess.';
        const snapshot = createTranslationProviderConfigSnapshot({...source, translationMaxRetries: 0,
            system_role: {...source.system_role, [service]: 'You are an image transcription engine. Read only the supplied image.'},
            user_role: {...source.user_role, [service]: prompt},
        });
        const request = attachTranslationImageInput(attachTranslationProviderConfig(attachTranslationRequestControl(markTranslationRemainingBudget({
            origin: prompt, sourceLanguage: 'en', targetLanguage: 'zh-Hans', serviceOverride: service, modelOverride: model,
            thinkingOverride: false, enableAIContext: false, pageContext: '', context: '', glossaryIds: [], useCache: false,
            requestTimeoutMs: VISION_PROBE_TIMEOUT_MS,
        }), {signal, ownershipKey: `vision-probe:${identity}`}), snapshot), challenge.image);
        let capability: VisionProbeResult['capability'];
        try {
            const text = await deps.translate(request);
            signal.throwIfAborted();
            capability = matchesVisionProbeAnswer(text, challenge.answer) ? 'supported' : 'unknown';
        } catch (error) {
            signal.throwIfAborted();
            if (!(error && typeof error === 'object' && (error as {imageInputUnsupported?: unknown}).imageInputUnsupported === true)) throw error;
            capability = 'unsupported';
        }
        if (capability === 'unknown') return {capability, source: 'unknown'};
        const checkedAt = now();
        await updateRecords(current => [{identity, capability, checkedAt}, ...current.filter(item => item.identity !== identity)], signal, identity);
        signal.throwIfAborted();
        return {capability, source: 'probe', checkedAt};
    }
    return {resolve};
}
