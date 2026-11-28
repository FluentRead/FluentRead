import {Config, normalizeConfig} from '@/src/core/config/model';
import {getApiKeyRequirementKey} from '@/src/core/config/validation';
import {customModelString, defaultModels, models, services, servicesType} from '@/src/core/config/catalog';
import {isCustomOpenAIProviderId} from '@/src/core/config/customOpenAI';
import {getStoredValue, setStoredValue} from './storage';
import {initializeUserscriptCount} from './count';

const CONFIG_STORAGE_KEY = 'local:config';

const legacyServiceMap: Record<string, string> = {
    microsoft: services.microsoft,
    deepL: services.deepL,
    openai: services.openai,
    gemini: services.gemini,
    yiyan: services.yiyan,
    tongyi: services.tongyi,
    zhipu: services.zhipu,
    moonshot: services.moonshot,
    ollama: services.custom,
};

const legacyDefaultModels: Record<string, ReadonlySet<string>> = {
    openai: new Set(['gpt-3.5-turbo']),
    gemini: new Set(['gemini-pro']),
    yiyan: new Set(['completions']),
    tongyi: new Set(['qwen-turbo']),
    zhipu: new Set(['glm-3-turbo']),
    moonshot: new Set(['moonshot-v1-8', 'moonshot-v1-8k']),
};

const supportedUserscriptServices = new Set([
    ...servicesType.machine,
    ...servicesType.AI,
]);
supportedUserscriptServices.delete(services.chromeTranslator);
supportedUserscriptServices.delete(services.chatgptPlan);

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

export function isUserscriptServiceSupported(service: unknown): service is string {
    return typeof service === 'string'
        && service !== services.chromeTranslator
        && service !== services.chatgptPlan
        && (supportedUserscriptServices.has(service) || isCustomOpenAIProviderId(service));
}

/** 即使已有 GM 配置启用了扩展专属能力，userscript 启动时也要强制关闭这些能力。 */
export function normalizeUserscriptConfig(value: unknown): Config {
    const rawService = isRecord(value) ? value.service : undefined;
    const rawVideoService = isRecord(value) ? value.videoService : undefined;
    const rawInputBoxTranslationService = isRecord(value) ? value.inputBoxTranslationService : undefined;
    const normalizedInput = isRecord(value)
        ? {...value, videoTranslationEnabled: false, videoSubtitleModeHotkeyEnabled: false}
        : value;
    const next = normalizeConfig(normalizedInput);
    if (typeof rawService === 'string' && !isUserscriptServiceSupported(rawService)) {
        next.service = services.microsoft;
    } else if (!isUserscriptServiceSupported(next.service)) {
        next.service = services.microsoft;
    }
    if (typeof rawVideoService === 'string' && !isUserscriptServiceSupported(rawVideoService)) {
        next.videoService = services.microsoft;
    } else if (!isUserscriptServiceSupported(next.videoService)) {
        next.videoService = services.microsoft;
    }
    if (typeof rawInputBoxTranslationService === 'string' && !isUserscriptServiceSupported(rawInputBoxTranslationService)) {
        next.inputBoxTranslationService = services.microsoft;
    } else if (!isUserscriptServiceSupported(next.inputBoxTranslationService)) {
        next.inputBoxTranslationService = services.microsoft;
    }
    next.contextMenuEnabled = false;
    next.selectionAreaEnabled = false;
    next.disableImageTranslator = true;
    next.videoTranslationEnabled = false;
    next.videoSubtitleModeHotkeyEnabled = false;
    next.maxConcurrentTranslations = Math.min(20, Math.max(1, Number(next.maxConcurrentTranslations) || 6));
    return next;
}

function comparableStoredConfig(value: unknown): unknown {
    if (!isRecord(value)) return value;
    const comparable = {...value};
    delete comparable.__fluentConfigRevision;
    delete comparable.__fluentCountOperations;
    return comparable;
}

function migrateLegacyModel(next: Config, legacyName: string, service: string, selectedModel: string): void {
    if (legacyName === 'ollama') {
        const knownModels = models.get(service) || [];
        if (knownModels.includes(selectedModel) && selectedModel !== customModelString) {
            next.model[service] = selectedModel;
        } else {
            next.model[service] = customModelString;
            next.customModel[service] = selectedModel;
        }
        return;
    }

    const defaultModel = defaultModels.get(service);
    next.model[service] = defaultModel && legacyDefaultModels[legacyName]?.has(selectedModel)
        ? defaultModel
        : selectedModel;
}

