/**
 * @file src/features/information-highlight/content/runtime.ts
 * 文件职责：拥有单个阅读页面的信息高亮会话，协调只读分帧扫描、评分取消、文本缓存和原生 CSS Highlight 绘制。
 * 主要内容：按视口优先分帧扫描和绘制，滚动复用未变化段落；评分与选区按分析方式、模型和纯文本缓存，切换模型取消旧请求并重新评分，迟到结果复验代次和 Text 身份；关闭或释放清理本实例的绘制、观察器和请求。
 * 模块边界：不访问配置存储或扩展消息、不改变宿主原文、class 和布局；本地模型评分、翻译根及状态通知由应用组合根注入，无原生绘制支持时诚实返回 unsupported。
 */
import type {InformationHighlightPreferences} from '@/src/core/config/informationHighlight';
import type {InformationHighlightModelId} from '@/src/core/config/informationHighlightModel';
import type {InformationHighlightResult, InformationHighlightSpan, InformationHighlightState} from '../protocol';
import {scoreInformationKeywords, selectInformationSpans} from '../domain/keywords';
import {INFORMATION_HIGHLIGHT_LEVELS, INFORMATION_HIGHLIGHT_PALETTES, informationHighlightOpacity, presentInformationHeatmap} from '../domain/presentation';
import {informationSliceEnd} from '../domain/textBoundaries';
import {collectInformationParagraphs, informationRanges, isInformationParagraphCurrent, isInformationMutationExcluded, type InformationReadingScan, type InformationParagraph} from './readingText';
export const INFORMATION_HIGHLIGHT_NAME = 'fluentread-information-highlight';
type PaintWindow = Window & typeof globalThis & {Highlight?: new (...ranges: Range[]) => Set<Range>; CSS?: {highlights?: Map<string, Set<Range>>}};
interface CachedParagraph {
    result: InformationHighlightResult;
    selections: Map<string, Array<InformationHighlightSpan & {level?: number}>>;
}
interface PaintedParagraph {text: string; signature: string; nodes: Text[]; spans: number; ranges: Array<[Set<Range>, Range]>}
export interface InformationHighlightController {
    getState(): InformationHighlightState;
    setEnabled(enabled: boolean): InformationHighlightState;
    retry(): InformationHighlightState;
    updatePreferences(preferences: InformationHighlightPreferences): void;
    refresh(): void;
    dispose(): void;
}
export interface InformationHighlightPorts {
    scoreLocal(text: string, signal: AbortSignal, modelId?: InformationHighlightModelId): Promise<InformationHighlightResult>;
    isCurrent?(): boolean;
    readTranslationRoot?(host: Element): ShadowRoot | undefined;
    changed?(state: InformationHighlightState): void;
    scope?: HTMLElement;
}

