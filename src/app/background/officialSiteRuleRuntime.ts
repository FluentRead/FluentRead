/**
 * @file src/app/background/officialSiteRuleRuntime.ts
 * 文件职责：把浏览器消息、规则缓存存储及维护闹钟接入官方规则更新。
 * 主要内容：同一后台实例共享更新服务，允许扩展读取已验证发布并安排周期检查。
 * 模块边界：只装配浏览器 API；数据下载、大小限制、验签和版本判断由领域与服务模块负责。
 */
import {
    OFFICIAL_SITE_RULE_READ_MESSAGE, OFFICIAL_SITE_RULE_REFRESH_MESSAGE,
    officialSiteRulePublicKey, officialSiteRuleUpdatesEnabled,
} from '@/src/services/site-adaptation/officialClient';
import {createOfficialSiteRuleUpdates} from '@/src/services/site-adaptation/officialUpdates';
import type {BackgroundMessageHandler} from '@/src/services/messaging/backgroundRouter';
import type {ConfigPersistenceContext} from './handlers/configPersistence';
import {isTrustedSettingsSender} from './handlers/trustedSettingsSender';

const CACHE_KEY = 'fluentread:official-site-rule-release-v1';
const ALARM = 'fluentread-official-site-rule-refresh';
let updates: ReturnType<typeof createOfficialSiteRuleUpdates> | undefined;

function ruleUpdates(): ReturnType<typeof createOfficialSiteRuleUpdates> {
    return updates ??= createOfficialSiteRuleUpdates({
        trustedPublicKey: officialSiteRulePublicKey,
        extensionVersion: browser.runtime.getManifest().version,
        readCachedEnvelope: async () => (await browser.storage.local.get(CACHE_KEY))[CACHE_KEY],
        writeCachedEnvelope: envelope => browser.storage.local.set({[CACHE_KEY]: envelope}),
        fetch: (input, init) => globalThis.fetch(input, init),
    });
}

export function createOfficialSiteRuleHandlers<TContext extends ConfigPersistenceContext>(): BackgroundMessageHandler<TContext>[] {
    if (!officialSiteRuleUpdatesEnabled) return [];
    return [{
        type: OFFICIAL_SITE_RULE_READ_MESSAGE,
        handle: (_message, {sender}) => sender?.id === browser.runtime.id ? ruleUpdates().readCurrent() : null,
    }, {
        type: OFFICIAL_SITE_RULE_REFRESH_MESSAGE,
        handle: (_message, {sender}) => isTrustedSettingsSender(sender, browser.runtime.id, browser.runtime.getURL('/options.html'))
            ? ruleUpdates().refresh() : null,
    }];
}

export function installOfficialSiteRuleMaintenance(): void {
    if (!officialSiteRuleUpdatesEnabled) return;
    browser.alarms.onAlarm.addListener((alarm: {name: string}) => {
        if (alarm.name === ALARM) void ruleUpdates().refresh();
    });
    void Promise.resolve().then(() => browser.alarms.get(ALARM)).then(async (current: unknown) => {
        if (!current) await browser.alarms.create(ALARM, {delayInMinutes: 1, periodInMinutes: 6 * 60});
    }).catch(() => {console.warn('[FluentRead] 官方网站规则更新定时任务安装失败');});
}
