/**
 * @file src/providers/translation/registry.ts
 *
 * 文件职责：集中登记翻译服务标识到 provider 函数的映射，是 background 路由和连接测试查找适配器的唯一目录。
 * 主要内容：汇集传统 REST、免费翻译、云服务厂商机器翻译、Chrome Translator 与 AI SDK 服务，复用 service 的统一强类型契约并拒绝将数组交给只支持单条的适配器，按 AI_SDK_SERVICE_IDS 为兼容服务绑定共享 transport，并为 Azure 与豆包保留各自的前置分流；ChatGPT 套餐使用独立的本机 OAuth Responses 适配器。 可核对的公开符号包括 TranslationProvider、TranslationProviderRegistry、translationProviderRegistry。
 * 模块边界：本文件位于 provider 适配层，只把统一翻译请求转换为外部或浏览器服务协议；不管理页面 DOM、UI 生命周期或配置持久化，缓存、去重和超时总预算由 translation broker 统一协调。
 */

import {services} from "@/src/core/config/catalog";
import {AI_SDK_SERVICE_IDS} from './ai-sdk/endpoints';
import myMemory from "./mymemory";
import microsoft from "./microsoft";
import freeTranslation from "./free-translation";
import bilibili from "./bilibili-free";
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
import localTranslation from "./local-translation";
import googleCloudTranslation from "./google-cloud-translation";
import azureTranslator from "./azure-translator";
import aliyunTranslation from "./aliyun-translation";
import baiduTranslation from "./baidu-translation";
import volcTranslation from "./volc-translation";
import doubao from "./doubao";
import chatgptPlan from './chatgpt-plan';

import type {TranslationProvider, TranslationProviderRegistry, TranslationProviderRequest, TranslationProviderResult} from '@/src/services/translation/types';

/** 注册单条服务时校验输入形状，避免 any 把数组静默传入只接受文本的协议。 */
function singleTextProvider(provider: TranslationProvider<TranslationProviderResult, string>): TranslationProvider<TranslationProviderResult> {
    return (message: TranslationProviderRequest) => {
        if (typeof message.origin !== 'string') return Promise.reject(new TypeError('当前翻译服务仅支持单条文本请求'));
        return provider({...message, origin: message.origin});
    };
}

const legacyServices: TranslationProviderRegistry<TranslationProviderResult> = {
    // 机器翻译
    [services.myMemory]: myMemory,
    [services.microsoft]: microsoft,
    [services.freeTranslation]: freeTranslation,
    [services.bilibili]: bilibili,
    [services.deepL]: deepl,
    [services.deeplx]: singleTextProvider(deeplx),
    [services.google]: google,
    [services.xiaoniu]: singleTextProvider(xiaoniu),
    [services.youdao]: singleTextProvider(youdao),
    [services.chromeTranslator]: singleTextProvider(chromeTranslator),

    // 云服务厂商机器翻译
    [services.tencent]: singleTextProvider(tencent),
    [services.googleCloudTranslation]: googleCloudTranslation,
    [services.azureTranslator]: azureTranslator,
    [services.aliyunTranslation]: singleTextProvider(aliyunTranslation),
    [services.baiduTranslation]: singleTextProvider(baiduTranslation),
    [services.volcTranslation]: singleTextProvider(volcTranslation),

    // 大模型翻译
    [services.tongyi]: singleTextProvider(tongyi),
    [services.zhipu]: singleTextProvider(zhipu),
    [services.gemini]: singleTextProvider(gemini),
    [services.claude]: singleTextProvider(claude),
    [services.deepseek]: singleTextProvider(deepseek),
    [services.huanYuanTranslation]: singleTextProvider(hunyuanTranslation),
    [services.localTranslation]: singleTextProvider(localTranslation),
    // ChatGPT 套餐通过独立本机 OAuth 助手使用 Responses SSE，不走 API Key transport。
    [services.chatgptPlan]: chatgptPlan,
};

const aiSdkServices: TranslationProviderRegistry<TranslationProviderResult> = Object.fromEntries(
    AI_SDK_SERVICE_IDS.map((service) => [service, translateWithOpenAICompatibleAiSdk]),
);

export const translationProviderRegistry: TranslationProviderRegistry<TranslationProviderResult> = {
    ...legacyServices,
    ...aiSdkServices,
    // Azure 在进入共享 transport 前保留自身的 endpoint/key 校验。
    [services.azureOpenai]: azureOpenai,
    // 豆包按模型分流：翻译专用模型只在 Responses API 上提供，其余模型仍走共享 transport。
    [services.doubao]: doubao,
};
