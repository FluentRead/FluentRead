/**
 * @file src/features/selection-translation/domain/directionAndState.ts
 *
 * 文件职责：封装划词翻译的目标语言方向解析、请求代次闸门、词典回退、展示触发状态机与朗读语言代码规范化。
 * 主要内容：导出 selectionReverseTarget、buildSelectionTargetOptions、resolveSelectionDirection、SelectionRequestTokenGate、resolveSelectionVocabularyAnswer、reconcileSelectionPresentation 与 normalizeSpeechLanguage。
 * 模块边界：纯业务逻辑与状态计算模块，不访问 DOM、不发消息、不渲染 Vue，也不触发音频播放。
 */

import {translationLanguageOptions} from '@/src/core/language/catalog';
import {getChineseScript, normalizeChineseLanguageCode} from '@/src/core/language/chinese';
import {isLanguageCodeMatch, normalizeDetectedLanguageCode} from '@/src/core/language/codes';
import {isTextInLanguage, shouldSkipChineseSelection} from '@/src/core/language/detect';

export interface SelectionContentRequest {
    text: string;
    sourceLanguage?: string;
    targetLanguage: string;
    generation: number;
}

/** 只在选区可信地属于当前目标语言时反向；不对短歧义词或其他语言猜测方向。 */
export function selectionReverseTarget(text: string, targetLanguage: string, sourceLanguage: string): string | null {
    if (getChineseScript(targetLanguage) && shouldSkipChineseSelection(text, targetLanguage)) return 'en';
    if (targetLanguage === 'en' && isTextInLanguage(text, 'en')) {
        return getChineseScript(sourceLanguage) ? normalizeChineseLanguageCode(sourceLanguage) : 'zh-Hans';
    }
    return null;
}

export interface SelectionTargetLanguageOption {
    value: string;
    label: string;
    shortLabel: string;
}

export interface SelectionDirectionInput {
    text: string;
    configuredFrom: string;
    configuredTo: string;
    bidirectional: boolean;
    manuallyRequested: boolean;
    targetOverride: string | null;
}

export interface SelectionDirection {
    sourceLanguage: string;
    targetLanguage: string;
}

/** 顶栏紧凑标签只展示首选原生名称，完整名称保留在原生下拉列表中。 */
export function selectionTargetShortLabel(value: string, label?: string): string {
    const raw = (label ?? translationLanguageOptions.find(item => item.value === value)?.label ?? value).trim();
    return raw.split(' / ')[0]?.trim() || value;
}

/** 生成本次划词弹窗的目标语言列表，把默认目标和当前生效目标置顶并去重。 */
export function buildSelectionTargetOptions(currentTarget: string, configuredTarget?: string): SelectionTargetLanguageOption[] {
    const options: SelectionTargetLanguageOption[] = [];
    const seen = new Set<string>();
    const append = (value: string, label?: string) => {
        const normalized = value.trim();
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        const catalogEntry = translationLanguageOptions.find(item => item.value === normalized);
        const fullLabel = (label ?? catalogEntry?.label ?? normalized).trim();
        options.push({value: normalized, label: fullLabel, shortLabel: selectionTargetShortLabel(normalized, fullLabel)});
    };
    if (configuredTarget) append(configuredTarget);
    if (currentTarget) append(currentTarget);
    for (const item of translationLanguageOptions) append(item.value, item.label);
    return options;
}

/** 统一解析划词卡片的源/目标语言：临时覆盖优先且不形成同语种自译，否则沿用配置与显式反向规则。 */
export function resolveSelectionDirection(input: SelectionDirectionInput): SelectionDirection {
    const override = input.targetOverride?.trim() || null;
    if (override) {
        const matchesConfiguredTarget = isLanguageCodeMatch(override, input.configuredTo);
        const sourceLanguage = matchesConfiguredTarget && !isLanguageCodeMatch(input.configuredFrom, override)
            ? input.configuredFrom
            : 'auto';
        return {sourceLanguage, targetLanguage: override};
    }
    const reverseTarget = input.bidirectional || input.manuallyRequested
        ? selectionReverseTarget(input.text, input.configuredTo, input.configuredFrom)
        : null;
    return reverseTarget
        ? {sourceLanguage: input.configuredTo, targetLanguage: reverseTarget}
        : {sourceLanguage: input.configuredFrom, targetLanguage: input.configuredTo};
}

export interface SelectionAnswerCandidate extends SelectionContentRequest {
    answer: string;
}

/** 为每条异步通道维护独立代次，避免一种请求的完成结果误废弃另一种请求。 */
export class SelectionRequestTokenGate {
    private generation = 0;

    begin(): number {
        this.generation += 1;
        return this.generation;
    }

