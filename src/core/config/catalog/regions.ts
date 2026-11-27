/**
 * @file src/core/config/catalog/regions.ts
 *
 * 文件职责：维护云服务厂商地域白名单以及 MiniMax、MiMo 的计费方案与地域集群选项和纯解析函数。
 * 主要内容：导出 cloudRegionOptions、getDefaultCloudRegion、resolveCloudRegion、minimaxBillingPlans、MiniMaxBillingPlan、minimaxRegions、MiniMaxRegion、mimoBillingPlans、MiMoBillingPlan、mimoRegions 与 MiMoRegion；未知服务或非白名单地域按安全默认契约回落。
 * 模块边界：只依赖 ./services 中的服务标识常量，不引入模型目录、提示词、语言标签或网络协议实现。
 */

import {services} from './services';

/**
 * 云服务厂商的可选地域。地域同时决定签名 scope 与请求域名，因此必须来自固定白名单，
 * 避免用户手填出一个既签不出正确签名、又把密钥发往未知主机的地址。
 */
export const cloudRegionOptions: Record<string, ReadonlyArray<{value: string; label: string}>> = {
    [services.azureTranslator]: [
        {value: "global", label: "全球（global）"},
        {value: "eastasia", label: "东亚（eastasia）"},
        {value: "southeastasia", label: "东南亚（southeastasia）"},
        {value: "japaneast", label: "日本东部（japaneast）"},
        {value: "japanwest", label: "日本西部（japanwest）"},
        {value: "koreacentral", label: "韩国中部（koreacentral）"},
        {value: "centralindia", label: "印度中部（centralindia）"},
        {value: "australiaeast", label: "澳大利亚东部（australiaeast）"},
        {value: "eastus", label: "美国东部（eastus）"},
        {value: "eastus2", label: "美国东部 2（eastus2）"},
        {value: "centralus", label: "美国中部（centralus）"},
        {value: "northcentralus", label: "美国中北部（northcentralus）"},
        {value: "southcentralus", label: "美国中南部（southcentralus）"},
        {value: "westcentralus", label: "美国中西部（westcentralus）"},
        {value: "westus", label: "美国西部（westus）"},
        {value: "westus2", label: "美国西部 2（westus2）"},
        {value: "canadacentral", label: "加拿大中部（canadacentral）"},
        {value: "brazilsouth", label: "巴西南部（brazilsouth）"},
        {value: "northeurope", label: "北欧（northeurope）"},
        {value: "westeurope", label: "西欧（westeurope）"},
        {value: "francecentral", label: "法国中部（francecentral）"},
        {value: "uksouth", label: "英国南部（uksouth）"},
        {value: "swedencentral", label: "瑞典中部（swedencentral）"},
        {value: "uaenorth", label: "阿联酋北部（uaenorth）"},
        {value: "southafricanorth", label: "南非北部（southafricanorth）"},
    ],
    [services.aliyunTranslation]: [
        {value: "cn-hangzhou", label: "华东 1 / 杭州（cn-hangzhou）"},
        {value: "ap-southeast-1", label: "新加坡（ap-southeast-1）"},
    ],
    [services.volcTranslation]: [
        {value: "cn-north-1", label: "华北 2 / 北京（cn-north-1）"},
        {value: "ap-southeast-1", label: "新加坡（ap-southeast-1）"},
    ],
    [services.huanYuan]: [
        {value: "ap-singapore", label: "新加坡 / 全球（ap-singapore）"},
        {value: "ap-guangzhou", label: "华南 / 广州（ap-guangzhou）"},
    ],
};

/** 未选择地域时使用的默认值，保证首次配置即可直接发起请求。 */
export function getDefaultCloudRegion(service: string): string {
    return Object.hasOwn(cloudRegionOptions, service) ? cloudRegionOptions[service][0].value : '';
}

/** 只接受白名单内的地域；未知值回落到默认地域。 */
export function resolveCloudRegion(service: string, region?: string): string {
    const candidate = region?.trim() || '';
    const allowed = Object.hasOwn(cloudRegionOptions, service) ? cloudRegionOptions[service] : undefined;
    if (!allowed) return '';
    return allowed.some((option) => option.value === candidate) ? candidate : getDefaultCloudRegion(service);
}

export const minimaxBillingPlans = [
    {value: "payg", label: "按量付费（API）"},
    {value: "token-plan", label: "Token Plan（套餐/积分）"},
] as const;

export type MiniMaxBillingPlan = typeof minimaxBillingPlans[number]["value"];

export const minimaxRegions = [
    {value: "cn", label: "中国版（api.minimaxi.com）"},
    {value: "global", label: "全球版（api.minimax.io）"},
] as const;

export type MiniMaxRegion = typeof minimaxRegions[number]["value"];

export const mimoBillingPlans = [
    {value: "payg", label: "按量付费（API）"},
    {value: "token-plan", label: "Token Plan（套餐/积分）"},
] as const;

export type MiMoBillingPlan = typeof mimoBillingPlans[number]["value"];

export const mimoRegions = [
    {value: "cn", label: "中国集群（token-plan-cn.xiaomimimo.com）"},
    {value: "sgp", label: "新加坡集群（token-plan-sgp.xiaomimimo.com）"},
    {value: "ams", label: "欧洲集群（token-plan-ams.xiaomimimo.com）"},
] as const;

export type MiMoRegion = typeof mimoRegions[number]["value"];
