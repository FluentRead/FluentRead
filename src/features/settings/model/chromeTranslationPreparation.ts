/**
 * @file src/features/settings/model/chromeTranslationPreparation.ts
 * 文件职责：在扩展设置页检查浏览器翻译语言包，并从用户点击中准备 Chrome 或 Edge 的设备端模型。
 * 主要内容：解析自检语言对，首次等待前同步启动两个现代 API；转发有界进度，状态回调取消后停止后续操作，消费取消时的迟到拒绝；私有固定校验样例按自身语言键精化泛中文检测结果，验证置信度、语言与翻译并释放资源。
 * 模块边界：本模块只服务设置页的主动连接检查，不读写配置、不发送 runtime 消息、不兼容 legacy translation API，也不参与网页正文的正式翻译链路。
 */

import {normalizeChineseLanguageCode, getChineseScript} from '@/src/core/language/chinese';
import {MIN_CHROME_LANGUAGE_CONFIDENCE} from '@/src/core/language/confidence';

export type ChromePreparationModel = 'language-detector' | 'translator';
export type ChromePreparationPhase = 'initializing' | 'downloading' | 'verifying';

export interface ChromeTranslationPreparationPair {
    readonly sourceLanguage: string;
    readonly targetLanguage: string;
    readonly sampleText: string;
}

export interface ChromeTranslationPreparationStatus {
    readonly phase: ChromePreparationPhase;
    readonly sourceLanguage: string;
    readonly targetLanguage: string;
    readonly model?: ChromePreparationModel;
    readonly loaded?: number;
}

export interface ChromeTranslationPreparationResult extends ChromeTranslationPreparationPair {
    readonly detectedLanguage: string;
    readonly translatedText: string;
}

interface ChromePreparationMonitor {
    addEventListener(
        type: 'downloadprogress',
        listener: (event: {readonly loaded?: unknown}) => void,
    ): void;
}

interface ChromePreparationCreateOptions {
    monitor?: (monitor: ChromePreparationMonitor) => void;
    signal?: AbortSignal;
}

interface ChromePreparationDetector {
    detect(text: string, options?: {signal?: AbortSignal}): Promise<unknown>;
    destroy?: () => void;
}

interface ChromePreparationTranslator {
    translate(text: string, options?: {signal?: AbortSignal}): Promise<unknown>;
    destroy?: () => void;
}

export interface ChromeTranslationPreparationEnvironment {
    readonly LanguageDetector?: {
        create(options?: ChromePreparationCreateOptions): Promise<ChromePreparationDetector>;
    };
    readonly Translator?: {
        availability?(pair: {sourceLanguage: string; targetLanguage: string}): Promise<unknown>;
        create(options: ChromePreparationCreateOptions & {
            sourceLanguage: string;
            targetLanguage: string;
        }): Promise<ChromePreparationTranslator>;
    };
}

export type ChromeLanguagePackAvailability = 'available' | 'downloadable' | 'downloading' | 'unavailable';

/** 状态预览只读浏览器的语言包状态，不触发模型下载。 */
export async function readChromeLanguagePackAvailability(
    {sourceLanguage, targetLanguage}: Pick<ChromeTranslationPreparationPair, 'sourceLanguage' | 'targetLanguage'>,
    environment: ChromeTranslationPreparationEnvironment = globalThis as unknown as ChromeTranslationPreparationEnvironment,
): Promise<ChromeLanguagePackAvailability | undefined> {
    try {
        const status = await environment.Translator?.availability?.({sourceLanguage, targetLanguage});
        if (status === 'available' || status === 'downloadable' || status === 'downloading' || status === 'unavailable') {
            return status;
        }
    } catch {
        // 旧接口或探测失败时仍允许用户主动检查。
    }
    return undefined;
}

export interface ChromeTranslationPreparationOptions {
    readonly from: string;
    readonly to: string;
    readonly signal?: AbortSignal;
    readonly onStatus?: (status: ChromeTranslationPreparationStatus) => void;
}

