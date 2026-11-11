import {parseHTML} from 'linkedom';
import {describe, expect, it} from 'vitest';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {SITE_RULE_LIMITS} from '@/src/core/site-adaptation/schema';
import {translateLegacyText} from '@/src/core/i18n';
import type {SiteAdaptationSettings, SiteRule, SiteRulePack} from '@/src/core/site-adaptation/types';
import {
    completeSiteRuleDraftSave, copySiteRuleToDraft, createSiteAdaptationCommitter, createSiteRuleDraftImportGuard,
    formatSiteRulePack, parseSiteAdaptationDraft, previewSiteRules,
    reconcileSiteRuleDraft, searchSiteRules, setSiteRuleEnabled, SITE_ADAPTATION_EXAMPLE,
    buildSiteRuleFromForm, createSiteRuleForm, listSiteRuleCatalog, mergeSiteRuleDraft, upsertSiteRuleDraft,
} from '@/src/features/settings/model/siteAdaptationEditor';
import {resolveSiteRule} from '@/src/core/site-adaptation/compiler';
import {registerAllUiLanguageBundles} from './helpers/uiLanguageBundles';

// 扩展运行时按需加载界面语言；本文件验证全部语言的文案契约，因此一次注册全部资源包。
registerAllUiLanguageBundles();

const document = parseHTML('<html><body></body></html>').document as unknown as Document;
const rule = (id: string, patch: Partial<SiteRule> = {}): SiteRule => ({
    id, name: id, match: {hosts: ['example.com']}, content: [{css: ['article p']}], ...patch,
});
const pack = (...rules: SiteRule[]): SiteRulePack => ({version: 1, rules});
const settings = (patch: Partial<SiteAdaptationSettings> = {}): SiteAdaptationSettings => ({
    enabled: true, disabledRuleIds: [], custom: pack(), ...patch,
});

