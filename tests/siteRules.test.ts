import { describe, expect, it, vi } from 'vitest';
import {listSitePreferences, previewSitePreferences, updateSitePreference} from '@/src/features/settings/model/sitePreferences';
import {createSiteRuleText, siteRuleTextRows} from '@/src/core/i18n/messages/siteRules';
import {normalizeConfig} from '@/src/core/config/model';
import {prepareConfigForExport, prepareConfigForImport} from '@/src/core/config/transfer';

import {
    getSiteBaseDomain,
    createSiteRuleMatcher,
    isAlwaysTranslateSite,
    isExtensionDisabledOnSite,
    isFloatingBallDisabledOnSite,
    normalizeAlwaysTranslateDomains,
    normalizeDisabledExtensionDomains,
    normalizeFloatingBallDisabledDomains,
    shouldAutoTranslatePage,
    resolveSiteTranslationDisplay,
} from '@/src/features/site-rules/domain';

const parserCalls = vi.hoisted(() => ({domain: 0, parse: 0}));
vi.mock('tldts', async importOriginal => {
    const actual = await importOriginal<typeof import('tldts')>();
    return {...actual,
        getDomain: (...args: Parameters<typeof actual.getDomain>) => {parserCalls.domain += 1; return actual.getDomain(...args);},
        parse: (...args: Parameters<typeof actual.parse>) => {parserCalls.parse += 1; return actual.parse(...args);},
    };
});

describe('页面私有网站规则索引', () => {
    const configuration = () => ({on: true, autoTranslate: false,
        alwaysTranslateDomains: ['https://docs.example.com/a', 'team.github.io', 'localhost:5173'],
        disabledExtensionDomains: ['blocked.com', '192.168.1.10']});

    it('与原规则保持一致，包括私有后缀、非法输入、禁用优先级和全局非网页语义', () => {
        for (const on of [true, false]) for (const autoTranslate of [true, false]) {
            const config = {...configuration(), on, autoTranslate};
            const matcher = createSiteRuleMatcher(config);
            for (const input of ['https://news.example.com/a', 'https://blocked.com/a', 'https://docs.team.github.io/a',
                'https://notexample.com/', 'http://localhost:5173/', 'http://192.168.1.10/', 'file:///tmp/a',
                'https://co.uk/', 'invalid host', new URL('https://mail.example.com/'), 42 as never]) {
                expect(matcher.isExtensionDisabled(input)).toBe(isExtensionDisabledOnSite(input, config.disabledExtensionDomains));
                expect(matcher.shouldAutoTranslate(input)).toBe(shouldAutoTranslatePage(input, config));
            }
        }
    });

    it('原地改写、追加、删除和同值新数组都按实际内容更新，不复用过期偏好', () => {
        const config = configuration(), matcher = createSiteRuleMatcher(config);
        expect(matcher.shouldAutoTranslate('https://example.com/')).toBe(true);
        config.alwaysTranslateDomains[0] = 'other.com';
        config.disabledExtensionDomains[0] = 'other.com';
        matcher.update(config);
        expect(matcher.shouldAutoTranslate('https://example.com/')).toBe(false);
        expect(matcher.shouldAutoTranslate('https://other.com/')).toBe(false);
        config.disabledExtensionDomains.splice(0, 1);
        matcher.update(config);
        expect(matcher.shouldAutoTranslate('https://other.com/')).toBe(true);
        config.disabledExtensionDomains.push('other.com');
        matcher.update(config);
        expect(matcher.isExtensionDisabled('https://other.com/')).toBe(true);
        matcher.update({...config, disabledExtensionDomains: [...config.disabledExtensionDomains]});
        expect(matcher.isExtensionDisabled('https://other.com/')).toBe(true);
        delete config.disabledExtensionDomains[1];
        matcher.update(config);
        expect(matcher.isExtensionDisabled('https://other.com/')).toBe(false);
        expect(matcher.shouldAutoTranslate('https://other.com/')).toBe(true);
        delete config.alwaysTranslateDomains[0];
        matcher.update(config);
        expect(matcher.shouldAutoTranslate('https://other.com/')).toBe(false);
        expect(matcher.shouldAutoTranslate('https://docs.team.github.io/')).toBe(true);
        config.alwaysTranslateDomains[0] = 'restored.com';
        matcher.update(config);
        expect(matcher.shouldAutoTranslate('https://restored.com/')).toBe(true);
    });

    it('配置快照不会被外部数组修改暗中改变，URL 对象变更则按最新 href 重新判定', () => {
        const config = configuration(), matcher = createSiteRuleMatcher(config);
        config.disabledExtensionDomains.push('example.com');
        expect(matcher.shouldAutoTranslate('https://example.com/')).toBe(true);
        matcher.update(config);
        expect(matcher.shouldAutoTranslate('https://example.com/')).toBe(false);
        const url = new URL('https://blocked.com/a');
        expect(matcher.isExtensionDisabled(url)).toBe(true);
        url.hostname = 'unlisted.com';
        expect(matcher.isExtensionDisabled(url)).toBe(false);
    });

    it('空或非法名单不建立可命中条目，开关更新不会遗留旧的全局状态', () => {
        const matcher = createSiteRuleMatcher({on: true, autoTranslate: false, alwaysTranslateDomains: []});
        expect(matcher.shouldAutoTranslate('https://example.com/')).toBe(false);
        expect(matcher.isExtensionDisabled('https://example.com/')).toBe(false);
        matcher.update({on: true, autoTranslate: true, alwaysTranslateDomains: undefined as never, disabledExtensionDomains: null as never});
        expect(matcher.shouldAutoTranslate('file:///tmp/a')).toBe(true);
        matcher.update({on: false, autoTranslate: true, alwaysTranslateDomains: ['com'], disabledExtensionDomains: ['*.example.com']});
        expect(matcher.shouldAutoTranslate('https://example.com/')).toBe(false);
        matcher.update({on: true, autoTranslate: false, alwaysTranslateDomains: ['com'], disabledExtensionDomains: []});
        expect(matcher.shouldAutoTranslate('https://example.com/')).toBe(false);
    });

    it('千条名单上的重复判定不重新解析名单，同值通知复用索引，新路由只解析当前域名', () => {
        const config = {on: true, autoTranslate: false,
            alwaysTranslateDomains: Array.from({length: 500}, (_, index) => `always-${index}.com`),
            disabledExtensionDomains: Array.from({length: 500}, (_, index) => `blocked-${index}.com`)};
        const matcher = createSiteRuleMatcher(config);
        parserCalls.domain = 0; parserCalls.parse = 0;
        for (let index = 0; index < 100; index += 1) {
            matcher.update({...config, alwaysTranslateDomains: [...config.alwaysTranslateDomains], disabledExtensionDomains: [...config.disabledExtensionDomains]});
            expect(matcher.isExtensionDisabled('https://always-499.com/a')).toBe(false);
            expect(matcher.shouldAutoTranslate('https://always-499.com/a')).toBe(true);
        }
        expect(parserCalls.domain).toBe(1);
        expect(parserCalls.parse).toBe(0);
        parserCalls.domain = 0;
        for (let index = 0; index < 100; index += 1) {
            const href = `https://always-499.com/article/${index}`;
            expect(matcher.isExtensionDisabled(href)).toBe(false);
            expect(matcher.shouldAutoTranslate(href)).toBe(true);
        }
        expect(parserCalls.domain).toBe(100);
        config.alwaysTranslateDomains[499] = 'replacement.com';
        matcher.update(config);
        expect(matcher.shouldAutoTranslate('https://always-499.com/article/99')).toBe(false);
        expect(matcher.shouldAutoTranslate('https://replacement.com/article/99')).toBe(true);
    });
});

