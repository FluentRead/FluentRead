/**
 * @file src/platform/shadow-ui/pageBridgeCore.ts
 *
 * 文件职责：实现不依赖具体 window 的 Shadow/路由 bridge 状态机，便于在测试中验证安装、启用、禁用和销毁。
 * 主要内容：定义事件名、全局状态键及宿主端口类型，create/install 逻辑管理 attachShadow、pushState、replaceState 补丁所有权并避免嵌套包装。 可核对的公开符号包括 SHADOW_ROOT_EVENT、ROUTE_CHANGE_EVENT、SHADOW_BRIDGE_DISPOSE_EVENT、SHADOW_BRIDGE_ENABLE_EVENT、SHADOW_BRIDGE_STATE_KEY、SHADOW_BRIDGE_LIFECYCLE_STATE_KEY、BridgeEventTarget、BridgeMethodSlot。
 * 模块边界：本文件属于 platform 基础设施边界，只封装浏览器、网络、存储上下文或 Shadow DOM 机制；不决定翻译业务策略，不直接实现 feature，业务层通过类型化端口消费这里的能力。
 */

export const SHADOW_ROOT_EVENT = 'fluentread-open-shadow-root';
export const ROUTE_CHANGE_EVENT = 'fluentread-route-change';
export const SHADOW_BRIDGE_DISPOSE_EVENT = 'fluentread-shadow-bridge-dispose';
export const SHADOW_BRIDGE_ENABLE_EVENT = 'fluentread-shadow-bridge-enable';
export const SHADOW_BRIDGE_STATE_KEY = '__fluentReadShadowBridgeState__';
export const SHADOW_BRIDGE_LIFECYCLE_STATE_KEY = '__fluentReadShadowBridgeLifecycleState__';

export interface BridgeEventTarget {
    addEventListener(type: string, listener: () => void): void;
    removeEventListener(type: string, listener: () => void): void;
    dispatchEvent(event: unknown): unknown;
}

export interface BridgeMethodSlot<T extends (...args: never[]) => unknown> {
    get(): T;
    set(value: T): void;
}

export interface ShadowHostPort {
    dispatchEvent(event: unknown): unknown;
}

export type AttachShadowPort = (this: ShadowHostPort, init: {mode?: string}) => unknown;
export type HistoryMutationPort = (
    this: unknown,
    data: unknown,
    unused: string,
    url?: string | URL | null,
) => unknown;

export interface ShadowRouteBridgeEnvironment {
    readonly stateHost: Record<string, unknown>;
    readonly attachShadow: BridgeMethodSlot<AttachShadowPort>;
    readonly pushState: BridgeMethodSlot<HistoryMutationPort>;
    readonly replaceState: BridgeMethodSlot<HistoryMutationPort>;
    readonly windowEvents: BridgeEventTarget;
    readonly documentEvents: BridgeEventTarget;
    readonly navigationEvents?: BridgeEventTarget;
    readonly getHref: () => string;
    readonly createEvent: (type: string, init?: Record<string, unknown>) => unknown;
}

interface ShadowRouteBridgeState {
    readonly owner: symbol;
    readonly dispose: () => void;
}

interface ShadowRouteBridgeLifecycleState {
    readonly owner: symbol;
    readonly dispose: () => void;
}

function installMethod<T extends (...args: never[]) => unknown>(slot: BridgeMethodSlot<T>, value: T): boolean {
    try {
        slot.set(value);
        return slot.get() === value;
    } catch {
        return false;
    }
}

function restoreMethod<T extends (...args: never[]) => unknown>(
    slot: BridgeMethodSlot<T>,
    wrapper: T,
    original: T,
): void {
    try {
        if (slot.get() === wrapper) slot.set(original);
    } catch {
        // 强化页面可能把宿主 API 改为不可写；卸载失败不能破坏页面生命周期。
    }
}

