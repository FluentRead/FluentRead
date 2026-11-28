/**
 * @file src/services/diagnostics/index.ts
 * 文件职责：将翻译与页面失败映射为可复用、可操作且不会泄露供应商原始消息的自助诊断。
 * 主要内容：定义稳定的诊断代码与动作，通过已注册的界面语言资源读取文案，按结构化错误优先归因，并用严格白名单生成供用户预览的本地报告。
 * 模块边界：本模块仅包含纯数据转换，不读取配置、网页正文或浏览器状态，不记录日志，不保存、下载或发送报告；具体界面决定何时展示及响应用户明确的导出操作。
 */

import {BROWSER_TRANSLATION_PREPARATION_REQUIRED, BROWSER_TRANSLATION_UNAVAILABLE, type TranslationErrorKind} from '../translation/errors';
import {resolveUiLanguageFromLocale, translate} from '@/src/core/i18n';

export const DIAGNOSTIC_CODES = [
  'cancelled', 'offline', 'no-content', 'unsupported-page', 'page-unavailable', 'source-closed', 'context-invalid',
  'authentication', 'model-configuration', 'configuration', 'configuration-save', 'rate-limit',
  BROWSER_TRANSLATION_PREPARATION_REQUIRED, BROWSER_TRANSLATION_UNAVAILABLE,
  'timeout', 'network', 'provider', 'unknown',
] as const;
export type DiagnosticCode = typeof DIAGNOSTIC_CODES[number];
export type DiagnosticAction = 'retry' | 'services' | 'site-settings' | 'refresh' | 'dismiss';
export interface Diagnostic {
  code: DiagnosticCode;
  titleKey: `diagnostics.${DiagnosticCode}.title`;
  detailKey: `diagnostics.${DiagnosticCode}.detail`;
  actions: DiagnosticAction[];
  /** 服务要求的最短等待时间；调用方应在等待期间禁用手动重试，不安排自动重试。 */
  retryAfterMs?: number;
}
export interface DiagnosticContext {
  reason?: 'no-content' | 'unsupported-page' | 'source-closed' | 'configuration' | 'configuration-save' | 'cancelled';
  online?: boolean;
}

const actions: Record<DiagnosticCode, DiagnosticAction[]> = {
  cancelled: ['retry', 'dismiss'],
  offline: ['retry', 'dismiss'],
  'no-content': ['retry', 'site-settings', 'dismiss'],
  'unsupported-page': ['dismiss'],
  'page-unavailable': ['refresh', 'dismiss'],
  'source-closed': ['dismiss'],
  'context-invalid': ['refresh', 'dismiss'],
  authentication: ['services', 'retry', 'dismiss'],
  'model-configuration': ['services', 'retry', 'dismiss'],
  configuration: ['services', 'retry', 'dismiss'],
  'configuration-save': ['retry', 'dismiss'],
  [BROWSER_TRANSLATION_PREPARATION_REQUIRED]: ['services', 'retry', 'dismiss'],
  [BROWSER_TRANSLATION_UNAVAILABLE]: ['services', 'dismiss'],
  'rate-limit': ['services', 'retry', 'dismiss'],
  timeout: ['retry', 'services', 'dismiss'],
  network: ['retry', 'services', 'dismiss'],
  provider: ['retry', 'services', 'dismiss'],
  unknown: ['retry', 'services', 'dismiss'],
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function duration(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(value)) : undefined;
}

function makeDiagnostic(code: DiagnosticCode, retryAfterMs?: number): Diagnostic {
  return {
    code, titleKey: `diagnostics.${code}.title`, detailKey: `diagnostics.${code}.detail`,
    actions: [...actions[code]],
    ...(retryAfterMs === undefined ? {} : {retryAfterMs}),
  };
}

/** 跨消息边界只信任固定代码；动作、文案键以及冷却数据必须在接收端重新生成。 */
export function normalizeDiagnostic(value: unknown): Diagnostic | undefined {
  const candidate = record(value);
  if (!DIAGNOSTIC_CODES.includes(candidate.code as DiagnosticCode)) return undefined;
  const code = candidate.code as DiagnosticCode;
  return makeDiagnostic(code, code === 'rate-limit' || code === 'provider' ? duration(candidate.retryAfterMs) : undefined);
}

const kinds: readonly TranslationErrorKind[] = [
  'authentication', 'rate-limit', 'timeout', 'network', 'bad-request', 'provider', 'response', 'unknown',
];

