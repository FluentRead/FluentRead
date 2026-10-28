/** 测试中直接触发真实单候选翻译，不再依赖仅供测试使用的生产封装。 */
import {getCurrentTranslationCore} from '@/src/core/translation/public';
import {config} from '@/src/services/config/store';
import {asHTMLElement} from '@/src/features/full-page-translation/content/mutationObservation';
import {translateTarget} from '@/src/features/full-page-translation/content/runtime';

export function translateBilingualFixture(node: unknown, slide: boolean): void {
    const target = asHTMLElement(node);
    if (!target) return;
    const candidate = getCurrentTranslationCore(config.translationScope).resolve(target);
    if (candidate) void translateTarget(candidate, 'bilingual', slide);
}
