import {defineConfig} from 'vitest/config';
import base from './vitest.config';

// 单独验证本次新增业务模块，不因聚焦回归重跑其它功能。
export default defineConfig({
    ...base,
    test: {
        ...base.test,
        include: ['tests/informationHighlight*.test.ts', 'tests/i18n.test.ts'],
        coverage: {
            provider: 'v8', enabled: true,
            reportsDirectory: 'coverage/information-highlight',
            reporter: ['text', 'json-summary', 'json', 'html'],
            include: [
                'src/core/i18n/messages/informationHighlight.ts',
                'src/core/config/informationHighlight.ts',
                'src/core/config/informationHighlightModel.ts',
                'src/core/information-highlight/**/*.ts',
                'src/features/information-highlight/**/*.ts',
                'src/platform/storage/modelArtifacts.ts',
                'src/app/background/localModelMessageRuntime.ts',
                'src/app/content/informationHighlight.ts',
                'src/app/content/informationHighlightScorePort.ts',
                'src/app/document-translation/informationHighlight.ts',
                'src/app/offscreen/informationHighlightWorker.ts',
                'src/features/full-page-translation/content/visibleTranslation.ts',
            ],
            exclude: ['**/*.d.ts'],
            thresholds: {statements: 100, branches: 100, functions: 100, lines: 100},
        },
    },
});