/** 仅把原始消息当作旧接口的归因线索；返回值永远不携带消息、堆栈、请求 ID 或供应商详情。 */
export function diagnoseFailure(error: unknown, context: DiagnosticContext = {}): Diagnostic {
  const candidate = record(error);
  const message = typeof candidate.message === 'string' ? candidate.message : typeof error === 'string' ? error : '';
  const code = typeof candidate.code === 'string' ? candidate.code.toLowerCase() : '';
  const name = typeof candidate.name === 'string' ? candidate.name : '';
  if (context.reason === 'cancelled' || name === 'AbortError' || code === 'err_canceled' || code === 'abort_err') {
    return makeDiagnostic('cancelled');
  }
  if (context.reason) return makeDiagnostic(context.reason);
  if (code === BROWSER_TRANSLATION_PREPARATION_REQUIRED || code === BROWSER_TRANSLATION_UNAVAILABLE) {
    return makeDiagnostic(code);
  }
  if (/extension context invalidated/iu.test(message)) return makeDiagnostic('context-invalid');
  const status = typeof candidate.statusCode === 'number' ? candidate.statusCode : candidate.status;
  const knownKind = kinds.includes(candidate.kind as TranslationErrorKind) ? candidate.kind as TranslationErrorKind : undefined;
  // 供应商适配层已经知道的类型优先于模糊消息；HTTP 状态码只在类型缺失或未知时补充。
  const kind = knownKind && knownKind !== 'unknown' ? knownKind
    : status === 401 || status === 403 ? 'authentication'
    : status === 429 ? 'rate-limit'
    : status === 408 || status === 504 ? 'timeout'
    : typeof status === 'number' && status >= 500 && status <= 599 ? 'provider'
    : typeof status === 'number' && status >= 400 && status <= 499 ? 'bad-request'
    : undefined;
  if (kind === 'authentication') return makeDiagnostic('authentication');
  if (kind === 'rate-limit') return makeDiagnostic('rate-limit', duration(candidate.retryAfterMs));
  if (kind === 'timeout') return makeDiagnostic('timeout');
  if (kind === 'network') return makeDiagnostic(context.online === false ? 'offline' : 'network');
  if (kind === 'provider' || kind === 'response') return makeDiagnostic('provider',
    status === 503 ? duration(candidate.retryAfterMs) : undefined);
  if (kind === 'bad-request') {
    return makeDiagnostic(/model|deployment|模型/iu.test(code + ' ' + message) ? 'model-configuration' : 'configuration');
  }
  if (/^(?:Error:\s*)?(?:No tab with id:\s*\d+\.?|No active tab)\s*$/iu.test(message)) return makeDiagnostic('source-closed');
  if (/receiving end does not exist|could not establish connection|(?:没有|找不到|无)(?:消息)?接收端|接收端不存在/iu.test(message)) return makeDiagnostic('page-unavailable');
  if (/invalid_api_key|authentication|unauthorized|forbidden/iu.test(code)
      || /\b40[13]\b|api.?key.*(?:invalid|missing|expired)|unauthori[sz]ed|forbidden|鉴权|密钥.*(?:无效|未配置|过期)|凭据.*(?:无效|未配置)/iu.test(message)) return makeDiagnostic('authentication');
  if (/model_not_found|invalid_model|deployment_not_found/iu.test(code)
      || /(?:model|deployment).*(?:not found|not configured|missing|invalid)|invalid model|模型.*(?:未配置|不存在|无效)/iu.test(message)) return makeDiagnostic('model-configuration');
  if (/\b429\b|rate.?limit|quota|限流|配额|请求过于频繁/iu.test(code + ' ' + message)) return makeDiagnostic('rate-limit', duration(candidate.retryAfterMs));
  if (/timeout|timed out|超时/iu.test(code + ' ' + message) || name === 'TimeoutError') return makeDiagnostic('timeout');
  if (context.online === false) return makeDiagnostic('offline');
  if (/failed to fetch|networkerror|network error|网络/iu.test(message)) return makeDiagnostic('network');
  if (/\b5\d\d\b|服务.*(?:不可用|内部错误)/iu.test(message)) return makeDiagnostic('provider');
  return makeDiagnostic('unknown');
}

