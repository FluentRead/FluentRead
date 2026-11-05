/**
 * @file src/services/translation/requestIdentity.ts
 * 文件职责：根据已冻结的请求配置构建翻译结果缓存身份，并统一模型、实际端点与上下文资格的纯策略。
 * 主要内容：维护单条、文本槽、原生批次与 AI 多段的身份维度，按实际消费的端点、合批偏好、图片原样成功策略、术语、文档保护、提示词、上下文泄漏门禁和自动识别样本隔离缓存；仅含 emoji 的正文增加字素恢复策略，摘要沿用独立身份；通过注入端口复用既有模型和端点解析。
 * 模块边界：不读取全局配置、不发起 provider 请求、不操作缓存仓库或在途去重，也不持有取消、调度或统计状态；broker 使用本模块生成结果身份，传输和 pending 生命周期仍由 broker 负责。
 */
import type {TranslationBrokerDependencies, TranslationProviderConfigSnapshot} from './types';
import {getTranslationGlossaryTerms} from './requestSnapshot';
import {getGlossaryProtectionEntries} from './glossaryProtection';
import {supportsNativeTranslationBatch} from './capabilities';
import {isNativeTranslationBatchEnabled} from '@/src/core/config/nativeBatch';
import {services} from '@/src/core/config/catalog';
import {resolveTranslationRequestModel} from '@/src/core/config/requestModel';
import {getAliyunTranslationEndpoint} from '@/src/core/config/constants';
import {getDeepLEndpoint} from '@/src/core/config/deepl';
import {hasEmojiLiterals} from '@/src/core/translation/emojiLiterals';

export type CacheRequestMode = 'single' | 'slot-protocol' | 'inline-code-v1' | 'batch' | 'ai-multi-segment';

export interface TranslationRequestIdentityContext {
    readonly config: TranslationProviderConfigSnapshot;
    readonly service: string;
    readonly sourceLanguage: string;
    readonly targetLanguage: string;
    readonly enableAIContext: boolean;
    readonly nativeBatchEnabled: boolean;
    readonly thinking: boolean;
    /** 仅受信图片入口允许有效原样结果；普通请求缺省仍拒绝外语回显。 */
    readonly acceptUnchangedResult?: boolean;
}

type TranslationIdentityPorts = Pick<TranslationBrokerDependencies,
    'resolveConfiguredModel' | 'serviceTypes' | 'endpointResolver' | 'buildTranslationCacheKey'>;