    invalidate(): void {
        this.generation += 1;
    }

    isCurrent(token: number): boolean {
        return token === this.generation;
    }
}

function normalizeSelectionRequestLanguage(value: string): string {
    return normalizeChineseLanguageCode(String(value || '')).replace(/_/g, '-').toLowerCase();
}

/** ECDICT 随包附带的辅助释义是简体中文，仅在目标语言兼容时参与回退。 */
export function canUseBundledDictionaryFallback(targetLanguage: string): boolean {
    return normalizeSelectionRequestLanguage(targetLanguage) === 'zh-hans';
}

export function resolveSelectionDictionaryFallback(targetLanguage: string, translatedDefinitions: readonly unknown[]): string {
    if (!canUseBundledDictionaryFallback(targetLanguage)) return '';
    return translatedDefinitions
        .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
        .map(value => value.trim())
        .slice(0, 4)
        .join('；');
}

export function resolveSelectionVocabularyAnswer(
    current: SelectionContentRequest | null,
    translation: SelectionAnswerCandidate | null,
    dictionary: SelectionAnswerCandidate | null,
): string {
    if (!current) return '';
    const matches = (candidate: SelectionAnswerCandidate | null): candidate is SelectionAnswerCandidate => Boolean(
        candidate
        && candidate.generation === current.generation
        && candidate.text === current.text
        && normalizeSelectionRequestLanguage(candidate.targetLanguage) === normalizeSelectionRequestLanguage(current.targetLanguage)
        && candidate.answer.trim(),
    );
    if (matches(translation)) return translation.answer.trim();
    return matches(dictionary) ? dictionary.answer.trim() : '';
}

export interface SelectionPresentationState {
    showIndicator: boolean;
    showTooltip: boolean;
}

export type SelectionPresentationTrigger = 'direct' | 'icon' | 'dot' | 'shortcut' | 'contextMenu';

/** 延迟配置变化仍以当前选区稳定时刻为起点，避免刷新配置后重新等待完整时长。 */
export function getSelectionPresentationDelayRemaining(
    delay: number,
    selectionSettledAt: number,
    now: number,
): number {
    const elapsed = Math.max(0, now - selectionSettledAt);
    return Math.max(0, delay - elapsed);
}

/** 与展示无关的配置刷新不能关闭用户已经明确打开的翻译浮层。 */
export function reconcileSelectionPresentation(
    current: SelectionPresentationState,
    trigger: SelectionPresentationTrigger,
    triggerChanged: boolean,
): SelectionPresentationState {
    if (!triggerChanged) return current;
    if (trigger === 'direct') return {showIndicator: false, showTooltip: true};
    if (trigger === 'shortcut' || trigger === 'contextMenu') return {showIndicator: false, showTooltip: false};
    return {showIndicator: true, showTooltip: false};
}

/** 选区检测结果与目标语言使用统一标签规则比较；中文必须具有一致的明确书写体系。 */
export function isSameLanguage(detectedLanguage: string | undefined, targetLanguage: string | undefined): boolean {
    return isLanguageCodeMatch(detectedLanguage, targetLanguage);
}

export function normalizeSpeechLanguage(language: string | undefined, fallback = 'en-US'): string {
    let normalized = String(language ?? '').trim().replace(/_/g, '-');
    // 词书导入和语言检测可能保存 ISO 639-3（如 eng、jpn）；只归一化主语言子标签，
    // 再拼回原来的脚本和地区，避免 zho-Hant 被扩展成 zh-Hant-Hant。
    if (/^[a-z]{3}(?:-|$)/iu.test(normalized)) {
        const [primary, ...subtags] = normalized.split('-');
        const canonical = normalizeDetectedLanguageCode(primary);
        if (canonical) normalized = [canonical, ...subtags].join('-');
    }
    const lower = normalized.toLowerCase();
    if (!normalized || ['auto', 'detect', 'unknown', 'und'].includes(lower)) return fallback;

    const script = getChineseScript(normalized);
    if (script) return script === 'Hans' ? 'zh-CN' : 'zh-TW';

    const aliases: Record<string, string> = {
        // 只选择普通话朗读音色，不据此推断原文的简繁或跳过翻译。
        'cmn': 'zh-CN',
        'zho': 'zh-CN',
        'chi': 'zh-CN',
        'en': 'en-US',
        'ja': 'ja-JP',
        'ko': 'ko-KR',
        'fr': 'fr-FR',
        'de': 'de-DE',
        'es': 'es-ES',
        'it': 'it-IT',
        'pt': 'pt-BR',
        'ru': 'ru-RU',
    };

    if (Object.hasOwn(aliases, lower)) return aliases[lower];
    return /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(normalized) ? normalized : fallback;
}
