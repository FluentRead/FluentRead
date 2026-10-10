/**
 * @file src/app/background/contextMenuRuntime.ts
 * 文件职责：管理后台右键菜单的安装、状态同步和点击路由，让菜单结构随设置重建，让标题随当前标签页的翻译与网站状态更新。
 * 主要内容：等待配置就绪后创建菜单并记录已落地属性，串行执行原生写入与重建；冷启动点击只等待结构就绪，轻量动作直接发往目标 frame，全文和网站开关按文档排队，旧文档回复及失败提示均受归属门禁保护。
 * 模块边界：这里只编排 browser.contextMenus、tabs 与 app 层状态，不推导菜单结构、不渲染文案、不执行翻译；结构归 core/context-menu，文案归 core/context-menu/presentation，动作归 contextMenuActions。
 */
import {buildContextMenuPlan, resolveContextMenuPresentation, type ContextMenuPlanItem} from '@/src/core/context-menu/domain';
import {configReady, subscribeConfig} from '@/src/services/config/store';
import {type ContextMenuClickInfo, type ContextMenuClickTab} from './contextMenuActions';
import {readContextMenuSettings, type ContextMenuSettingsSnapshot} from './contextMenuPreferences';
import {renderContextMenuTitle} from '@/src/core/context-menu/presentation';
import {isBrowserTabId, type TabTranslationState, TabTranslationStateStore} from './tabTranslationState';
import {createTabTranslationStateReader} from './tabTranslationQuery';
import {ensureUiLanguageBundle} from '@/src/platform/i18n/uiLanguageBundles';
import {browserCapabilities} from '@/src/platform/browser/capabilities';
import {createContextMenuUpdater, type ContextMenuNativePresentation} from './contextMenuUpdates';
import {createContextMenuClickHandler} from './contextMenuClicks';

const NEUTRAL_STATE: TabTranslationState = {isTranslated: false, isSiteDisabled: false};

export interface BackgroundContextMenuRuntime {
    readonly isSupported: boolean;
    update(tabId: number): Promise<void>;
}

/**
 * 组装右键菜单与标签页生命周期。
 *
 * 该模块只保存 worker 瞬时状态；页面是否已翻译仍以 content script 的回复为真值。
 */
export function installBackgroundContextMenus(
    tabTranslationStates: TabTranslationStateStore,
): BackgroundContextMenuRuntime {
    // Thunderbird 使用邮件工具栏；Firefox Android 可能只暴露不完整的菜单接口。
    const menus = browser.contextMenus;
    const isSupported = browserCapabilities.browser !== 'thunderbird'
        && typeof menus?.create === 'function'
        && typeof menus.removeAll === 'function'
        && typeof menus.update === 'function'
        && typeof menus.onClicked?.addListener === 'function';
    let settings: ContextMenuSettingsSnapshot = readContextMenuSettings();
    let plan: readonly ContextMenuPlanItem[] = [];
    let syncQueue: Promise<void> = Promise.resolve(), initialized: Promise<void> = Promise.resolve();
    let mutationQueue: Promise<void> = Promise.resolve();
    const appliedPresentations = new Map<string, ContextMenuNativePresentation>();
    const readTabTranslationState = createTabTranslationStateReader(tabTranslationStates);

    // 已发出的原生写入无法取消；让后续更新和结构重建排在它之后，保证最新结果最后落地。
    const mutate = (work: () => Promise<void>): Promise<void> => {
        mutationQueue = mutationQueue.catch(() => undefined).then(work);
        return mutationQueue;
    };
    const update = createContextMenuUpdater({
        isSupported, getSettings: () => settings, getPlan: () => plan, mutate, readTabTranslationState, appliedPresentations,
    });

    const createItems = async (snapshot: ContextMenuSettingsSnapshot): Promise<ContextMenuPlanItem[]> => {
        const items = snapshot.enabled ? [...buildContextMenuPlan(snapshot.toggles)] : [];
        const initial = resolveContextMenuPresentation(items, NEUTRAL_STATE, snapshot.display);
        for (const [index, item] of items.entries()) {
            if (snapshot !== settings) break;
            const properties = {
                title: renderContextMenuTitle(initial[index], snapshot.titleContext),
                visible: initial[index].visible,
            };
            await menus.create({
                id: item.menuItemId,
                ...properties,
                contexts: [...item.contexts],
            });
            appliedPresentations.set(item.menuItemId, properties);
        }
        return items;
    };

    const sync = (): Promise<void> => {
        const requested = settings;
        syncQueue = syncQueue
            .then(async () => {
                if (requested !== settings) return;
                // 菜单标题是一次性写入的原生文案；先取得界面语言资源，避免非中文用户看到中文回退。
                await ensureUiLanguageBundle(requested.titleContext.language);
                if (requested !== settings) return;
                await mutate(async () => {
                    if (requested !== settings) return;
                    plan = [];
                    appliedPresentations.clear();
                    await menus.removeAll();
                    const items = await createItems(requested);
                    // 重建期间设置又变了：撤掉本轮已创建项，让后一次同步重新生成。
                    if (requested !== settings) {
                        appliedPresentations.clear();
                        await menus.removeAll();
                        return;
                    }
                    plan = items;
                });
                if (requested !== settings) return;
                // 已创建的菜单即可响应点击；活动页状态查询不能拖住冷启动首击或下一轮设置同步。
                void browser.tabs.query({active: true, lastFocusedWindow: true}).then(async (tabs: ContextMenuClickTab[]) => {
                    if (requested !== settings) return;
                    const active = (tabs as ContextMenuClickTab[]).find(tab => isBrowserTabId(tab.id));
                    if (active?.id !== undefined) await update(active.id);
                }).catch((error: unknown) => console.error('Error querying context menu active tab:', error));
            })
            .catch((error) => {
                // 结构写入前已清空 plan；活动页查询失败则保留已创建的有效路由。
                console.error('Error syncing context menu:', error);
            });
        return syncQueue;
    };

    const clicks = createContextMenuClickHandler({ready: async () => {await initialized; await syncQueue;},
        getSettings: () => settings, getPlan: () => plan, tabTranslationStates, readTabTranslationState, update});

    if (!isSupported) {
        console.log('不支持右键菜单');
    } else {
        initialized = configReady.then(() => {
            settings = readContextMenuSettings();
            const initialSync = sync();
            subscribeConfig(() => {
                const next = readContextMenuSettings();
                if (next.signature === settings.signature) return;
                settings = next;
                void sync();
            });
            return initialSync;
        }).catch(error => console.error('Error initializing context menu:', error));

        browser.contextMenus.onClicked.addListener((info: any, tab: any) => void clicks.handleClick(info as ContextMenuClickInfo, (tab ?? {}) as ContextMenuClickTab));
    }

    browser.tabs.onActivated.addListener((activeInfo: any) => { if (isSupported) void update(activeInfo.tabId); });
    browser.tabs.onUpdated.addListener((tabId: any, changeInfo: any) => { if (changeInfo.status !== 'loading') return; clicks.reset(tabId); tabTranslationStates.reset(tabId); if (isSupported) void update(tabId); });
    browser.tabs.onRemoved.addListener((tabId: any) => {clicks.reset(tabId); tabTranslationStates.delete(tabId);});

    return {isSupported, update};
}