export interface ChromeTranslationPreparationLanguage {
    readonly value: string;
    readonly label: string;
}

export type ChromeTranslationPreparationErrorCode =
    | 'invalid-language-code'
    | 'sample-unavailable'
    | 'aborted'
    | 'invalid-detection'
    | 'api-unavailable'
    | 'user-activation-required'
    | 'model-unavailable'
    | 'detection-mismatch'
    | 'invalid-translation'
    | 'preparation-failed';

/** 保留稳定错误语义，交由设置 UI 按当前界面语言呈现。 */
export class ChromeTranslationPreparationError extends Error {
    constructor(
        readonly code: ChromeTranslationPreparationErrorCode,
        message: string,
        readonly params: Readonly<Record<string, string>> = {},
    ) {
        super(message);
        this.name = 'ChromeTranslationPreparationError';
    }
}

/** Chrome 官方语言与自检样本目录，不作为运行时可用性的替代。https://developer.chrome.com/docs/ai/translator-api */
export const CHROME_TRANSLATION_PREPARATION_LANGUAGES: readonly ChromeTranslationPreparationLanguage[] = Object.freeze([
    {value: 'ar', label: '阿拉伯语'}, {value: 'bg', label: '保加利亚语'},
    {value: 'bn', label: '孟加拉语'}, {value: 'cs', label: '捷克语'},
    {value: 'da', label: '丹麦语'}, {value: 'de', label: '德语'},
    {value: 'el', label: '希腊语'}, {value: 'en', label: '英语'},
    {value: 'es', label: '西班牙语'}, {value: 'fi', label: '芬兰语'},
    {value: 'fr', label: '法语'}, {value: 'he', label: '希伯来语'},
    {value: 'hi', label: '印地语'}, {value: 'hr', label: '克罗地亚语'},
    {value: 'hu', label: '匈牙利语'}, {value: 'id', label: '印度尼西亚语'},
    {value: 'it', label: '意大利语'}, {value: 'ja', label: '日语'},
    {value: 'kn', label: '卡纳达语'}, {value: 'ko', label: '韩语'},
    {value: 'lt', label: '立陶宛语'}, {value: 'mr', label: '马拉地语'},
    {value: 'nl', label: '荷兰语'}, {value: 'no', label: '挪威语'},
    {value: 'pl', label: '波兰语'}, {value: 'pt', label: '葡萄牙语'},
    {value: 'ro', label: '罗马尼亚语'}, {value: 'ru', label: '俄语'},
    {value: 'sk', label: '斯洛伐克语'}, {value: 'sl', label: '斯洛文尼亚语'},
    {value: 'sv', label: '瑞典语'}, {value: 'ta', label: '泰米尔语'},
    {value: 'te', label: '泰卢固语'}, {value: 'th', label: '泰语'},
    {value: 'tr', label: '土耳其语'}, {value: 'uk', label: '乌克兰语'},
    {value: 'vi', label: '越南语'}, {value: 'zh', label: '简体中文'},
    {value: 'zh-Hant', label: '繁体中文'},
]);

/** 自动选择的检查语言使用当前界面的语言名称呈现。 */
export function getChromeTranslationPreparationLanguageLabel(
    value: string,
    uiLanguage: string,
): string {
    const fallback = CHROME_TRANSLATION_PREPARATION_LANGUAGES.find((item) => item.value === value)?.label || value;
    const displayLanguage = value === 'zh' ? 'zh-Hans' : value;
    try {
        return new Intl.DisplayNames([uiLanguage], {type: 'language'}).of(displayLanguage) || fallback;
    } catch {
        return fallback;
    }
}

const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/iu;

