/**
 * @file userscript/uiLanguageBundles.ts
 * 文件职责：按需加载并注册 userscript 的六种非中文界面语言。
 * 主要内容：英文内嵌 gzip；其他语言从静态 JSON 获取并缓存在 GM 私有存储中，注册时补齐缺少的错误恢复、AI 翻译超时、局部划选、DeepLX 直连与 MiMo 退役文案，保留已发布远端文件内容与提交号。
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
import {mimoRetirementLegacyText} from '@/src/core/i18n/messages/mimoRetirement';
import {aiRequestTimeoutMessages} from '@/src/core/i18n/messages/aiRequestTimeout';

const pending = new Map<RegisteredUiLanguage, Promise<boolean>>();

type RecoveryMessages = Readonly<Record<'learning.panelLoadError' | 'learning.reloadPage', string>>;
// 固定远程词典保持原发布内容；仅在注册时补齐缺少的恢复文案。
const recoveryMessages: Readonly<Partial<Record<RegisteredUiLanguage, RecoveryMessages>>> = {
    'ja-JP': {
        "learning.panelLoadError": "この項目を開けませんでした。ページを再読み込みして、もう一度お試しください。",
        "learning.reloadPage": "ページを再読み込み",
    },
    'ko-KR': {
        "learning.panelLoadError": "이 항목을 열 수 없습니다. 페이지를 새로고침한 후 다시 시도하세요.",
        "learning.reloadPage": "페이지 새로고침",
    },
    'fr-FR': {
        "learning.panelLoadError": "Cette section n’a pas pu être ouverte. Rechargez la page pour réessayer.",
        "learning.reloadPage": "Recharger la page",
    },
    'ru-RU': {
        "learning.panelLoadError": "Не удалось открыть этот раздел. Перезагрузите страницу и попробуйте снова.",
        "learning.reloadPage": "Перезагрузить страницу",
    },
    'es-ES': {
        "learning.panelLoadError": "No se pudo abrir esta sección. Recarga la página para volver a intentarlo.",
        "learning.reloadPage": "Recargar página",
    },
};

const sectionSweepMessages: Readonly<Partial<Record<RegisteredUiLanguage, Readonly<Record<string, string>>>>> = {
    "ja-JP": {
        "sectionTranslation.picker.preview": "マウスでプレビュー、クリックまたはドラッグで選択",
        "popup.sectionTranslationTitle": "部分翻訳：クリックまたはドラッグで選択して確定",
        "sectionTranslation.picker.instruction": "クリックまたはドラッグで翻訳する範囲を選択",
        "sectionTranslation.picker.dragging": "ドラッグで選択し、離してから確定",
        "sectionTranslation.scope.selected": "{count} 個の範囲を選択"
    },
    "ko-KR": {
        "sectionTranslation.picker.preview": "마우스로 미리 보고 클릭하거나 드래그하여 선택",
        "popup.sectionTranslationTitle": "부분 번역: 클릭하거나 드래그하여 선택한 뒤 확인",
        "sectionTranslation.picker.instruction": "클릭하거나 드래그하여 번역할 영역 선택",
        "sectionTranslation.picker.dragging": "드래그하여 선택하고 놓은 뒤 확인",
        "sectionTranslation.scope.selected": "선택한 영역 {count}개"
    },
    "fr-FR": {
        "sectionTranslation.picker.preview": "Survolez pour prévisualiser ; cliquez ou glissez pour sélectionner",
        "popup.sectionTranslationTitle": "Traduction partielle : cliquez ou glissez pour sélectionner, puis confirmez",
        "sectionTranslation.picker.instruction": "Cliquez ou glissez pour sélectionner les zones à traduire",
        "sectionTranslation.picker.dragging": "Glissez pour sélectionner, relâchez puis confirmez",
        "sectionTranslation.scope.selected": "{count} zones sélectionnées"
    },
    "ru-RU": {
        "sectionTranslation.picker.preview": "Наведите курсор для предпросмотра; нажмите или протяните для выбора",
        "popup.sectionTranslationTitle": "Перевод фрагмента: нажмите или протяните для выбора, затем подтвердите",
        "sectionTranslation.picker.instruction": "Нажмите или протяните, чтобы выбрать области для перевода",
        "sectionTranslation.picker.dragging": "Протяните для выбора, отпустите и подтвердите",
        "sectionTranslation.scope.selected": "Выбрано областей: {count}"
    },
    "es-ES": {
        "sectionTranslation.picker.preview": "Mueve el ratón para previsualizar; haz clic o arrastra para seleccionar",
        "popup.sectionTranslationTitle": "Traducción parcial: haz clic o arrastra para seleccionar y confirma",
        "sectionTranslation.picker.instruction": "Haz clic o arrastra para seleccionar las zonas que quieres traducir",
        "sectionTranslation.picker.dragging": "Arrastra para seleccionar, suelta y confirma",
        "sectionTranslation.scope.selected": "{count} zonas seleccionadas"
    }
};

const deeplxMessages: Readonly<Partial<Record<RegisteredUiLanguage, Readonly<Record<string, string>>>>> = {
    'en-US': {
        'settings.services.deeplx.defaultRoute': 'Direct to DeepL by default',
        'settings.services.deeplx.endpointHelp': 'Without an API key, the default connects directly to DeepL, then tries the public endpoint on failure. Custom URLs need the full path (usually ending in /translate); paths are not added automatically.',
    },
    'ja-JP': {
        'settings.services.deeplx.defaultRoute': '既定：DeepL に直接接続',
        'settings.services.deeplx.endpointHelp': 'API Key が未設定の場合、既定では DeepL に直接接続し、失敗時に公開 API を使用します。カスタム URL は完全なパス（通常は /translate で終わる）が必要です。パスは自動追加されません。',
    },
    'ko-KR': {
        'settings.services.deeplx.defaultRoute': '기본: DeepL 직접 연결',
        'settings.services.deeplx.endpointHelp': 'API Key가 없으면 기본적으로 DeepL에 직접 연결하고, 실패하면 공개 API를 사용합니다. 사용자 지정 주소에는 전체 경로(보통 /translate로 끝남)가 필요하며 경로는 자동으로 추가되지 않습니다.',
    },
    'fr-FR': {
        'settings.services.deeplx.defaultRoute': 'Connexion directe à DeepL par défaut',
        'settings.services.deeplx.endpointHelp': 'Sans clé API, la connexion par défaut se fait directement à DeepL, puis au service public en cas d’échec. Une URL personnalisée doit inclure le chemin complet (généralement /translate) ; le chemin n’est pas ajouté automatiquement.',
    },
    'ru-RU': {
        'settings.services.deeplx.defaultRoute': 'По умолчанию — напрямую к DeepL',
        'settings.services.deeplx.endpointHelp': 'Без API-ключа по умолчанию используется прямое подключение к DeepL, а при сбое — публичный API. Укажите полный путь в своём URL (обычно /translate); путь не добавляется автоматически.',
    },
    'es-ES': {
        'settings.services.deeplx.defaultRoute': 'Conexión directa a DeepL por defecto',
        'settings.services.deeplx.endpointHelp': 'Sin clave API, la conexión predeterminada es directa a DeepL; si falla, se usa el servicio público. Las URL personalizadas necesitan la ruta completa (normalmente /translate); no se añade automáticamente.',
    },
};

async function inflateBundle(base64: string): Promise<UiLanguageBundle> {
    return JSON.parse(await inflateGzipBase64(base64)) as UiLanguageBundle;
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
            const recovery = recoveryMessages[registered];
            registerUiLanguageBundle(registered, {...bundle, messages: {
                ...recovery, ...bundle.messages, ...aiRequestTimeoutMessages[registered], ...sectionSweepMessages[registered],
                ...deeplxMessages[registered],
            }, legacyText: {...bundle.legacyText, ...mimoRetirementLegacyText[registered]}});
            return true;
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
