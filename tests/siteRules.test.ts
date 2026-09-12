import { describe, expect, it } from 'vitest';

import {
    getFullPageContextMenuPresentation,
    getSiteBaseDomain,
    isAlwaysTranslateSite,
    isExtensionDisabledOnSite,
    isFloatingBallDisabledOnSite,
    normalizeAlwaysTranslateDomains,
    normalizeDisabledExtensionDomains,
    normalizeFloatingBallDisabledDomains,
    shouldAutoTranslatePage,
} from '@/src/features/site-rules/domain';

describe('始终翻译网站规则', () => {
    it('使用 Public Suffix List 统一为可注册域名，并覆盖私有后缀', () => {
        expect(getSiteBaseDomain('https://news.bbc.co.uk/world')).toBe('bbc.co.uk');
        expect(getSiteBaseDomain('WWW.Example.COM./article')).toBe('example.com');
        expect(getSiteBaseDomain('https://docs.team.github.io/guide')).toBe('team.github.io');
        expect(getSiteBaseDomain('https://www.例子.中国/')).toBe('xn--fsqu00a.xn--fiqs8s');
    });

    it('为 localhost、单标签主机和 IP 保留精确 hostname', () => {
        expect(getSiteBaseDomain('localhost:5173/path')).toBe('localhost');
        expect(getSiteBaseDomain('http://printer/queue')).toBe('printer');
        expect(getSiteBaseDomain('http://192.168.1.10:8080/')).toBe('192.168.1.10');
        expect(getSiteBaseDomain('https://[::1]:8443/')).toBe('[::1]');
    });

    it('拒绝 public suffix、非法主机及非网页协议', () => {
        expect(getSiteBaseDomain(new URL('https://docs.example.com/page'))).toBe('example.com');
        expect(getSiteBaseDomain(new URL('ftp://example.com/file'))).toBeNull();
        expect(getSiteBaseDomain(42 as never)).toBeNull();
        expect(getSiteBaseDomain('http://example.com/page')).toBe('example.com');
        expect(getSiteBaseDomain('https://example.com/page')).toBe('example.com');
        expect(getSiteBaseDomain('com')).toBeNull();
        expect(getSiteBaseDomain('https://co.uk/')).toBeNull();
        expect(getSiteBaseDomain('github.io')).toBeNull();
        expect(getSiteBaseDomain('*.example.com')).toBeNull();
        expect(getSiteBaseDomain('http://[::1')).toBeNull();
        expect(getSiteBaseDomain('foo:123')).toBeNull();
        expect(getSiteBaseDomain(`${'a'.repeat(64)}.example.com`)).toBeNull();
        expect(getSiteBaseDomain(`${'a'.repeat(250)}.example.com`)).toBeNull();
        expect(getSiteBaseDomain('https://foo..com/')).toBeNull();
        expect(getSiteBaseDomain('file:///tmp/article.html')).toBeNull();
        expect(getSiteBaseDomain('chrome://settings')).toBeNull();
        expect(getSiteBaseDomain('mailto:user@example.com')).toBeNull();
        expect(getSiteBaseDomain('')).toBeNull();
    });

    it('规范化导入列表时保持顺序、按 base domain 去重并忽略非法项', () => {
        expect(normalizeAlwaysTranslateDomains([
            'https://news.bbc.co.uk/world',
            'BBC.CO.UK',
            'https://docs.team.github.io/guide',
            'blog.team.github.io',
            'localhost:3000',
            'co.uk',
            42,
            '',
        ])).toEqual(['bbc.co.uk', 'team.github.io', 'localhost']);
        expect(normalizeAlwaysTranslateDomains('example.com')).toEqual([]);
    });

    it('复用相同的主域名规则规范化禁用扩展名单', () => {
        expect(normalizeDisabledExtensionDomains([
            'https://docs.example.com/guide',
            'EXAMPLE.COM',
            'https://notexample.com',
            '*.invalid.example',
        ])).toEqual(['example.com', 'notexample.com']);
    });

    it('只按规范化后的 base domain 匹配，不产生字符串后缀误判', () => {
        const domains = ['https://www.example.com/path', 'team.github.io'];
        expect(isAlwaysTranslateSite('https://mail.example.com/inbox', domains)).toBe(true);
        expect(isAlwaysTranslateSite('https://docs.team.github.io/', domains)).toBe(true);
        expect(isAlwaysTranslateSite('https://notexample.com/', domains)).toBe(false);
        expect(isAlwaysTranslateSite('edge://settings', domains)).toBe(false);
    });

    it('按主域名匹配禁用扩展，并由自动翻译规则优先避让', () => {
        const disabledDomains = ['example.com'];
        expect(isExtensionDisabledOnSite('https://news.example.com/article', disabledDomains)).toBe(true);
        expect(isExtensionDisabledOnSite('https://notexample.com/article', disabledDomains)).toBe(false);
        expect(shouldAutoTranslatePage('https://news.example.com/article', {
            on: true,
            autoTranslate: true,
            alwaysTranslateDomains: [],
            disabledExtensionDomains: disabledDomains,
        })).toBe(false);
    });

    it('禁用站点时同步禁用全文翻译右键菜单', () => {
        expect(getFullPageContextMenuPresentation(false, true)).toEqual({
            enabled: false,
            title: '流畅阅读（当前网站已禁用）',
        });
        expect(getFullPageContextMenuPresentation(false, false)).toEqual({
            enabled: true,
            title: '流畅阅读翻译',
        });
        expect(getFullPageContextMenuPresentation(true, false)).toEqual({
            enabled: true,
            title: '流畅阅读取消翻译',
        });
    });

    it('同时保留旧全局自动翻译开关，并只对网站名单限制网页协议', () => {
        expect(shouldAutoTranslatePage('https://unlisted.example/', {
            on: true,
            autoTranslate: true,
            alwaysTranslateDomains: [],
        })).toBe(true);
        expect(shouldAutoTranslatePage('https://news.example.com/', {
            on: true,
            autoTranslate: false,
            alwaysTranslateDomains: ['example.com'],
        })).toBe(true);
        expect(shouldAutoTranslatePage('https://news.example.com/', {
            on: false,
            autoTranslate: true,
            alwaysTranslateDomains: ['example.com'],
        })).toBe(false);
        expect(shouldAutoTranslatePage('file:///tmp/article.html', {
            on: true,
            autoTranslate: true,
            alwaysTranslateDomains: [],
        })).toBe(true);
        expect(shouldAutoTranslatePage('file:///tmp/article.html', {
            on: true,
            autoTranslate: false,
            alwaysTranslateDomains: ['example.com'],
        })).toBe(false);
    });
});

describe('悬浮球禁用网站规则', () => {
    it('按主域名匹配子域，并忽略非法或非数组输入', () => {
        expect(normalizeFloatingBallDisabledDomains([
            'https://mail.example.com/inbox',
            'mail.example.com',
            'invalid host',
        ])).toEqual(['example.com']);
        expect(normalizeFloatingBallDisabledDomains('example.com')).toEqual([]);
        expect(isFloatingBallDisabledOnSite('https://mail.example.com/inbox', ['example.com'])).toBe(true);
        expect(isFloatingBallDisabledOnSite('https://example.org/', ['example.com'])).toBe(false);
        expect(isFloatingBallDisabledOnSite('file:///tmp/article.html', ['example.com'])).toBe(false);
    });

    it('只影响悬浮球，不改变扩展禁用与自动翻译判定', () => {
        expect(isExtensionDisabledOnSite('https://mail.example.com/', ['example.com'])).toBe(true);
        expect(shouldAutoTranslatePage('https://news.example.com/', {
            on: true,
            autoTranslate: false,
            alwaysTranslateDomains: ['example.com'],
        })).toBe(true);
        expect(isAlwaysTranslateSite('https://news.example.com/', ['example.com'])).toBe(true);
    });
});
