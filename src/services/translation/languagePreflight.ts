/**
 * @file src/services/translation/languagePreflight.ts
 * 文件职责：在翻译入队前组合统一纯识别与可选本地浏览器证据，减少可信同语言正文的请求而保留未知和混合内容。
 * 主要内容：本地明确结果优先，只有纯规则批准的长正文才调用平台端口；按完整文本去重并缓存规范证据，目标与排除语言逐次比较；限制两项真实在途调用和一百二十八项短期缓存，检测超时或故障继续翻译，超时同文保持去重至底层结算，每个订阅者可独立取消且不影响其他等待者。
 * 模块边界：本服务不读取页面语言或全局目标配置、不更改原文或 provider 的源语言、不发送网络请求；浏览器不支持该能力时维持纯识别行为，结构化内部包由调用方显式绕过检测。
 */

import {shouldSkipTranslationForTarget} from '@/src/core/language/detect';
import {isLanguageCodeMatch} from '@/src/core/language/codes';
import {acceptSupplementalLanguage, getSupplementalLanguageCandidate} from '@/src/core/language/supplement';
import {detectBrowserLanguage} from '@/src/platform/browser/languageDetection';
import {createTranslationAbortError as aborted} from './errors';

type Detector = (text: string) => Promise<unknown> | undefined;
const TIMEOUT_MS = 120;
const CACHE_TTL_MS = 60_000;
const CACHE_LIMIT = 128;
const MAX_ACTIVE = 2;

/** 单个调用退出等待，不取消同文的其他订阅者；底层 i18n API 本身没有 abort 接口。 */
function subscribe(work: Promise<string | undefined>, signal?: AbortSignal): Promise<string | undefined> {
    if (!signal) return work;
    if (signal.aborted) return Promise.reject(aborted());
    return new Promise((resolve, reject) => {
        const onAbort = (): void => { cleanup(); reject(aborted()); };
        const cleanup = (): void => signal.removeEventListener('abort', onAbort);
        signal.addEventListener('abort', onAbort, {once: true});
        // lookup 的共享工作始终 resolve；平台拒绝由资源所有者转换成未知。
        work.then(value => {cleanup(); resolve(value);});
    });
}

/** 可注入端口供边界测试；每个实例独立拥有在途工作与有界缓存。 */
export function createLanguagePreflight(detector: Detector) {
    const cache = new Map<string, {language: string | undefined; expires: number}>();
    const pending = new Map<string, Promise<string | undefined>>();
    let active = 0;

    const lookup = (text: string, candidate: string): Promise<string | undefined> => {
        const cached = cache.get(text);
        if (cached && cached.expires > Date.now()) {
            cache.delete(text); cache.set(text, cached);
            return Promise.resolve(cached.language);
        }
        cache.delete(text);
        const existing = pending.get(text);
        if (existing) return existing;
        if (active >= MAX_ACTIVE) return Promise.resolve(undefined);
        let request: Promise<unknown> | undefined;
        try { request = detector(text); } catch { return Promise.resolve(undefined); }
        if (!request) return Promise.resolve(undefined);
        active += 1;
        let finish!: (language: string | undefined) => void;
        const work = new Promise<string | undefined>(resolve => {finish = resolve;});
        pending.set(text, work);
        let settled = false;
        const complete = (language: string | undefined): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            finish(language);
        };
        const timer = setTimeout(() => complete(undefined), TIMEOUT_MS);
        request.then(result => {
            active -= 1;
            pending.delete(text);
            if (settled) return;
            const language = acceptSupplementalLanguage(candidate, result);
            cache.set(text, {language, expires: Date.now() + CACHE_TTL_MS});
            if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
            complete(language);
        }, () => { active -= 1; pending.delete(text); complete(undefined); });
        return work;
    };

    return async (text: string, target: string, excluded: readonly string[] = [], signal?: AbortSignal): Promise<boolean> => {
        if (signal?.aborted) throw aborted();
        const languages = [target, ...excluded];
        if (shouldSkipTranslationForTarget(text, target, excluded)) return true;
        const candidate = getSupplementalLanguageCandidate(text);
        if (!candidate || !languages.some(language => isLanguageCodeMatch(candidate, language))) return false;
        const evidence = await subscribe(lookup(text, candidate), signal);
        if (signal?.aborted) throw aborted();
        return evidence !== undefined && languages.some(language => isLanguageCodeMatch(evidence, language));
    };
}

export const shouldSkipTranslationWithEvidence = createLanguagePreflight(detectBrowserLanguage);
