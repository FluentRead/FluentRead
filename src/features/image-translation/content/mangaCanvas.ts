/**
 * @file src/features/image-translation/content/mangaCanvas.ts
 * 文件职责：把可读正文画布、背景图片和长图分段快照接入既有漫画识别与局部译图合成，保留宿主正文及翻页交互。
 * 主要内容：自动布局以小尺寸指纹提示重绘，显式操作先隐藏旧译层并以完整 PNG 摘要验证来源；任务复用独立快照编码，合成后复核完整来源再发布；原生画布仅在译层真正显示时借用透明度与过渡样式隐藏下层原字，撤层时归还并保留宿主后续改写；背景等载体可异步准备自身绘制层资源，发布前复核任务归属，暂停时隐藏复用、取消或淘汰时销毁；注入正文锚点、绘制范围及核心裁切支持背景与分段；会话端口串行调度，失败时复用图片的紧凑恢复控件并通过原会话重试，取消、来源变化和关闭释放控件且不伪造成功；缓存只保留有界压缩图块。最后捕获之后的无事件重绘不作逐帧一致性承诺。
 * 模块边界：只读取公开 DOM 画布或注入的已展示正文快照，不访问站点接口、不读取受污染像素、不更改原画布像素；本模块仅为原生画布借用透明度，背景资源与样式归还由载体端口负责，不隐藏背景元素或共享长图宿主；识别和翻译由注入的现有图片客户端完成。
 */
import {compressMangaPage, createMangaLightCache, type MangaCompressedPage, type MangaPatchPacket} from '../mangaPatchResult';
import {encodeImageCanvas, encodeReadingImageCanvas, readingImageEncodingBusy} from '../services/imageEncoding';
import {composeMangaPage} from './mangaCompositor';
import {createImageControls, IMAGE_CONTROLS_CSS, type ImageSettingsSection} from './controls';
import {imageTranslationFailureCode, imageLocalFailureMessage} from '../failure';
import {sha256Hex} from '@/src/shared/function/sha256';
import {prepareMangaReadingLines, type createMangaReadingSnapshots} from './mangaReadingSnapshots';
import type {MangaReadingResult} from './mangaReadingCoordinator';

interface CanvasState {
    identity: string;
    controller: AbortController | null;
    surface: HTMLCanvasElement | null;
    completed: boolean;
    failed: boolean;
    showing: boolean;
    recovery: ReturnType<typeof createImageControls> | null;
    validationPending: boolean;
    contentKey?: string;
    readingKey?: number;
    readingFailure?: 'overBudget' | 'error';
    presentation?: MangaSurfacePresentation;
    sourceLease?: {
        opacity: StyleProperty;
        transition: StyleProperty;
        ownedTransition: StyleProperty[];
        computedOpacity: string;
        originalStyleAttribute: string | null;
        ownedStyleAttribute: string | null;
        classAttribute: string | null;
    };
}

/** 背景等载体在自身绘制层展示已完成译图；隐藏保留缓存，释放归还宿主并销毁资源。 */
export interface MangaSurfacePresentation {
    show(): boolean;
    hide(): void;
    dispose(): void;
}

interface StyleProperty {property: string; value: string; priority: string}
const TRANSITION_PROPERTIES = ['transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay', 'transition-behavior'];
const readStyleProperty = (style: CSSStyleDeclaration, property: string): StyleProperty => ({property, value: style.getPropertyValue(property), priority: style.getPropertyPriority(property)});
const matchesStyleProperty = (style: CSSStyleDeclaration, saved: StyleProperty) => style.getPropertyValue(saved.property) === saved.value && style.getPropertyPriority(saved.property) === saved.priority;
function writeStyleProperty(style: CSSStyleDeclaration, saved: StyleProperty): void {
    if (saved.value) style.setProperty(saved.property, saved.value, saved.priority);
    else style.removeProperty(saved.property);
}

