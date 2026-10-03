/**
 * @file src/features/image-translation/content/mangaEntry.ts
 * 文件职责：将安静的独立漫画按钮和按需资源确认挂载到隔离 Shadow UI，并桥接真实会话、资源检查与持久偏好。
 * 主要内容：用地址识别阅读页，按悬浮球和站点显隐显示备用按钮，不自动弹出阅读面板；订阅会话和配置，跨路由同步网站名称；挂载所有权防止关闭后的迟到实例回到页面，卸载清理订阅。
 * 模块边界：仅编排 feature 内部 UI 与公共配置、浏览器消息端口，不下载模型、不实现翻译，宿主脚本不能通过合成 DOM 事件发起动作。
 */
import {reactive} from 'vue';
import browser from 'webextension-polyfill';
import type {ContentScriptContext} from 'wxt/utils/content-script-context';
import {createVueShadowUi, type VueShadowMount} from '@/src/platform/shadow-ui';
import type {ShadowRootContentScriptUi} from 'wxt/utils/content-script-ui/shadow-root';
import {config, requestConfigPatch, subscribeConfig} from '@/src/services/config/store';
import {isFloatingBallDisabledOnSite} from '@/src/core/site-rules/domain';
import {resolveMangaSite} from '@/src/core/config/manga';
import MangaEntry from '../ui/MangaEntry.vue';
import {subscribeMangaTranslation, toggleMangaTranslation} from './runtime';
import type {MangaTranslationStatus} from './mangaSession';

let ui: ShadowRootContentScriptUi<VueShadowMount> | null = null;
let pending: Promise<void> | null = null;
let owner = 0;
let cleanup: (() => void) | undefined;
export function isMangaReaderPage(href = typeof location === 'undefined' ? '' : location.href): boolean {return !!resolveMangaSite(href, config.imageTranslationMangaSites);}
export function isImageTranslatorNeeded(): boolean {return config.on && (!config.disableImageTranslator || (config.imageTranslationMangaEnabled && isMangaReaderPage()));}

export function mountMangaEntry(ctx: ContentScriptContext): Promise<void> {
    if (ui || pending) return pending ?? Promise.resolve();
    const request = ++owner;
    const status = reactive<MangaTranslationStatus>({available: false, active: false, pending: false, errors: 0});
    const settings = reactive({promptEnabled: config.imageTranslationMangaPromptEnabled, floatingBallVisible: !config.disableFloatingBall && !isFloatingBallDisabledOnSite(location.href, config.floatingBallDisabledDomains), to: config.to,
        service: config.imageTranslationService, downloadConfirmed: config.imageTranslationMangaDownloadConfirmed, animations: config.animations, prefetchPages: config.imageTranslationMangaPrefetchPages});
    const page = reactive({site: resolveMangaSite(location.href, config.imageTranslationMangaSites)?.name ?? '', route: location.href});
    const sync = () => {Object.assign(settings, {promptEnabled: config.imageTranslationMangaPromptEnabled, floatingBallVisible: !config.disableFloatingBall && !isFloatingBallDisabledOnSite(location.href, config.floatingBallDisabledDomains), to: config.to,
        service: config.imageTranslationService, downloadConfirmed: config.imageTranslationMangaDownloadConfirmed, animations: config.animations, prefetchPages: config.imageTranslationMangaPrefetchPages});
        Object.assign(page, {site: resolveMangaSite(location.href, config.imageTranslationMangaSites)?.name ?? '', route: location.href});};
    const stopStatus = subscribeMangaTranslation(value => Object.assign(status, value));
    const stopConfig = subscribeConfig(sync);
    document.addEventListener('fluentread-route-change', sync);
    const remove = () => {stopStatus();stopConfig();document.removeEventListener('fluentread-route-change', sync);};
    pending = createVueShadowUi(ctx, {name: 'fluent-read-manga-entry', hostId: 'fluent-read-manga-entry-container', component: MangaEntry, mode: 'closed',
        props: {status, settings, page,
            toggle: () => {if (config.on && config.imageTranslationMangaEnabled) toggleMangaTranslation();},
            inspectResources: async () => {
                const result = await browser.runtime.sendMessage({type: 'fluentReadMangaModelStatus'}) as {success?: boolean; ready?: boolean; inpaintingReady?: boolean; error?: string};
                if (!result?.success) throw new Error(result?.error || '阅读资源状态读取失败，请重试');
                return result.ready === true && result.inpaintingReady === true;
            },
            persist: (patch: Record<string, unknown>) => requestConfigPatch(patch, message => browser.runtime.sendMessage(message)),
            openSettings: () => {void browser.runtime.sendMessage({type: 'openOptionsPage', section: 'settings-image-translation'}).catch(() => undefined);},
        },
    }).then(value => {if (request !== owner || !config.on || !config.imageTranslationMangaEnabled || !isMangaReaderPage()) {value.remove();remove();return;}
        // 与译图使用同一根层级，避免被 Pixiv 的 body 堆叠上下文压到译图下方。
        if (value.shadowHost) document.documentElement.appendChild(value.shadowHost);
        ui = value;cleanup = remove;})
        .catch(error => {remove();throw error;}).finally(() => {if (request === owner) pending = null;});
    return pending;
}
export function openMangaEntry(): boolean {
    const instance = ui?.mounted?.instance as {open?: () => void} | undefined;
    if (!instance?.open) return false;
    instance.open();return true;
}
export function unmountMangaEntry(): void {owner++;pending = null;cleanup?.();cleanup = undefined;ui?.remove();ui = null;}
