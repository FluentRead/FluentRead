import {describe, expect, it, vi} from 'vitest';

// 公开入口还导出浏览器 UI；仅隔离这些无关依赖，Markdown 解析始终使用真实实现。
vi.mock('@/src/features/reading-assistant/ui/ReadingPanel.vue', () => ({default: {}}));
vi.mock('@/src/features/reading-assistant/ui/ReadingAnswer.vue', () => ({default: {}}));
vi.mock('@/src/features/reading-assistant/ui/HarnessReadingHistory.vue', () => ({default: {}}));
vi.mock('webextension-polyfill', () => ({default: {}}));
import {writingPlainText} from '@/src/features/writing-assistant/markdown';

describe('Writing Markdown to Gmail plain text', () => {
    it('removes headings and emphasis while preserving paragraphs, soft breaks and inline code', () => {
        const markdown = '# **Reply**\r\n\r\nHello *there*, _friend_ and __team__.\r\nUse `x * y` and snake_case_value.\r\n\r\n---\r\nThanks.';
        expect(writingPlainText(markdown)).toBe('Reply\n\nHello there, friend and team.\nUse x * y and snake_case_value.\n\nThanks.');
    });

    it('retains list structure and the original ordered starting number', () => {
        expect(writingPlainText('- **First**\n+ Second\n\n3. `check()`\n4) Done')).toBe('• First\n• Second\n\n3. check()\n4. Done');
        expect(writingPlainText('> A **quoted** message\n> continues here.')).toBe('A quoted message\ncontinues here.');
    });

    it('keeps code literally, including Markdown, HTML and resource syntax inside fences', () => {
        const code = '  const label = "**literal**";\n<img src="https://example.test/pixel">\n[guide](https://example.test)';
        expect(writingPlainText(`\`\`\`html\n${code}\n\`\`\``)).toBe(code);
        expect(writingPlainText('~~~\n  unfinished\n# still code')).toBe('  unfinished\n# still code');
        expect(writingPlainText('Use `[guide](https://example.test)` literally.')).toBe('Use [guide](https://example.test) literally.');
    });

    it('removes emphasis around protected code and links without colliding with original private-use text', () => {
        expect(writingPlainText('**Use `a * b` and [Guide](https://example.test/_path_)**.')).toBe('Use a * b and Guide (https://example.test/_path_).');
        expect(writingPlainText('_`snake_case`_ \\*literal\\* \uE000 **`code`**')).toBe('snake_case *literal* \uE000 code');
    });

    it('projects tables into readable rows without losing escaped pipes or partial cells', () => {
        expect(writingPlainText('| **Name** | Value |\n| :--- | ---: |\n| `a\\|b` | *one* |\n| Two |')).toBe('Name\tValue\na|b\tone\nTwo');
        expect(writingPlainText('Name | Value\n--- | ---')).toBe('Name\tValue');
    });

    it('keeps link labels and exact URLs, including URL underscores and balanced parentheses', () => {
        expect(writingPlainText('[**Guide**](https://example.test/_private_/guide_(new))')).toBe('Guide (https://example.test/_private_/guide_(new))');
        expect(writingPlainText('[Guide](<https://example.test/a b> "A title") and [Help](https://example.test/help \'Help title\')')).toBe('Guide (https://example.test/a b) and Help (https://example.test/help)');
        expect(writingPlainText('[https://example.test](https://example.test) [](https://example.test/empty) [label]()')).toBe('https://example.test https://example.test/empty label');
        expect(writingPlainText('[guide](https://example.test/a\\(b\\))')).toBe('guide (https://example.test/a(b))');
    });

    it('keeps image addresses and unsafe-looking links as inert plain strings', () => {
        const markdown = '<script>alert("literal")</script>\n\n![Diagram](https://example.test/pixel) [Run](javascript:alert(1))';
        expect(writingPlainText(markdown)).toBe('<script>alert("literal")</script>\n\nDiagram (https://example.test/pixel) Run (javascript:alert(1))');
    });

    it('preserves escaped punctuation and incomplete syntax without guessing missing content', () => {
        expect(writingPlainText('\\*literal\\* \\[label\\] \\_value\\_')).toBe('*literal* [label] _value_');
        expect(writingPlainText('[a\\]b](https://example.test)')).toBe('a]b (https://example.test)');
        expect(writingPlainText('**unfinished [guide](https://example.test')).toBe('**unfinished [guide](https://example.test');
        expect(writingPlainText('')).toBe('');
        expect(writingPlainText('\n\n```\n```\n\n---\n')).toBe('');
    });
});
