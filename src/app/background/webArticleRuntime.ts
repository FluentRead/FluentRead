/**
 * @file src/app/background/webArticleRuntime.ts
 * 文件职责：从当前标签页取得正文，将快照登记到现有文档历史，再打开工作台。
 * 主要内容：核对来源标签页与文档生命周期，按网址和正文确定记录身份，通过版本校验保存，避免重复打开和覆盖既有译文及阅读位置。
 * 模块边界：不读取 DOM、不抽取正文、不执行翻译；浏览器页、时钟和文档历史由组合入口注入。
 */
import {
    WEB_ARTICLE_PARAMETER, normalizeWebArticleUrl, readWebArticleSnapshot, webArticleIdentityBytes,
    type WebArticleOpenStatus,
} from '@/src/features/document-translation/core/webArticle';
import {getPdfSourceUrl} from '@/src/features/document-translation/core/pdfSource';
import {documentHistoryId, type DocumentHistory} from '@/src/features/document-translation/services/history';
import {isBrowserTabId} from '@/src/platform/browser/ids';
import type {BackgroundMessageHandler} from '@/src/services/messaging/backgroundRouter';

interface WebArticleContext {sender?: {id?: string; url?: string}}
interface SourceTab {url?: string; pendingUrl?: string; incognito?: boolean; windowId?: number}
interface WebArticlePorts {
    ready: Promise<unknown>;
    extensionId: string;
    popupUrl: string;
    documentUrl: string;
    history: Pick<DocumentHistory, 'loadChecked' | 'saveChecked'>;
    isDisabled(url: string): boolean;
    captureDocument(tabId: number): () => boolean;
    getTab(tabId: number): Promise<SourceTab>;
    askForArticle(tabId: number, expectedUrl: string): Promise<unknown>;
    openDocument(url: string, windowId?: number): Promise<unknown>;
    now(): number;
}

export function createWebArticleOpenHandler<Context extends WebArticleContext>(
    ports: WebArticlePorts,
): BackgroundMessageHandler<Context, {type: 'openWebArticle'; tabId?: unknown; expectedUrl?: unknown}, {status: WebArticleOpenStatus}> {
    const pending = new Set<number>();
    const unavailable = {status: 'unavailable'} as const;
    return {
        type: 'openWebArticle',
        async handle(message, {sender}) {
            const tabId = message.tabId;
            const expectedUrl = normalizeWebArticleUrl(message.expectedUrl);
            if (sender?.id !== ports.extensionId || sender.url?.split(/[?#]/u, 1)[0] !== ports.popupUrl ||
                !isBrowserTabId(tabId) || !expectedUrl || getPdfSourceUrl(expectedUrl) || pending.has(tabId)) return unavailable;
            const owns = ports.captureDocument(tabId);
            let expired = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const current = () => !expired && owns() && !ports.isDisabled(expectedUrl);
            const matches = (tab: SourceTab) => tab.url === expectedUrl && !tab.incognito && !tab.pendingUrl;
            pending.add(tabId);
            const timeout = new Promise<typeof unavailable>(resolve => {
                timer = setTimeout(() => {expired = true; resolve(unavailable);}, 12_000);
            });
            const open = async (): Promise<{status: WebArticleOpenStatus}> => {
                await ports.ready;
                if (!current() || !matches(await ports.getTab(tabId)) || !current()) return unavailable;
                const snapshot = await ports.askForArticle(tabId, expectedUrl);
                if (!current()) return unavailable;
                const status = (snapshot as {status?: unknown} | null)?.status;
                if (status === 'no-article' || status === 'too-large') return {status};
                if (status !== 'ok' || !matches(await ports.getTab(tabId)) || !current()) return unavailable;
                const article = readWebArticleSnapshot(snapshot, expectedUrl);
                if (!article) return unavailable;
                const bytes = new TextEncoder().encode(article.html);
                const id = await documentHistoryId(webArticleIdentityBytes(expectedUrl, bytes));
                if (!id || !current()) return unavailable;
                const entry = await ports.history.loadChecked(id);
                if (entry.status !== 'ok' || !current()) return unavailable;
                if (!entry.record) {
                    const name = (article.title.trim().replace(/[\\/<>:"|?*\u0000-\u001f]/gu, ' ') ||
                        new URL(expectedUrl).hostname) + '.html';
                    const saved = await ports.history.saveChecked({
                        id, name, bytes, format: 'html', mimeType: 'text/html', size: bytes.byteLength,
                        sourceUrl: expectedUrl, translations: [], fingerprint: '', updatedAt: ports.now(), total: 0, completed: 0,
                    }, entry.version);
                    if (saved.status === 'unavailable') return unavailable;
                    if (saved.status === 'conflict') {
                        const existing = await ports.history.loadChecked(id);
                        if (existing.status !== 'ok' || !existing.record) return unavailable;
                    }
                }
                const tab = await ports.getTab(tabId);
                if (!current() || !matches(tab)) return unavailable;
                await ports.openDocument(`${ports.documentUrl}?${WEB_ARTICLE_PARAMETER}=${id}`, tab.windowId);
                return {status: 'opened'};
            };
            try {
                return await Promise.race([open(), timeout]);
            } catch {
                return unavailable;
            } finally {
                expired = true;
                clearTimeout(timer);
                pending.delete(tabId);
            }
        },
    };
}