const TEST_SAMPLES: Readonly<Record<string, string>> = {
    en: 'The local translation model should understand this complete English sentence.',
    fr: 'Le modèle de traduction locale doit comprendre cette phrase française complète.',
    zh: '这是简体中文，请把这段完整文字翻译成其他语言。',
    'zh-Hant': '這是繁體中文，請把這段完整文字翻譯成其他語言。',
    ja: 'ローカル翻訳モデルがこの日本語の文章を理解できるか確認します。',
    ko: '로컬 번역 모델이 이 한국어 문장을 이해하는지 확인합니다.',
    de: 'Das lokale Übersetzungsmodell soll diesen vollständigen deutschen Satz verstehen.',
    es: 'El modelo de traducción local debe comprender esta oración completa en español.',
    ru: 'Локальная модель перевода должна понимать это полное русское предложение.',
    it: 'Il modello di traduzione locale deve comprendere questa frase italiana completa.',
    pt: 'O modelo de tradução local deve compreender esta frase completa em português.',
    ar: 'يجب أن يفهم نموذج الترجمة المحلي هذه الجملة العربية الكاملة.',
    hi: 'स्थानीय अनुवाद मॉडल को इस पूरे हिन्दी वाक्य को समझना चाहिए।',
    th: 'โมเดลแปลภาษาในเครื่องควรเข้าใจประโยคภาษาไทยที่สมบูรณ์นี้',
    vi: 'Mô hình dịch cục bộ phải hiểu được câu tiếng Việt hoàn chỉnh này.',
    nl: 'Het lokale vertaalmodel moet deze volledige Nederlandse zin begrijpen.',
    pl: 'Lokalny model tłumaczenia powinien rozumieć to pełne polskie zdanie.',
    tr: 'Yerel çeviri modeli bu eksiksiz Türkçe cümleyi anlamalıdır.',
    bg: 'Проверяваме дали локалният модел за превод разбира това пълно българско изречение.',
    bn: 'স্থানীয় অনুবাদ মডেলটি এই সম্পূর্ণ বাংলা বাক্যটি বুঝতে পারে কিনা আমরা পরীক্ষা করছি।',
    cs: 'Ověřujeme, zda místní překladový model rozumí této úplné české větě.',
    da: 'Vi kontrollerer, om den lokale oversættelsesmodel forstår denne komplette danske sætning.',
    el: 'Ελέγχουμε αν το τοπικό μοντέλο μετάφρασης κατανοεί αυτή την πλήρη ελληνική πρόταση.',
    fi: 'Tarkistamme, ymmärtääkö paikallinen käännösmalli tämän kokonaisen suomenkielisen lauseen.',
    he: 'אנו בודקים אם מודל התרגום המקומי מבין את המשפט המלא הזה בעברית.',
    hr: 'Provjeravamo razumije li lokalni model za prevođenje ovu potpunu hrvatsku rečenicu.',
    hu: 'Ellenőrizzük, hogy a helyi fordítási modell megérti-e ezt a teljes magyar mondatot.',
    id: 'Kami memeriksa apakah model terjemahan lokal memahami kalimat bahasa Indonesia yang lengkap ini.',
    kn: 'ಸ್ಥಳೀಯ ಅನುವಾದ ಮಾದರಿಯು ಈ ಸಂಪೂರ್ಣ ಕನ್ನಡ ವಾಕ್ಯವನ್ನು ಅರ್ಥಮಾಡಿಕೊಳ್ಳುತ್ತದೆಯೇ ಎಂದು ಪರಿಶೀಲಿಸುತ್ತಿದ್ದೇವೆ.',
    lt: 'Tikriname, ar vietinis vertimo modelis supranta šį visą lietuvišką sakinį.',
    mr: 'स्थानिक भाषांतर मॉडेलला हे संपूर्ण मराठी वाक्य समजते का ते आम्ही तपासत आहोत.',
    no: 'Vi sjekker om den lokale oversettelsesmodellen forstår denne fullstendige norske setningen.',
    ro: 'Verificăm dacă modelul local de traducere înțelege această propoziție completă în limba română.',
    sk: 'Overujeme, či miestny prekladový model rozumie tejto úplnej slovenskej vete.',
    sl: 'Preverjamo, ali lokalni prevajalski model razume ta celoten slovenski stavek.',
    sv: 'Vi kontrollerar om den lokala översättningsmodellen förstår den här fullständiga svenska meningen.',
    ta: 'உள்ளூர் மொழிபெயர்ப்பு மாதிரி இந்த முழுமையான தமிழ் வாக்கியத்தைப் புரிந்துகொள்கிறதா என்று சரிபார்க்கிறோம்.',
    te: 'స్థానిక అనువాద నమూనా ఈ పూర్తి తెలుగు వాక్యాన్ని అర్థం చేసుకుంటుందో లేదో మేము పరిశీలిస్తున్నాము.',
    uk: 'Ми перевіряємо, чи розуміє локальна модель перекладу це повне українське речення.',
};

