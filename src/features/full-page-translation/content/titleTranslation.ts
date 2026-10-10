/**
 * @file src/features/full-page-translation/content/titleTranslation.ts
 * 文件职责：在全文翻译会话期间翻译页面标题，并在恢复时把标题交还给页面。
 * 主要内容：精确相同译文和有同目标语言证据的排版回显保留原文且不重复展示；以 <title> 当前文本为源、复用会话冻结的配置快照发起翻译；观察 head 子树以跟随 SPA 改写的标题；用「上次写入值」区分自身写入与页面写入来阻断自激循环；源标题变化时取消旧请求，并用 generation 与写前快照丢弃迟到结果；恢复时仅在译文仍然在位时写回原标题。
 * 模块边界：本文件只读写 document.title 并观察 head，不参与正文候选遍历、不渲染双语 DOM、不读取配置存储；翻译经 translateText 发出，配置由调用方传入的快照提供。
 *
 * 背景：正文候选遍历把整个 <head> 列为硬裁剪标签（core/translation/dom.ts），标题因此
 * 永远不会成为候选。标题也无法承载双语对照——标签页只显示一行文本——所以这里统一采用
 * 替换式呈现，不跟随 displayMode。
 */
import {hasDistinctTargetTranslation as hasDistinctTranslation} from '@/src/core/translation/targetResult';
import {translateText} from '@/src/app/translation/client';
import {shouldSkipTranslationForTarget} from '@/src/core/language/detect';
import {createSnapshotTranslateOptions, type FullPageTranslationConfigSnapshot} from './translationRequest';

/** SPA 的一次路由切换常连续改写标题；合并抖动，只翻译稳定下来的那一次。 */
const TITLE_SETTLE_DELAY_MS = 150;

interface TitleTranslationState {
    snapshot: FullPageTranslationConfigSnapshot;
    controller: AbortController;
    observer: MutationObserver;
    settleTimer: number | null;
    /** 页面自己的标题文本；恢复时写回这一份。 */
    originalTitle: string;
    /** 最近一次由本模块写入的标题；用于识别自身写入。 */
    appliedTitle: string | null;
    /** 源标题每变化一次自增，用于丢弃迟到的旧请求结果。 */
    generation: number;
}

let state: TitleTranslationState | null = null;

async function translateCurrentTitle(active: TitleTranslationState): Promise<void> {
    const source = active.originalTitle;
    const generation = active.generation;
    if (!source.trim()) return;
    // 与正文一致：已是目标语言或命中会话排除列表的标题不再发请求。
    if (shouldSkipTranslationForTarget(source, active.snapshot.targetLanguage, active.snapshot.excludedLanguages)) return;

    let translated: string;
    try {
        // 标题自身即为上下文；不默认取 document.title，否则再次翻译会把译文当作上下文喂回去。
        translated = await translateText(source, source, createSnapshotTranslateOptions(active.snapshot, {
            signal: active.controller.signal,
        }));
    } catch {
        // 标题翻译失败不影响正文，保留原标题即可。
        return;
    }

    // 会话已结束，或源标题在请求期间又变了：这份结果已经过期。
    if (state !== active || active.generation !== generation || document.title !== source) return;
    const normalized = translated.trim();
    if (!hasDistinctTranslation(source, normalized, active.snapshot.targetLanguage)) return;
    // 先记录再写入：观察者稍后收到变更记录时，必须能识别出这是自身写入。
    active.appliedTitle = normalized;
    document.title = normalized;
}

function scheduleTranslate(active: TitleTranslationState): void {
    if (active.settleTimer !== null) window.clearTimeout(active.settleTimer);
    // 停止时一定会清掉这个定时器，因此回调里无需再判会话是否还在；
    // 真正的过期判定由 translateCurrentTitle 在 await 之后统一完成。
    active.settleTimer = window.setTimeout(() => {
        active.settleTimer = null;
        void translateCurrentTitle(active);
    }, TITLE_SETTLE_DELAY_MS);
}

function handleTitleMutation(active: TitleTranslationState): void {
    // disconnect 之后仍可能收到已排队的记录；停用的会话不再改写标题。
    if (state !== active) return;
    const current = document.title;
    // 本模块刚写入的译文，不能再当作新的源标题，否则会自激循环。
    if (active.appliedTitle !== null && current === active.appliedTitle) return;
    if (current === active.originalTitle) return;

    // 页面自己换了标题（多见于 SPA 路由切换）：以新文本为源重新翻译。
    active.originalTitle = current;
    active.appliedTitle = null;
    active.generation += 1;
    // 路由已不再使用旧标题，即使新标题为空或无需翻译，也立即归还旧请求的资源。
    active.controller.abort();
    active.controller = new AbortController();
    scheduleTranslate(active);
}

export function isFullPageTitleTranslationActive(): boolean {
    return state !== null;
}

/** 随全文翻译会话启动；重复调用会先归还上一轮标题，再以当前标题为源重新开始。 */
export function startFullPageTitleTranslation(snapshot: FullPageTranslationConfigSnapshot): void {
    stopFullPageTitleTranslation();

    // SPA 可能改写 <title> 的文本，也可能整体替换该元素；观察 head 子树两种都能覆盖。
    // 回调只在观察开始后触发，此时 active 已完成初始化。
    const observer = new MutationObserver(() => handleTitleMutation(active));
    const active: TitleTranslationState = {
        snapshot,
        controller: new AbortController(),
        observer,
        settleTimer: null,
        originalTitle: document.title,
        appliedTitle: null,
        generation: 0,
    };
    observer.observe(document.head, {childList: true, subtree: true, characterData: true});
    state = active;

    // 首次不进入合并窗口：会话启动时标题已经稳定，等待只会让标签页延迟变化。
    void translateCurrentTitle(active);
}

/** 随全文翻译恢复调用；页面若已自行改写标题，保留页面的新值不覆盖。 */
export function stopFullPageTitleTranslation(): void {
    const active = state;
    if (!active) return;
    state = null;

    if (active.settleTimer !== null) window.clearTimeout(active.settleTimer);
    active.observer.disconnect();
    active.controller.abort();

    if (active.appliedTitle !== null && document.title === active.appliedTitle) {
        document.title = active.originalTitle;
    }
}
