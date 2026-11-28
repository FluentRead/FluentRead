/**
 * @file src/features/selection-translation/protocol.ts
 * 文件职责：定义划词 TTS 跨 content、background 与 Offscreen 的稳定路由协议，以 tabId、clientRequestId 及可选 frame/document 所有权标识一次播放；无 documentId 的回退依赖 CSPRNG 请求 UUID。
 * 主要内容：包含播放请求与 ended/stopped/error/progress 状态及可选句段时间类型、各字段严格解析、路由相等与消息匹配函数，以及基于 crypto 的客户端请求编号生成。
 * 模块边界：协议模块不发送消息、不维护当前播放状态也不合成音频；内容控制器和后台 handler 分别消费这些纯契约，随机源可注入以保持可测试性。
 */
/**
 * 划词 TTS 跨 content、MV3 background 和 offscreen 的稳定路由身份。
 * `clientRequestId` 由 content 在每次远程播放前生成，不依赖可随时重启的 Service Worker 内存。
 */
import type {SpeechCue} from '@/src/core/tts/speechProgress';
export interface SelectionTtsRoute {
    readonly tabId: number;
    readonly clientRequestId: string;
    readonly frameId?: number;
    readonly ownerUrl?: string;
    /** 浏览器 sender 的 immutable document 身份；缺失时仅保证 frame + CSPRNG 请求 UUID。 */
    readonly documentId?: string;
}

export interface SelectionTtsPlaybackRequest extends SelectionTtsRoute {
    readonly audioBase64?: string;
    readonly text?: string;
    readonly timings?: SpeechCue[];
    readonly contentType?: string;
    readonly sourceUrl?: string;
    readonly rate?: number;
}

export type SelectionTtsPlaybackState = 'ended' | 'stopped' | 'error' | 'progress';

const PLAYBACK_STATES = new Set<SelectionTtsPlaybackState>(['ended', 'stopped', 'error', 'progress']);

export function parseSelectionTtsTabId(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError('TTS tabId 必须是非负安全整数');
    }
    return value;
}

export function parseSelectionTtsClientRequestId(value: unknown): string {
    if (typeof value !== 'string') throw new TypeError('TTS clientRequestId 必须是非空字符串');
    const normalized = value.trim();
    if (!normalized || normalized.length > 128) {
        throw new TypeError('TTS clientRequestId 必须是非空字符串');
    }
    return normalized;
}

export function parseSelectionTtsRoute(value: unknown): SelectionTtsRoute {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('TTS 路由必须是对象');
    }
    const record = value as Record<string, unknown>;
    return {
        tabId: parseSelectionTtsTabId(record.tabId),
        clientRequestId: parseSelectionTtsClientRequestId(record.clientRequestId),
        ...(record.frameId === undefined ? {} : {frameId: parseSelectionTtsTabId(record.frameId)}),
        ...(record.ownerUrl === undefined ? {} : {ownerUrl: normalizeSelectionTtsOwnerUrl(record.ownerUrl)}),
        ...(record.documentId === undefined ? {} : {documentId: parseSelectionTtsClientRequestId(record.documentId)}),
    };
}

export function parseSelectionTtsPlaybackState(value: unknown): SelectionTtsPlaybackState {
    if (typeof value !== 'string' || !PLAYBACK_STATES.has(value as SelectionTtsPlaybackState)) {
        throw new TypeError('TTS state 无效');
    }
    return value as SelectionTtsPlaybackState;
}

/** hash 导航保持同一页面归属；路径与查询参数仍区分不同页面。 */
export function normalizeSelectionTtsOwnerUrl(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError('TTS ownerUrl 必须是有效 URL');
    const url = new URL(value);
    url.hash = '';
    return url.href;
}

export function sameSelectionTtsRoute(left: SelectionTtsRoute, right: SelectionTtsRoute): boolean {
    if (left.tabId !== right.tabId || left.clientRequestId !== right.clientRequestId
        || left.frameId !== right.frameId) return false;
    // documentId 优先于可变 URL；两边必须同时存在，不能降级匹配另一 document。
    if (left.documentId !== undefined || right.documentId !== undefined) {
        return left.documentId !== undefined && left.documentId === right.documentId;
    }
    // 兼容显式携带 URL 的旧端口。无 documentId 的生产 sender route 不携带 URL：
    // 同 document SPA 控制可用，但跨 document 故意复用相同 UUID 不在 fallback 保证内。
    return left.ownerUrl === right.ownerUrl;
}

export function matchesSelectionTtsClientRequest(
    candidate: unknown,
    activeClientRequestId: string | null,
    pendingClientRequestId: string | null,
): candidate is string {
    return typeof candidate === 'string'
        && (candidate === activeClientRequestId || candidate === pendingClientRequestId);
}

type SelectionTtsRandomSource = Pick<Crypto, 'getRandomValues'> & {
    readonly randomUUID?: () => string;
};

/** 使用浏览器 CSPRNG 生成不会随组件或 worker 重建复用的请求 ID。 */
export function createSelectionTtsClientRequestId(
    randomSource: SelectionTtsRandomSource = globalThis.crypto,
): string {
    if (typeof randomSource.randomUUID === 'function') {
        return parseSelectionTtsClientRequestId(randomSource.randomUUID());
    }

    // randomUUID 只在 secure context 中保证暴露；HTTP 页的 content script
    // 仍可使用 getRandomValues 生成等价的 RFC 4122 v4 身份。
    const bytes = randomSource.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
