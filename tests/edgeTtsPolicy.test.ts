import {describe, expect, it} from 'vitest';
import {
    buildEdgeTtsSsml,
    concatEdgeTtsAudio,
    edgeTtsLimits,
    edgeTtsTokenExpiry,
    edgeTtsVoiceCandidatesForLanguage,
    normalizeEdgeTtsLanguage,
    splitEdgeTtsText,
} from '@/src/features/selection-translation/services/edgeTtsPolicy';

function base64UrlJson(value: unknown): string {
    return btoa(JSON.stringify(value))
        .replace(/\+/gu, '-')
        .replace(/\//gu, '_')
        .replace(/=+$/gu, '');
}

describe('Edge TTS pure policy', () => {
    it('normalizes supported translation language aliases without guessing unknown locales', () => {
        expect(normalizeEdgeTtsLanguage(undefined as unknown as string)).toBe('en-US');
        expect(normalizeEdgeTtsLanguage('auto')).toBe('en-US');
        expect(normalizeEdgeTtsLanguage('detect')).toBe('en-US');
        expect(normalizeEdgeTtsLanguage('ZH-HANS')).toBe('zh-CN');
        expect(normalizeEdgeTtsLanguage('zh_hant')).toBe('zh-TW');
        expect(normalizeEdgeTtsLanguage('zh-HK')).toBe('zh-TW');
        expect(normalizeEdgeTtsLanguage('zh-Hant-CN')).toBe('zh-TW');
        expect(normalizeEdgeTtsLanguage('EN')).toBe('en-US');
        expect(normalizeEdgeTtsLanguage(' fr_CA ')).toBe('fr-CA');
        expect(normalizeEdgeTtsLanguage('xx-ZZ')).toBe('xx-ZZ');
    });

    it('keeps same-locale user voices first, then stable automatic fallbacks', () => {
        expect(edgeTtsVoiceCandidatesForLanguage('en-US', [
            'en-US-JennyNeural',
            'en-US-JennyNeural',
            'en-GB-SoniaNeural',
        ])).toEqual([
            'en-US-JennyNeural',
            'en-US-AvaMultilingualNeural',
            'en-US-AriaNeural',
            'en-US-GuyNeural',
        ]);
        expect(edgeTtsVoiceCandidatesForLanguage('fr-CA')).toEqual(['fr-FR-RemyMultilingualNeural']);
        expect(edgeTtsVoiceCandidatesForLanguage('xx-ZZ', 'not-an-array')).toEqual([]);
        expect(edgeTtsVoiceCandidatesForLanguage('zh-Hans')[0]).toBe('zh-CN-XiaoxiaoMultilingualNeural');
        expect(edgeTtsVoiceCandidatesForLanguage('zh-Hant')[0]).toBe('zh-TW-YunJheMultilingualNeural');
        expect(edgeTtsVoiceCandidatesForLanguage('xx-ZZ')).toEqual([]);
    });

    it('accepts Mandarin detection aliases without losing configured Chinese voices or traditional locales', () => {
        for (const language of ['cmn', ' ZHO ', 'CHI']) {
            expect(normalizeEdgeTtsLanguage(language)).toBe('zh-CN');
            const candidates = edgeTtsVoiceCandidatesForLanguage(language, ['zh-CN-XiaoyiNeural', 'zh-TW-HsiaoYuNeural']);
            expect(candidates[0]).toBe('zh-CN-XiaoyiNeural');
            expect(candidates).toContain('zh-CN-XiaoxiaoMultilingualNeural');
            expect(candidates).not.toContain('zh-TW-HsiaoYuNeural');
        }
        expect(normalizeEdgeTtsLanguage('zh-Hant')).toBe('zh-TW');
        expect(edgeTtsVoiceCandidatesForLanguage('zh-Hant')[0]).toBe('zh-TW-YunJheMultilingualNeural');
    });

    it('escapes all SSML-controlled values and applies defaults', () => {
        const ssml = buildEdgeTtsSsml(
            `  A < B & C > D "quoted" 'single'  `,
            'en-US-Ava&Neural',
            '"fast"',
            '<high>',
            "'loud'",
        );
        expect(ssml).toContain('xml:lang="en-US"');
        expect(ssml).toContain('name="en-US-Ava&amp;Neural"');
        expect(ssml).toContain('rate="&quot;fast&quot;"');
        expect(ssml).toContain('pitch="&lt;high&gt;"');
        expect(ssml).toContain('volume="&apos;loud&apos;"');
        expect(ssml).toContain('A &lt; B &amp; C &gt; D &quot;quoted&quot; &apos;single&apos;');

        expect(buildEdgeTtsSsml(' text ', '')).toContain('xml:lang="en-US"');
        expect(buildEdgeTtsSsml('text', 'en-US-Test')).toContain('rate="+0%" pitch="+0Hz" volume="+0%"');
    });

    it('splits by UTF-8 budget, prefers readable boundaries, and rejects excessive text', () => {
        expect(splitEdgeTtsText('   ')).toEqual([]);
        expect(splitEdgeTtsText(' short text ')).toEqual(['short text']);

        const sentenceBoundary = `${'a'.repeat(1_200)}. ${'b'.repeat(900)}`;
        const sentenceChunks = splitEdgeTtsText(sentenceBoundary);
        expect(sentenceChunks).toHaveLength(2);
        expect(sentenceChunks[0]?.endsWith('.')).toBe(true);
        expect(sentenceChunks.join(' ')).toBe(sentenceBoundary);

        const multibyte = `${'é'.repeat(300)}${'中'.repeat(600)}${'😀'.repeat(200)}`;
        const multibyteChunks = splitEdgeTtsText(multibyte);
        expect(multibyteChunks.length).toBeGreaterThan(1);
        expect(multibyteChunks.join('')).toBe(multibyte);
        expect(multibyteChunks.every((chunk) => new TextEncoder().encode(chunk).byteLength <= edgeTtsLimits.chunkBytes)).toBe(true);

        expect(() => splitEdgeTtsText('x'.repeat(edgeTtsLimits.chunkBytes * (edgeTtsLimits.chunks + 2))))
            .toThrow('Edge TTS text is too long');
    });

    it('concatenates audio chunks without changing byte order', () => {
        expect(new Uint8Array(concatEdgeTtsAudio([]))).toEqual(new Uint8Array());
        expect(new Uint8Array(concatEdgeTtsAudio([
            new Uint8Array([1, 2]).buffer,
            new Uint8Array([3]).buffer,
        ]))).toEqual(new Uint8Array([1, 2, 3]));
    });

    it('uses JWT expiry when safe and a short fallback for malformed tokens', () => {
        const now = 1_000;
        expect(edgeTtsTokenExpiry(`header.${base64UrlJson({exp: 123})}.signature`, now)).toBe(123_000);
        expect(edgeTtsTokenExpiry(`header.${base64UrlJson({exp: '123'})}.signature`, now))
            .toBe(now + edgeTtsLimits.fallbackTokenLifetimeMs);
        expect(edgeTtsTokenExpiry('opaque-token', now)).toBe(now + edgeTtsLimits.fallbackTokenLifetimeMs);
        expect(edgeTtsTokenExpiry('header.%%%invalid.signature', now)).toBe(now + edgeTtsLimits.fallbackTokenLifetimeMs);
        expect(edgeTtsTokenExpiry('opaque-token')).toBeGreaterThan(Date.now());
    });
});
