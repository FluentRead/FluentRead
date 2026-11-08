/**
 * @file src/features/reading-appearance/runtime.ts
 * 文件职责：拥有当前文档的阅读外观选择、网站记忆和异步保存生命周期。
 * 主要内容：默认跟随网站原样，只在显式请求时保存基础域偏好；校验文档标识，串行化保存，区分普通锚点与哈希路由，导航及暂停后丢弃旧响应。
 * 模块边界：通过端口控制字体及提交现有配置补丁，不建立平行存储、不访问浏览器 API、不实现弹窗 UI。
 */
import {getPageTranslationMaterialIdentity} from '@/src/services/translation/context/policy';
import {getSiteBaseDomain} from '@/src/core/site-rules/domain';
import type {ReadingFont, ReadingAppearanceSites} from '@/src/core/config/readingAppearance';
export interface ReadingAppearancePorts {
    href(): string;
    enabled(): boolean;
    sites(): ReadingAppearanceSites;
    persist(sites: ReadingAppearanceSites): Promise<void>;
    controller: {setEnabled(enabled: boolean): void; dispose(): void};
    documentToken: string;
}
export function createReadingAppearanceRuntime(ports: ReadingAppearancePorts) {
    let pageFont: ReadingFont | undefined;
    let active = false, disposed = false, busy = false, revision = 0;
    let href = ports.href(), documentToken = ports.documentToken;
    let pageIdentity = getPageTranslationMaterialIdentity(href);
    const invalidate = () => {revision += 1; documentToken = `${ports.documentToken}:${revision}`;};
    const domain = () => getSiteBaseDomain(href) ?? '';
    const saved = () => Object.prototype.hasOwnProperty.call(ports.sites(), domain()) ? ports.sites()[domain()] : undefined;
    const font = () => pageFont ?? saved() ?? 'original';
    const state = () => ({status: 'success', font: font(), remembered: saved() !== undefined,
        domain: domain(), documentToken});
    function sync() {ports.controller.setEnabled(!disposed && active && ports.enabled() && font() === 'system');}
    function routeChanged() {
        const next = ports.href();
        if (next === href) return;
        const nextIdentity = getPageTranslationMaterialIdentity(next);
        href = next;
        if (nextIdentity === pageIdentity) return;
        pageIdentity = nextIdentity; pageFont = undefined; invalidate(); sync();
    }
    return {
        activate() {active = true; sync();},
        suspend() {if (active) invalidate(); active = false; sync();},
        sync,
        routeChanged,
        dispose() {disposed = true; revision += 1; ports.controller.dispose();},
        async handle(payload: Record<string, unknown>) {
            routeChanged();
            if (disposed || !active || !ports.enabled()) return {status: 'disabled'};
            if (payload.type === 'getReadingAppearanceState') return state();
            if (payload.type !== 'setReadingAppearance' ||
                (payload.font !== 'original' && payload.font !== 'system') ||
                (payload.remember !== undefined && typeof payload.remember !== 'boolean')) return {status: 'invalid'};
            if (payload.documentToken !== documentToken) return {status: 'stale'};
            if (busy) return {status: 'busy'};
            const selected = payload.font;
            const generation = revision;
            if (payload.remember !== undefined) {
                const site = domain();
                if (!site) return {status: 'unsupported'};
                const sites = {...ports.sites()};
                if (payload.remember) sites[site] = selected;
                else delete sites[site];
                busy = true;
                try {await ports.persist(sites);} catch {return {status: 'failed'};} finally {busy = false;}
                routeChanged();
                if (disposed || generation !== revision || !ports.enabled() || !active) return {status: 'stale'};
            }
            pageFont = selected; sync();
            return state();
        },
    };
}
