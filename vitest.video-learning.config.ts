import {defineConfig} from 'vitest/config';
import base from './vitest.config';

// 有界的视频学习专项。显式替换 include，避免 mergeConfig 把全量测试拼进来。
export default defineConfig({
    ...base,
    test: {
        ...base.test,
        include: [
            'tests/videoSentenceLearningAppearance.test.ts',
            'tests/videoSentenceLearningAppearanceSettingsLifecycle.test.ts',
            'tests/videoSentenceTimeline.test.ts',
            'tests/videoSentencePlayback.test.ts',
            'tests/videoSentenceLearningHost.test.ts',
            'tests/videoSentenceLearningSession.test.ts',
            'tests/videoSentenceLearningPlacement.test.ts',
            'tests/vocabularyVideoSource.test.ts',
            'tests/vocabularyVideoSourceUi.test.ts',
        ],
        coverage: {
            provider: 'v8',
            include: [
                'src/core/config/videoSentenceLearningAppearance.ts',
                'src/features/settings/ui/VideoSentenceLearningAppearanceSettings.vue',
                'src/features/video-subtitle/content/sentenceTimeline.ts',
                'src/features/video-subtitle/content/sentencePlayback.ts',
                'src/features/video-subtitle/content/sentenceLearningHost.ts',
                'src/features/video-subtitle/content/sentenceLearningSession.ts',
                'src/features/video-subtitle/content/sentenceLearningPlacement.ts',
                'src/features/vocabulary/source.ts',
            ],
            reporter: ['text', 'json-summary'],
            reportsDirectory: 'coverage/video-learning',
            thresholds: {statements: 100, branches: 100, functions: 100, lines: 100, perFile: true},
        },
    },
});