type Copy = {title: string; detail: string};
/** 只读取已注册资源；非中文语言由界面现有的 lazy loader 加载，未就绪时沿用中文回退。 */
export function getDiagnosticText(diagnostic: Pick<Diagnostic, 'code'>, locale = 'zh-CN'): Copy {
  const language = resolveUiLanguageFromLocale(locale);
  return {
    title: translate(`diagnostics.${diagnostic.code}.title`, language),
    detail: translate(`diagnostics.${diagnostic.code}.detail`, language),
  };
}
export type DiagnosticUiTextKey = "close-details" | "dismiss-notice" | "details" | "service-action" | "site-action" | "refresh-failed" | "source-closed" | "source-looking" | "source-return" | "source-unavailable" | "source-returned" | "source-return-hint" | "preview" | "report" | "privacy" | "export" | "exportFailed" | "first-use-start" | "first-use-translating" | "first-use-ready";
const diagnosticUiKeys: Record<DiagnosticUiTextKey, string> = {
  "close-details": "diagnostics.ui.close-details",
  "dismiss-notice": "diagnostics.ui.dismiss-notice",
  "details": "diagnostics.ui.details",
  "service-action": "diagnostics.ui.service-action",
  "site-action": "diagnostics.ui.site-action",
  "refresh-failed": "diagnostics.ui.refresh-failed",
  "source-closed": "diagnostics.ui.source-closed",
  "source-looking": "diagnostics.ui.source-looking",
  "source-return": "diagnostics.ui.source-return",
  "source-unavailable": "diagnostics.ui.source-unavailable",
  "source-returned": "diagnostics.ui.source-returned",
  "source-return-hint": "diagnostics.ui.source-return-hint",
  "preview": "diagnostics.report.preview",
  "report": "diagnostics.report.previewLabel",
  "privacy": "diagnostics.report.localOnly",
  "export": "diagnostics.report.export",
  "exportFailed": "diagnostics.report.exportFailed",
  "first-use-start": "diagnostics.ui.first-use-start",
  "first-use-translating": "diagnostics.ui.first-use-translating",
  "first-use-ready": "diagnostics.ui.first-use-ready"
};
/** 纯文案读取；界面通过现有 bundleRevision 跟踪按需资源更新。 */
export function getDiagnosticUiText(key: DiagnosticUiTextKey, locale = 'zh-CN'): string {
  return translate(diagnosticUiKeys[key], resolveUiLanguageFromLocale(locale));
}

const FEATURES = ['popup', 'page', 'services', 'selection', 'hover', 'document', 'image', 'video', 'unknown'] as const;
const SERVICE_TYPES = ['free', 'traditional', 'ai', 'custom', 'composite', 'local', 'unknown'] as const;
export interface DiagnosticReportInput {
  diagnostic: Pick<Diagnostic, 'code' | 'retryAfterMs'>;
  feature?: typeof FEATURES[number];
  serviceType?: typeof SERVICE_TYPES[number];
  extensionVersion?: string;
  online?: boolean;
}
export interface DiagnosticReport {
  schemaVersion: 1;
  diagnostic: {code: DiagnosticCode; retryAfterMs?: number};
  feature?: typeof FEATURES[number];
  serviceType?: typeof SERVICE_TYPES[number];
  extensionVersion?: string;
  online?: boolean;
}

/** 用户请求预览时才调用；即使调用方误传整个 Error、配置或恶意对象，也只投影白名单标量。 */
export function buildDiagnosticReport(input: DiagnosticReportInput): DiagnosticReport {
  const source = record(input);
  const diagnostic = record(source.diagnostic);
  const code = DIAGNOSTIC_CODES.includes(diagnostic.code as DiagnosticCode) ? diagnostic.code as DiagnosticCode : 'unknown';
  const retryAfterMs = code === 'rate-limit' ? duration(diagnostic.retryAfterMs) : undefined;
  return {
    schemaVersion: 1,
    diagnostic: {code, ...(retryAfterMs === undefined ? {} : {retryAfterMs})},
    ...(FEATURES.includes(source.feature as typeof FEATURES[number]) ? {feature: source.feature as typeof FEATURES[number]} : {}),
    ...(SERVICE_TYPES.includes(source.serviceType as typeof SERVICE_TYPES[number]) ? {serviceType: source.serviceType as typeof SERVICE_TYPES[number]} : {}),
    ...(typeof source.extensionVersion === 'string' && /^\d{1,4}(?:\.\d{1,4}){1,3}$(?![\s\S])/u.test(source.extensionVersion) ? {extensionVersion: source.extensionVersion} : {}),
    ...(typeof source.online === 'boolean' ? {online: source.online} : {}),
  };
}