/** 每个安装实例仅拥有自己的 registry 对象和样式节点，绝不删除同名的后来拥有者。 */
export function installInformationHighlight(document: Document, initial: InformationHighlightPreferences, ports: InformationHighlightPorts): InformationHighlightController {
    const view = document.defaultView as PaintWindow, registry = view.CSS?.highlights as Map<string, Set<Range>> | undefined;
    const supported = Boolean(view.Highlight && registry);
    // 细线与底色使用基础名称；热力每档强度一个原生 Highlight，按需创建和注册。
    const paints = new Map<string, Set<Range>>();
    const painted = new Map<Text, Map<number, PaintedParagraph>>(), seen = new Set<PaintedParagraph>();
    let paintedRanges = 0;
    let preferences = {...initial}, disposed = false, enabled = false, generation = 0, session = 0;
    let timer: number | undefined, frame: number | undefined, scoreAbort: AbortController | undefined;
    let work: Generator<InformationParagraph | undefined, InformationReadingScan> | undefined;
    let pending: InformationParagraph[] = [];
    // active：正在收集或评分的扫描代次；wanted：其间又有滚动或页面变化；since：尚未开始扫描的最早一次请求。
    let active = -1, wanted = false, since = 0;
    // touched：本轮扫描是否改动过绘制；quiet：连续多少轮什么都没改。动画、轮播等只改样式的页面据此放慢重扫。
    let touched = false, quiet = 0;
    // 正文文字是浅色即视为深色页面（比背景色可靠：很多深色页面的 body 背景是透明的）。
    let dark = false;
    const readDark = () => {
        const channels = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/u.exec(String(view.getComputedStyle(ports.scope ?? document.body).color));
        return Boolean(channels) && (0.2126 * Number(channels![1]) + 0.7152 * Number(channels![2]) + 0.0722 * Number(channels![3])) / 255 > 0.6;
    };
    const styles = new Map<Document | ShadowRoot, HTMLStyleElement>(), observers = new Map<Document | ShadowRoot, MutationObserver>();
    const cache = new Map<string, CachedParagraph>();
    let cachedCharacters = 0;
    let state: InformationHighlightState = {enabled: false, phase: 'idle', sessionId: '0', processedParagraphs: 0, queuedParagraphs: 0, highlightedSpans: 0, mode: preferences.mode};
    const current = () => !disposed && enabled && (ports.isCurrent?.() ?? true);
    const snapshot = () => ({...state});
    const notify = (patch: Partial<InformationHighlightState>) => {
        const next = {...state, ...patch, enabled, mode: preferences.mode};
        // Vue 的状态订阅会重绘模板；相同快照无需触发另一轮界面更新。
        if (Object.keys(next).every(key => next[key as keyof InformationHighlightState] === state[key as keyof InformationHighlightState])) return;
        state = next;
        try {ports.changed?.(snapshot());} catch { /* 界面订阅失败不影响资源归属与清理。 */ }
    };
    const bucket = (name: string) => {
        let paint = paints.get(name);
        if (!paint) {paint = new view.Highlight!() as unknown as Set<Range>; paints.set(name, paint);}
        // 原生 Highlight.add 已触发重绘；同一对象不必为每段重复注册。
        if (registry!.get(name) !== paint) registry!.set(name, paint);
        return paint;
    };
    const erase = (entry: PaintedParagraph) => {for (const [paint, range] of entry.ranges) paint.delete(range); paintedRanges -= entry.ranges.length;};
    const clearPaint = () => {for (const paint of paints.values()) paint.clear(); painted.clear(); seen.clear(); paintedRanges = 0; notify({highlightedSpans: 0});};
    /** 回收本轮扫描未再遇到的段落；仍在阅读区域内的绘制对象保持不动。 */
    const sweep = () => {
        for (const [node, entries] of painted) {
            for (const [offset, entry] of entries) if (!seen.has(entry)) {erase(entry); entries.delete(offset); touched = true;}
            if (!entries.size) painted.delete(node);
        }
    };
    const cancel = () => {
        generation++;
        if (timer !== undefined) view.clearTimeout(timer);
        if (frame !== undefined) view.cancelAnimationFrame(frame);
        timer = frame = undefined; wanted = false;
        work?.return({roots: [document]}); work = undefined; pending = [];
        scoreAbort?.abort(); scoreAbort = undefined;
    };
    const css = () => {
        const color = INFORMATION_HIGHLIGHT_PALETTES[preferences.color].rgb, style = preferences.style;
        if (style === 'heatmap') return Array.from({length: INFORMATION_HIGHLIGHT_LEVELS}, (_, level) =>
            `::highlight(${INFORMATION_HIGHLIGHT_NAME}-${level}) { background-color: rgb(${color} / ${informationHighlightOpacity(style, level, preferences.intensity, dark)}); }`).join('\n');
        return `::highlight(${INFORMATION_HIGHLIGHT_NAME}) { ${style === 'underline'
            ? `text-decoration-line: underline; text-decoration-color: rgb(${color} / ${informationHighlightOpacity(style, undefined, preferences.intensity, dark)}); text-decoration-thickness: 2px;`
            : `background-color: rgb(${color} / ${informationHighlightOpacity(style, undefined, preferences.intensity, dark)});`} }`;
    };
    const ownStyle = (node: Node) => [...styles.values()].some(style => node === style || style.contains(node));
    const irrelevant = (node: Node) => ownStyle(node) || Boolean((node.nodeType === 1 ? node as Element : node.parentElement)?.closest('[data-fluent-read-ui],[data-fluentread-pdf-decoration],[id^="fluent-read-"]'));
    function observe(root: Document | ShadowRoot): void {
        if (observers.has(root)) return;
        const observer = new view.MutationObserver(records => {
            // Vue patchStyle 会重复写入相同 CSS 变量。排除实际值未变的属性记录，避免状态通知与观察器互相触发。
            if (records.every(record => (record.type === 'attributes' && record.oldValue === (record.target as Element).getAttribute(record.attributeName!)) || isInformationMutationExcluded(record) || irrelevant(record.target) || (record.type === 'childList'
                && [...record.addedNodes, ...record.removedNodes].every(irrelevant)))) return;
            rescan();
        });
        observer.observe(root === document && ports.scope ? ports.scope : root, {subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true,
            attributeFilter: ['hidden', 'aria-hidden', 'contenteditable', 'translate', 'class', 'style', 'inert']});
        observers.set(root, observer);
    }
    function styleRoot(root: Document | ShadowRoot): void {
        const owner = styles.get(root);
        if (owner?.isConnected) {if (owner.textContent !== css()) owner.textContent = css(); return;}
        owner?.remove();
        const style = document.createElement('style'); style.setAttribute('data-fr-information-highlight-style', 'true'); style.textContent = css();
        (root === document ? document.head ?? document.documentElement : root).appendChild(style); styles.set(root, style);
    }
    function reconcileRoots(roots: Array<Document | ShadowRoot>): void {
        const live = new Set(roots);
        for (const [root, observer] of observers) if (!live.has(root)) {observer.disconnect(); observers.delete(root);}
        for (const [root, style] of styles) if (!live.has(root)) {style.remove(); styles.delete(root);}
        for (const root of roots) {observe(root); styleRoot(root);}
    }
    function remember(key: string, result: InformationHighlightResult): CachedParagraph {
        // 缓存只保存纯数据；最多 96 段 / 160k 字符，每段最多三种密度选区，永久不持有网页节点和 Range。
        const paragraph: CachedParagraph = {result: {engine: result.engine, spans: result.spans.map(span => ({...span}))}, selections: new Map()};
        cache.set(key, paragraph); cachedCharacters += key.length;
        while (cache.size > 96 || cachedCharacters > 160_000) {
            const oldest = cache.keys().next().value!; cachedCharacters -= oldest.length; cache.delete(oldest);
        }
        return paragraph;
    }
    async function scoreComplete(text: string, signal: AbortSignal, modelId: InformationHighlightModelId): Promise<InformationHighlightResult> {
        if (signal.aborted) throw new Error('INFORMATION_HIGHLIGHT_CANCELLED');
        try {return await ports.scoreLocal(text, signal, modelId);}
        catch (error) {
            // tokenizer 的真实 token 上限可能先于字符预算；完整重分字素安全的子段，绝不截去剩余正文。
            if (signal.aborted || !(error instanceof Error) || !['INFORMATION_HIGHLIGHT_TOKEN_LIMIT', 'INFORMATION_HIGHLIGHT_TEXT_LIMIT'].includes(error.message)) throw error;
            const middle = informationSliceEnd(text, 0, Math.max(1, Math.floor(text.length / 2)));
            if (middle >= text.length) throw error;
            const first = await scoreComplete(text.slice(0, middle), signal, modelId);
            const second = await scoreComplete(text.slice(middle), signal, modelId);
            return {engine: first.engine, spans: [...first.spans, ...second.spans.map(span => ({...span, start: span.start + middle, end: span.end + middle}))]};
        }
    }
    async function analyze(paragraphs: InformationParagraph[], version: number, started: number, completed: InformationReadingScan): Promise<void> {
        let budgetStarted = started;
        for (const paragraph of paragraphs) {observe(paragraph.root); styleRoot(paragraph.root);}
        notify({phase: paragraphs.length ? (preferences.mode === 'surprisal-local' ? 'loading-model' : 'analyzing') : 'active',
            queuedParagraphs: paragraphs.length, errorCode: undefined});
        // 整轮段落按离视口的距离排序：可见正文最先评分，同距离保持文档顺序。
        for (const paragraph of paragraphs.sort((a, b) => a.distance - b.distance)) {
            if (!current() || version !== generation) return;
            const mode = preferences.mode, model = preferences.model, identity = mode === 'surprisal-local' ? `${mode}:${model}` : mode;
            const key = `${identity}:${paragraph.text}`, heat = preferences.style === 'heatmap';
            const signature = `${identity}:${heat ? 'heatmap' : 'flat'}:${preferences.density}`;
            const first = paragraph.runs[0], previous = painted.get(first.node)?.get(first.offset);
            scoreAbort = new AbortController(); const signal = scoreAbort.signal;
            try {
                let count: number;
                // 滚动后的重扫：正文、节点和呈现方式都未变化的段落直接沿用已有 Range，不重新评分和绘制。
                if (previous && previous.text === paragraph.text && previous.signature === signature && previous.nodes.length === paragraph.runs.length
                    && paragraph.runs.every((run, index) => run.node === previous.nodes[index]) && isInformationParagraphCurrent(paragraph)) {
                    seen.add(previous); count = previous.spans;
                } else {
                    let cached = cache.get(key);
                    const waited = !cached && mode !== 'keywords';
                    const result = cached?.result ?? (waited ? await scoreComplete(paragraph.text, signal, model) : scoreInformationKeywords(paragraph.text));
                    if (!current() || version !== generation) return;
                    if (!isInformationParagraphCurrent(paragraph)) {schedule(); return;}
                    cached ??= remember(key, result);
                    const selection = `${heat ? 'heatmap' : 'flat'}:${preferences.density}`;
                    let spans = cached.selections.get(selection);
                    if (!spans) {
                        spans = heat ? presentInformationHeatmap(paragraph.text, result.spans, preferences.density)
                            : selectInformationSpans(paragraph.text, result.spans, preferences.density);
                        cached.selections.set(selection, spans);
                    }
                    const groups = new Map<string, InformationHighlightSpan[]>();
                    for (const span of spans) {
                        const name = heat ? `${INFORMATION_HIGHLIGHT_NAME}-${span.level}` : INFORMATION_HIGHLIGHT_NAME, group = groups.get(name);
                        if (group) group.push(span); else groups.set(name, [span]);
                    }
                    const ranges: Array<[string, Range]> = [];
                    for (const [name, group] of groups) for (const range of informationRanges(document, paragraph, group)) ranges.push([name, range]);
                    // 清除起点落在本段正文内的旧绘制：既替换同一位置的旧段，也避免分段变化后新旧范围叠色。
                    for (const run of paragraph.runs) {
                        const entries = painted.get(run.node);
                        if (entries) for (const [offset, entry] of entries) if (!seen.has(entry) && offset >= run.offset && offset < run.offset + run.end - run.start) {erase(entry); entries.delete(offset);}
                    }
                    if (paintedRanges + ranges.length > 4096) sweep();
                    if (paintedRanges + ranges.length > 4096) {active = -1; notify({phase: 'error', errorCode: 'INFORMATION_HIGHLIGHT_PAGE_LIMIT'}); return;}
                    const entry: PaintedParagraph = {text: paragraph.text, signature, nodes: paragraph.runs.map(run => run.node), spans: spans.length,
                        ranges: ranges.map(([name, range]) => {const paint = bucket(name); paint.add(range); return [paint, range];})};
                    paintedRanges += ranges.length; seen.add(entry); touched = true;
                    let entries = painted.get(first.node);
                    if (!entries) {entries = new Map(); painted.set(first.node, entries);}
                    entries.set(first.offset, entry); count = spans.length;
                    // 等待模型期间页面滚动或变化过：这一段已画好，余下的按新的视口重新排序。
                    if (waited && wanted) {schedule(); return;}
                }
                notify({phase: 'analyzing', processedParagraphs: state.processedParagraphs + 1,
                    queuedParagraphs: state.queuedParagraphs - 1, highlightedSpans: state.highlightedSpans + count});
                if (!current() || version !== generation) return;
                // 扫描与轻量选区共享 4ms 预算；已缓存段落无需无条件占用一整帧。
                if (view.performance.now() - budgetStarted >= 4) {
                    await new Promise<void>(resolve => {frame = view.requestAnimationFrame(() => {frame = undefined; resolve();}); signal.addEventListener('abort', () => resolve(), {once: true});});
                    budgetStarted = view.performance.now();
                }
            } catch (error) {
                if (!current() || version !== generation || signal.aborted) return;
                const errorCode = error instanceof Error ? error.message : 'INFORMATION_HIGHLIGHT_SCORE_FAILED';
                active = -1; notify({phase: 'error', errorCode: errorCode.slice(0, 120)}); return;
            }
        }
        if (current() && version === generation) {
            scoreAbort = undefined; sweep(); reconcileRoots(completed.roots); notify({phase: 'active'});
            const again = wanted; active = -1; quiet = touched ? 0 : Math.min(quiet + 1, 3);
            if (again) schedule(false, 180 << quiet);
        }
    }
    function step(version: number): void {
        frame = undefined;
        if (!current() || version !== generation || !work) return;
        const started = view.performance.now(); let count = 0;
        while (count++ < 8192) {
            const result = work.next();
            if (result.done) {work = undefined; const batch = pending; pending = []; void analyze(batch, version, started, result.value); return;}
            if (result.value) pending.push(result.value);
            if (view.performance.now() - started >= 4) break;
        }
        frame = view.requestAnimationFrame(() => step(version));
    }
    function schedule(invalidate = false, settle = 180): void {
        if (!current() || !supported) return;
        // 持续滚动或不断变化的页面不会无限推迟：从最早一次请求起最迟 600ms 开始扫描。
        const now = view.performance.now(); if (timer === undefined) since = now;
        cancel(); if (invalidate) clearPaint();
        notify({phase: 'paused', queuedParagraphs: 0, errorCode: undefined});
        const version = generation;
        timer = view.setTimeout(() => {
            timer = undefined;
            if (!current() || version !== generation) return;
            active = version; touched = false; dark = readDark(); seen.clear(); work = collectInformationParagraphs(document, ports.readTranslationRoot, ports.scope);
            notify({phase: 'analyzing', processedParagraphs: 0, highlightedSpans: 0});
            frame = view.requestAnimationFrame(() => step(version));
        }, Math.max(0, Math.min(settle, since + (600 << quiet) - now)));
    }
    /** 滚动、尺寸与页面自身变化：保留现有绘制；进行中的扫描先完成，不丢弃已做的工作，也不会被持续滚动反复打断。 */
    function rescan(): void {if (active === generation) wanted = true; else schedule(false, 180 << quiet);}
    // 读者自己在滚动：恢复最快的响应。
    const scroll = () => {quiet = 0; rescan();}, refresh = () => schedule(true);
    const teardown = () => {
        cancel(); clearPaint();
        for (const observer of observers.values()) observer.disconnect(); observers.clear();
        // 样式表留到释放时才移除：加入或移除 ::highlight 规则都会让浏览器重算整页样式（大页面约 70ms），
        // 留着没有任何可见效果，却能让关闭和再次开启都不卡顿。
        for (const [name, paint] of paints) if (registry!.get(name) === paint) registry!.delete(name);
        paints.clear();
        document.removeEventListener('scroll', scroll, true); view.removeEventListener('resize', scroll);
        for (const event of ['fluentread-shadow-root-attached', 'fluentread-translation-started', 'fluentread-translation-ended']) document.removeEventListener(event, refresh);
    };
    return {
        getState: snapshot,
        setEnabled(value) {
            if (disposed || (value && !(ports.isCurrent?.() ?? true))) return snapshot();
            if (enabled === value) return snapshot();
            enabled = value; session++; notify({sessionId: String(session), processedParagraphs: 0, queuedParagraphs: 0, errorCode: undefined});
            if (!enabled) {teardown(); notify({phase: 'idle'}); return snapshot();}
            if (!supported) {notify({phase: 'unsupported', errorCode: 'INFORMATION_HIGHLIGHT_NATIVE_UNSUPPORTED'}); return snapshot();}
            observe(document);
            document.addEventListener('scroll', scroll, true); view.addEventListener('resize', scroll);
            for (const event of ['fluentread-shadow-root-attached', 'fluentread-translation-started', 'fluentread-translation-ended']) document.addEventListener(event, refresh);
            // 用户刚按下开关：页面已稳定，不必再等稳定窗口。
            schedule(false, 0); return snapshot();
        },
        retry() {schedule(true, 0); return snapshot();},
        updatePreferences(next) {
            const rescore = preferences.mode !== next.mode || (next.mode === 'surprisal-local' && preferences.model !== next.model)
                || preferences.density !== next.density || (preferences.style === 'heatmap') !== (next.style === 'heatmap');
            preferences = {...next}; notify({});
            for (const root of styles.keys()) styleRoot(root);
            if (rescore) schedule(true, 0);
        },
        refresh,
        dispose() {if (disposed) return; enabled = false; disposed = true; teardown(); for (const style of styles.values()) style.remove(); styles.clear(); cache.clear(); cachedCharacters = 0; notify({phase: 'idle', queuedParagraphs: 0});},
    };
}