function normalizeLanguageCode(value: string, field: 'from' | 'to', allowAuto: boolean): string {
    const language = value.trim();
    if (allowAuto && language.toLowerCase() === 'auto') return 'auto';
    if (!language || !LANGUAGE_CODE_PATTERN.test(language) || (!allowAuto && language.toLowerCase() === 'auto')) {
        throw new ChromeTranslationPreparationError(
            'invalid-language-code',
            `浏览器内置翻译 ${field} 语言代码无效`,
            {field},
        );
    }
    const normalized = normalizeChineseLanguageCode(language.toLowerCase());
    return normalized === 'zh-Hans' ? 'zh' : normalized;
}

function languageSampleKey(language: string): string {
    if (language === 'zh-Hant') return language;
    if (language === 'zh') return language;
    return language.split('-')[0];
}

function languageComparisonKey(language: string): string {
    const normalized = normalizeLanguageCode(language, 'from', false);
    return languageSampleKey(normalized);
}

export function resolveChromeTranslationPreparationPair(
    from: string,
    to: string,
): ChromeTranslationPreparationPair {
    const configuredTarget = normalizeLanguageCode(to, 'to', false);
    const configuredSource = normalizeLanguageCode(from, 'from', true);
    const sourceLanguage = configuredSource === 'auto'
        || languageComparisonKey(configuredSource) === languageComparisonKey(configuredTarget)
        ? languageComparisonKey(configuredTarget) === 'en' ? 'fr' : 'en'
        : configuredSource;
    const targetLanguage = configuredTarget;
    const sampleText = TEST_SAMPLES[languageSampleKey(sourceLanguage)];
    if (!sampleText) {
        throw new ChromeTranslationPreparationError(
            'sample-unavailable',
            `暂时无法为源语言 ${sourceLanguage} 生成内置翻译校验文本`,
            {sourceLanguage},
        );
    }
    return {sourceLanguage, targetLanguage, sampleText};
}

function reportStatus(
    reporter: ChromeTranslationPreparationOptions['onStatus'],
    status: ChromeTranslationPreparationStatus,
): void {
    try {
        reporter?.({...status});
    } catch {
        // 状态展示属于旁路观察，不能让 UI 回调错误打断模型准备。
    }
}

function createMonitorOptions(
    model: ChromePreparationModel,
    pair: ChromeTranslationPreparationPair,
    reporter: ChromeTranslationPreparationOptions['onStatus'],
    signal?: AbortSignal,
): ChromePreparationCreateOptions {
    let lastReportedPercentage: number | undefined;
    return {
        ...(signal ? {signal} : {}),
        monitor(monitor) {
            monitor.addEventListener('downloadprogress', (event) => {
                if (signal?.aborted) return;
                const loaded = event.loaded;
                if (typeof loaded !== 'number' || !Number.isFinite(loaded) || loaded < 0 || loaded > 1) return;
                const percentage = Math.round(loaded * 100);
                if (percentage === lastReportedPercentage) return;
                lastReportedPercentage = percentage;
                reportStatus(reporter, {
                    phase: 'downloading',
                    model,
                    loaded,
                    sourceLanguage: pair.sourceLanguage,
                    targetLanguage: pair.targetLanguage,
                });
            });
        },
    };
}

