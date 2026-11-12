/**
 * @file src/app/background/badgeRuntime.ts
 * 文件职责：按标签页显示浏览器原生的三态翻译状态角标。
 * 主要内容：根据内容脚本真实结果显示蓝色省略号、绿色对勾或橙色感叹号，复用底图并合并在途同态写入；通过平台适配捕获图标错误，在导航和关闭时清理，并忽略过期写入的失败。
 * 模块边界：只读取状态并调用 action/browserAction，不改页面 DOM、用户配置或翻译任务；角标尺寸由浏览器管理，不需要额外权限或后台 Canvas。
 */
import {TabTranslationStateStore} from './tabTranslationState';
import {createTabTranslationStateReader} from './tabTranslationQuery';
import {normalizeTranslationToolbarStatus, type TranslationToolbarStatus} from '@/src/features/full-page-translation/toolbarStatus';
import {setActionIcon} from '@/src/platform/browser/actionIcon';
import {browserCapabilities} from '@/src/platform/browser/capabilities';

interface BadgeActionApi {
    setBadgeText(details: {tabId: number; text: string}): Promise<void> | void;
    setBadgeBackgroundColor(details: {tabId: number; color: string}): Promise<void> | void;
    setBadgeTextColor?(details: {tabId: number; color: string}): Promise<void> | void;
    setIcon(details: {tabId: number; path: Record<number, string>}): Promise<void> | void;
}
export interface BackgroundBadgeRuntime {
    readonly isSupported: boolean;
    update(tabId: number): Promise<void>;
}

// Safari 的工具栏按钮按模板渲染，只保留字形轮廓；用整块方形图标会被压成一个灰底方块，
// 因此 Safari 走透明底的模板图标，其余浏览器保留带底色的应用图标。
const iconPaths = browserCapabilities.browser === 'safari'
    ? Object.fromEntries([16, 19, 32, 38].map(size => [size, `icon/action/${size}.png`]))
    : Object.fromEntries([16, 32, 48, 64, 128].map(size => [size, `icon/${size}.png`]));
const badges = {
    translating: {text: '…', color: '#2563eb'},
    translated: {text: '✓', color: '#15803d'},
    error: {text: '!', color: '#b45309'},
};
// 与全文段落 loading 的等待时间一致，缓存命中和快速补译不打断已显示的结果。
const TRANSIENT_BADGE_DELAY_MS = 180;

export function installBackgroundBadge(tabTranslationStates: TabTranslationStateStore): BackgroundBadgeRuntime {
    const action = (browser.action ?? browser.browserAction) as BadgeActionApi | undefined;
    const isSupported = !!action;
    const read = createTabTranslationStateReader(tabTranslationStates);
    const queues = new Map<number, Promise<void>>();
    const versions = new Map<number, object>();
    const rendered = new Map<number, TranslationToolbarStatus>();
    const initializedIcons = new Set<number>();
    const requested = new Map<number, {status: TranslationToolbarStatus; version: object; job: Promise<void>}>();
    const pendingStatus = new Map<number, {status: TranslationToolbarStatus; timer: ReturnType<typeof setTimeout>; resolve: () => void; job: Promise<void>}>();

    const cancelPendingStatus = (tabId: number): void => {
        const pending = pendingStatus.get(tabId);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingStatus.delete(tabId);
        pending.resolve();
    };

    const render = (tabId: number, status: TranslationToolbarStatus): Promise<void> => {
        if (!action) return Promise.resolve();
        const current = requested.get(tabId);
        if (current?.status === status && versions.get(tabId) === current.version) return current.job;
        const version = {}; versions.set(tabId, version);
        const job = (queues.get(tabId) ?? Promise.resolve()).then(async () => {
            if (versions.get(tabId) !== version || rendered.get(tabId) === status) return;
            try {
                // 首次写入后旧缓存便不能代表实际角标；中断或失败后回到原状态也必须重画。
                rendered.delete(tabId);
                // 每个页面只初始化一次品牌底图；状态切换不先清空，避免原生工具栏重绘闪烁。
                if (!initializedIcons.has(tabId)) {
                    await setActionIcon(action, {tabId, path: iconPaths});
                    if (versions.get(tabId) !== version) return;
                    initializedIcons.add(tabId);
                }
                if (status !== 'idle') {
                    const badge = badges[status];
                    await action.setBadgeBackgroundColor({tabId, color: badge.color});
                    if (versions.get(tabId) !== version) return;
                    if (action.setBadgeTextColor) {
                        await action.setBadgeTextColor({tabId, color: '#ffffff'});
                        if (versions.get(tabId) !== version) return;
                    }
                    await action.setBadgeText({tabId, text: badge.text});
                } else {
                    await action.setBadgeText({tabId, text: ''});
                }
                if (versions.get(tabId) === version) rendered.set(tabId, status);
            } catch (error) {
                // 关闭或更新后的任务已失效；仅记录当前版本仍需要处理的真实失败。
                if (versions.get(tabId) === version) console.error('Failed to update toolbar translation status:', error);
            }
        }).finally(() => {
            if (queues.get(tabId) === job) queues.delete(tabId);
            if (requested.get(tabId)?.job === job) requested.delete(tabId);
        });
        queues.set(tabId, job);
        requested.set(tabId, {status, version, job});
        return job;
    };
    const update = async (tabId: number): Promise<void> => {
        if (!isSupported) return;
        const state = tabTranslationStates.get(tabId);
        const status = state.isTranslated && !state.isSiteDisabled
            ? normalizeTranslationToolbarStatus(state.toolbarStatus) : 'idle';
        const previousStatus = rendered.get(tabId);
        // 发现候选和 IO 入队之间可能暂时无工作；会话内的短空档不清空已显示标识。
        const transientIdle = status === 'idle' && state.isTranslated && !state.isSiteDisabled
            && previousStatus !== undefined && previousStatus !== 'idle';
        const supplementalWork = status === 'translating' && (previousStatus === 'translated' || previousStatus === 'error');
        if (transientIdle || supplementalWork) {
            const pending = pendingStatus.get(tabId);
            if (pending?.status === status) return pending.job;
            cancelPendingStatus(tabId);
            let resolve!: () => void;
            const job = new Promise<void>(done => { resolve = done; });
            const timer = setTimeout(() => {
                pendingStatus.delete(tabId);
                void render(tabId, status).finally(resolve);
            }, TRANSIENT_BADGE_DELAY_MS);
            pendingStatus.set(tabId, {status, timer, resolve, job});
            return job;
        }
        cancelPendingStatus(tabId);
        await render(tabId, status);
    };
    const refresh = async (tabId: number): Promise<void> => {
        if (!isSupported) return;
        const token = {}; versions.set(tabId, token);
        await read(tabId, true);
        if (versions.get(tabId) === token) await update(tabId);
    };
    if (isSupported) {
        browser.tabs.onActivated.addListener((info: {tabId: number}) => { void refresh(info.tabId); });
        browser.tabs.onUpdated.addListener((tabId: number, change: {status?: string}) => {
            if (change.status === 'loading') {
                cancelPendingStatus(tabId); initializedIcons.delete(tabId); rendered.delete(tabId);
                void render(tabId, 'idle');
            }
        });
        browser.tabs.onRemoved.addListener((tabId: number) => {
            cancelPendingStatus(tabId); versions.delete(tabId); rendered.delete(tabId);
            initializedIcons.delete(tabId); requested.delete(tabId);
        });
    }
    return {isSupported, update};
}
