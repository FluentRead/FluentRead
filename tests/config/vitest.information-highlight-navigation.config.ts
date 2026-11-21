import {defineConfig} from 'vitest/config';
import base from '../../vitest.config';

// 独立导航覆盖报告与模型、内容及设置生命周期报告分开写，避免并行验证互相覆盖证据。
export default defineConfig({
    ...base,
    test: {
        ...base.test,
        include: [
            'tests/optionsNavigation.test.ts',
            'tests/optionsAppNavigationLifecycle.test.ts',
            'tests/popupFeatureVisibility.test.ts',
            'tests/userscriptFullOptions.test.ts',
        ],
        coverage: {
            enabled: true,
            provider: 'v8',
            include: ['src/features/settings/model/navigation.ts'],
            reportsDirectory: 'coverage/information-highlight-navigation',
            reporter: ['text', 'json', 'json-summary'],
            thresholds: {statements: 100, branches: 100, functions: 100, lines: 100},
        },
    },
});
