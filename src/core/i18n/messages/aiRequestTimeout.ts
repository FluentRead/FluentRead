/**
 * @file src/core/i18n/messages/aiRequestTimeout.ts
 * 文件职责：维护 AI 翻译请求等待时间设置的七语言稳定文案。
 * 主要内容：说明默认 120 秒、10 至 600 秒范围与适合慢模型或长文本的调整方式；中文独立导出供运行时引用，七语聚合表继续供扩展资源包构建与 userscript 注册使用。
 * 模块边界：仅提供静态文本，不读取配置、不修改远端语言资源、不发起请求或控制计时器。
 */
import type {UiLanguage} from '../types';

export const aiRequestTimeoutChineseMessages = {
    "settings.requestLimits.aiTimeout": "AI 翻译请求超时",
    "settings.requestLimits.aiTimeoutHelp": "每次 AI 翻译请求默认等待 120 秒，可设为 10–600 秒。慢模型或长文本可适当延长等待时间。",
    "settings.requestLimits.seconds": "秒",
} as const;

export const aiRequestTimeoutMessages: Readonly<Record<UiLanguage, Readonly<Record<string, string>>>> = {
    "zh-CN": aiRequestTimeoutChineseMessages,
    "zh-TW": {
        "settings.requestLimits.aiTimeout": "AI 翻譯要求逾時",
        "settings.requestLimits.aiTimeoutHelp": "每次 AI 翻譯要求預設等待 120 秒，可設為 10–600 秒。慢模型或長文字可適當延長等待時間。",
        "settings.requestLimits.seconds": "秒",
    },
    "en-US": {
        "settings.requestLimits.aiTimeout": "AI translation request timeout",
        "settings.requestLimits.aiTimeoutHelp": "Each AI translation request waits up to 120 seconds by default. Range: 10–600 seconds. Allow more time for slow models or long text.",
        "settings.requestLimits.seconds": "s",
    },
    "ja-JP": {
        "settings.requestLimits.aiTimeout": "AI 翻訳リクエストのタイムアウト",
        "settings.requestLimits.aiTimeoutHelp": "AI 翻訳はリクエストごとに既定で最大 120 秒待機します。範囲は 10～600 秒です。応答の遅いモデルや長文では待機時間を延ばせます。",
        "settings.requestLimits.seconds": "秒",
    },
    "ko-KR": {
        "settings.requestLimits.aiTimeout": "AI 번역 요청 제한 시간",
        "settings.requestLimits.aiTimeoutHelp": "AI 번역 요청은 기본적으로 최대 120초 동안 기다리며 10–600초로 설정할 수 있습니다. 느린 모델이나 긴 텍스트는 대기 시간을 늘려 주세요.",
        "settings.requestLimits.seconds": "초",
    },
    "fr-FR": {
        "settings.requestLimits.aiTimeout": "Délai des requêtes de traduction IA",
        "settings.requestLimits.aiTimeoutHelp": "Chaque requête de traduction IA attend jusqu’à 120 secondes par défaut. Plage : 10–600 secondes. Prolongez l’attente pour les modèles lents ou les textes longs.",
        "settings.requestLimits.seconds": "sec",
    },
    "ru-RU": {
        "settings.requestLimits.aiTimeout": "Тайм-аут запросов перевода ИИ",
        "settings.requestLimits.aiTimeoutHelp": "По умолчанию каждый запрос перевода ИИ ожидает до 120 секунд. Диапазон: 10–600 секунд. Для медленных моделей или длинного текста увеличьте время ожидания.",
        "settings.requestLimits.seconds": "с",
    },
    "es-ES": {
        "settings.requestLimits.aiTimeout": "Tiempo de espera de traducción IA",
        "settings.requestLimits.aiTimeoutHelp": "Cada solicitud de traducción IA espera hasta 120 segundos de forma predeterminada. Rango: 10–600 segundos. Amplíe la espera para modelos lentos o textos largos.",
        "settings.requestLimits.seconds": "seg",
    },
};
