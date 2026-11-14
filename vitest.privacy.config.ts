/** 隐私专项的有界覆盖率入口；完整回归仍使用全局配置。 */
import {defineConfig} from 'vitest/config';
import base from './vitest.config';
export default defineConfig({...base, test: {...base.test,
    include: ['tests/privacyProtection.test.ts', 'tests/translationPrivacy.test.ts', 'tests/privacySettingsLifecycle.test.ts'],
    coverage: {provider: 'v8', enabled: true, reportOnFailure: true,
        reportsDirectory: 'coverage/privacy', reporter: ['text', 'json-summary', 'json'],
        include: ['src/core/privacy/*.ts', 'src/services/translation/privacyProtection.ts', 'src/features/settings/ui/PrivacyProtectionSettings.vue'],
        thresholds: {statements: 100, branches: 100, functions: 100, lines: 100},
    },
}});
