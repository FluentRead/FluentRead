/**
 * @file src/core/config/constants.ts
 *
 * 文件职责：集中声明配置领域中跨模块复用的端点、请求方式、菜单标识、样式名和连接测试消息等稳定常量。
 * 主要内容：包含 MiniMax/MiMo 地域端点映射、服务 URL、POST/GET 常量、上下文菜单 ID 以及 getMimoEndpoint 的回退解析，避免调用方各自复制协议字面量。 可核对的公开符号包括 MINIMAX_ENDPOINTS、MIMO_ENDPOINTS、getMimoEndpoint、urls、method、CONNECTION_TEST_MESSAGE、tongyiTokenPlanUrl、constants。
 * 模块边界：本文件属于 core 领域层，只定义规则、类型与纯转换；不直接读写浏览器存储、不发起网络请求、不挂载 Vue/WXT 入口，持久化、协议调用和界面编排分别由 services、providers 与 features 承担。
 */

import { services } from "./catalog";
import type { MiniMaxBillingPlan, MiniMaxRegion, MiMoBillingPlan, MiMoRegion } from "./catalog";
import {DEFAULT_DEEPLX_ENDPOINT} from "./deeplx";

// MiniMax 的 OpenAI 兼容地址目前按区域区分；计费方案单独建模，用于
// Key/权益校验，也为未来两套方案出现不同端点保留明确的配置维度。
export const MINIMAX_ENDPOINTS: Record<MiniMaxBillingPlan, Record<MiniMaxRegion, string>> = {
    payg: {
        global: "https://api.minimax.io/v1/chat/completions",
        cn: "https://api.minimaxi.com/v1/chat/completions",
    },
    "token-plan": {
        global: "https://api.minimax.io/v1/chat/completions",
        cn: "https://api.minimaxi.com/v1/chat/completions",
    },
};

// MiMo 按量付费使用统一 API 地址；Token Plan 的 Base URL 必须使用购买页面
// 返回的集群地址，且不同集群的 Token Plan Key 不能互换。
export const MIMO_ENDPOINTS: Record<MiMoBillingPlan, Record<MiMoRegion, string>> = {
    payg: {
        cn: "https://api.xiaomimimo.com/v1/chat/completions",
        sgp: "https://api.xiaomimimo.com/v1/chat/completions",
        ams: "https://api.xiaomimimo.com/v1/chat/completions",
    },
    "token-plan": {
        cn: "https://token-plan-cn.xiaomimimo.com/v1/chat/completions",
        sgp: "https://token-plan-sgp.xiaomimimo.com/v1/chat/completions",
        ams: "https://token-plan-ams.xiaomimimo.com/v1/chat/completions",
    },
};

export function getMimoEndpoint(billingPlan: string, region: string): string {
    const plan = billingPlan === 'token-plan' ? 'token-plan' : 'payg';
    const normalizedRegion = region === 'sgp' || region === 'ams' ? region : 'cn';
    return MIMO_ENDPOINTS[plan][normalizedRegion];
}

// 常量工具类
export const urls: any = {
    [services.myMemory]: "https://api.mymemory.translated.net/get",
    [services.deepL]: "https://api-free.deepl.com/v2/translate",
    [services.deeplx]: DEFAULT_DEEPLX_ENDPOINT,
    [services.openai]: "https://api.openai.com/v1/chat/completions",
    [services.azureOpenai]: "https://your-resource-name.openai.azure.com/openai/v1/chat/completions",
    [services.moonshot]: "https://api.moonshot.cn/v1/chat/completions",
    [services.custom]: "https://localhost:11434/v1/chat/completions",
    [services.tongyi]: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    [services.zhipu]: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    [services.xiaoniu]: "https://api.niutrans.com/NiuTransServer/translationXML",
    [services.youdao]: "https://openapi.youdao.com/api",
    [services.tencent]: "https://tmt.tencentcloudapi.com/",
    [services.claude]: "https://api.anthropic.com/v1/messages",
    [services.baichuan]: "https://api.baichuan-ai.com/v1/chat/completions",
    [services.lingyi]: "https://api.lingyiwanwu.com/v1/chat/completions",
    [services.deepseek]: "https://api.deepseek.com/chat/completions",
    [services.infini]: "https://cloud.infini-ai.com/maas/v1/chat/completions",
    [services.minimax]: MINIMAX_ENDPOINTS.payg.cn,
    [services.mimo]: MIMO_ENDPOINTS.payg.cn,
    [services.jieyue]: "https://api.stepfun.com/v1/chat/completions",
    [services.yiyan]: "https://qianfan.bj.baidubce.com/v2/chat/completions",
    [services.groq]: "https://api.groq.com/openai/v1/chat/completions",
    [services.huanYuan]: "https://api.tokenhub.tencent.com/v1/chat/completions",
    [services.huanYuanTranslation]: "https://hunyuan.tencentcloudapi.com/",
    [services.doubao]: "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
    [services.siliconCloud]: "https://api.siliconflow.cn/v1/chat/completions",
    [services.openrouter]: "https://openrouter.ai/api/v1/chat/completions",
    [services.grok]: "https://api.x.ai/v1/chat/completions",
}

export const method = {POST: "POST", GET: "GET",};

export const CONNECTION_TEST_MESSAGE = 'testTranslationService' as const;

// qwen3.8 预览模型属于百炼 Token Plan，使用独立的 OpenAI 兼容端点。
export const tongyiTokenPlanUrl = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions";

export const constants = {
    // 键鼠事件
    DoubleClick: "DoubleClick",
    LongPress: "LongPress",
    MiddleClick: "MiddleClick",
    // 触屏设备事件
    TwoFinger: "TwoFinger",
    ThreeFinger: "ThreeFinger",
    FourFinger: "FourFinger",
    DoubleClickScreen: "DoubleClickScree",
    TripleClickScreen: "TripleClickScreen",
}

export const styles = {
    // 仅译文模式
    singleTranslation: 0,
    // 双语对照模式
    bilingualTranslation: 1,
}

// 右键菜单ID常量
export const CONTEXT_MENU_IDS = {
    TRANSLATE_IMAGE: 'fluent-read-translate-image',
    TRANSLATE_FULL_PAGE: 'fluent-read-translate-full-page',
}
