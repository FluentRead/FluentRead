import { afterEach, describe, expect, it } from 'vitest';

import {getPageTranslationContext, resetPageTranslationContextCache} from '@/src/services/translation/context';

const originalDocument = globalThis.document;
const originalLocation = globalThis.location;

afterEach(() => {
    resetPageTranslationContextCache();
    Object.defineProperty(globalThis, 'document', {value: originalDocument, configurable: true});
    Object.defineProperty(globalThis, 'location', {value: originalLocation, configurable: true});
});

describe('getPageTranslationContext', () => {
    it('without a document returns no page context', async () => {
        Object.defineProperty(globalThis, 'document', {value: undefined, configurable: true});
        expect(await getPageTranslationContext()).toBe('');
    });
    it('提取标题、描述和正文，并移除插件生成内容', async () => {
        const removed: string[] = [];
        const clone = {
            innerText: 'prefix context sentence target sentence suffix',
            textContent: '',
            querySelectorAll: (selector: string) => selector === '*'
                ? []
                : [{remove: () => removed.push('generated')}],
        };

        Object.defineProperty(globalThis, 'location', {
            value: {href: 'https://example.com/article'},
            configurable: true,
        });
        Object.defineProperty(globalThis, 'document', {
            value: {
                title: 'An article',
                body: {closest: () => null, cloneNode: () => clone},
                querySelector: (selector: string) => selector === 'meta[name="description"]'
                    ? {getAttribute: () => 'A short description'}
                    : null,
            },
            configurable: true,
        });

        const context = await getPageTranslationContext();

        expect(context).toContain('Page title: An article');
        expect(context).toContain('Page description: A short description');
        expect(context).toContain('Readable page content (Markdown):\nprefix context sentence target sentence suffix');
        expect(removed).toEqual(['generated']);
    });

    it('限制上下文长度，避免正文无限扩大请求体', async () => {
        const longText = 'x'.repeat(10000);
        const clone = {
            innerText: longText,
            textContent: '',
            querySelectorAll: () => [],
        };

        Object.defineProperty(globalThis, 'location', {
            value: {href: 'https://example.com/long'},
            configurable: true,
        });
        Object.defineProperty(globalThis, 'document', {
            value: {
                title: '',
                body: {closest: () => null, cloneNode: () => clone},
                querySelector: () => null,
            },
            configurable: true,
        });

        const context = await getPageTranslationContext();
        expect(context).toContain('Readable page content (Markdown):');
        expect(context.length).toBeLessThanOrEqual(4000);
        expect(context).toContain('x'.repeat(2000));
    });
});
