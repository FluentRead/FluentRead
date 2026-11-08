import {defineConfig} from 'vitest/config';
import base from './vitest.config';

// ChatGPT 套餐接入的专属行为门禁，显式范围避免启动全量回归。
export default defineConfig({...base, test: {...base.test,
    include: ['tests/chatgptPlanBridgeClient.test.ts', 'tests/chatgptPlanConfig.test.ts', 'tests/chatgptPlanHarness.test.ts', 'tests/chatgptPlanProvider.test.ts', 'tests/chatgptPlanSettingsLifecycle.test.ts'],
    coverage: {provider: 'v8', reporter: ['text', 'json-summary', 'json'], reportsDirectory: '/private/tmp/fluentread-chatgpt-plan-coverage',
        include: [
            'src/core/i18n/serviceLabels.ts',
            'src/platform/chatgpt-plan/buildMode.ts',
            'src/platform/chatgpt-plan/bridge.ts', 'src/platform/chatgpt-plan/events.ts',
            'src/services/chatgpt-plan/client.ts', 'src/services/harness/chatgptPlanModel.ts',
            'src/providers/translation/chatgpt-plan.ts', 'src/app/background/chatgptPlanRuntime.ts',
            'src/features/settings/model/chatgptPlanMessages.ts', 'src/features/settings/ui/services/ChatGPTPlanSettings.vue',
        ],
        thresholds: {statements: 100, branches: 100, functions: 100, lines: 100},
    },
}});