/** 固定译层只能等价替代简单画布；复杂绘制继续保留原来的叠层，不隐藏宿主。 */
function simpleCanvasStyle(style: CSSStyleDeclaration, source: boolean): boolean {
    if ([style.transform, style.translate, style.rotate, style.scale, style.filter, style.backdropFilter, style.maskImage, style.webkitMaskImage, style.clipPath, style.perspective]
        .some(value => value && value !== 'none')) return false;
    if ((style.zoom && style.zoom !== '1' && style.zoom !== 'normal') || (style.clip && style.clip !== 'auto')) return false;
    if (style.mixBlendMode && style.mixBlendMode !== 'normal') return false;
    if (!source) return true;
    if (style.objectFit && style.objectFit !== 'fill') return false;
    if (style.outlineStyle && style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0) return false;
    if ([style.backgroundImage, style.boxShadow].some(value => value && value !== 'none')) return false;
    if (style.backgroundColor && style.backgroundColor !== 'transparent' && !/^rgba\([^()]+,\s*0(?:\.0+)?\s*\)$/.test(style.backgroundColor)) return false;
    return ![style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth,
        style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft,
        style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius].some(value => Number.parseFloat(value) > 0);
}

function inactiveCanvas(element: Element): boolean {
    return typeof element.getAnimations === 'function' && !element.getAnimations().some(animation => animation.pending || animation.playState === 'running');
}

/** HTTPS 复用异步原生摘要；HTTP 内容环境沿用项目已有的本地 SHA-256。 */
async function imageDigest(image: string): Promise<string> {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return sha256Hex(image);
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(image));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function releaseSurface(surface: HTMLCanvasElement | null): void {
    surface?.remove();
    if (surface) surface.width = surface.height = 0;
}

