/**
 * @file src/features/input-translation/content/configKey.ts
 *
 * 文件职责：定义网页输入框翻译的配置/依赖契约、连接指纹计算、启用判定、安全写回以及带超时的后台翻译请求封装。
 * 主要内容：导出 InputTranslationContentConfig、InputTranslationContentDependencies、InputTranslationContentFeature、inputBoxTranslationConfigKey、isInputBoxTranslationEnabled、setInputBoxText、INPUT_TRANSLATION_TIMEOUT_MS 与 translateInputBox。
 * 模块边界：无 UI/监听器副作用，不持有输入框翻译会话状态，供 content/index.ts 与相关测试复用。
 */

import type {ContentScriptContext} from 'wxt/utils/content-script-context';
import type {ShadowRootContentScriptUi} from 'wxt/utils/content-script-ui/shadow-root';
import {normalizeAiRequestTimeoutMs} from '@/src/core/config/aiRequestTimeout';
import {services as translationServices, servicesType} from '@/src/core/config/catalog';
import {getCompositeTranslationConfigFingerprint} from '@/src/core/config/compositeTranslation';
import {
    normalizeCustomInputBoxTranslationHotkey,
    normalizeInputBoxTranslationOutputMode,
    type InputBoxTranslationOutputMode,
} from '@/src/core/config/inputTranslation';
import {parseApiKeyRequirementKey} from '@/src/core/config/validation';
import {replaceEditableText} from './editableHost';
import {isFormControl, isInputElement} from './inputBox';

export interface InputTranslationContentConfig {
    on?: boolean;
    uiLanguage?: string;
    service?: string;
    aiRequestTimeoutMs?: number;
    inputBoxTranslationTrigger: string;
    customInputBoxTranslationHotkey?: string;
    inputBoxTranslationTarget: string;
    inputBoxTranslationOutputMode?: string;
    inputBoxTranslationInterval?: number;
    inputBoxTranslationService?: string;
    inputBoxTranslationModel?: string;
    inputBoxTranslationPrompt?: string;
    inputBoxTranslationSystemPrompt?: string;
    animations?: boolean;
}

export interface InputTranslationContentDependencies {
    context: ContentScriptContext;
    config: InputTranslationContentConfig;
    isSiteDisabled: () => boolean;
    readConfigGeneration: () => number;
    sendMessage: (message: unknown) => Promise<unknown>;
    document: Document;
    createUi: <T extends HTMLElement>(
        context: ContentScriptContext,
        options: {
            name: string;
            position: 'overlay';
            alignment: 'top-left';
            zIndex: number;
            mode: 'closed';
            inheritStyles: false;
            css: string;
            onMount: (container: HTMLElement) => T;
        },
    ) => Promise<ShadowRootContentScriptUi<T>>;
    logger: Pick<Console, 'error'>;
}

export interface InputTranslationContentFeature {
    mount: (signal: AbortSignal) => void;
    invalidate: () => void;
}