function preserveLegacyYiyanCredentials(next: Config, value: unknown): void {
    if (!isRecord(value)) return;
    const accessToken = nonEmptyString(value.token);
    const ak = nonEmptyString(value.ak);
    const sk = nonEmptyString(value.sk);
    if (accessToken) next.token[services.yiyan] = accessToken;
    if (ak) next.ak = ak;
    if (sk) next.sk = sk;
}

function allowLegacyOllamaWithoutApiKey(next: Config): void {
    next.requireApiKey[getApiKeyRequirementKey(services.custom, next)] = false;
}

/**
 * 把 2024 版 userscript 的分散键迁移为当前统一配置，同时保留可识别的模型、凭据与模板。
 * 迁移只在统一配置不存在时执行，旧键不会在每次启动时反复覆盖用户的新设置。
 */
async function migrateLegacyConfig(): Promise<Config> {
    const next = new Config();
    next.disableFloatingBall = false;
    next.contextMenuEnabled = false;
    next.disableImageTranslator = true;
    next.selectionAreaEnabled = false;
    next.videoTranslationEnabled = false;
    next.videoSubtitleModeHotkeyEnabled = false;

    const legacyService = String(await getStoredValue('model') || '');
    if (legacyService) next.service = legacyServiceMap[legacyService] || services.microsoft;
    const from = await getStoredValue<string>('from');
    const to = await getStoredValue<string>('to');
    const hotkey = await getStoredValue<string>('hotkey');
    if (from) next.from = from;
    if (to) next.to = to;
    if (hotkey) next.hotkey = hotkey;

    for (const [legacyName, service] of Object.entries(legacyServiceMap)) {
        const selectedModel = await getStoredValue<string>(`model_${legacyName}`);
        if (selectedModel) migrateLegacyModel(next, legacyName, service, selectedModel);
        const token = await getStoredValue<unknown>(`token_${legacyName}`);
        if (typeof token === 'string' && token) next.token[service] = token;
        if (legacyName === 'yiyan') preserveLegacyYiyanCredentials(next, token);
        if (legacyName === 'zhipu' && token && typeof token === 'object') {
            const apiKey = (token as {apikey?: unknown}).apikey;
            if (typeof apiKey === 'string') next.token[service] = apiKey;
        }
    }

    const systemRole = await getStoredValue<string>('systemMsg');
    const userRole = await getStoredValue<string>('userMsg');
    const legacyAiServices = new Set(Object.values(legacyServiceMap).filter(service => servicesType.isAI(service)));
    legacyAiServices.forEach((service) => {
        if (systemRole) next.system_role[service] = systemRole;
        if (userRole) next.user_role[service] = userRole;
    });

    const legacyOpenAiUrl = await getStoredValue<string>('openai_url');
    if (legacyOpenAiUrl && legacyOpenAiUrl !== 'https://api.openai.com/v1/chat/completions') {
        next.proxy[services.openai] = legacyOpenAiUrl;
    }
    const legacyOllamaUrl = await getStoredValue<string>('ollama_url');
    if (legacyOllamaUrl) next.custom = legacyOllamaUrl;
    if (legacyOllamaUrl || await getStoredValue<string>('model_ollama')) {
        const ollamaModel = next.model[services.custom] === customModelString
            ? next.customModel[services.custom]
            : next.model[services.custom];
        next.customOpenAIProviders = [{
            id: services.custom,
            name: '自定义接口',
            endpoint: legacyOllamaUrl || next.custom,
            models: ollamaModel ? [ollamaModel] : [],
        }];
        allowLegacyOllamaWithoutApiKey(next);
    }

    return normalizeUserscriptConfig(next);
}

/** 首次运行时写入或迁移配置；之后每次启动仍重新收紧 userscript 能力边界。 */
export async function ensureUserscriptConfig(): Promise<void> {
    const existing = await getStoredValue(CONFIG_STORAGE_KEY);
    let safe: Config;
    if (existing === null || existing === undefined) {
        safe = await migrateLegacyConfig();
    } else {
        safe = normalizeUserscriptConfig(existing);
    }

    // G-counter 才是 userscript 的计数事实来源；启动时修复可能被旧标签回写的显示投影。
    const authoritativeCount = await initializeUserscriptCount(safe.count);
    safe.count = authoritativeCount;

    // 迁移、能力收紧与计数恢复合并成一次最终写入，配置 store 只会在这一步
    // 成功后开始水合，不能捕获并回写中间快照。
    if (existing === null
        || existing === undefined
        || JSON.stringify(comparableStoredConfig(existing)) !== JSON.stringify(safe)) {
        await setStoredValue(CONFIG_STORAGE_KEY, safe);
    }
}