describe('site adaptation settings persistence and editor behavior', () => {
    it('presents one effective rule per identifier and distinguishes custom overrides from additions', () => {
        const builtin = pack(rule('same'), rule('builtin'));
        const custom = pack(rule('same', {name: 'My override'}), rule('new'));
        const rows = listSiteRuleCatalog(builtin, settings({enabled: false, disabledRuleIds: ['same'], custom}));
        expect(rows.map(item => [item.rule.id, item.source, item.overridesBuiltin, item.enabled])).toEqual([
            ['same', 'custom', true, false], ['builtin', 'builtin', false, true], ['new', 'custom', false, true],
        ]);
        expect(rows[0]!.rule.name).toBe('My override');
        expect(rows[0]!.pack).toBe(custom);
        expect(builtin.rules[0]!.name).toBe('same');
    });
    it('roundtrips advanced content, CSS commas and inherited template behavior through the visual form', () => {
        const source: SiteRulePack = {version: 1, profiles: {base: {
            mode: 'focus', content: [{css: [':is(article, main) p'], atomic: false, resolve: 'closest', splitOnBr: true, key: 'paragraph'}],
            protect: ['pre'], omit: ['.private'], literalLabels: ['b'], literalTokens: ['code'], forceTranslate: ['#comments'],
        }}, rules: [rule('advanced', {profile: 'base', allScopes: true, content: undefined,
            match: {hosts: ['example.com'], paths: ['/read/*'], excludePaths: ['/read/private/*']}, watchIgnore: ['.clock'], exclude: ['nav']})]};
        const expanded = resolveSiteRule(source, source.rules[0]!);
        const form = createSiteRuleForm(expanded);
        form.name = 'User name'; form.protect += '\nbutton'; form.priority = 25;
        const rebuilt = buildSiteRuleFromForm(form, expanded);
        expect(rebuilt).toMatchObject({name: 'User name', allScopes: true, mode: 'focus', priority: 25,
            omit: ['.private'], literalLabels: ['b'], literalTokens: ['code'], forceTranslate: ['#comments'], protect: ['pre', 'button']});
        expect(rebuilt.content).toEqual(expanded.content);
        expect(rebuilt.match).toEqual(expanded.match);
        expect(rebuilt).not.toHaveProperty('profile');
        expect(parseSiteAdaptationDraft(formatSiteRulePack(pack(rebuilt)), document).ok).toBe(true);
        expect(expanded.name).toBe('advanced');
    });
    it('creates minimal rules and omits cleared optional lists without inventing empty content', () => {
        const empty = createSiteRuleForm();
        expect(empty).toMatchObject({id: '', mode: 'augment', content: [], protect: ''});
        Object.assign(empty, {id: 'new', name: 'New', hosts: ' example.com\n *.example.com ', protect: '', exclude: '', watchIgnore: ''});
        const minimal = buildSiteRuleFromForm(empty, rule('old', {profile: 'old', protect: ['button'], exclude: ['nav'], watchIgnore: ['.clock']}));
        expect(minimal).toEqual({id: 'new', name: 'New', mode: 'augment', priority: 0, match: {hosts: ['example.com', '*.example.com']}});
        const form = createSiteRuleForm(rule('content-defaults'));
        expect(form.content[0]).toMatchObject({resolve: 'self', splitOnBr: false, atomic: true});
        form.content[0]!.key = '  ';
        expect(buildSiteRuleFromForm(form).content![0]).not.toHaveProperty('key');
        form.content[0]!.key = '  content-key ';
        expect(buildSiteRuleFromForm(form).content![0]!.key).toBe('content-key');
    });
    it('explains all-node scope using the same allScopes boundary as the runtime engine', () => {
        const builtin = pack(rule('content-only', {mode: 'focus'}), rule('all', {allScopes: true}));
        expect(previewSiteRules('https://example.com', builtin, settings(), 'all')).toMatchObject({ok: true,
            rules: [{rule: {id: 'content-only'}, applicable: false, enabled: false}, {rule: {id: 'all'}, applicable: true, enabled: true}]});
        expect(previewSiteRules('https://example.com', builtin, settings())).toMatchObject({ok: true,
            rules: [{applicable: true, enabled: true}, {applicable: true, enabled: true}]});
    });
    it('upserts only the selected draft rule, retaining other rules and profiles, and blocks ID collisions', () => {
        const source = {version: 1 as const, profiles: {local: {protect: ['code']}}, rules: [rule('one'), rule('two')]};
        const text = formatSiteRulePack(source);
        const updated = upsertSiteRuleDraft(text, rule('one', {name: 'Changed'}), 'one', document);
        expect(updated.ok).toBe(true);
        if (!updated.ok) throw new Error('Expected a valid update');
        expect(JSON.parse(updated.draft)).toEqual({...source, rules: [rule('one', {name: 'Changed'}), rule('two')]});
        expect(upsertSiteRuleDraft(text, rule('one'), null, document)).toMatchObject({ok: false, issues: [{path: '$.id'}]});
        expect(upsertSiteRuleDraft('{broken', rule('new'), null, document).ok).toBe(false);
        expect(upsertSiteRuleDraft(text, rule('new', {protect: ['[']}), null, document).ok).toBe(false);
        const added = upsertSiteRuleDraft(text, rule('new'), null, document);
        expect(added.ok && JSON.parse(added.draft).rules.map((item: SiteRule) => item.id)).toEqual(['one', 'two', 'new']);
    });
    it('merges imported rules without dropping existing rules and refuses conflicting profile definitions', () => {
        const source = {version: 1 as const, profiles: {base: {protect: ['code']}}, rules: [rule('one'), rule('two')]};
        const incoming = {version: 1 as const, profiles: {base: {protect: ['code']}, added: {exclude: ['nav']}}, rules: [rule('two', {name: 'Imported'}), rule('three')]};
        const merged = mergeSiteRuleDraft(formatSiteRulePack(source), incoming, document);
        expect(merged.ok).toBe(true);
        if (!merged.ok) throw new Error('Expected merge');
        expect(JSON.parse(merged.draft)).toEqual({version: 1, profiles: incoming.profiles,
            rules: [rule('one'), rule('two', {name: 'Imported'}), rule('three')]});
        expect(mergeSiteRuleDraft(formatSiteRulePack(source), {...incoming, profiles: {base: {protect: ['button']}}}, document))
            .toMatchObject({ok: false, issues: [{path: '$.profiles.base'}]});
        expect(mergeSiteRuleDraft('{broken', incoming, document).ok).toBe(false);
        const minimal = mergeSiteRuleDraft(formatSiteRulePack(pack()), pack(rule('new')), document);
        expect(minimal.ok && JSON.parse(minimal.draft)).toEqual(pack(rule('new')));
        expect(mergeSiteRuleDraft(formatSiteRulePack(source), pack(rule('bad', {protect: ['[']})), document).ok).toBe(false);
    });
    it('migrates older configurations to enabled builtins and independent empty custom packs', () => {
        const first = new Config();
        const second = normalizeConfig({});
        expect(first.siteAdaptation).toEqual(settings());
        expect(second.siteAdaptation).toEqual(settings());
        first.siteAdaptation.custom.rules.push(rule('first'));
        expect(second.siteAdaptation.custom.rules).toEqual([]);
        const source = settings({enabled: false, disabledRuleIds: ['one', 'one'], custom: pack(rule('local'))});
        const normalized = normalizeConfig({siteAdaptation: source});
        expect(normalized.siteAdaptation).toEqual({...source, disabledRuleIds: ['one']});
        source.custom.rules[0]!.name = 'changed outside configuration';
        expect(normalized.siteAdaptation.custom.rules[0]!.name).toBe('local');
        expect(normalizeConfig({siteAdaptation: {enabled: false, custom: {version: 99}}}).siteAdaptation)
            .toEqual(settings({enabled: false}));
    });

    it('roundtrips the provided example and preserves Unicode and path patterns', () => {
        const draft = formatSiteRulePack(SITE_ADAPTATION_EXAMPLE);
        expect(draft).toContain('\n  "version": 1');
        expect(parseSiteAdaptationDraft(draft, document)).toEqual({ok: true, pack: SITE_ADAPTATION_EXAMPLE});
    });

    it('localizes adaptation controls and detailed guidance in every interface language', () => {
        for (const language of ['en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const) {
            for (const label of ['网站适配', '保存并应用', 'JSON 编辑草稿', '网址匹配预览', '撤销草稿替换',
                '按主域名生效，包含所有子域', '检查已保存规则，不访问网站', '检查规则',
                '选择要翻译和保留原文的区域', '匹配网站', '翻译范围', '高级选项', 'JSON 与备份',
                '只停用这条规则，其他匹配规则仍会生效', '放弃尚未保存的规则修改？', '每行填写一项，保存后应用到网页']) {
                expect(translateLegacyText(label, language)).not.toBe(label);
            }
        }
        const guide = '按已保存规则预览；仅检查网址匹配，实际内容以网页结构为准。';
        for (const locale of ['ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const) {
            expect(translateLegacyText(guide, locale)).not.toBe(translateLegacyText(guide, 'en-US'));
            expect(translateLegacyText(guide, locale)).not.toBe(guide);
        }
        expect(translateLegacyText(guide, 'en-US')).toContain('URL matching only');
    });

    it('reports syntax, field and browser-selector errors without accepting invalid drafts', () => {
        expect(parseSiteAdaptationDraft('{"version":1,}', document)).toMatchObject({
            ok: false, issues: [{path: '$', message: 'JSON 格式无效，请检查引号、逗号和括号。'}],
        });
        expect(parseSiteAdaptationDraft('{"version":7,"rules":[]}', document)).toMatchObject({
            ok: false, issues: [expect.objectContaining({path: '$.version'})],
        });
        expect(parseSiteAdaptationDraft(formatSiteRulePack(pack(rule('broken', {protect: ['[']}))), document))
            .toEqual({ok: false, issues: [{path: '$.rules[0].protect[0]', message: '当前浏览器不支持此 CSS 选择器'}]});
    });

    it('rejects oversized draft bytes before parsing JSON', () => {
        expect(parseSiteAdaptationDraft('中'.repeat(Math.ceil(SITE_RULE_LIMITS.bytes / 3)), document))
            .toEqual({ok: false, issues: [{path: '$', message: '规则包不能超过 2 MB'}]});
    });

    it('finds rules by trimmed case-insensitive names, identifiers and hostnames', () => {
        const rules = [rule('article-source', {name: 'Article Reader'}), rule('forum', {
            name: '论坛', match: {hosts: ['community.example.org', '*.forum.example.org']},
        })];
        expect(searchSiteRules(rules, '   ')).toEqual(rules);
        expect(searchSiteRules(rules, '  READER ')).toEqual([rules[0]]);
        expect(searchSiteRules(rules, 'source')).toEqual([rules[0]]);
        expect(searchSiteRules(rules, 'COMMUNITY.EXAMPLE')).toEqual([rules[1]]);
        expect(searchSiteRules(rules, '论坛')).toEqual([rules[1]]);
        expect(searchSiteRules(rules, 'missing')).toEqual([]);
    });

    it('toggles one rule idempotently without changing global enablement or custom rules', () => {
        const original = settings({enabled: false, disabledRuleIds: ['other'], custom: pack(rule('mine'))});
        const disabled = setSiteRuleEnabled(original, 'target', false);
        expect(disabled).toEqual({...original, disabledRuleIds: ['other', 'target']});
        expect(setSiteRuleEnabled(disabled, 'target', false)).toEqual(disabled);
        expect(setSiteRuleEnabled(disabled, 'target', true)).toEqual(original);
        expect(original.disabledRuleIds).toEqual(['other']);
        expect(disabled.custom).toBe(original.custom);
    });

    it('refreshes a clean draft from external configuration but preserves unsaved and invalid edits', () => {
        const previous = pack(rule('old'));
        const incoming = pack(rule('new'));
        expect(reconcileSiteRuleDraft(formatSiteRulePack(previous), previous, incoming))
            .toBe(formatSiteRulePack(incoming));
        expect(reconcileSiteRuleDraft('{ unfinished draft', previous, incoming)).toBe('{ unfinished draft');
        // 乐观回声暂时等于草稿，失败回滚仍不能把它误当作已经确认保存的内容。
        expect(reconcileSiteRuleDraft(formatSiteRulePack(incoming), incoming, previous, true))
            .toBe(formatSiteRulePack(incoming));
    });

    it('awaits persistence, snapshots settings, prevents duplicate commits and permits retry after failure', async () => {
        let succeed!: () => void;
        let fail!: (reason: Error) => void;
        const captured: SiteAdaptationSettings[] = [];
        const committer = createSiteAdaptationCommitter(value => {
            captured.push(value);
            return new Promise<void>((resolve, reject) => { succeed = resolve; fail = reject; });
        });
        const value = settings({custom: pack(rule('new-rule'))});
        const saving = committer.commit(value);
        value.custom.rules[0]!.name = 'edit while saving';
        expect(captured[0]!.custom.rules[0]!.name).toBe('new-rule');
        expect(await committer.commit(value)).toBe('busy');
        expect(captured).toHaveLength(1);
        fail(new Error('storage quota exceeded'));
        expect(await saving).toBe('failed');
        const retry = committer.commit(value);
        expect(captured[1]!.custom.rules[0]!.name).toBe('edit while saving');
        succeed();
        expect(await retry).toBe('saved');
    });

    it('retains the submitted draft after rollback and newer edits after successful acknowledgement', async () => {
        const original = pack();
        const submitted = pack(rule('new-rule'));
        const text = JSON.stringify(submitted);
        let draft = text;
        let previous = original;
        const failed = createSiteAdaptationCommitter(async value => {
            draft = reconcileSiteRuleDraft(draft, previous, value.custom, true);
            previous = value.custom;
            draft = reconcileSiteRuleDraft(draft, previous, original, true);
            throw new Error('background write failed');
        });
        expect(await failed.commit(settings({custom: submitted}))).toBe('failed');
        expect(draft).toBe(text);
        expect(completeSiteRuleDraftSave(draft, text, submitted)).toEqual({
            draft: formatSiteRulePack(submitted), clearUndo: true,
        });
        const newerDraft = '{ new input still being edited';
        expect(completeSiteRuleDraftSave(newerDraft, text, submitted)).toEqual({
            draft: newerDraft, clearUndo: false,
        });
    });

    it('accepts a file read only while its original draft and import generation remain current', async () => {
        const guard = createSiteRuleDraftImportGuard();
        let draft = 'original draft';
        let finishFirst!: (text: string) => void;
        const firstRead = new Promise<string>(resolve => { finishFirst = resolve; });
        const firstTicket = guard.begin(draft);
        const firstImport = firstRead.then(text => {
            if (guard.check(firstTicket, draft) === 'current') draft = text;
        });
        const secondTicket = guard.begin(draft);
        expect(guard.check(secondTicket, draft)).toBe('current');
        draft = 'newer imported file';
        finishFirst('stale imported file');
        await firstImport;
        expect(draft).toBe('newer imported file');
        expect(guard.check(firstTicket, firstTicket.draft)).toBe('superseded');

        const editedTicket = guard.begin(draft);
        draft = 'user kept typing while the file was being read';
        expect(guard.check(editedTicket, draft)).toBe('edited');
        const retryTicket = guard.begin(draft);
        expect(guard.check(retryTicket, draft)).toBe('current');
    });

    it('copies an independent built-in recipe into a draft, preserving local profiles and edits', () => {
        const builtin: SiteRulePack = {
            version: 1, profiles: {article: {mode: 'focus', protect: ['code'], content: [{css: ['.title']}]}},
            rules: [rule('builtin', {profile: 'article', protect: ['button']})],
        };
        const current: SiteRulePack = {
            version: 1, profiles: {local: {protect: ['kbd']}}, rules: [rule('existing', {name: '用户尚未保存的名称'})],
        };
        const copied = copySiteRuleToDraft(formatSiteRulePack(current), builtin, builtin.rules[0]!, document);
        expect(copied.ok).toBe(true);
        if (!copied.ok) throw new Error('expected valid copied draft');
        const parsed = JSON.parse(copied.draft) as SiteRulePack;
        expect(parsed.profiles).toEqual(current.profiles);
        expect(parsed.rules[0]).toEqual(current.rules[0]);
        expect(parsed.rules[1]).toMatchObject({
            id: 'builtin', mode: 'focus', protect: ['code', 'button'],
            content: [{css: ['article p']}, {css: ['.title']}],
        });
        expect(parsed.rules[1]).not.toHaveProperty('profile');
        expect(builtin.rules[0]).toHaveProperty('profile', 'article');
        const replaced = copySiteRuleToDraft(copied.draft, builtin, {...builtin.rules[0]!, name: 'updated'}, document);
        expect(replaced.ok).toBe(true);
        if (!replaced.ok) throw new Error('expected valid replacement');
        expect(JSON.parse(replaced.draft).rules).toHaveLength(2);
        expect(JSON.parse(replaced.draft).rules[1].name).toBe('updated');
    });

    it('rejects copying into an invalid draft or beyond the rule limit without dropping existing work', () => {
        const source = pack(rule('addition'));
        expect(copySiteRuleToDraft('{user is editing', source, source.rules[0]!, document))
            .toMatchObject({ok: false, issues: [{path: '$', message: expect.any(String)}]});
        const full = pack(...Array.from({length: SITE_RULE_LIMITS.rules}, (_, index) => rule(`rule-${index}`)));
        expect(copySiteRuleToDraft(formatSiteRulePack(full), source, source.rules[0]!, document))
            .toMatchObject({ok: false, issues: [expect.objectContaining({path: '$.rules'})]});
        expect(full.rules).toHaveLength(SITE_RULE_LIMITS.rules);
    });

    it('previews effective saved rules with exact runtime override, priority and disabled semantics', () => {
        const builtin = pack(
            rule('first', {priority: 1}), rule('default-priority'), rule('overridden', {priority: 20}),
            rule('unmatched', {match: {hosts: ['different.example']}}), rule('another-default'),
        );
        const custom = pack(rule('overridden', {name: '本地版本', priority: 10}), rule('additional', {priority: 5}));
        const result = previewSiteRules('  https://example.com/path?q=1  ', builtin,
            settings({custom, disabledRuleIds: ['first']}));
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('expected valid preview');
        expect(result.url).toBe('https://example.com/path?q=1');
        expect(result.rules.map(item => [item.rule.id, item.source, item.enabled])).toEqual([
            ['overridden', 'custom', true], ['additional', 'custom', true], ['first', 'builtin', false],
            ['default-priority', 'builtin', true], ['another-default', 'builtin', true],
        ]);
        expect(result.rules[0]!.rule.name).toBe('本地版本');
        expect(previewSiteRules('https://example.com', builtin, settings({enabled: false})))
            .toMatchObject({ok: true, rules: [
                expect.objectContaining({enabled: false}), expect.objectContaining({enabled: false}),
                expect.objectContaining({enabled: false}), expect.objectContaining({enabled: false}),
            ]});
        expect(previewSiteRules('https://unknown.example', builtin, settings())).toEqual({
            ok: true, url: 'https://unknown.example/', rules: [],
        });
    });

    it('previews only valid web URLs and respects path exclusions from saved rules', () => {
        expect(previewSiteRules('example.com', pack(), settings())).toEqual({ok: false});
        expect(previewSiteRules('file:///tmp/example', pack(), settings())).toEqual({ok: false});
        expect(previewSiteRules('javascript:alert(1)', pack(), settings())).toEqual({ok: false});
        const configured = settings({custom: pack(rule('article', {
            match: {hosts: ['example.com'], paths: ['/articles/*'], excludePaths: ['/articles/private/*']},
        }))});
        expect(previewSiteRules('http://example.com/articles/hello', pack(), configured))
            .toMatchObject({ok: true, rules: [expect.objectContaining({source: 'custom'})]});
        expect(previewSiteRules('http://example.com/articles/private/one', pack(), configured))
            .toMatchObject({ok: true, rules: []});
    });
});