function hashConfigValue(value: unknown): string {
    const serialized = JSON.stringify(value)!;
    let hash = 2166136261;
    for (let index = 0; index < serialized.length; index += 1) {
        hash ^= serialized.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
}

/** 仅提取输入翻译实际服务（独立或继承）会读取的连接/模型配置，避免无关网页翻译设置作废请求。 */
function inputBoxTranslationConnectionKey(value: InputTranslationContentConfig): string {
    const source = value as unknown as Record<string, unknown>;
    const service = value.inputBoxTranslationService || value.service || translationServices.freeTranslation;
    const compositeFingerprint = getCompositeTranslationConfigFingerprint(value, service);
    if (compositeFingerprint) return compositeFingerprint;
    const serviceValue = (key: string): unknown => {
        const candidate = source[key];
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
            return (candidate as Record<string, unknown>)[service];
        }
        return candidate;
    };
    const customProvider = Array.isArray(source.customOpenAIProviders)
        ? source.customOpenAIProviders.find((item) => (
            item && typeof item === 'object' && (item as {id?: unknown}).id === service
        ))
        : undefined;
    const selectedRequireApiKey = Object.fromEntries(
        Object.entries((source.requireApiKey && typeof source.requireApiKey === 'object')
            ? source.requireApiKey as Record<string, unknown>
            : {}).filter(([key]) => key === service
                || key.startsWith(`${service}:`)
                || parseApiKeyRequirementKey(key)?.[0] === service),
    );
    const selected = {
        service,
        aiRequestTimeoutMs: servicesType.isAI(service) ? normalizeAiRequestTimeoutMs(value.aiRequestTimeoutMs) : undefined,
        model: serviceValue('model'),
        customModel: serviceValue('customModel'),
        serviceRegion: serviceValue('serviceRegion'),
        modelThinking: serviceValue('modelThinking'),
        requireApiKey: Object.keys(selectedRequireApiKey).length ? selectedRequireApiKey : undefined,
        proxy: serviceValue('proxy'),
        token: serviceValue('token'),
        apiKeys: serviceValue('apiKeys'),
        apiKeyRotationEnabled: serviceValue('apiKeyRotationEnabled'),
        secret: serviceValue('secret'),
        customHeaders: serviceValue('customHeaders'),
        customBody: serviceValue('customBody'),
        customProvider,
        endpoint: service === translationServices.custom ? source.custom : undefined,
        newApiUrl: service === translationServices.newapi ? source.newApiUrl : undefined,
        azureOpenaiEndpoint: service === translationServices.azureOpenai ? source.azureOpenaiEndpoint : undefined,
        deeplx: service === translationServices.deeplx ? source.deeplx : undefined,
        myMemoryEmail: service === translationServices.myMemory ? source.myMemoryEmail : undefined,
        youdaoCredentials: service === translationServices.youdao
            ? [source.youdaoAppKey, source.youdaoAppSecret]
            : undefined,
        tencentCredentials: [
            translationServices.tencent,
            translationServices.huanYuan,
            translationServices.huanYuanTranslation,
        ].includes(service)
            ? [source.tencentSecretId, source.tencentSecretKey]
            : undefined,
        deeplPlan: service === translationServices.deepL ? source.deeplApiPlan : undefined,
        freeTranslationOrder: service === translationServices.freeTranslation ? source.freeTranslationOrder : undefined,
        freeTranslationMode: service === translationServices.freeTranslation ? source.freeTranslationMode : undefined,
        minimaxPlan: service === translationServices.minimax ? source.minimaxBillingPlan : undefined,
        minimaxRegion: service === translationServices.minimax ? source.minimaxRegion : undefined,
        mimoPlan: service === translationServices.mimo ? source.mimoBillingPlan : undefined,
        mimoRegion: service === translationServices.mimo ? source.mimoRegion : undefined,
        deepseekApiType: service === translationServices.deepseek ? source.deepseekApiType : undefined,
    };
    const hasSelectedValue = Object.entries(selected).some(([key, item]) => key !== 'service' && item !== undefined);
    return hasSelectedValue ? hashConfigValue(selected) : '';
}

export function inputBoxTranslationConfigKey(value: InputTranslationContentConfig): string {
    const key = [
        value.on,
        value.inputBoxTranslationTrigger,
        value.inputBoxTranslationTarget,
        normalizeInputBoxTranslationOutputMode(value.inputBoxTranslationOutputMode),
        value.inputBoxTranslationInterval ?? 1000,
        value.inputBoxTranslationService || value.service || translationServices.freeTranslation,
        value.inputBoxTranslationModel ?? '',
        value.inputBoxTranslationPrompt ?? '',
        value.inputBoxTranslationSystemPrompt ?? '',
    ];
    const customHotkey = value.inputBoxTranslationTrigger === 'custom'
        ? normalizeCustomInputBoxTranslationHotkey(value.customInputBoxTranslationHotkey)
        : '';
    if (customHotkey) key.push(`hotkey:${customHotkey}`);
    const connectionKey = inputBoxTranslationConnectionKey(value);
    if (connectionKey) key.push(connectionKey);
    return JSON.stringify(key);
}

