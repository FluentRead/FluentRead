/**
 * @file src/core/i18n/messages/mimoRetirement.ts
 * 文件职责：提供扩展及油猴完整设置共用的 MiMo 退役提示。
 * 主要内容：集中六种非中文译文，允许油猴在旧固定词典注册时补齐，覆盖内嵌、远程及离线缓存路径。
 * 模块边界：只声明界面资源，不改变保存配置、请求模型、固定资源或缓存。
 */
import type {RegisteredUiLanguage} from '../types';

export const mimoRetirementSource = "MiMo 旧编号将于北京时间 2026-10-21 10:00 失效。直连官方 API 时，自定义模型及请求体中的 mimo-v2.5 / mimo-v2.5-pro 会分别按 mimo-v2.6-flash / mimo-v2.6-pro 请求并按新模型计费；第三方网关请手动确认型号。";

export const mimoRetirementLegacyText: Readonly<Record<RegisteredUiLanguage, Readonly<Record<string, string>>>> = {
    'en-US': {[mimoRetirementSource]: "MiMo legacy IDs expire at 10:00 Beijing time on 2026-10-21. For direct official API requests, custom model and request-body IDs mimo-v2.5 / mimo-v2.5-pro are sent as mimo-v2.6-flash / mimo-v2.6-pro and billed at the new rates. Check model IDs with your third-party gateway."},
    'ja-JP': {[mimoRetirementSource]: "MiMo の旧 ID は北京時間 2026-10-21 10:00 に無効になります。公式 API への直接リクエストでは、カスタムモデルとリクエスト本文の mimo-v2.5 / mimo-v2.5-pro をそれぞれ mimo-v2.6-flash / mimo-v2.6-pro に置換し、新モデルの料金が適用されます。外部ゲートウェイのモデル ID は手動で確認してください。"},
    'ko-KR': {[mimoRetirementSource]: "MiMo의 기존 ID는 베이징 시간 2026-10-21 10:00에 만료됩니다. 공식 API에 직접 요청할 때 사용자 지정 모델 및 요청 본문의 mimo-v2.5 / mimo-v2.5-pro는 각각 mimo-v2.6-flash / mimo-v2.6-pro로 전송되며 새 모델 요금이 적용됩니다. 타사 게이트웨이의 모델 ID는 직접 확인하세요."},
    'fr-FR': {[mimoRetirementSource]: "Les anciens identifiants MiMo expirent le 2026-10-21 à 10:00, heure de Pékin. Pour les appels directs à l’API officielle, mimo-v2.5 / mimo-v2.5-pro dans le modèle personnalisé ou le corps de requête deviennent respectivement mimo-v2.6-flash / mimo-v2.6-pro, aux nouveaux tarifs. Vérifiez manuellement les modèles des passerelles tierces."},
    'ru-RU': {[mimoRetirementSource]: "Старые ID MiMo перестанут действовать 2026-10-21 в 10:00 по пекинскому времени. При прямом обращении к официальному API идентификаторы mimo-v2.5 / mimo-v2.5-pro в пользовательской модели и теле запроса заменяются на mimo-v2.6-flash / mimo-v2.6-pro соответственно, с оплатой по новым тарифам. Модели сторонних шлюзов проверьте вручную."},
    'es-ES': {[mimoRetirementSource]: "Los ID antiguos de MiMo caducan el 2026-10-21 a las 10:00, hora de Pekín. En las solicitudes directas a la API oficial, mimo-v2.5 / mimo-v2.5-pro en modelos personalizados o cuerpos de solicitud se envían como mimo-v2.6-flash / mimo-v2.6-pro, respectivamente, con las nuevas tarifas. Comprueba manualmente los modelos de pasarelas de terceros."},
};
