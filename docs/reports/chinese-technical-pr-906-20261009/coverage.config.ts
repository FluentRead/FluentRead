import {defineConfig} from 'vitest/config';
import base from '../../../tests/config/vitest.coverage.config';

// 仅检查本次语言与 DOM 边界；沿用仓库四维 100% 门禁，不扩大到全仓回归。
export default defineConfig({...base, test: {...base.test,
    include: [
        'tests/translationControlOwnership.test.ts', 'tests/serializationPerformance.test.ts',
        'tests/translationCore.test.ts', 'tests/allNodesTranslationCore.test.ts',
        'tests/translationSnapshotProtection.test.ts', 'tests/translationVisualProtection.test.ts',
        'tests/upstreamTranslationBoundaries.test.ts', 'tests/sectionTranslationCore.test.ts',
        'tests/fullPageVisibilityScheduling.test.ts', 'tests/languageIdentification.test.ts',
        'tests/languageIdentificationCorpus.test.ts', 'tests/chineseLanguage.test.ts',
        'tests/chineseUiNamesRegression.test.ts', 'tests/languageAuditBoundaries.test.ts',
        'tests/sameTargetLanguageRegression.test.ts', 'tests/sameTargetLanguageClient.test.ts',
    ],
    coverage: {...base.test!.coverage,
        provider: 'v8',
        include: ['src/core/language/identify.ts', 'src/core/language/chinese.ts',
            'src/core/language/lexicon.ts', 'src/core/language/functionWordData.ts',
            'src/core/translation/dom.ts'],
        reportsDirectory: 'coverage/chinese-technical-language',
    },
}});