/** 与 DOM 全局无关的 MAIN world bridge 状态机。 */
export function installShadowRouteBridgeCore(environment: ShadowRouteBridgeEnvironment): () => void {
    const previous = environment.stateHost[SHADOW_BRIDGE_STATE_KEY] as ShadowRouteBridgeState | undefined;
    previous?.dispose?.();

    const owner = Symbol('fluentread-shadow-bridge');
    const originalAttachShadow = environment.attachShadow.get();
    const originalPushState = environment.pushState.get();
    const originalReplaceState = environment.replaceState.get();
    let previousHref = environment.getHref();
    let disposed = false;
    const dispatchRouteChange = () => {
        if (disposed) return;
        const href = environment.getHref();
        if (href === previousHref) return;
        previousHref = href;
        environment.documentEvents.dispatchEvent(environment.createEvent(ROUTE_CHANGE_EVENT));
    };
    const attachShadowWrapper: AttachShadowPort = function attachShadow(_init) {
        const root = Reflect.apply(originalAttachShadow, this, arguments);
        // 原生调用只读取一次 Web IDL 参数；通知失败不能把成功创建的 root 变成异常。
        try {
            if (!disposed && (root as {mode?: string})?.mode === 'open') {
                this.dispatchEvent(environment.createEvent(SHADOW_ROOT_EVENT, {
                    bubbles: true,
                    composed: true,
                }));
            }
        } catch { /* 页面可改写事件 API；保持原生调用的返回值。 */ }
        return root;
    };
    const pushStateWrapper: HistoryMutationPort = function pushState(_data, _unused, _url) {
        // 保留参数数量与额外参数；缺参必须仍由原生 API 抛错，已存在的宿主包装器
        // 也必须收到页面原本提供的参数，而不是扩展补齐的 undefined。
        const result = Reflect.apply(originalPushState, this, arguments);
        try { dispatchRouteChange(); } catch { /* 桥通知失败不能改变宿主导航结果。 */ }
        return result;
    };
    const replaceStateWrapper: HistoryMutationPort = function replaceState(_data, _unused, _url) {
        const result = Reflect.apply(originalReplaceState, this, arguments);
        try { dispatchRouteChange(); } catch { /* 桥通知失败不能改变宿主导航结果。 */ }
        return result;
    };
    const dispose = () => {
        const current = environment.stateHost[SHADOW_BRIDGE_STATE_KEY] as ShadowRouteBridgeState | undefined;
        if (current?.owner !== owner) return;
        // 宿主可能已把我们的 wrapper 包进它自己的方法，不能强行覆盖宿主。
        // 即使旧 wrapper 仍被持有，也必须停止通知，避免恢复后叠加多代观察。
        disposed = true;
        restoreMethod(environment.attachShadow, attachShadowWrapper, originalAttachShadow);
        restoreMethod(environment.pushState, pushStateWrapper, originalPushState);
        restoreMethod(environment.replaceState, replaceStateWrapper, originalReplaceState);
        environment.windowEvents.removeEventListener('popstate', dispatchRouteChange);
        environment.windowEvents.removeEventListener('hashchange', dispatchRouteChange);
        environment.navigationEvents?.removeEventListener('currententrychange', dispatchRouteChange);
        environment.documentEvents.removeEventListener(SHADOW_BRIDGE_DISPOSE_EVENT, dispose);
        delete environment.stateHost[SHADOW_BRIDGE_STATE_KEY];
    };

    // 步骤 1：三个宿主方法独立安装；单个只读 API 不妨碍其余路由/ShadowRoot 观测。
    installMethod(environment.attachShadow, attachShadowWrapper);
    installMethod(environment.pushState, pushStateWrapper);
    installMethod(environment.replaceState, replaceStateWrapper);
    environment.windowEvents.addEventListener('popstate', dispatchRouteChange);
    environment.windowEvents.addEventListener('hashchange', dispatchRouteChange);
    // navigate 在提交前触发，保存同页滚动状态也会触发；只读取提交后的 URL，
    // 并与 history/hash/popstate 共用去重，避免误废弃仍属于当前页面的请求。
    environment.navigationEvents?.addEventListener('currententrychange', dispatchRouteChange);
    environment.stateHost[SHADOW_BRIDGE_STATE_KEY] = {owner, dispose};
    environment.documentEvents.addEventListener(SHADOW_BRIDGE_DISPOSE_EVENT, dispose);
    return dispose;
}

/** 允许 isolated content runtime 在站点禁用/恢复时完整还原并重装 MAIN world 宿主 API。 */
export function installShadowRouteBridgeLifecycleCore(environment: ShadowRouteBridgeEnvironment): () => void {
    const previous = environment.stateHost[SHADOW_BRIDGE_LIFECYCLE_STATE_KEY] as ShadowRouteBridgeLifecycleState | undefined;
    previous?.dispose?.();

    const owner = Symbol('fluentread-shadow-bridge-lifecycle');
    let disposeBridge = installShadowRouteBridgeCore(environment);
    const disable = () => disposeBridge();
    const enable = () => {
        if (environment.stateHost[SHADOW_BRIDGE_STATE_KEY]) return;
        disposeBridge = installShadowRouteBridgeCore(environment);
    };
    const dispose = () => {
        const current = environment.stateHost[SHADOW_BRIDGE_LIFECYCLE_STATE_KEY] as ShadowRouteBridgeLifecycleState | undefined;
        if (current?.owner !== owner) return;
        environment.documentEvents.removeEventListener(SHADOW_BRIDGE_DISPOSE_EVENT, disable);
        environment.documentEvents.removeEventListener(SHADOW_BRIDGE_ENABLE_EVENT, enable);
        disposeBridge();
        delete environment.stateHost[SHADOW_BRIDGE_LIFECYCLE_STATE_KEY];
    };

    environment.documentEvents.addEventListener(SHADOW_BRIDGE_DISPOSE_EVENT, disable);
    environment.documentEvents.addEventListener(SHADOW_BRIDGE_ENABLE_EVENT, enable);
    environment.stateHost[SHADOW_BRIDGE_LIFECYCLE_STATE_KEY] = {owner, dispose};
    return dispose;
}
