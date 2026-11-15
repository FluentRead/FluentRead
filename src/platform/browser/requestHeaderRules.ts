/**
 * @file src/platform/browser/requestHeaderRules.ts
 * 文件职责：把请求头移除名单同步为浏览器 DNR 动态规则，仅影响本扩展对精确域名的 HTTP 请求。
 * 主要内容：独立规则编号段和内置供应商额外槽位、Origin/Referer remove 动作、扩展 initiator 限制、串行原子替换、成功去重和失败重试。
 * 模块边界：不读配置或选择服务；后台注入配置快照和浏览器端口，不修改宿主请求、响应头或 CORS。
 */
import type {DeclarativeNetRequest} from 'webextension-polyfill';
import {MAX_REQUEST_HEADER_RULES, normalizeRequestHeaderRules} from '@/src/core/config/requestHeaders';

export const REQUEST_HEADER_RULE_START = 2_763_000;
export type RequestHeaderRulesPort = Pick<DeclarativeNetRequest.Static, 'getDynamicRules' | 'updateDynamicRules'>;

export function createRequestHeaderRulesSynchronizer(api: RequestHeaderRulesPort | undefined, extensionDomain: string) {
    let applied: string | undefined;
    let tail: Promise<void> = Promise.resolve();
    return {
        sync(value: unknown): Promise<void> {
            const entries = normalizeRequestHeaderRules(value, MAX_REQUEST_HEADER_RULES + 1);
            const key = JSON.stringify(entries);
            const result = tail.then(async () => {
                if (applied === key) return;
                const enabled = entries.filter(entry => entry.removeOrigin || entry.removeReferer);
                if (!api) {
                    if (enabled.length) throw new Error('当前浏览器不支持网络层移除 Origin / Referer 请求头。');
                    applied = key;
                    return;
                }
                const current = await api.getDynamicRules();
                const removeRuleIds = current.filter(rule => rule.id >= REQUEST_HEADER_RULE_START
                    && rule.id < REQUEST_HEADER_RULE_START + MAX_REQUEST_HEADER_RULES + 1).map(rule => rule.id);
                const addRules: DeclarativeNetRequest.Rule[] = enabled.map((entry, index) => ({
                    id: REQUEST_HEADER_RULE_START + index,
                    priority: 2, // 用户明确移除优先于图片读取等临时来源头补充规则。
                    action: {type: 'modifyHeaders', requestHeaders: [
                        ...(entry.removeOrigin ? [{header: 'Origin', operation: 'remove' as const}] : []),
                        ...(entry.removeReferer ? [{header: 'Referer', operation: 'remove' as const}] : []),
                    ]},
                    condition: {
                        regexFilter: `^https?://${entry.domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?::[0-9]+)?/`,
                        initiatorDomains: [extensionDomain],
                        resourceTypes: ['xmlhttprequest'],
                    },
                }));
                if (removeRuleIds.length || addRules.length) await api.updateDynamicRules({removeRuleIds, addRules});
                applied = key;
            });
            tail = result.catch(() => undefined);
            return result;
        },
    };
}
