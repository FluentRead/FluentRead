/**
 * @file userscript/uiLanguageBundles.ts
 * 文件职责：按需加载并注册 userscript 的六种非中文界面语言。
 * 主要内容：英文内嵌 gzip，standalone 同序键列复用已恢复的默认中文；合法旧对象与完整列格式不依赖共享状态。其他语言从静态 JSON 获取并缓存在 GM 私有存储中，注册前应用本地 gzip 增量；保留固定远程资源、私有缓存与发布提交号。
 * 模块边界：只注册核心 i18n 资源，不访问宿主网页存储；扩展继续使用自己的按需资源加载器。
 */
import {
    hasUiLanguageBundle,
    normalizeUiLanguage,
    registerUiLanguageBundle,
    type RegisteredUiLanguage,
    type UiLanguageBundle,
} from '@/src/core/i18n';
import type {EnsureUiLanguageBundle, renderWithUiLanguageBundle as RenderWithUiLanguageBundle} from '@/src/platform/i18n/uiLanguageBundles';
import {inflateGzipBase64} from './compression';
import {userscriptFetch} from './http';
import {getStoredValue, setStoredValue} from './storage';
import type {UserscriptLanguageUpdate} from './languageBundles';
import {unpackLanguageUpdates, unpackUiLanguageBundle} from './languageData';
import {readDefaultMessageKeys} from './defaultMessageData';

const pending = new Map<RegisteredUiLanguage, Promise<boolean>>();

let updates: Promise<Readonly<Partial<Record<RegisteredUiLanguage, UserscriptLanguageUpdate>>>> | undefined;

/** 只解压一次本地静态覆盖，失败时允许下次选择语言重新尝试。 */
function loadUpdates(): Promise<Readonly<Partial<Record<RegisteredUiLanguage, UserscriptLanguageUpdate>>>> {
    if (!updates) {
        const compressed = typeof __FLUENTREAD_USERSCRIPT_LANGUAGE_UPDATES__ === 'string' ? __FLUENTREAD_USERSCRIPT_LANGUAGE_UPDATES__ : '';
        updates = (compressed ? inflateGzipBase64(compressed).then(value => unpackLanguageUpdates(JSON.parse(value))) : Promise.resolve({}))
            .catch(error => {updates = undefined;throw error;});
    }
    return updates;
}

/** 稳定 key 与旧说明按当前资源覆盖；模板用位置还原，保留重复正则的本地译文和后备译文次序。 */
function applyUpdate(bundle: UiLanguageBundle, update: UserscriptLanguageUpdate | undefined): UiLanguageBundle {
    if (!update) return bundle;
    if (!isBundle(update)) throw new TypeError('界面语言增量格式无效');
    const phase = (name: 'early' | 'late') => {
        const order = update.patternOrder?.[name];
        if (order === undefined) return bundle.legacyPatterns[name];
        if (!Array.isArray(order)) throw new TypeError('界面语言模板增量格式无效');
        return order.map(index => {
            if (!Number.isSafeInteger(index)) throw new TypeError('界面语言模板增量格式无效');
            const entry = index >= 0 ? bundle.legacyPatterns[name][index] : update.legacyPatterns[name][-index - 1];
            if (!entry) throw new TypeError('界面语言模板增量位置无效');
            return entry;
        });
    };
    return {messages: {...bundle.messages, ...update.messages}, legacyText: {...bundle.legacyText, ...update.legacyText},
        legacyPatterns: {early: phase('early'), late: phase('late')}};
}

async function inflateBundle(base64: string): Promise<UiLanguageBundle> {
    return unpackUiLanguageBundle(JSON.parse(await inflateGzipBase64(base64)), readDefaultMessageKeys());
}

function isBundle(value: unknown): value is UiLanguageBundle {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const candidate = value as Partial<UiLanguageBundle>;
    return Boolean(candidate.messages && typeof candidate.messages === 'object' && !Array.isArray(candidate.messages)
        && Object.values(candidate.messages).every((message) => typeof message === 'string')
        && candidate.legacyText && typeof candidate.legacyText === 'object' && !Array.isArray(candidate.legacyText)
        && Object.values(candidate.legacyText).every((message) => typeof message === 'string')
        && Array.isArray(candidate.legacyPatterns?.early)
        && Array.isArray(candidate.legacyPatterns?.late)
        && [...candidate.legacyPatterns.early, ...candidate.legacyPatterns.late].every((entry) => Array.isArray(entry)
            && typeof entry[0] === 'string' && typeof entry[1] === 'string'
            && (entry[2] === undefined || (Array.isArray(entry[2]) && entry[2].every(Number.isSafeInteger)))));
}

async function fetchRemoteBundle(fileName: string): Promise<UiLanguageBundle> {
    const cacheKey = `fluentread:ui-language:${fileName}`;
    const cached = await getStoredValue<UiLanguageBundle>(cacheKey).catch(() => null);
    if (isBundle(cached)) return cached;

    const sources = [
        `https://cdn.jsdelivr.net/gh/FluentRead/FluentRead@${__FLUENTREAD_USERSCRIPT_RESOURCE_COMMIT__}/userscript/languages/${fileName}`,
        `https://raw.githubusercontent.com/FluentRead/FluentRead/${__FLUENTREAD_USERSCRIPT_RESOURCE_COMMIT__}/userscript/languages/${fileName}`,
    ];
    let lastError: unknown;
    for (const url of sources) {
        try {
            const response = await userscriptFetch(url, {credentials: 'omit'});
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const bundle = await response.json();
            if (!isBundle(bundle)) throw new TypeError('界面语言资源格式无效');
            // GM 私有存储只是离线缓存；缓存失败不影响本次显示。
            await setStoredValue(cacheKey, bundle).catch(() => undefined);
            return bundle;
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError;
}

export const ensureUiLanguageBundle: EnsureUiLanguageBundle = (value) => {
    const language = normalizeUiLanguage(value);
    if (hasUiLanguageBundle(language)) return Promise.resolve(true);
    const registered = language as RegisteredUiLanguage;
    const embedded = registered === 'en-US' ? globalThis.__FLUENTREAD_USERSCRIPT_DATA__?.english : undefined;
    const compressed = __FLUENTREAD_USERSCRIPT_LANGUAGE_BUNDLES__[registered];
    const remoteFile = __FLUENTREAD_USERSCRIPT_REMOTE_LANGUAGES__[registered];
    if (!embedded && !compressed && !remoteFile) return Promise.resolve(false);
    const existing = pending.get(registered);
    if (existing) return existing;
    const request = (embedded ? Promise.resolve(embedded) : compressed ? inflateBundle(compressed) : fetchRemoteBundle(remoteFile))
        .then((bundle) => {
            if (!isBundle(bundle)) throw new TypeError('界面语言资源格式无效');
            return loadUpdates().then(local => {
                registerUiLanguageBundle(registered, applyUpdate(bundle, local[registered]));
                return true;
            });
        })
        .catch((error: unknown) => {
            console.warn('[FluentRead] userscript 界面语言资源不可用', error);
            return false;
        })
        .finally(() => pending.delete(registered));
    pending.set(registered, request);
    return request;
};

export const renderWithUiLanguageBundle: typeof RenderWithUiLanguageBundle = (language, render) => {
    render();
    if (hasUiLanguageBundle(normalizeUiLanguage(language))) return;
    void ensureUiLanguageBundle(language).then((loaded) => { if (loaded) render(); });
};
