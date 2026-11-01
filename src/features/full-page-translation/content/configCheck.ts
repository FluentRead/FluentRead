/**
 * @file src/features/full-page-translation/content/configCheck.ts
 * 文件职责：在全文及悬浮页面翻译前将纯配置预检结果转换为用户可操作的页面通知。
 * 主要内容：从现有配置及网站仅译文偏好读取本次预检输入，沿用快捷方案覆盖，并分别反馈缺模型与显示模式不支持；全文入口可把真实拒绝原因存为安全诊断，关闭状态直接停止。
 * 模块边界：配置政策由 core/config/translationPreflight 持有；本文件只负责全文 feature 的通知适配，不检查受保护凭据、不选择端点、不执行网络请求。
 */
import {resolveTranslationPreflight, type TranslationConfigCheckOptions} from '@/src/core/config/translationPreflight';
import {config} from '@/src/services/config/store';
import {resolveSiteTranslationDisplay} from '@/src/core/site-rules/domain';
import {sendErrorMessage} from '@/src/features/page-notice/public';
import {diagnoseFailure} from '@/src/services/diagnostics';
import {notifyFullPageTranslationDiagnostic} from './stateNotification';

export function checkConfig(options: TranslationConfigCheckOptions = {}, reportFullPageDiagnostic = false): boolean {
    const result = resolveTranslationPreflight(config, {...options, displayMode: options.displayMode
        ?? (resolveSiteTranslationDisplay(config, typeof location === 'undefined' ? '' : location.href) === 0 ? 'single' : 'bilingual')});
    if (result.allowed) return true;
    if (reportFullPageDiagnostic) notifyFullPageTranslationDiagnostic(result.reason === 'disabled' ? undefined
        : result.reason === 'missing-model' ? diagnoseFailure({code: 'model_not_found'})
        : diagnoseFailure(undefined, {reason: 'configuration'}));
    if (result.reason === 'missing-model') sendErrorMessage('模型尚未配置，请前往设置页配置');
    else if (result.reason === 'unsupported-display') sendErrorMessage('「谷歌翻译」仅支持双语模式，请切换翻译服务');
    return false;
}
