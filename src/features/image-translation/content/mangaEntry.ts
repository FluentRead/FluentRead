/**
 * @file src/features/image-translation/content/mangaEntry.ts
 * 文件职责：将安静的独立漫画按钮和按需资源确认挂载到隔离 Shadow UI，并桥接真实会话、资源检查与持久偏好。
 * 主要内容：用地址识别阅读页，在已有 Shadow UI 中持有唯一按需文字面板；主入口和悬浮球共享打开状态与可信触发目标，不自动读取；注册实际宿主并按实例释放。订阅会话和配置，卸载即时退订，挂载所有权防止迟到实例影响新入口。
 * 模块边界：仅编排 feature 内部 UI 与公共配置、浏览器消息端口，不下载模型、不实现翻译，宿主脚本不能通过合成 DOM 事件发起动作。
 */
import {reactive} from 'vue';
import browser from 'webextension-polyfill';
import type {ContentScriptContext} from 'wxt/utils/content-script-context';
import {createVueShadowUi, type VueShadowMount} from '@/src/platform/shadow-ui';
import type {ShadowRootContentScriptUi} from 'wxt/utils/content-script-ui/shadow-root';
import {config, requestConfigPatch, subscribeConfig} from '@/src/services/config/store';
import {isFloatingBallDisabledOnSite} from '@/src/core/site-rules/domain';
import {resolveMangaSite, resolveMangaSourceLanguage} from '@/src/core/config/manga';
import MangaEntry from '../ui/MangaEntry.vue';
import {subscribeMangaTranslation, toggleMangaTranslation, getMangaReadingCandidates, readMangaReadingCandidate, observeMangaReadingCandidate, registerMangaReadingOverlayHost, registerMangaReadingOpener} from './runtime';
import type {MangaTranslationStatus} from './mangaSession';
import {getMangaOcrEngine, getRequiredImageOcrLanguages, normalizeImageOcrLanguageCodes, type ImageOcrStatusResponse} from '../ocrLanguages';

let ui: ShadowRootContentScriptUi<VueShadowMount> | null = null;
let pending: Promise<void> | null = null;
let owner = 0;
let cleanup: (() => void) | undefined;
let readingOpen = false;
const readingListeners = new Set<(open:boolean)=>void>();
let canRead: (()=>boolean) | undefined;
function publishReading(open:boolean):void {
    if (readingOpen === open) return;
    readingOpen = open;
    for (const listener of Array.from(readingListeners)) if (readingListeners.has(listener)) {try {listener(open);} catch {/* 订阅者不影响阅读 */}}
}
export function subscribeMangaReading(listener:(open:boolean)=>void):()=>void {
    readingListeners.add(listener);try {listener(readingOpen);} catch {/* 不影响其他订阅者 */}
    return () => {readingListeners.delete(listener);};
}
export function isMangaReaderPage(href = typeof location === 'undefined' ? '' : location.href): boolean {return !!resolveMangaSite(href, config.imageTranslationMangaSites);}
export function isImageTranslatorNeeded(): boolean {return config.on && (!config.disableImageTranslator || (config.imageTranslationMangaEnabled && isMangaReaderPage()));}

