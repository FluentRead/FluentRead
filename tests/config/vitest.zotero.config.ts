import {defineConfig} from 'vitest/config';
import base from '../../vitest.config';

// 专项配置显式替换 include，避免执行全仓测试；应用 API 由各行为测试提供隔离端口。
export default defineConfig({
    ...base,
    test: {
        ...base.test,
        include: ['tests/zotero*.test.ts', 'tests/pdfResources.test.ts'],
    },
});
