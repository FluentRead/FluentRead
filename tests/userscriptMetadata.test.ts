import {describe, expect, it} from 'vitest';
import {createUserscriptMetadata} from '@/userscript/metadata';

describe('userscript metadata', () => {
    it('targets classic GM APIs supported by Via and allows provider requests', () => {
        const metadata = createUserscriptMetadata({version: '1.2.3'});

        expect(metadata.startsWith('// ==UserScript==\n')).toBe(true);
        expect(metadata).toContain('// @name         FluentRead-流畅阅读');
        expect(metadata).toContain('// @namespace    https://fr.unmeta.cn/');
        expect(metadata).toContain('// @version      1.2.3');
        expect(metadata).toContain('// @grant        GM_xmlhttpRequest');
        expect(metadata).toContain('// @grant        GM_registerMenuCommand');
        expect(metadata).toContain('// @connect      *');
        expect(metadata).toContain('// @run-at       document-start');
        expect(metadata).not.toContain('@require');
    });
});
