import {readFileSync, realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import base from '../vitest.config';
import strict from '../vitest.coverage.config';

describe('shared Vitest regression configuration', () => {
    it('uses identical plugins, resolution and isolated execution settings for regular and coverage tests', () => {
        expect(strict.plugins).toBe(base.plugins);
        expect(strict.resolve).toBe(base.resolve);
        expect(strict.server).toBe(base.server);
        expect(base.server?.fs?.allow).toContain(realpathSync(resolve(__dirname, '../node_modules')));
        expect(base.server?.fs?.strict).not.toBe(false);
        const {coverage, ...execution} = strict.test!;
        expect(execution).toEqual(base.test);
        expect(execution.environment).toBe('node');
        expect(execution.isolate).not.toBe(false);
        expect(coverage).toBeDefined();
    });

    it('discovers the complete classified TypeScript suite in the single coverage pass', () => {
        const matrix = JSON.parse(readFileSync(resolve(__dirname, 'test-matrix.json'), 'utf8'));
        const files: string[] = Object.values(matrix.groups as Record<string, string[]>).flat();
        expect(base.test?.include).toEqual(['tests/**/*.test.ts']);
        expect(strict.test?.include).toBe(base.test?.include);
        expect(files.length).toBeGreaterThan(0);
        expect(new Set(files).size).toBe(files.length);
        expect(files.every(file => file.startsWith('tests/') && file.endsWith('.test.ts'))).toBe(true);
        expect(base.test?.exclude ?? []).toEqual([]);
    });

    it('keeps all-file instrumentation and the four strict 100 percent coverage gates', () => {
        const coverage = strict.test?.coverage;
        expect(coverage).toMatchObject({
            provider: 'v8', enabled: true, clean: true,
            exclude: ['**/*.d.ts'],
            thresholds: {statements: 100, branches: 100, functions: 100, lines: 100},
        });
        if (!coverage || !('include' in coverage)) throw new Error('Strict coverage must declare instrumented source files');
        expect(coverage.include).toContain('src/features/image-translation/content/mangaReader.ts');
        expect(coverage.include).toContain('src/services/translation/broker.ts');
    });
});
