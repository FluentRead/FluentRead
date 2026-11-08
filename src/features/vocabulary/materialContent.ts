/**
 * @file src/features/vocabulary/materialContent.ts
 * 文件职责：在获准网页恢复本地材料的原段落或视频时间，并维护主动打开材料的阅读位置。
 * 主要内容：仅本地标识进入地址，后台核对来源后读取定位；动态内容按整页游标分片扫描，变更合并后重试；文章只沿可信阅读输入后的滚动链更新，滚轮监听仅在文章材料活跃时挂到页面根元素；收藏和布局变化撤销旧任务及过期恢复提示，关闭及卸载清理监听和异步归属。
 * 模块边界：使用配置公开服务与框架无关的界面翻译函数，不读取其他来源材料，不扫描或保存整页正文，不自动收藏新材料；文档恢复由文档页通过公共定位合同接入。
 */
import {materialCapture, materialGeneration, materialResolve} from './materialClient';
import type {MaterialLocator, MaterialRecord} from './materialProtocol';
import {canonicalMaterialUrl, normalizeMaterialSource} from './materialModel';
import {MATERIAL_RESUME_PARAMETER} from './materialSource';
import {getVideoLearningSource} from '@/src/features/video-subtitle/content/public';
import {scanMaterialParagraphs, type MaterialParagraphScanOptions} from './materialParagraphScan';
import {config} from '@/src/services/config/store';
import {translateLegacyText} from '@/src/core/i18n';

const SESSION_KEY = 'fluentread.material.resume';
const SCROLL_SETTLE_MS = 1200;

/** 整页定位是可取消的异步扫描；调用方须区分 incomplete、invalidated 与真正未找到。 */
export function locateMaterialParagraph(doc: Document, locator: MaterialLocator, options: MaterialParagraphScanOptions = {}) {
    return scanMaterialParagraphs(doc, {kind: 'locate', locator}, options);
}

