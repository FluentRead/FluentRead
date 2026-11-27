import {describe, expect, it} from 'vitest';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {normalizeShareCardPreferences, SHARE_CARD_THEMES} from '@/src/core/config/shareCard';
import {cardGraphemes, cardSourceDomain, cleanCardText, validateCardExcerpt, wrapCardText} from '@/src/features/share-card/core';

describe('双语分享卡片内容与外观', () => {
    it('八套样式稳定且新增样式通过持久化归一化往返', () => {
        expect(SHARE_CARD_THEMES).toHaveLength(8); expect(new Set(SHARE_CARD_THEMES).size).toBe(8);
        for (const theme of SHARE_CARD_THEMES) expect(normalizeConfig(JSON.parse(JSON.stringify({shareCard: {theme}}))).shareCard.theme).toBe(theme);
    });
    it('旧配置得到珊瑚默认样式且只持久化白名单外观字段', () => {
        expect(new Config().shareCard).toEqual(normalizeShareCardPreferences());
        const result = normalizeConfig({shareCard: {theme: 'prism', format: 'square', showSource: false, original: 'private excerpt', source: 'secret URL'}});
        expect(result.shareCard).toEqual({theme: 'prism', format: 'square', showSource: false, showBrand: false, translationFirst: false, fontSize: 'medium'});
        expect(JSON.stringify(result.shareCard)).not.toContain('private');
        expect(normalizeConfig(JSON.parse(JSON.stringify(result))).shareCard).toEqual(result.shareCard);
    });
    it('旧版风格对应新视觉身份，保留已有选择', () => {
        expect(normalizeShareCardPreferences().theme).toBe('coral');
        for (const [old, current] of Object.entries({paper: 'coral', minimal: 'pearl', night: 'prism', dusk: 'sky', vermilion: 'coral', cobalt: 'sky', aurora: 'prism', noir: 'pearl'})) {
            expect(normalizeShareCardPreferences({theme: old}).theme).toBe(current);
        }
    });
    it('非法偏好回退，显式关闭署名和译文在前保留', () => {
        expect(normalizeShareCardPreferences({theme: '__proto__', fontSize: 400, format: 'huge', showBrand: false, translationFirst: true})).toEqual({...normalizeShareCardPreferences(), showBrand: false, translationFirst: true});
    });
    it('来源只默认包含公开域名，不带路径、查询、账号、fragment或本地文件名', () => {
        expect(cardSourceDomain('https://user:password@www.example.com/private/doc?token=secret#anchor')).toBe('example.com');
        for (const href of ['file:///private/a.txt', 'about:blank', 'data:text/plain,secret', 'broken']) expect(cardSourceDomain(href)).toBe('');
    });
    it('保留 HTML 字面量、组合字符和换行，去掉控制字符', () => {
        expect(cleanCardText(' <script>hello</script>\r\n你\x00好 ')).toBe('<script>hello</script>\n你好');
        expect(cardGraphemes('a👨‍👩‍👧‍👦🇨🇳e\u0301')).toEqual(['a', '👨‍👩‍👧‍👦', '🇨🇳', 'e\u0301']);
    });
    it('英文尽量整词换行，长 URL 和 CJK 无空格文本仍可完整换行', () => {
        expect(wrapCardText('Hello world', 6, s => s.length)).toEqual(['Hello', 'world']);
        const text = '中文测试🙂'.repeat(5);
        const lines = wrapCardText(text, 4, s => cardGraphemes(s).length);
        expect(lines.join('')).toBe(text);
        expect(lines.every(line => cardGraphemes(line).length <= 4)).toBe(true);
        expect(wrapCardText('abcdefghijk', 4, s => s.length)).toEqual(['abcd', 'efgh', 'ijk']);
        expect(wrapCardText('first\n\nlast', 20, s => s.length)).toEqual(['first', '', 'last']);
    });
    it('拒绝空白和超长双语，不用截断伪装成功', () => {
        expect(validateCardExcerpt({original: ' ', translation: '好', source: ''})).toBe('empty');
        expect(validateCardExcerpt({original: 'a'.repeat(3000), translation: '好', source: ''})).toBe('long');
        expect(validateCardExcerpt({original: 'Hello', translation: '你好', source: ''})).toBeNull();
    });
});