export function createMangaCanvas<T extends object = HTMLCanvasElement>(ports: {
    enabled: () => boolean;
    configurationIdentity: () => string;
    cacheEnabled: () => boolean;
    readingSnapshots?: ReturnType<typeof createMangaReadingSnapshots>;
    lightCacheLimits?: {pages:number;bytes:number};
    acceptsInteractionLayer?: (canvas: T, hit: Element) => boolean;
    source?: {
        anchor?: (element: T) => HTMLElement;
        identity: (element: T) => string | null;
        /** 只读身份检查；背景载体须避免 identity 中的异步探测副作用。 */
        readingIdentity?: (element:T) => string | null;
        readingBounds?: (element:T) => DOMRect | null;
        capture: (element: T, target: HTMLCanvasElement, signal: AbortSignal) => Promise<void>;
        bounds: (element: T) => DOMRect;
        viewport?: (element: T) => {x: number; y: number; width: number; height: number};
        presentation?: (element: T, surface: HTMLCanvasElement, signal: AbortSignal) => Promise<MangaSurfacePresentation>;
    };
    hostId?: string;
    recovery?: {
        retry: (surface: T) => boolean;
        openSettings: (section: ImageSettingsSection) => Promise<void>;
        translateUi?: (source: string) => string;
    };
    translate: (image: string, signal: AbortSignal) => Promise<{mangaPatches?: MangaPatchPacket; lines: MangaCompressedPage['lines']}>;
}) {
    const states = new Map<T, CanvasState>();
    // key 含每个载体的实例 id，活动完成页可按键常数时间定位，无需遍历全部页面。
    const completedByKey = new Map<string,CanvasState>();
    const untrack=(state:CanvasState)=>{if(state.contentKey&&completedByKey.get(state.contentKey)===state)completedByKey.delete(state.contentKey);};
    const track=(state:CanvasState)=>{if(state.completed&&state.contentKey)completedByKey.set(state.contentKey,state);};
    const ids = new WeakMap<T, number>();
    const revisions = new WeakMap<T, number>();
    const lightCache = createMangaLightCache(ports.lightCacheLimits?.pages,ports.lightCacheLimits?.bytes,(key,page)=>{
        // 仅容量淘汰时将仍显示的活动结果转移到共享预算；未淘汰的缓存无需重复驻留。
        if(!ports.readingSnapshots)return;
        const state=completedByKey.get(key);
        if(state?.completed&&state.showing&&state.readingKey===undefined)try {
            const readingKey=ports.readingSnapshots.allocateKey();
            if(readingKey===undefined)state.readingFailure='overBudget';
            else {const stored=ports.readingSnapshots.put(readingKey,page.lines);
                if(stored==='stored')state.readingKey=readingKey;else state.readingFailure=stored==='overBudget'?'overBudget':'error';}
        }catch{state.readingFailure='error';}
    });
    let sequence = 0;
    let sample: HTMLCanvasElement | null = null;
    let host: HTMLDivElement | null = null, root: ShadowRoot | null = null;
    let recoveryStyled = false;
    let disposed = false;
    const anchor = (element: T) => ports.source?.anchor ? ports.source.anchor(element) : element as unknown as HTMLElement;

    function restoreSource(canvas: T, state: CanvasState): void {
        const lease = state.sourceLease;
        if (!lease) return;
        const element = anchor(canvas), style = element.style;
        const ownsOpacity = style.getPropertyValue('opacity') === '0' && style.getPropertyPriority('opacity') === 'important';
        const ownsTransition = style.getPropertyValue('transition-property') === 'none' && style.getPropertyPriority('transition-property') === 'important';
        const unchanged = ownsOpacity && ownsTransition && element.getAttribute('style') === lease.ownedStyleAttribute;
        if (ownsOpacity) {
            writeStyleProperty(style, lease.opacity);
            if (ownsTransition) void getComputedStyle(element).opacity;
        }
        // 只借用并归还一个 longhand；不写派生 shorthand，宿主新的 duration 等声明原样保留。
        if (ownsTransition) writeStyleProperty(style, lease.transition);
        if (unchanged) {
            if (lease.originalStyleAttribute === null) element.removeAttribute('style');
            else element.setAttribute('style', lease.originalStyleAttribute);
        }
        state.sourceLease = undefined;
    }

    function hideSource(canvas: T, state: CanvasState, computedOpacity: string): void {
        if (state.sourceLease) return;
        const element = anchor(canvas), style = element.style;
        const opacity = readStyleProperty(style, 'opacity'), transition = readStyleProperty(style, 'transition-property');
        const originalStyleAttribute = element.getAttribute('style');
        style.setProperty('transition-property', 'none', 'important');
        style.setProperty('opacity', '0', 'important');
        state.sourceLease = {opacity, transition, ownedTransition: TRANSITION_PROPERTIES.map(property => readStyleProperty(style, property)), computedOpacity, originalStyleAttribute, ownedStyleAttribute: element.getAttribute('style'), classAttribute: element.getAttribute('class')};
    }

    function identity(element: T): string | null {
        if (disposed) return null;
        if (ports.source) {
            const fingerprint = ports.source.identity(element);
            if (!fingerprint) return null;
            if (!ids.has(element)) ids.set(element, ++sequence);
            return `${ids.get(element)}:${fingerprint}:${ports.configurationIdentity()}`;
        }
        const canvas = element as unknown as HTMLCanvasElement;
        if (canvas.width < 80 || canvas.height < 40 || canvas.width > 8192 || canvas.height > 8192
            || canvas.width * canvas.height > 16_000_000) return null;
        try {
            sample ??= document.createElement('canvas');
            // 重设尺寸同时清除前一张受污染画布的状态，不让它阻止其他可读正文。
            sample.width = sample.height = 8;
            const context = sample.getContext('2d', {willReadFrequently: true});
            if (!context) return null;
            // 用整数位置的一比一像素抽样，避免缩图采样的边界与插值差异误判未变的原页。
            context.imageSmoothingEnabled = false;
            for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
                context.drawImage(canvas, Math.floor((x + .5) * canvas.width / 8), Math.floor((y + .5) * canvas.height / 8), 1, 1, x, y, 1, 1);
            }
            const data = context.getImageData(0, 0, 8, 8).data;
            if (!data.some(value => value !== 0)) return null;
            let hash = 2166136261;
            for (const value of data) hash = Math.imul(hash ^ value, 16777619);
            if (!ids.has(element)) ids.set(element, ++sequence);
            return `${ids.get(element)}:${canvas.width}:${canvas.height}:${hash >>> 0}:${ports.configurationIdentity()}`;
        } catch { return null; }
    }

    function release(canvas: T): void {
        const state = states.get(canvas);
        if (!state) return;
        untrack(state);
        restoreSource(canvas, state);
        state.presentation?.dispose();
        state.controller?.abort();
        state.recovery?.dispose();
        if(state.readingKey!==undefined)ports.readingSnapshots?.remove(state.readingKey);
        releaseSurface(state.surface);
        states.delete(canvas);
    }

    function update(): void {
        for (const [canvas, state] of states) {
            const element = anchor(canvas);
            if (!element.isConnected || identity(canvas) !== state.identity) {release(canvas);continue;}
            const surface = state.surface;
            if (state.sourceLease && (element.style.getPropertyValue('opacity') !== '0' || element.style.getPropertyPriority('opacity') !== 'important'
                || element.getAttribute('class') !== state.sourceLease.classAttribute
                || state.sourceLease.ownedTransition.some(saved => !matchesStyleProperty(element.style, saved)))) {
                restoreSource(canvas, state);state.showing = false;surface?.remove();
            }
            if (!surface && !state.presentation && !state.recovery) continue;
            const rect = ports.source ? ports.source.bounds(canvas) : element.getBoundingClientRect();
            let left = Math.max(0, rect.left), right = Math.min(window.innerWidth, rect.right);
            let top = Math.max(0, rect.top), bottom = Math.min(window.innerHeight, rect.bottom);
            let visible = state.showing && !state.validationPending && ports.enabled() && !document.hidden && rect.width > 0 && rect.height > 0;
            let canHide = !ports.source, sourceOpacity = '1';
            for (let parent: Element | null = element; parent; parent = parent.parentElement) {
                const style = getComputedStyle(parent);
                const alpha = parent === element && state.sourceLease ? state.sourceLease.computedOpacity : style.opacity;
                if (parent === element) sourceOpacity = alpha || '1';
                if (canHide) canHide = (parent === element || !alpha || alpha === '1') && simpleCanvasStyle(style, parent === element) && inactiveCanvas(parent);
                if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || alpha === '0') visible = false;
                if (parent === document.documentElement || parent === document.scrollingElement) continue;
                const bounds = parent.getBoundingClientRect();
                if (/^(hidden|clip|auto|scroll)$/.test(style.overflowX)) {left = Math.max(left, bounds.left);right = Math.min(right, bounds.right);}
                if (/^(hidden|clip|auto|scroll)$/.test(style.overflowY)) {top = Math.max(top, bounds.top);bottom = Math.min(bottom, bounds.bottom);}
            }
            visible &&= right > left && bottom > top;
            if (visible) {
                const x = (left + right) / 2, y = (top + bottom) / 2;
                let hit = document.elementFromPoint(x, y);
                if (hit === host) hit = document.elementsFromPoint?.(x, y).find(element => element !== host) ?? null;
                visible = !!hit && (hit === element || hit.contains(element) || ports.acceptsInteractionLayer?.(canvas, hit) === true);
            }
            if (surface) surface.style.cssText = `position:fixed;pointer-events:none;display:${visible ? 'block' : 'none'};left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;clip-path:inset(${Math.max(0, top - rect.top)}px ${Math.max(0, rect.right - right)}px ${Math.max(0, rect.bottom - bottom)}px ${Math.max(0, left - rect.left)}px);`;
            if (surface && !ports.source) {
                surface.style.opacity = canHide ? sourceOpacity : '1';
                if (visible && canHide && state.completed && surface.isConnected) hideSource(canvas, state, sourceOpacity);
                else restoreSource(canvas, state);
            }
            if (state.presentation) {
                if (!visible) state.presentation.hide();
                else if (!state.presentation.show()) {state.presentation.hide();state.showing = false;}
            }
            if (state.recovery) {
                const feedback = state.recovery.feedback;
                feedback.hidden = !visible;
                feedback.style.cssText = `position:fixed;left:${left + 8}px;top:${top + 8}px;max-width:${Math.max(0, Math.min(280, right - left - 16))}px;max-height:${Math.max(0, bottom - top - 16)}px;`;
            }
        }
    }

    function ensureRoot(): ShadowRoot {
        if (!host) {
            host = document.createElement('div');host.id = ports.hostId ?? (ports.source ? 'fluent-read-manga-background-container' : 'fluent-read-manga-canvas-container');
            host.setAttribute('data-fluent-read-ui', 'manga-canvas');
            // Shadow DOM 隔离内部译图，外层宿主也需抵抗页面的全局 !important 规则。
            host.style.cssText = 'all:initial!important;display:block!important;position:fixed!important;left:0!important;top:0!important;width:0!important;height:0!important;overflow:visible!important;pointer-events:none!important;z-index:2147483644!important;';
            root = host.attachShadow({mode: 'closed'});document.documentElement.append(host);
        }
        return root!;
    }

    function show(state: CanvasState): void {
        state.showing = true;
        if (state.surface) ensureRoot().append(state.surface);
        update();
    }

    function showFailure(canvas: T, state: CanvasState, error: unknown): void {
        const recovery = ports.recovery;
        if (!recovery) return;
        const current = () => !disposed && state.showing && states.get(canvas) === state
            && anchor(canvas).isConnected && ports.enabled() && identity(canvas) === state.identity;
        const retry = () => {if (current() && recovery.retry(canvas)) controls.button.disabled = true;};
        const controls = state.recovery = createImageControls({
            translate: recovery.translateUi,
            onAction: retry, onPrepare: retry,
            onDismiss: () => {controls.dispose();state.recovery = null;},
            onSettings: section => {
                void Promise.resolve().then(() => {
                    if (current() && state.recovery === controls) return recovery.openSettings(section);
                }).catch(cause => {
                    if (current() && state.recovery === controls) {
                        controls.update('error', '无法打开设置，请从扩展菜单打开设置后重试',
                            {quiet: true, errorDetails: cause instanceof Error ? cause.message : String(cause)});
                        update();
                    }
                });
            },
        });
        const message = error instanceof Error ? error.message : String(error), local = imageTranslationFailureCode(error);
        controls.update('error', local ? imageLocalFailureMessage(local) : `图片翻译失败：${message}`,
            {quiet: true, modelSettings: !!local, serviceSettings: true, errorDetails: message});
        const target = ensureRoot();
        if (!recoveryStyled) {const style = document.createElement('style');style.textContent = IMAGE_CONTROLS_CSS;target.append(style);recoveryStyled = true;}
        target.append(controls.feedback);
        update();
    }

    function reuse(canvas: T): boolean {
        const state = states.get(canvas);
        if (!state?.completed || state.failed || state.validationPending || state.identity !== identity(canvas) || !ports.enabled()) return false;
        show(state);return true;
    }

    function invalidate(canvas: T): void {
        if (disposed || ports.source) return;
        revisions.set(canvas, (revisions.get(canvas) ?? 0) + 1);
        const state = states.get(canvas);
        if (state) {restoreSource(canvas, state);state.controller?.abort();state.validationPending = true;state.showing = false;state.surface?.remove();state.recovery?.dispose();state.recovery = null;}
    }

    function captureNative(canvas: T, target: HTMLCanvasElement): void {
        const source = canvas as unknown as HTMLCanvasElement;
        target.width = source.width;target.height = source.height;
        const context = target.getContext('2d');
        if (!context) throw new Error('浏览器不支持图片处理');
        context.drawImage(source, 0, 0);
    }

    async function translate(canvas: T): Promise<void> {
        if (reuse(canvas)) return;
        const owner = identity(canvas);
        if (!owner || !ports.enabled() || !anchor(canvas).isConnected) return;
        const previous = states.get(canvas);
        const retained = !ports.source && previous?.completed && !previous.failed ? previous : undefined;
        if (retained) {untrack(retained);restoreSource(canvas, retained);retained.surface?.remove();}
        else release(canvas);
        const controller = new AbortController();
        const revision = revisions.get(canvas) ?? 0;
        const state: CanvasState = {identity: owner, controller, surface: retained?.surface ?? null, completed: false, failed: false, showing: true, recovery: null, validationPending: !ports.source,
            readingKey:retained?.readingKey,readingFailure:retained?.readingFailure};
        states.set(canvas, state);
        const original = document.createElement('canvas');
        let surface: HTMLCanvasElement | null = null;
        let presentation: MangaSurfacePresentation | undefined;
        const current = () => !disposed && !controller.signal.aborted && states.get(canvas) === state
            && (revisions.get(canvas) ?? 0) === revision && anchor(canvas).isConnected && ports.enabled() && identity(canvas) === owner;
        try {
            if (ports.source) {
                await ports.source.capture(canvas, original, controller.signal);
                if (!current()) return;
            } else captureNative(canvas, original);
            let key = owner, image: string | undefined;
            if (!ports.source) {
                image = await encodeImageCanvas(original, controller.signal);
                if (!current()) return;
                key = `${owner}:${await imageDigest(image)}`;
                if (!current()) return;
                if (retained?.contentKey === key) {
                    state.contentKey = key;state.completed = true;state.validationPending = false;track(state);show(state);return;
                }
                if(state.readingKey!==undefined)ports.readingSnapshots?.remove(state.readingKey);
                state.readingKey=undefined;state.readingFailure=undefined;
                releaseSurface(state.surface);state.surface = null;
            }
            let page = ports.cacheEnabled() ? lightCache.get(key) : undefined;
            let retainedInLightCache = !!page;
            if (!page) {
                image ??= await encodeImageCanvas(original, controller.signal);
                if (!current()) return;
                const result = await ports.translate(image, controller.signal);
                if (!current()) return;
                if (result.lines.length === 0) page = {width: original.width, height: original.height, patches: [], lines: []};
                else {
                    if (!result.mangaPatches) throw new Error('漫画译图数据无效');
                    page = compressMangaPage(result.mangaPatches, result.lines);
                }
                if (ports.source && ports.cacheEnabled()) retainedInLightCache=lightCache.put(key, page);
            }
            surface = page.patches.length ? await composeMangaPage(original, page, controller.signal) : null;
            if (!current()) return;
            if (!ports.source) {
                // 合成已读完初始快照；复用同一画布重新捕获，避免额外保留整页像素。
                captureNative(canvas, original);
                const latest = await encodeImageCanvas(original, controller.signal);
                if (!current()) return;
                const latestKey = `${owner}:${await imageDigest(latest)}`;
                if (!current()) return;
                if (latestKey !== key) throw new Error('画布内容已变化，请重试');
                if (ports.cacheEnabled()) retainedInLightCache=lightCache.put(key, page);
            }
            if (surface && ports.source?.viewport) {
                const viewport = ports.source.viewport(canvas);
                const cropped = document.createElement('canvas');
                cropped.width = viewport.width;cropped.height = viewport.height;
                try {
                    const context = cropped.getContext('2d');
                    if (!context) throw new Error('浏览器不支持图片处理');
                    context.drawImage(surface, viewport.x, viewport.y, viewport.width, viewport.height, 0, 0, viewport.width, viewport.height);
                } catch (error) {cropped.width = cropped.height = 0;throw error;}
                finally {surface.width = surface.height = 0;}
                surface = cropped;
            }
            if (surface && ports.source?.presentation) {
                presentation = await ports.source.presentation(canvas, surface, controller.signal);
                if (!current()) return;
                releaseSurface(surface);surface = null;
            }
            if(!retainedInLightCache && ports.readingSnapshots) try {
                const readingKey=ports.readingSnapshots.allocateKey();
                if(readingKey===undefined)state.readingFailure='overBudget';
                else {
                    const stored=ports.readingSnapshots.put(readingKey,page.lines);
                    if(stored==='stored')state.readingKey=readingKey;
                    else state.readingFailure=stored==='overBudget'?'overBudget':'error';
                }
            }catch{state.readingFailure='error';}
            state.presentation = presentation;presentation = undefined;
            state.surface = surface;surface = null;state.contentKey = key;state.completed = true;state.validationPending = false;track(state);show(state);
        } catch (error) {
            if (current()) {untrack(state);if(state.readingKey!==undefined)try{ports.readingSnapshots?.remove(state.readingKey);}catch{/* 文字快照故障不影响译图错误处理 */}state.readingKey=undefined;restoreSource(canvas, state);state.presentation?.dispose();state.presentation = undefined;state.failed = true;state.validationPending = false;releaseSurface(state.surface);state.surface = null;showFailure(canvas, state, error);throw error;}
        } finally {
            presentation?.dispose();
            releaseSurface(surface);
            original.width = original.height = 0;
            if (states.get(canvas) === state) state.controller = null;
        }
    }

    function readingIdentity(canvas:T):string|null {
        if(!ports.source)return identity(canvas);
        if(!ports.source.readingIdentity)return null;
        const fingerprint=ports.source.readingIdentity(canvas),id=ids.get(canvas);
        return fingerprint&&id?`${id}:${fingerprint}:${ports.configurationIdentity()}`:null;
    }

    function readingVisible(canvas:T,verifiedIdentity?:string|null,readingHost?:HTMLElement|null):boolean {
        try {
            const state=states.get(canvas),element=anchor(canvas);
            if(!state||!state.showing||!element.isConnected||document.hidden
                ||!ports.enabled()||(verifiedIdentity===undefined?readingIdentity(canvas):verifiedIdentity)!==state.identity)return false;
            const rect=ports.source?ports.source.readingBounds?.(canvas):element.getBoundingClientRect();
            if(!rect||rect.width<=0||rect.height<=0)return false;
            let left=Math.max(0,rect.left),right=Math.min(window.innerWidth,rect.right),top=Math.max(0,rect.top),bottom=Math.min(window.innerHeight,rect.bottom);
            for(let parent:Element|null=element;parent;parent=parent.parentElement){
                const style=getComputedStyle(parent);
                const opacity=parent===element&&state.sourceLease?state.sourceLease.computedOpacity:style.opacity;
                if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||opacity==='0')return false;
                if(parent===document.documentElement||parent===document.scrollingElement)continue;
                if(/^(hidden|clip|auto|scroll)$/.test(style.overflowX)||/^(hidden|clip|auto|scroll)$/.test(style.overflowY)){
                    const bounds=parent.getBoundingClientRect();
                    if(/^(hidden|clip|auto|scroll)$/.test(style.overflowX)){left=Math.max(left,bounds.left);right=Math.min(right,bounds.right);}
                    if(/^(hidden|clip|auto|scroll)$/.test(style.overflowY)){top=Math.max(top,bounds.top);bottom=Math.min(bottom,bounds.bottom);}
                }
            }
            if(right<=left||bottom<=top||typeof document.elementFromPoint!=='function')return false;
            const x=(left+right)/2,y=(top+bottom)/2;
            let hit=document.elementFromPoint(x,y);
            if(hit===host||host?.contains(hit)||hit===readingHost||readingHost?.contains(hit))hit=document.elementsFromPoint?.(x,y)
                .find(item=>item!==host&&!host?.contains(item)&&item!==readingHost&&!readingHost?.contains(item))??null;
            return !!hit&&(hit===element||hit.contains(element)||ports.acceptsInteractionLayer?.(canvas,hit)===true);
        } catch {return false;}
    }

    async function readLines(canvas:T, signal:AbortSignal):Promise<MangaReadingResult> {
        if(signal.aborted)return {status:'cancelled'};
        if(ports.source&&!ports.source.readingIdentity)return {status:'unavailable'};
        const state=states.get(canvas);
        if(!state)return {status:'unavailable'};
        if(!state.completed)return {status:state.failed?'error':'pending'};
        const current=()=>{try{return !disposed&&!signal.aborted&&!document.hidden&&states.get(canvas)===state&&state.showing&&!state.validationPending
            && anchor(canvas).isConnected&&ports.enabled()&&readingIdentity(canvas)===state.identity;}catch{return false;}};
        if(!current())return {status:'stale'};
        let original:HTMLCanvasElement|undefined;
        let failure:MangaReadingResult|undefined;
        try {
            if(!ports.source) {
                // 可取消地重捕获已发布的完整像素；这是捕获时刻验证，不能保证之后的无事件重绘。
                if(readingImageEncodingBusy())return {status:'unavailable'};
                original=document.createElement('canvas');captureNative(canvas,original);
                const image=await encodeReadingImageCanvas(original,signal);if(!current())return {status:signal.aborted?'cancelled':'stale'};
                // 摘要本身无法物理取消，等待前先释放整页临时画布。
                original.width=original.height=0;original=undefined;
                // data URL 已编码完成；限制后续 UTF-8 摘要输入，不代表浏览器内部编码的硬内存峰值。
                if(image.length>32*1024*1024)return {status:'overBudget'};
                const digest=await imageDigest(image);if(!current())return {status:signal.aborted?'cancelled':'stale'};
                if(`${state.identity}:${digest}`!==state.contentKey)return {status:'stale'};
            }
            const cached=ports.cacheEnabled()&&state.contentKey?lightCache.get(state.contentKey):undefined;
            const lines=cached?.lines ?? (state.readingKey===undefined?undefined:ports.readingSnapshots?.get(state.readingKey));
            if(!lines)return {status:state.readingFailure ?? 'unavailable'};
            const prepared=prepareMangaReadingLines(lines);
            if(prepared.status!=='ready')return {status:prepared.status==='overBudget'?'overBudget':'error'};
            return prepared.lines.length?{status:'ready',lines:prepared.lines}:{status:'empty'};
        } catch {
            failure=signal.aborted?{status:'cancelled'}:{status:'error'};
        }
        finally {if(original)original.width=original.height=0;}
        return failure!;
    }
    const clear = () => {Array.from(states.keys()).forEach(release);lightCache.clear();};
    return {
        identity, readingIdentity, readingVisible, translate, reuse, release, update, invalidate, readLines,
        readingVersion(canvas:T):object|undefined {const state=states.get(canvas);return state?.completed?state:undefined;},
        refreshLanguage() {states.forEach(state => state.recovery?.refreshLanguage());},
        failed: (canvas: T) => states.get(canvas)?.failed === true,
        restore(canvas: T) {
            const state = states.get(canvas);
            if (state) {if(state.readingKey!==undefined)ports.readingSnapshots?.remove(state.readingKey);state.readingKey=undefined;restoreSource(canvas, state);state.presentation?.hide();state.controller?.abort();state.showing = false;state.surface?.remove();state.recovery?.dispose();state.recovery = null;}
        },
        resetCache: clear,
        dispose() {disposed = true;clear();if (sample) sample.width = sample.height = 0;host?.remove();host = null;root = null;},
    };
}