describe('网站规则工作区文案', () => {
    it('为全部六种非中文界面提供独立、无重复且非空的完整文案', () => {
        const sources = siteRuleTextRows.map(row => row[0]);
        expect(new Set(sources).size).toBe(sources.length);
        for (const locale of ['en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const) {
            const translated = createSiteRuleText(locale);
            expect(Object.keys(translated)).toEqual(sources);
            for (const source of sources) {
                expect(translated[source]?.trim()).toBeTruthy();
                expect(translated[source]).not.toBe(source);
            }
        }
    });
});

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

describe('统一网站偏好与生效解释', () => {
    const config = () => ({on: true, autoTranslate: false, disableFloatingBall: false,
        alwaysTranslateDomains: ['https://docs.example.com/a', 'example.com'],
        disabledExtensionDomains: ['example.com'], floatingBallDisabledDomains: ['mail.example.com', 'other.test']});
    it('将旧数组按主域归并为一行，保留重叠偏好并支持搜索', () => {
        const source = config();
        const rows = listSitePreferences(source);
        expect(rows).toEqual([
            {domain: 'example.com', alwaysTranslate: true, extensionDisabled: true, floatingBallHidden: true, translationOnly: false},
            {domain: 'other.test', alwaysTranslate: false, extensionDisabled: false, floatingBallHidden: true, translationOnly: false},
        ]);
        expect(source.alwaysTranslateDomains).toHaveLength(2);
    });
    it('编辑与删除只影响目标域名，不突变源名单，撤销可以完整补回', () => {
        const source = config(); const snapshot = structuredClone(source);
        const row = listSitePreferences(source)[0]!;
        const removed = updateSitePreference(source, 'https://news.example.com/a', null)!;
        expect(removed).toEqual({alwaysTranslateDomains: [], disabledExtensionDomains: [], floatingBallDisabledDomains: ['other.test'], translationOnlyDomains: []});
        expect(updateSitePreference(removed, row.domain, row)).toEqual({
            alwaysTranslateDomains: ['example.com'], disabledExtensionDomains: ['example.com'], floatingBallDisabledDomains: ['other.test', 'example.com'],
            translationOnlyDomains: [],
        });
        expect(updateSitePreference(source, 'co.uk', row)).toBeNull();
        expect(source).toEqual(snapshot);
        expect(updateSitePreference(source, row.domain, {...row, extensionDisabled: false})?.disabledExtensionDomains).toEqual([]);
    });
    it.each([
        ['暂停', {on: false, autoTranslate: true}, 'paused', 'paused'],
        ['网站禁用', {autoTranslate: true}, 'disabled', 'disabled'],
        ['全局自动', {disabledExtensionDomains: [], autoTranslate: true}, 'global', 'hidden-site'],
        ['网站自动', {disabledExtensionDomains: []}, 'site', 'hidden-site'],
        ['全局隐藏', {disabledExtensionDomains: [], disableFloatingBall: true}, 'site', 'hidden-global'],
        ['手动翻译', {disabledExtensionDomains: [], alwaysTranslateDomains: [], floatingBallDisabledDomains: []}, 'manual', 'visible'],
    ])('解释%s并与运行时自动翻译判定保持一致', (_, patch, translation, ball) => {
        const source = {...config(), ...patch};
        const preview = previewSitePreferences('https://news.example.com/a', source)!;
        expect(preview.translation).toBe(translation);
        expect(preview.floatingBall).toBe(ball);
        expect(preview.domain).toBe('example.com');
        expect(shouldAutoTranslatePage(preview.url, source)).toBe(['global', 'site'].includes(translation));
    });
    it('拒绝不完整网址及非网页协议，支持无注册域与 IP 的全局行为', () => {
        expect(previewSitePreferences('not a URL', config())).toBeNull();
        expect(previewSitePreferences('example.com', config())).toBeNull();
        expect(previewSitePreferences('file:///private/tmp/a.html', config())).toBeNull();
        expect(previewSitePreferences('https://co.uk/', {...config(), autoTranslate: true})).toMatchObject({domain: null, translation: 'global'});
        expect(previewSitePreferences('http://127.0.0.1/a', config())).toMatchObject({domain: '127.0.0.1', translation: 'manual'});
    });
});

describe('按网站关闭双语对照', () => {
    it('仅命中主域及子域的网站使用仅译文，其他网站沿用全局模式，不改变源配置', () => {
        const config = {display: 1, translationOnlyDomains: ['https://docs.example.com/article', 'team.github.io']};
        const before = structuredClone(config);
        for (const input of ['https://example.com/', new URL('http://news.example.com:8080/a')]) {
            expect(resolveSiteTranslationDisplay(config, input)).toBe(0);
        }
        for (const url of ['https://example.com.evil.test/', 'https://other.github.io/', 'file:///example.com', 'bad url']) {
            expect(resolveSiteTranslationDisplay(config, url)).toBe(1);
        }
        expect(resolveSiteTranslationDisplay(config, 'https://docs.team.github.io/a')).toBe(0);
        expect(resolveSiteTranslationDisplay({display: 0, translationOnlyDomains: ['example.com']}, 'https://other.test')).toBe(0);
        for (const translationOnlyDomains of [undefined, []]) {
            parserCalls.domain = 0;
            expect(resolveSiteTranslationDisplay({display: 1, translationOnlyDomains}, 'https://example.com')).toBe(1);
            expect(parserCalls.domain).toBe(0);
        }
        expect(config).toEqual(before);
    });
    it('单独添加仅译文偏好可预览、删除和撤销，且不会开启自动翻译或禁用其他能力', () => {
        const config = normalizeConfig({display: 1, autoTranslate: false, disableFloatingBall: false});
        const row = {alwaysTranslate: false, extensionDisabled: false, floatingBallHidden: false, translationOnly: true};
        const patch = updateSitePreference(config, 'https://docs.example.com/a', row)!;
        expect(listSitePreferences(patch)).toEqual([{domain: 'example.com', ...row}]);
        const next = {...config, ...patch};
        expect(previewSitePreferences('https://example.com/a', next)).toMatchObject({display: 'single', translation: 'manual', extension: 'enabled', floatingBall: 'visible'});
        expect(previewSitePreferences('https://another.test/a', next)).toMatchObject({display: 'bilingual', translation: 'manual'});
        expect(previewSitePreferences('https://another.test/a', {...next, display: 0})).toMatchObject({display: 'single'});
        expect(previewSitePreferences('https://another.test/a', {...next, display: undefined})).toMatchObject({display: 'bilingual'});
        expect(updateSitePreference(next, 'example.com', null)?.translationOnlyDomains).toEqual([]);
        expect(next.display).toBe(1); expect(config.translationOnlyDomains).toEqual([]);
    });
    it('旧配置默认空名单，网址归并与完整备份往返保留站点偏好及全局显示', () => {
        expect(normalizeConfig({}).translationOnlyDomains).toEqual([]);
        const config = normalizeConfig({display: 1, translationOnlyDomains: ['https://docs.example.com/a', 'example.com', 'co.uk', 2]});
        expect(config.translationOnlyDomains).toEqual(['example.com']);
        const restored = prepareConfigForImport(JSON.parse(JSON.stringify(prepareConfigForExport(config))), normalizeConfig({}));
        expect(restored.translationOnlyDomains).toEqual(['example.com']); expect(restored.display).toBe(1);
    });
});