export function isInputBoxTranslationEnabled(
    config: Pick<InputTranslationContentConfig, 'on' | 'inputBoxTranslationTrigger' | 'customInputBoxTranslationHotkey'>,
    isSiteDisabled = false,
): boolean {
    return !isSiteDisabled
        && config.on !== false
        && config.inputBoxTranslationTrigger !== 'disabled'
        && (config.inputBoxTranslationTrigger !== 'custom'
            || Boolean(normalizeCustomInputBoxTranslationHotkey(config.customInputBoxTranslationHotkey)));
}

/**
 * 把文本写回输入目标，返回是否已写入。
 * 原生控件同步写入；编辑宿主经 editableHost.ts 的原生编辑路径异步写入，isCurrent 在真正写入前再次校验请求所有权。
 */
export async function setInputBoxText(
    element: HTMLElement,
    text: string,
    isCurrent: () => boolean = () => true,
    outputMode: InputBoxTranslationOutputMode = 'replace',
    signal?: AbortSignal,
): Promise<boolean> {
    // 写回本身也是安全边界：异步期间页面可能把普通输入框改成 password 或只读，
    // 直接调用者也不能绕过资格判定。
    if (!isInputElement(element)) return false;

    if (isFormControl(element)) {
        if (!isCurrent()) return false;
        // React/Vue 等受控输入框通过自身 tracker 观察原生 setter；直接赋值可能被宿主回滚。
        const valueSetter = Object.getOwnPropertyDescriptor(
            Object.getPrototypeOf(element),
            'value',
        )?.set;
        const value = outputMode === 'append' ? `${element.value}\n${text}`
            : outputMode === 'prepend' ? `${text}\n${element.value}` : text;
        if (outputMode !== 'replace' && element.tagName.toLowerCase() === 'input') return false;
        if (valueSetter) valueSetter.call(element, value);
        else element.value = value;
        element.dispatchEvent(new Event('input', {bubbles: true}));
        element.dispatchEvent(new Event('change', {bubbles: true}));
        return true;
    }

    // 富文本编辑器由自身模型渲染 DOM；直接改写 innerText 会被回滚或删除链接、mention 等结构。
    const value = outputMode === 'append' ? `\n${text}` : outputMode === 'prepend' ? `${text}\n` : text;
    const selectionMode = outputMode === 'append' ? 'end' : outputMode === 'prepend' ? 'start' : 'all';
    return await replaceEditableText(element, value, isCurrent, selectionMode, '', signal) === 'replaced';
}

/** 包含后台唤醒与配置水合的页面等待上限，避免消息故障让编辑器永久停留在翻译中。 */
export const INPUT_TRANSLATION_TIMEOUT_MS = 60_000;
export const INPUT_MACHINE_PROVIDER_TIMEOUT_MS = 45_000;
export const INPUT_TRANSLATION_RESPONSE_GRACE_MS = 1_000;

export async function translateInputBox(
    sendMessage: (message: unknown) => Promise<unknown>,
    text: string,
    targetLang: string,
    clientRequestId: string,
    signal: AbortSignal,
    cancelRemote: () => void,
    requestTimeoutMs: number,
    responseTimeoutMs: number,
): Promise<string> {
    const result = await new Promise<unknown>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const cleanup = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
        };
        const abort = () => { cleanup(); reject(new DOMException('输入框翻译已取消', 'AbortError')); };
        if (signal.aborted) { abort(); return; }
        signal.addEventListener('abort', abort, {once: true});
        timer = setTimeout(() => {
            cleanup();
            cancelRemote();
            reject(new DOMException('输入框翻译等待超时', 'TimeoutError'));
        }, responseTimeoutMs);
        Promise.resolve().then(() => {
            if (signal.aborted) throw new DOMException('输入框翻译已取消', 'AbortError');
            return sendMessage({type: 'inputBoxTranslation', text, targetLang, clientRequestId, requestTimeoutMs});
        }).then(resolve, reject).finally(cleanup);
    }) as {success?: boolean; translatedText?: string; error?: string} | undefined;

    if (result?.success === true && typeof result.translatedText === 'string' && result.translatedText.trim()) {
        return result.translatedText;
    }
    throw new Error(result?.error || '翻译失败');
}
