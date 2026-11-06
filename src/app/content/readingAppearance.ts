/**
 * @file src/app/content/readingAppearance.ts
 * 文件职责：把独立阅读外观功能接入内容脚本的既有配置与共享译文字体控制器。
 * 主要内容：为当前文档创建字体控制器，使用现有配置补丁协议保存网站偏好，生成隔离的文档令牌。
 * 模块边界：仅承担 composition 接线；字体识别和会话状态属于 feature，持久化属于 config 服务。
 */
import {createReadingAppearanceController} from '@/src/features/reading-appearance/content';
import {createReadingAppearanceRuntime} from '@/src/features/reading-appearance/runtime';
import type {PageTranslationFontRuntime} from './pageTranslationFont';
import {config, requestConfigPatch} from '@/src/services/config/store';
export function createContentReadingAppearance(document: Document, enabled: () => boolean, href = () => document.location.href, translationFont?: Pick<PageTranslationFontRuntime, 'setReadingSystem'>) {
    const controller = createReadingAppearanceController(document);
    return createReadingAppearanceRuntime({
        href, enabled,
        sites: () => config.readingAppearanceSites ?? {},
        persist: sites => requestConfigPatch({readingAppearanceSites: sites}, message => browser.runtime.sendMessage(message)),
        controller: {
            setEnabled(value) {controller.setEnabled(value); translationFont?.setReadingSystem(value);},
            dispose() {controller.dispose(); translationFont?.setReadingSystem(false);},
        },
        documentToken: typeof crypto.randomUUID === 'function' ? crypto.randomUUID()
            : Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16).padStart(8, '0')).join(''),
    });
}