export function mountMaterialContent(doc: Document, signal: AbortSignal, enabled: () => boolean): () => void {
    const view = doc.defaultView;
    if (!view) return () => {};
    let disposed = false;
    let epoch = 0;
    let active: MaterialRecord | undefined;
    let activeGeneration = 0;
    let activeUrl = '';
    let restoringPosition = false;
    let observer: MutationObserver | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let scrollTimer: ReturnType<typeof setTimeout> | undefined;
    let readingInputUntil = 0;
    let readingWheelRoot: HTMLElement | null = null;
    let notice: HTMLElement | undefined;
    let lastPosition = '';
    let lastVideoSave = 0;
    let restoreController: AbortController | undefined;
    let positionController: AbortController | undefined;
    let positionRevision = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let rescheduleRestore: (() => void) | undefined;
    const cancelPosition = () => {positionRevision++; positionController?.abort(); positionController = undefined;};
    const cancelReadingScroll = () => {clearTimeout(scrollTimer); scrollTimer = undefined; readingInputUntil = 0; cancelPosition();};
    // Chromium 优先派发同节点上的 wheel，挂到 document 会压住 B 站播放器的 mousewheel。
    const setReadingWheelRoot = (root: HTMLElement | null) => {
        readingWheelRoot?.removeEventListener('wheel', onReadingInput, true);
        readingWheelRoot = root;
        readingWheelRoot?.addEventListener('wheel', onReadingInput, {capture: true, passive: true});
    };
    const forgetSession = () => {try {view.sessionStorage?.removeItem(SESSION_KEY);} catch { /* 站点禁用会话存储时只保留当前阅读。 */ }};
    const rememberSession = (id: string, url: string) => {try {view.sessionStorage?.setItem(SESSION_KEY, JSON.stringify({id, url}));} catch { /* 仅保存本地标识，存储不可用不阻断恢复。 */ }};
    const sessionMaterial = (): string | undefined => {
        try {
            const text = view.sessionStorage?.getItem(SESSION_KEY);
            if (!text) return;
            const stored = JSON.parse(text) as {id?: unknown; url?: unknown};
            if (typeof stored?.id === 'string' && stored.id.length > 0 && stored.id.length < 256 && stored.url === canonicalMaterialUrl(view.location.href)) return stored.id;
        } catch { /* 损坏标识或站点禁用存储均忽略，不信任页面提供的正文。 */ }
        forgetSession();
    };
    const current = (owner: number, url: string) => !disposed && !signal.aborted && enabled() && owner === epoch && canonicalMaterialUrl(view.location.href) === url;
    const stopWaiting = () => {observer?.disconnect(); observer = undefined; clearTimeout(timeout); clearTimeout(retryTimer); rescheduleRestore = undefined; restoringPosition = false; restoreController?.abort(); restoreController = undefined;};
    const showNotice = (message: string) => {
        notice = doc.createElement('div');
        notice.setAttribute('data-fluent-read-ui', 'material-resume'); notice.setAttribute('role', 'status');
        notice.style.cssText = 'position:fixed;bottom:20px;left:20px;right:20px;max-width:520px;z-index:2147483647;padding:12px 16px;border:1px solid #9ca3af;border-radius:12px;background:Canvas;color:CanvasText;box-shadow:0 4px 24px #0002;font:14px/1.5 system-ui;display:flex;gap:12px;align-items:center';
        const text = doc.createElement('span'); text.textContent = translateLegacyText(message, config.uiLanguage);
        const close = doc.createElement('button'); close.type = 'button'; close.textContent = translateLegacyText('关闭', config.uiLanguage); close.style.cssText = 'background:transparent;color:inherit;border:1px solid currentColor;border-radius:6px;padding:4px 8px;white-space:nowrap';
        close.addEventListener('click', () => {notice?.remove(); notice = undefined;}, {once: true});
        notice.append(text, close); doc.body.append(notice);
    };
    const materialVideos = (record: MaterialRecord): HTMLVideoElement[] => Array.from(doc.querySelectorAll('video')).filter(video => {
        const url = getVideoLearningSource(video, view.location, doc).sourceUrl;
        const identities = [record.identityKey, ...(record.aliases || [])];
        try {
            if (url) return identities.includes(normalizeMaterialSource({kind: 'video', url}).identityKey);
            // 其他视频网页没有站点专用适配器时，仅同一规范地址上的唯一媒体可恢复。
            const platformHost = /(?:^|\.)(?:youtube\.com|youtu\.be|x\.com|twitter\.com)$/u;
            if (doc.querySelectorAll('video').length !== 1 || platformHost.test(view.location.hostname) || platformHost.test(new URL(record.source.url || view.location.href).hostname)) return false;
            return identities.includes(normalizeMaterialSource({kind: 'video', url: view.location.href}).identityKey);
        } catch {return false;}
    });
    // 两个调用点均已核对 video 和待恢复 locator。
    const restoreVideo = (record: MaterialRecord): boolean => {
        const videos = materialVideos(record).filter(video => video.readyState > 0);
        // 复用字幕学习当前媒体来源，X 多视频绝不根据 DOM 顺序猜测。
        if (videos.length !== 1) return false;
        const video = videos[0]; const time = (record.locator!.startMs || 0) / 1000;
        if (!Number.isFinite(video.duration) || time >= video.duration) return false;
        try {video.pause(); video.currentTime = time; video.scrollIntoView({block: 'center', behavior: 'instant'}); return true;} catch {return false;}
    };
    const load = async (id: string, resume: boolean) => {
        const owner = ++epoch; stopWaiting(); cancelReadingScroll(); active = undefined; activeGeneration = 0; lastPosition = '';
        setReadingWheelRoot(null);
        notice?.remove(); notice = undefined;
        const url = canonicalMaterialUrl(view.location.href);
        try {
            const [record, generation] = await Promise.all([materialResolve(id), materialGeneration()]);
            if (!current(owner, url)) return;
            if (!record) {forgetSession(); throw new Error('材料不存在');}
            active = record; activeUrl = url; activeGeneration = generation;
            if (record.kind === 'article') setReadingWheelRoot(doc.documentElement);
            rememberSession(id, url);
            if (!resume || !record.locator) return;
            const restoreLocator = record.locator;
            restoringPosition = true;
            const attempt = async () => {
                if (!restoringPosition || !current(owner, url)) return;
                restoreController?.abort();
                const controller = new AbortController(); restoreController = controller;
                if (record.kind === 'video') {if (restoreVideo(record)) stopWaiting(); return;}
                const result = await locateMaterialParagraph(doc, restoreLocator, {
                    signal: controller.signal,
                    isCurrent: () => restoringPosition && restoreController === controller && current(owner, url),
                }).catch(() => ({status: 'incomplete' as const}));
                if (!restoringPosition || restoreController !== controller || !current(owner, url)) return;
                if (result.status === 'matched' && result.node?.isConnected) {
                    result.node.scrollIntoView({block: 'center', behavior: 'instant'});
                    if (typeof result.node.animate === 'function') result.node.animate([{outline: '3px solid #4f80ff', outlineOffset: '4px'}, {outline: '3px solid transparent', outlineOffset: '4px'}], {duration: 2400});
                    stopWaiting();
                } else if (result.status === 'invalidated') rescheduleRestore?.();
            };
            // 变更风暴只更新一个安静期任务；不在每个动画帧重新扫描前6000段。
            rescheduleRestore = () => {
                if (!restoringPosition || !current(owner, url)) return;
                restoreController?.abort(); clearTimeout(retryTimer);
                retryTimer = setTimeout(() => {void attempt();}, 120);
            };
            observer = new MutationObserver(() => rescheduleRestore?.());
            observer.observe(doc.documentElement, {childList: true, characterData: true, attributes: true, subtree: true});
            timeout = setTimeout(() => {stopWaiting(); if (current(owner, url)) showNotice(record.kind === 'video' ? '未能恢复视频时间。请确认原视频仍可播放，再从学习材料重新打开。' : '暂时未能确认原文位置。材料与原句仍保留，可在页面内搜索原句，或稍后重新打开。');}, 8000);
            void attempt();
        } catch {if (current(owner, url)) {forgetSession(); if (resume) showNotice('材料已移除、来源不匹配或当前隐私设置禁止读取。请从学习工作区检查来源并重新打开。');}}
    };
    const savePosition = async () => {
        const record = active; const owner = epoch; const url = canonicalMaterialUrl(view.location.href);
        if (!record || url !== activeUrl || !current(owner, url) || record.kind === 'document' || restoringPosition) return;
        cancelPosition(); const positionOwner = positionRevision;
        let locator: MaterialLocator | undefined;
        let sourceUrl = url;
        if (record.kind === 'video') {
            const videos = materialVideos(record);
            if (videos.length === 1 && Number.isFinite(videos[0].currentTime)) {locator = {kind: 'video', startMs: Math.floor(videos[0].currentTime * 1000)};
                sourceUrl = getVideoLearningSource(videos[0], view.location, doc).sourceUrl || url;}
        } else {
            const controller = new AbortController(); positionController = controller;
            const result = await scanMaterialParagraphs(doc, {kind: 'viewport'}, {signal: controller.signal,
                isCurrent: () => positionOwner === positionRevision && record === active && current(owner, url)}).catch(() => undefined);
            if (result?.status !== 'matched' || !result.locator?.quote) return;
            locator = result.locator;
        }
        if (!locator || JSON.stringify(locator) === lastPosition || positionOwner !== positionRevision || !current(owner, url)) return;
        const capturedAt = Date.now();
        const generation = activeGeneration;
        try {await materialCapture({source: {...record.source, url: sourceUrl}, locator, positionOnly: true, generation, capturedAt}); if (positionOwner === positionRevision && current(owner, url)) lastPosition = JSON.stringify(locator);} catch { /* 归档、清空与隐私设置优先，不复活已删除材料。 */ }
    };
    const onReadingInput = (event: Event) => {
        if (!event.isTrusted || active?.kind !== 'article') return;
        const input = event as KeyboardEvent;
        if (input.ctrlKey || input.metaKey || input.altKey) return;
        if (event.type === 'keydown' && !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(input.key)) return;
        const target = event.target as Element | null;
        if (target?.nodeType === 1 && (target.closest('[data-fluent-read-ui],[id^="fluent-read-"]')
            || event.type === 'keydown' && target.closest('input,textarea,select,button,a,[contenteditable]:not([contenteditable="false"])'))) return;
        // 恢复尚在等动态内容或分片扫描时，读者开始阅读就撤销自动定位。
        if (restoringPosition) stopWaiting();
        readingInputUntil = Date.now() + SCROLL_SETTLE_MS;
    };
    const onScroll = (event: Event) => {
        // 浏览器也会为程序滚动、译文重排、浮层内部滚动产生 scroll。
        // 文章仅在读者输入后的正文滚动链上记录进度；暂停/时间轴继续走视频合同。
        if (active?.kind !== 'video') {
            const target = event.target as Element;
            if (event.type !== 'scroll' || event.target !== doc && (target.nodeType !== 1 || target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[data-fluent-read-ui],[id^="fluent-read-"]'))) return;
            if (!scrollTimer && Date.now() >= readingInputUntil) return;
        }
        cancelPosition(); clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => {scrollTimer = undefined; readingInputUntil = 0; void savePosition();}, SCROLL_SETTLE_MS);
    };
    const onTime = () => {if (active?.kind !== 'video' || Date.now() - lastVideoSave < 5000) return; lastVideoSave = Date.now(); void savePosition();};
    const onLeave = () => {cancelReadingScroll(); if (active?.kind === 'video') void savePosition();};
    const onVisibility = () => {if (doc.visibilityState === 'hidden') cancelReadingScroll();};
    const onLayout = () => {cancelReadingScroll(); rescheduleRestore?.();};
    const onCaptured = (event: Event) => {const id = (event as CustomEvent<unknown>).detail; if (typeof id === 'string' && id.length < 256) void load(id, false);};
    const onMediaReady = () => {if (restoringPosition && active?.kind === 'video' && current(epoch, activeUrl) && restoreVideo(active)) stopWaiting();};
    const onRoute = () => {
        if (!active || canonicalMaterialUrl(view.location.href) === activeUrl) return;
        epoch++; cancelReadingScroll(); active = undefined;
        setReadingWheelRoot(null); forgetSession(); stopWaiting(); notice?.remove();
    };
    doc.addEventListener('scroll', onScroll, {capture: true, passive: true});
    doc.addEventListener('touchmove', onReadingInput, {capture: true, passive: true});
    doc.addEventListener('keydown', onReadingInput, true);
    doc.addEventListener('visibilitychange', onVisibility);
    doc.addEventListener('pause', onScroll, true);
    doc.addEventListener('timeupdate', onTime, true);
    doc.addEventListener('loadedmetadata', onMediaReady, true);
    doc.addEventListener('fluentread-material-captured', onCaptured);
    view.addEventListener('popstate', onRoute); view.addEventListener('hashchange', onRoute);
    view.addEventListener('pagehide', onLeave, true);
    view.addEventListener('resize', onLayout);
    doc.addEventListener('load', onLayout, true);
    doc.fonts?.addEventListener('loadingdone', onLayout);
    const target = new URL(view.location.href); const id = target.searchParams.get(MATERIAL_RESUME_PARAMETER);
    if (id) {target.searchParams.delete(MATERIAL_RESUME_PARAMETER); view.history.replaceState(view.history.state, '', target.href); void load(id, true);}
    else {const rememberedId = sessionMaterial(); if (rememberedId) void load(rememberedId, true);}
    const dispose = () => {
        if (disposed) return;
        disposed = true; epoch++; cancelReadingScroll(); stopWaiting(); notice?.remove();
        setReadingWheelRoot(null);
        doc.removeEventListener('scroll', onScroll, true);
        doc.removeEventListener('touchmove', onReadingInput, true);
        doc.removeEventListener('keydown', onReadingInput, true);
        doc.removeEventListener('visibilitychange', onVisibility);
        doc.removeEventListener('pause', onScroll, true);
        doc.removeEventListener('timeupdate', onTime, true);
        doc.removeEventListener('loadedmetadata', onMediaReady, true);
        doc.removeEventListener('fluentread-material-captured', onCaptured);
        view.removeEventListener('popstate', onRoute);
        view.removeEventListener('hashchange', onRoute);
        view.removeEventListener('pagehide', onLeave, true);
        view.removeEventListener('resize', onLayout);
        doc.removeEventListener('load', onLayout, true);
        doc.fonts?.removeEventListener('loadingdone', onLayout);
        signal.removeEventListener('abort', dispose);
    };
    signal.addEventListener('abort', dispose, {once: true}); if (signal.aborted) dispose();
    return dispose;
}
