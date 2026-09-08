/**
 * @file src/providers/translation/registry.ts
 *
 * 文件职责：集中登记翻译服务标识到 provider 函数的映射，是 background 路由和连接测试查找适配器的唯一目录。
 * 主要内容：汇集传统 REST、免费翻译、Chrome Translator 与 AI SDK 服务，声明 TranslationProviderRegistry，并按 AI_SDK_SERVICE_IDS 为兼容服务绑定共享 transport。 可核对的公开符号包括 TranslationProvider、TranslationProviderRegistry、translationProviderRegistry。
 * 模块边界：本文件位于 provider 适配层，只把统一翻译请求转换为外部或浏览器服务协议；不管理页面 DOM、UI 生命周期或配置持久化，缓存、去重和超时总预算由 translation broker 统一协调。
 */

import {services} from "@/src/core/config/catalog";
import {isCustomOpenAIProviderId, LEGACY_CUSTOM_OPENAI_PROVIDER_ID} from '@/src/core/config/customOpenAI';
import {AI_SDK_SERVICE_IDS} from './ai-sdk/endpoints';
import apertium from "./apertium";
import libreTranslate from "./libretranslate";
import myMemory from "./mymemory";
import microsoft from "./microsoft";
import freeTranslation from "./free-translation";
import deepl from "./deepl";
import deeplx from "./deeplx";
import {translateWithOpenAICompatibleAiSdk} from './ai-sdk/openai-compatible';
import tongyi from "./tongyi";
import zhipu from "./zhipu";
import gemini from "./gemini";
import google from "./google";
import xiaoniu from "./xiaoniu";
import youdao from "./youdao";
import tencent from "./tencent";
import claude from "./claude";
import deepseek from "./deepseek";
import azureOpenai from "./azure-openai";
import chromeTranslator from "./chrome-translator";
import hunyuanTranslation from "./hunyuan-translation";

export type TranslationProvider = (message: any) => Promise<any>;
export type TranslationProviderRegistry = Record<string, TranslationProvider>;

const legacyServices: TranslationProviderRegistry = {
    // 机器翻译
    [services.apertium]: apertium,
    [services.libreTranslate]: libreTranslate,
    [services.myMemory]: myMemory,
    [services.microsoft]: microsoft,
    [services.freeTranslation]: freeTranslation,
    [services.deepL]: deepl,
    [services.deeplx]: deeplx,
    [services.google]: google,
    [services.xiaoniu]: xiaoniu,
    [services.youdao]: youdao,
    [services.tencent]: tencent,
    [services.chromeTranslator]: chromeTranslator,

    // 大模型翻译
    [services.tongyi]: tongyi,
    [services.zhipu]: zhipu,
    [services.gemini]: gemini,
    [services.claude]: claude,
    [services.deepseek]: deepseek,
    [services.huanYuanTranslation]: hunyuanTranslation,
};

const aiSdkServices: TranslationProviderRegistry = Object.fromEntries(
    AI_SDK_SERVICE_IDS.map((service) => [service, translateWithOpenAICompatibleAiSdk]),
);

export const translationProviderRegistry: TranslationProviderRegistry = {
    ...legacyServices,
    ...aiSdkServices,
    // Azure 在进入共享 transport 前保留自身的 endpoint/key 校验。
    [services.azureOpenai]: azureOpenai,
};

/** 动态 custom:* profile 与旧 custom 共用同一个 OpenAI-compatible transport。 */
export function getTranslationProvider(service: string): TranslationProvider | undefined {
    return translationProviderRegistry[service]
        || (isCustomOpenAIProviderId(service)
            ? translationProviderRegistry[LEGACY_CUSTOM_OPENAI_PROVIDER_ID]
            : undefined);
}