function invokeCreate<T>(factory: () => Promise<T>): Promise<T> {
    try {
        return Promise.resolve(factory());
    } catch (error) {
        return Promise.reject(error);
    }
}

function safelyDestroy(resource: {destroy?: () => void} | undefined): void {
    try {
        resource?.destroy?.();
    } catch {
        // 实验 API 的清理异常不能覆盖已经得到的自检结果或权威失败原因。
    }
}

function createAbortError(): ChromeTranslationPreparationError {
    const error = new ChromeTranslationPreparationError('aborted', '语言包准备已取消');
    error.name = 'AbortError';
    return error;
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw createAbortError();
}

function awaitWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return operation;
    if (signal.aborted) {
        void operation.catch(() => undefined);
        return Promise.reject(createAbortError());
    }
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
            signal.removeEventListener('abort', onAbort);
            reject(createAbortError());
        };
        signal.addEventListener('abort', onAbort, {once: true});
        operation.then(
            value => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            error => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            },
        );
    });
}

function detectedLanguageFrom(value: unknown): string {
    if (!Array.isArray(value)
        || typeof value[0]?.detectedLanguage !== 'string'
        || typeof value[0]?.confidence !== 'number') {
        throw new ChromeTranslationPreparationError('invalid-detection', '浏览器语言检测器返回了无效结果');
    }
    const detectedLanguage = value[0].detectedLanguage.trim();
    const confidence = value[0].confidence;
    if (!detectedLanguage
        || !LANGUAGE_CODE_PATTERN.test(detectedLanguage)
        || !Number.isFinite(confidence)
        || confidence < MIN_CHROME_LANGUAGE_CONFIDENCE
        || confidence > 1) {
        throw new ChromeTranslationPreparationError('invalid-detection', '浏览器语言检测器返回了无效结果');
    }
    return detectedLanguage;
}

function friendlyPreparationError(
    error: unknown,
    pair: ChromeTranslationPreparationPair,
): Error {
    if (error instanceof Error && error.name === 'NotAllowedError') {
        return new ChromeTranslationPreparationError(
            'user-activation-required',
            `浏览器需要用户操作才能下载模型。请再次点击「准备语言包」继续准备 ${pair.sourceLanguage} → ${pair.targetLanguage}。`,
            {sourceLanguage: pair.sourceLanguage, targetLanguage: pair.targetLanguage},
        );
    }
    if (error instanceof Error && error.name === 'NotSupportedError') {
        // 两个 create 都可能拒绝，NotSupportedError 并不能证明语言组合不受支持；
        // 模型组件、下载与浏览器策略同样会影响当前环境的可用性。
        return new ChromeTranslationPreparationError(
            'model-unavailable',
            `浏览器无法创建翻译模型（${pair.sourceLanguage} → ${pair.targetLanguage}）。请检查模型下载和浏览器策略。`,
            {sourceLanguage: pair.sourceLanguage, targetLanguage: pair.targetLanguage, detail: error.message},
        );
    }
    return error instanceof Error
        ? error
        : new ChromeTranslationPreparationError(
            'preparation-failed',
            String(error || '语言包准备失败'),
        );
}

/**
 * 必须直接从 click handler 调用，且调用前不能 await。函数在首个 await 之前同时
 * 启动 LanguageDetector.create 与 Translator.create，确保下载请求仍拥有用户激活。
 */