/** 纯策略的组装只保存端口，不保存请求、配置快照或计算结果。 */
export function createTranslationIdentityPolicy(deps: TranslationIdentityPorts) {
    function getSelectedModel(
        current: TranslationProviderConfigSnapshot,
        service: string,
        modelOverride?: string,
    ): string {
        return deps.resolveConfiguredModel(
            modelOverride || current.model[service],
            modelOverride || current.customModel[service],
        );
    }

    /** 自定义请求体可以改写最终发送模型；调度身份必须与 provider payload 一致。 */
    function getEffectiveRequestModel(
        current: TranslationProviderConfigSnapshot,
        service: string,
        modelOverride?: string,
    ): string {
        return resolveTranslationRequestModel(
            current,
            service,
            modelOverride,
            deps.serviceTypes.isAiSdk,
            deps.serviceTypes.isAI,
        );
    }

    function isPromptBasedAI(
        current: TranslationProviderConfigSnapshot,
        service: string,
        modelOverride?: string,
    ): boolean {
        return deps.serviceTypes.isUseAIContext(service, getSelectedModel(current, service, modelOverride));
    }

    function isAIContextEnabled(
        execution: TranslationRequestIdentityContext,
        modelOverride?: string,
    ): boolean {
        return execution.enableAIContext && isPromptBasedAI(
            execution.config,
            execution.service,
            modelOverride,
        );
    }

    function getProviderEndpoint(current: TranslationProviderConfigSnapshot, service: string): string {
        // 这些路径固定使用匿名端点，残留代理不能分裂缓存或在途去重。
        if (service === 'freeTranslation' || service === 'myMemory' || service === 'bilibili' || service === services.chatgptPlan) return '';
        if (deps.serviceTypes.isAiSdk(service)) {
            try {
                return deps.endpointResolver.resolveOpenAICompatibleEndpoint(service, current).endpoint;
            } catch {
                // 步骤 1：配置校验负责用户可见错误；缓存 key 生成必须在设置缺失时仍可完成。
                return '';
            }
        }
        // custom、New API、MiniMax 与 MiMo 都经 AI SDK 端点解析；这里只保留仍走旧适配器的地址来源，
        // 避免同一服务出现第二套默认区域或地址补全规则。
        if (service === 'deepL') return getDeepLEndpoint(current.deeplApiPlan, current.proxy[service]);
        // 云服务按固定端点或地域访问，未消费的旧代理值不能分裂缓存与在途身份。
        if (service === services.aliyunTranslation) return getAliyunTranslationEndpoint(current.serviceRegion?.[service]);
        if (service === services.baiduTranslation || service === services.googleCloudTranslation
            || service === services.azureTranslator || service === services.volcTranslation
            || service === services.youdao) return '';
        if (current.proxy[service]) return current.proxy[service];
        if (service === 'deeplx') return current.deeplx;
        return '';
    }

    function buildCacheKey(
        execution: TranslationRequestIdentityContext,
        origin: string | string[],
        context: string,
        pageContext: string,
        mode: CacheRequestMode,
        modelOverride?: string,
        sourceLanguageDetectionText?: string,
        subtitleContext?: string,
    ): string {
        const {config: current, service, sourceLanguage, targetLanguage} = execution;
        // 公开入口已冻结本次匹配范围；普通键复用保护条目，避免两次扫描同一术语库。
        // token（包括空数组）继续按原 helper 筛选，未命中时不追加保护解析。
        const glossaryEntries = current.glossaryProtectedTokens ? undefined : getGlossaryProtectionEntries(current, origin);
        const glossaryTerms = glossaryEntries
            ? glossaryEntries.map(({source, target}) => ({source, target: target || source}))
            : getTranslationGlossaryTerms(current, origin);

        return deps.buildTranslationCacheKey({
            requestMode: mode,
            sourceText: origin,
            // 仅含 emoji 的正文采用新恢复契约；不能复用保护前已经丢失字素的结果。
            ...(hasEmojiLiterals(origin) ? {emojiLiteralProtection: {version: 1}} : {}),
            sourceLanguage,
            targetLanguage,
            service,
            ...(execution.acceptUnchangedResult ? {unchangedResultPolicy: 1} : {}),
            ...(supportsNativeTranslationBatch(service) ? {enableNativeBatch: execution.nativeBatchEnabled} : {}),
            model: getSelectedModel(current, service, modelOverride),
            ...(subtitleContext ? {subtitleContext: subtitleContext.slice(0, 1200)} : {}),
            endpoint: getProviderEndpoint(current, service),
            azureOpenaiEndpoint: service === 'azureOpenai' ? current.azureOpenaiEndpoint : undefined,
            ...(service === 'freeTranslation' ? {freeTranslationPolicy: {
                // v4 使用后台动态权重；缓存按用户模式隔离，不随每次性能观测抖动。
                version: 4,
                order: current.freeTranslationOrder,
                mode: current.freeTranslationMode,
                nativeBatch: [services.google, services.microsoft].map(id =>
                    [id, isNativeTranslationBatchEnabled(id, current.nativeBatchTranslationEnabled)]),
            }} : {}),
            // v3 将相邻自动数学字面值合为有界保护组，旧文档缓存不能绕过完整恢复契约。
            // 仅分隔文档请求；网页缓存、已保存译文和人工校订不清空。
            ...(current.glossaryMatchContext?.context === 'document' ? {documentTranslationPolicy: {version: 3}} : {}),
            customBody: current.customBody[service] || '',
            ...(current.customHeaders?.[service] ? {customHeaders: current.customHeaders[service]} : {}),
            systemRole: current.system_role[service] || '',
            userRole: current.user_role[service] || '',
            ...(glossaryTerms.length ? {glossaryTerms, glossaryProtection: {version: 1,
                entries: glossaryEntries ?? getGlossaryProtectionEntries(current, origin)}} : {}),
            deepseekApiType: current.deepseekApiType,
            modelThinking: execution.thinking,
            transportProfile: deps.serviceTypes.isAiSdk(service)
                ? deps.endpointResolver.aiSdkTransportProfile
                : undefined,
            // 步骤 1：DeepL 把标题上下文直接发送给 provider；AI adapter 通过 prompt 注入页面上下文。
            context: service === 'deepL' ? context : undefined,
            pageContext: isAIContextEnabled(execution, modelOverride) ? pageContext : undefined,
            // v2 补齐跨语种短原文异常扩写的软恢复门禁。旧上下文结果未经过此门禁，
            // 仅隔离实际携带 AI 页面上下文的正文缓存，摘要、无上下文与机器翻译身份保持稳定。
            // 新身份中的结果已经复验；缓存读取仍只拒绝确定泄漏，合法长扩写不会每次重试。
            ...(pageContext.trim() && isAIContextEnabled(execution, modelOverride)
                ? {pageContextValidationPolicy: {version: 2}}
                : {}),
            ...((service === 'chromeTranslator' || service === 'localTranslation')
                && sourceLanguage === 'auto'
                && sourceLanguageDetectionText?.trim()
                ? {sourceLanguageDetectionText}
                : {}),
        });
    }

    return {getSelectedModel, getEffectiveRequestModel, isPromptBasedAI, isAIContextEnabled,
        getProviderEndpoint, buildCacheKey};
}