export function mountMangaEntry(ctx: ContentScriptContext, ports: {startAreaTranslation?: () => boolean | Promise<boolean>} = {}): Promise<void> {
    if (ui || pending) return pending ?? Promise.resolve();
    const request = ++owner;
    const status = reactive<MangaTranslationStatus>({available: false, active: false, pending: false, errors: 0});
    const readingState = reactive({open:false});
    const theme = () => config.theme === 'dark' || config.theme === 'light' ? config.theme : 'auto';
    const reading = reactive({list:getMangaReadingCandidates,read:readMangaReadingCandidate,observe:observeMangaReadingCandidate,
        copy:(text:string)=>navigator.clipboard.writeText(text),theme:theme()});
    const allowed = () => config.on && config.imageTranslationMangaEnabled && status.available && status.active && !status.areaFallback;
    canRead = allowed;
    const sourceLanguage = () => resolveMangaSourceLanguage(location.href, config.from, config.imageTranslationMangaSites);
    const settings = reactive({sourceLanguage: sourceLanguage(), promptEnabled: config.imageTranslationMangaPromptEnabled, floatingBallVisible: !config.disableFloatingBall && !isFloatingBallDisabledOnSite(location.href, config.floatingBallDisabledDomains), to: config.to,
        service: config.imageTranslationService, downloadConfirmed: config.imageTranslationMangaDownloadConfirmed, animations: config.animations, toolsDisplay: config.floatingBallToolsDisplay ?? 'always', prefetchPages: config.imageTranslationMangaPrefetchPages});
    const page = reactive({site: resolveMangaSite(location.href, config.imageTranslationMangaSites)?.name ?? '', route: location.href});
    const sync = () => {Object.assign(settings, {sourceLanguage: sourceLanguage(), promptEnabled: config.imageTranslationMangaPromptEnabled, floatingBallVisible: !config.disableFloatingBall && !isFloatingBallDisabledOnSite(location.href, config.floatingBallDisabledDomains), to: config.to,
        service: config.imageTranslationService, downloadConfirmed: config.imageTranslationMangaDownloadConfirmed, animations: config.animations, toolsDisplay: config.floatingBallToolsDisplay ?? 'always', prefetchPages: config.imageTranslationMangaPrefetchPages});
        reading.theme = theme();Object.assign(page, {site: resolveMangaSite(location.href, config.imageTranslationMangaSites)?.name ?? '', route: location.href});};
    const stopOpener = registerMangaReadingOpener(event => openMangaReading(event, false));
    const stopStatus = subscribeMangaTranslation(value => Object.assign(status, value));
    const stopConfig = subscribeConfig(sync);
    document.addEventListener('fluentread-route-change', sync);
    let removed = false;
    let releaseOverlay: (()=>void) | undefined;
    const remove = () => {
        if (removed) return;
        removed = true;
        stopOpener();stopStatus();stopConfig();releaseOverlay?.();releaseOverlay = undefined;document.removeEventListener('fluentread-route-change', sync);
        if (cleanup === remove) {cleanup = undefined;if(canRead===allowed)canRead=undefined;publishReading(false);}
    };
    cleanup = remove;
    pending = createVueShadowUi(ctx, {name: 'fluent-read-manga-entry', hostId: 'fluent-read-manga-entry-container', component: MangaEntry, mode: 'closed',
        props: {status, settings, page,reading,readingState,readManga:openMangaReading,
            readingChanged:(open:boolean)=>{if(request===owner && !removed){readingState.open=open;publishReading(open);}},
            startAreaTranslation: async () => config.on && config.imageTranslationMangaEnabled && status.available && status.areaFallback === true
                && await (ports.startAreaTranslation?.() ?? false),
            toggle: () => {if (config.on && config.imageTranslationMangaEnabled) toggleMangaTranslation();},
            inspectResources: async () => {
                const sourceLanguage = resolveMangaSourceLanguage(location.href, config.from, config.imageTranslationMangaSites);
                const result = await browser.runtime.sendMessage({type: 'fluentReadMangaModelStatus'}) as {success?: boolean; ready?: boolean; inpaintingReady?: boolean; error?: string};
                if (!result?.success) throw new Error(result?.error || '阅读资源状态读取失败，请重试');
                if (getMangaOcrEngine(sourceLanguage) === 'tesseract') {
                    const status = await browser.runtime.sendMessage({type: 'fluentReadImageOcrStatus'}) as ImageOcrStatusResponse;
                    if (!status?.success) throw new Error(status?.error || '阅读资源状态读取失败，请重试');
                    const downloaded = new Set(normalizeImageOcrLanguageCodes(status.languages));
                    return result.inpaintingReady === true && getRequiredImageOcrLanguages(sourceLanguage).every(language => downloaded.has(language));
                }
                return result.ready === true && result.inpaintingReady === true;
            },
            persist: (patch: Record<string, unknown>) => requestConfigPatch(patch, message => browser.runtime.sendMessage(message)),
            openSettings: () => {void browser.runtime.sendMessage({type: 'openOptionsPage', section: 'settings-image-translation'}).catch(() => undefined);},
        },
    }).then(value => {if (request !== owner || !config.on || !config.imageTranslationMangaEnabled || !isMangaReaderPage()) {value.remove();remove();return;}
        // 与译图使用同一根层级，避免被 Pixiv 的 body 堆叠上下文压到译图下方。
        try {if (value.shadowHost) {document.documentElement.appendChild(value.shadowHost);releaseOverlay=registerMangaReadingOverlayHost(value.shadowHost);}}
        catch (error) {value.remove();throw error;}
        ui = value;})
        .catch(error => {remove();throw error;}).finally(() => {if (request === owner) pending = null;});
    return pending;
}
export function openMangaEntry(): boolean {
    const instance = ui?.mounted?.instance as {open?: () => void} | undefined;
    if (!instance?.open) return false;
    instance.open();return true;
}
export function openMangaReading(event: MouseEvent, toggle = true):boolean {
    if (!event.isTrusted || !canRead?.()) return false;
    const target = event.currentTarget as HTMLElement | null;
    const current = ui;
    const instance = current?.mounted?.instance as {openReading?: (event:Event,target:HTMLElement)=>Promise<boolean>;closeReading?:()=>void} | undefined;
    if (!target?.isConnected || typeof target.focus !== 'function' || !instance?.openReading) return false;
    if (readingOpen) {if (!toggle) return true;if (!instance.closeReading) return false;instance.closeReading();return true;}
    void instance.openReading(event,target).catch(() => {if(ui===current){instance.closeReading?.();publishReading(false);}});return true;
}
export function unmountMangaEntry(): void {owner++;pending = null;cleanup?.();cleanup = undefined;ui?.remove();ui = null;}