export async function prepareChromeTranslationInPage(
    options: ChromeTranslationPreparationOptions,
    environment: ChromeTranslationPreparationEnvironment = globalThis as unknown as ChromeTranslationPreparationEnvironment,
): Promise<ChromeTranslationPreparationResult> {
    const pair = resolveChromeTranslationPreparationPair(options.from, options.to);
    throwIfAborted(options.signal);
    const detectorApi = environment.LanguageDetector;
    const translatorApi = environment.Translator;
    if (typeof detectorApi?.create !== 'function' || typeof translatorApi?.create !== 'function') {
        throw new ChromeTranslationPreparationError(
            'api-unavailable',
            '当前浏览器未开放语言检测或翻译接口',
        );
    }

    reportStatus(options.onStatus, {
        phase: 'initializing',
        sourceLanguage: pair.sourceLanguage,
        targetLanguage: pair.targetLanguage,
    });
    throwIfAborted(options.signal);

    let cleanupRequested = false;
    let detector: ChromePreparationDetector | undefined;
    let translator: ChromePreparationTranslator | undefined;
    const detectorPromise = invokeCreate(() => detectorApi.create(
        createMonitorOptions('language-detector', pair, options.onStatus, options.signal),
    )).then((resource) => {
        if (cleanupRequested) safelyDestroy(resource);
        else {
            detector = resource;
            if (!translator) reportStatus(options.onStatus, {
                phase: 'initializing', model: 'translator',
                sourceLanguage: pair.sourceLanguage, targetLanguage: pair.targetLanguage,
            });
        }
        return resource;
    });
    const translatorPromise = invokeCreate(() => translatorApi.create({
        sourceLanguage: pair.sourceLanguage,
        targetLanguage: pair.targetLanguage,
        ...createMonitorOptions('translator', pair, options.onStatus, options.signal),
    })).then((resource) => {
        if (cleanupRequested) safelyDestroy(resource);
        else {
            translator = resource;
            if (!detector) reportStatus(options.onStatus, {
                phase: 'initializing', model: 'language-detector',
                sourceLanguage: pair.sourceLanguage, targetLanguage: pair.targetLanguage,
            });
        }
        return resource;
    });
    const cleanupResources = () => {
        cleanupRequested = true;
        safelyDestroy(detector);
        safelyDestroy(translator);
        detector = undefined;
        translator = undefined;
    };

    try {
        [detector, translator] = await awaitWithAbort(
            Promise.all([detectorPromise, translatorPromise]),
            options.signal,
        );
        throwIfAborted(options.signal);
        reportStatus(options.onStatus, {
            phase: 'verifying',
            sourceLanguage: pair.sourceLanguage,
            targetLanguage: pair.targetLanguage,
        });
        throwIfAborted(options.signal);
        const [detectedValue, translatedValue] = await awaitWithAbort(Promise.all([
            options.signal
                ? detector.detect(pair.sampleText, {signal: options.signal})
                : detector.detect(pair.sampleText),
            options.signal
                ? translator.translate(pair.sampleText, {signal: options.signal})
                : translator.translate(pair.sampleText),
        ]), options.signal);
        const detectedCode = detectedLanguageFrom(detectedValue);
        const script = detectedCode.toLowerCase() === 'zh' ? getChineseScript(languageSampleKey(pair.sourceLanguage)) : undefined;
        const detectedLanguage = script ? `zh-${script}` : detectedCode;
        if (languageComparisonKey(detectedLanguage) !== languageComparisonKey(pair.sourceLanguage)) {
            throw new ChromeTranslationPreparationError(
                'detection-mismatch',
                `浏览器语言检测验证失败：预期 ${pair.sourceLanguage}，实际 ${detectedLanguage}`,
                {expectedLanguage: pair.sourceLanguage, detectedLanguage},
            );
        }
        if (typeof translatedValue !== 'string' || !translatedValue.trim()) {
            throw new ChromeTranslationPreparationError('invalid-translation', '浏览器翻译器返回了无效结果');
        }
        cleanupResources();
        return {...pair, detectedLanguage, translatedText: translatedValue};
    } catch (error) {
        cleanupResources();
        throw friendlyPreparationError(error, pair);
    }
}
