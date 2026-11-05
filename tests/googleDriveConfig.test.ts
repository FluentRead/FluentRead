import {describe, expect, it} from 'vitest';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {CONFIG_CREDENTIAL_FIELDS} from '@/src/core/config/credentials';
import {builtinSiteRulePack} from '@/src/core/site-adaptation/catalog';
import {buildDriveSyncDiff, driveSyncPayload as completePayload, driveValuesEqual, parseDriveSyncPayload, resolveDriveSyncDiff, toDriveSyncConfig, projectDriveSyncConfig, restoreDriveSyncSettings, parseDriveSyncSnapshot, validateDriveSyncConsent} from '@/src/core/config/driveSync';

const driveSyncPayload = (config: Record<string, unknown>) => completePayload(config, true);
function complete(patch: Record<string, unknown> = {}) {return toDriveSyncConfig(normalizeConfig({...new Config(), videoServiceDefaultMigrated: true, ...patch}));}
describe('Google Drive 完整快照和安全合并', () => {
    it('previews signed margin units and keeps selected remote values through backup restoration', () => {
        const local = complete({floatingBallDefaultMargin: 0, floatingBallPopoutMargin: 20});
        const remote = complete({floatingBallDefaultMargin: -18, floatingBallPopoutMargin: -18});
        const parsed = parseDriveSyncPayload(completePayload(remote));
        expect(restoreDriveSyncSettings(local, parsed)).toMatchObject({floatingBallDefaultMargin: -18, floatingBallPopoutMargin: -18});
        const diff = buildDriveSyncDiff(local, local, remote);
        expect(diff.changes.find(change => change.label === '悬浮球默认边距')).toMatchObject({local:'0 px',remote:'-18 px'});
        expect(diff.changes.find(change => change.label === '悬浮球弹出边距')).toMatchObject({local:'20 px',remote:'-18 px'});
        const merged = resolveDriveSyncDiff(diff, Object.fromEntries(diff.changes.map(change => [change.id,'remote'])));
        expect(merged).toMatchObject({floatingBallDefaultMargin: -18, floatingBallPopoutMargin: -18});
    });
    it('浏览器默认译文字体属于普通备份设置，恢复和双向同步保留布尔选择及中文差异名称', () => {
        for (const enabled of [true, false]) {
            const local = complete({browserDefaultTranslationFont: !enabled, translationAppearance: {fontFamily: 'mono'}});
            const remote = complete({browserDefaultTranslationFont: enabled, translationAppearance: {fontFamily: 'mono'}});
            const publicSettings = projectDriveSyncConfig(remote);
            expect(publicSettings.browserDefaultTranslationFont).toBe(enabled);
            const restored = restoreDriveSyncSettings(local, parseDriveSyncPayload(completePayload(remote)));
            expect(restored.browserDefaultTranslationFont).toBe(enabled);
            expect(restored.translationAppearance).toEqual(remote.translationAppearance);
            expect(parseDriveSyncPayload(driveSyncPayload(remote)).browserDefaultTranslationFont).toBe(enabled);
            const diff = buildDriveSyncDiff(local, local, remote);
            expect(diff.changes).toHaveLength(1);
            expect(diff.changes[0]).toMatchObject({label: '浏览器默认译文字体', sensitive: false, conflict: false,
                local: enabled ? '关闭' : '开启', remote: enabled ? '开启' : '关闭'});
            expect(resolveDriveSyncDiff(diff, {}).browserDefaultTranslationFont).toBe(enabled);
        }
    });
    it('普通备份携带公开组合策略，无运行统计或凭据；完整备份拒绝孤儿组合引用', () => {
        const composite = {id: 'composite:work', name: '工作组合', strategy: 'smart', services: ['google', 'custom:fixture'], timeoutMs: 12_000};
        const fixture = complete({service: composite.id, compositeTranslationProviders: [composite], customOpenAIProviders: [
            {id: 'custom:fixture', name: 'Fixture', endpoint: 'https://fixture.invalid/v1', models: ['fixture-model']},
        ], token: {'custom:fixture': 'synthetic-local-secret'}});
        expect(parseDriveSyncPayload(driveSyncPayload(fixture)).compositeTranslationProviders).toEqual([composite]);
        const publicSettings = projectDriveSyncConfig(fixture);
        expect(publicSettings.compositeTranslationProviders).toEqual([composite]);
        expect(JSON.stringify(publicSettings)).not.toContain('synthetic-local-secret');
        expect(publicSettings).not.toHaveProperty('token');
        expect(publicSettings).not.toHaveProperty('customOpenAIProviders');
        const unknownRuntime = {...fixture, compositeTranslationProviders: [{...composite, runtimeStatistics: {successes: 5}}]};
        expect(projectDriveSyncConfig(unknownRuntime)).not.toHaveProperty('compositeTranslationProviders');
        expect(() => parseDriveSyncPayload(driveSyncPayload({...fixture, service: 'google', videoService: composite.id, compositeTranslationProviders: []}))).toThrow('不存在的组合翻译服务');
    });

    it('备份差异复用设置名称，连接整组说明变更类别而不暴露凭据', () => {
        const diff=buildDriveSyncDiff(null,{translationScope:'content',hotkey:'Alt',inputBoxTranslationPrompt:'fixture-private-prompt',service:'google',token:{},proxy:{}},{translationScope:'all',hotkey:'Shift',inputBoxTranslationPrompt:'other-private-prompt',service:'bing',token:{openai:'fixture-private-key'},proxy:{openai:'https://private.invalid'}});
        expect(diff.changes.map(change=>change.label)).toEqual(['识别全部节点','鼠标悬浮快捷键','输入框翻译提示词','翻译连接与凭据（整组）']);
        expect(diff.changes.at(-1)?.details).toEqual(['settings.cloud.changed.credentials','settings.cloud.changed.requests','settings.cloud.changed.services']);
        expect(JSON.stringify(diff.changes)).not.toMatch(/private|\.invalid/u);
        const headerRules = buildDriveSyncDiff(null, {requestHeaderRules: []}, {requestHeaderRules: [{domain: 'fixture-private.invalid', removeOrigin: true, removeReferer: false}]});
        expect(headerRules.changes[0].label).toBe('移除来源请求头');
        expect(JSON.stringify(headerRules.changes)).not.toContain('fixture-private.invalid');
        const unknown=buildDriveSyncDiff(null,{future:{secret:'private'},toString:'fixture-private'},{future:{secret:'other'},toString:'other-private'});
        expect(unknown.changes[0].label).toBe('私密或自定义设置');
        expect(unknown.changes.every(change=>change.sensitive)).toBe(true);
        expect(JSON.stringify(unknown.changes)).not.toMatch(/private|toString/u);
    });
    it('提前翻译零页跨设备保留，差异预览使用设置名称', () => {
        const fixture=complete({imageTranslationMangaPrefetchPages:0,imageTranslationMangaCachePages:18});
        expect(parseDriveSyncPayload(driveSyncPayload(fixture)).imageTranslationMangaPrefetchPages).toBe(0);
        expect(parseDriveSyncPayload(driveSyncPayload(fixture)).imageTranslationMangaCachePages).toBe(18);
        expect(buildDriveSyncDiff(null,{imageTranslationMangaPrefetchPages:3},fixture).changes).toContainEqual(expect.objectContaining({label:'提前翻译后续页面'}));
    });
    it('保留全部指定凭据及请求体/URL 鉴权，省略本机统计和迁移状态', () => {
        const fixture = complete({customOpenAIProviders: [{id: 'custom:fixture', name: 'Fixture', endpoint: 'https://fixture.invalid/v1', models: ['fixture-model']}], token: {openai: 'fixture-key'}, customHeaders: {'custom:fixture': '{"Authorization":"fixture-header"}'}, customBody: {openai: '{"auth":"fixture-body"}'}, proxy: {openai: 'https://fixture.invalid/?token=fixture-query'}, extra: {oauth: 'fixture-oauth'}, key: 'fixture-scalar', count: 10});
        expect(fixture).toMatchObject({customOpenAIProviders: [{id: 'custom:fixture', name: 'Fixture', endpoint: 'https://fixture.invalid/v1', models: ['fixture-model']}], token: {openai: 'fixture-key'}, customHeaders: {'custom:fixture': '{"Authorization":"fixture-header"}'}, customBody: {openai: '{"auth":"fixture-body"}'}, proxy: {openai: 'https://fixture.invalid/?token=fixture-query'}, extra: {oauth: 'fixture-oauth'}, key: 'fixture-scalar'});
        for (const field of CONFIG_CREDENTIAL_FIELDS) expect(Object.hasOwn(fixture, field)).toBe(true);
        for (const field of ['count', 'persistCredentials', 'uiLanguageSetupCompleted', 'videoServiceDefaultMigrated']) expect(fixture).not.toHaveProperty(field);
        expect(parseDriveSyncPayload(driveSyncPayload(fixture))).toEqual(fixture);
    });
    it('拒绝不完整快照、恶意原型字段和复杂树', () => {
        const fixture = complete();
        for (const invalid of [null, [], {}, {format: 'fluentread-complete-config', version: 2, config: fixture}, {format: 'fluentread-complete-config', version: 1, config: {}}, {format: 'fluentread-complete-config', version: 1, config: {...fixture, token: undefined, on: null}}]) expect(() => parseDriveSyncPayload(invalid)).toThrow();
        for (const field of CONFIG_CREDENTIAL_FIELDS) {const missing = {...fixture}; delete missing[field]; expect(() => parseDriveSyncPayload(driveSyncPayload(missing))).toThrow('完整');}
        const malicious = JSON.parse('{"future":{"__proto__":{"polluted":true}}}');
        expect(() => toDriveSyncConfig({...fixture, ...malicious})).toThrow('无效字段');
        let deep: unknown = 1;
        for (let depth = 0; depth < 42; depth++) deep = {nested: deep};
        expect(() => toDriveSyncConfig({...fixture, deep})).toThrow('复杂');
        expect(() => toDriveSyncConfig({...fixture, huge: Array.from({length: 50_001}, () => 0)})).toThrow('复杂');
        expect({}).not.toHaveProperty('polluted');
    });
    it('按共同基线自动选择单边修改，并要求显式解决双方冲突', () => {
        const base = {to: 'en', theme: 'light', future: {a: 1, b: 2}, list: [1, 2]};
        const local = {...base, theme: 'dark', future: {a: 3, b: 2}, list: [2, 3]};
        const remote = {...base, to: 'fr', future: {a: 4, b: 2}};
        const diff = buildDriveSyncDiff(base, local, remote);
        expect(diff.changes.filter(change => change.conflict)).toHaveLength(1);
        expect(() => resolveDriveSyncDiff(diff, {})).toThrow('每个冲突');
        const choices = Object.fromEntries(diff.changes.filter(change => change.conflict).map(change => [change.id, 'remote']));
        expect(resolveDriveSyncDiff(diff, choices)).toEqual({to: 'fr', theme: 'dark', future: {a: 4, b: 2}, list: [2, 3]});
        expect(() => resolveDriveSyncDiff(diff, null)).toThrow('选择无效');
        expect(() => resolveDriveSyncDiff(diff, {...choices, [diff.changes[0].id]: 'bad'})).toThrow();
    });
    it('连接与凭据整组选择，不把旧密钥合并到新地址，支持明确删除', () => {
        const base = {theme: 'light', token: {openai: 'fixture-old'}, proxy: {openai: 'https://old.invalid'}, customHeaders: {openai: 'fixture-header'}};
        const local = {...base, token: {openai: 'fixture-local'}};
        const remote = {...base, proxy: {openai: 'https://new.invalid'}, customHeaders: {}};
        const diff = buildDriveSyncDiff(base, local, remote);
        expect(diff.changes).toHaveLength(1);
        expect(diff.changes[0]).toMatchObject({sensitive: true, conflict: true});
        expect(JSON.stringify(diff.changes)).not.toContain('fixture');
        expect(JSON.stringify(diff.changes)).not.toContain('.invalid');
        expect(resolveDriveSyncDiff(diff, {'0': 'remote'})).toEqual(remote);
        const deletion = buildDriveSyncDiff({future: {a: 1}, theme: 'light'}, {future: {}, theme: 'light'}, {future: {a: 1}, theme: 'dark'});
        expect(resolveDriveSyncDiff(deletion, {})).toEqual({future: {}, theme: 'dark'});
    });
    it('首次同步没有隐含方向；预览隐藏未知键和值，覆盖空值和递归相等', () => {
        const diff = buildDriveSyncDiff(null, {theme: 'light', futureSecret: 'fixture-secret', future: null, empty: '', list: []}, {theme: 'dark', futureSecret: 'remote-secret', future: {}, empty: 'secret', list: ['secret']});
        expect(diff.changes.every(change => change.conflict)).toBe(true);
        expect(JSON.stringify(diff.changes)).not.toMatch(/fixture-secret|remote-secret|futureSecret/u);
        expect(resolveDriveSyncDiff(diff, Object.fromEntries(diff.changes.map(change => [change.id, 'local'])))).toEqual(diff.draft);
        expect(driveValuesEqual({a: [1, {b: null}]}, {a: [1, {b: null}]})).toBe(true);
        for (const [left, right] of [[[], {}], [[1], [1, 2]], [{a: 1}, {b: 1}], [{a: 1}, {a: 2}], [null, 1]]) expect(driveValuesEqual(left, right)).toBe(false);
        expect(buildDriveSyncDiff({}, {}, {}).changes).toEqual([]);
    });
    it('普通设置可辨认名称和值；伪装成普通字段的复杂私密对象仍掩码', () => {
        const diff = buildDriveSyncDiff(null,
            {mouseHoverTranslationDelay: 100, selectionTranslatorDelay: 200, disableFloatingBall: false},
            {mouseHoverTranslationDelay: 300, selectionTranslatorDelay: 400, disableFloatingBall: true});
        expect(diff.changes.map(change => change.label)).toEqual(['悬停翻译延迟（毫秒）', '划词翻译延迟（毫秒）', '禁用悬浮球']);
        expect(diff.changes[0]).toMatchObject({local: '100 ms', remote: '300 ms', sensitive: false});
        expect(diff.changes[2]).toMatchObject({local: '关闭', remote: '开启'});
        expect(JSON.stringify(buildDriveSyncDiff(null, {theme: {private: 'fixture-secret'}}, {theme: 'dark'}).changes)).not.toContain('fixture-secret');
    });
    it('兼容缺省嵌套偏好并隐藏空连接、未知结构及伪装的普通字段', () => {
        const payload = complete();
        expect(() => parseDriveSyncPayload(driveSyncPayload({...payload, translationCenterServices: null, favoriteServices: null, quickTranslationProfiles: null, writing: null, harness: null}))).not.toThrow();
        expect(() => parseDriveSyncPayload(driveSyncPayload({...payload, quickTranslationProfiles: [null, {service: 'google'}]}))).not.toThrow();
        const diff = buildDriveSyncDiff(null, {theme: 'light', future: {a: 1}, customOpenAIProviders: []}, {theme: null, future: {a: 2}, customOpenAIProviders: [{name: 'fixture-private'}]});
        expect(JSON.stringify(diff.changes)).not.toContain('fixture-private');
        expect(buildDriveSyncDiff(null, {}, {token: {openai: 'fixture'}}).changes[0].local).toBe('空值');
    });
    it('拒绝各功能引用已删除服务，服务选择与连接定义必须一起合并', () => {
        const base = complete({customOpenAIProviders: [{id: 'custom:fixture', name: 'Fixture', endpoint: 'https://fixture.invalid/v1', models: ['fixture-model']}]});
        const local = complete({...base, customOpenAIProviders: []});
        for (const field of ['service', 'documentService', 'hoverTranslationService', 'selectionTranslationService', 'imageTranslationService', 'videoService', 'areaTranslationService', 'inputBoxTranslationService']) {
            const remote = complete({...base, [field]: 'custom:fixture'});
            const diff = buildDriveSyncDiff(base, local, remote);
            expect(diff.changes.filter(change => change.conflict)).toHaveLength(1);
            const merged = resolveDriveSyncDiff(diff, Object.fromEntries(diff.changes.map(change => [change.id, 'remote'])));
            expect(parseDriveSyncPayload(driveSyncPayload(merged))).toEqual(remote);
            expect(() => parseDriveSyncPayload(driveSyncPayload({...local, [field]: 'custom:fixture'}))).toThrow();
        }
        for (const patch of [{translationCenterServices: ['custom:missing']}, {favoriteServices: ['custom:missing']}, {quickTranslationProfiles: [{service: 'custom:missing'}]}, {writing: {service: 'custom:missing'}}, {harness: {service: 'custom:missing'}}]) {
            expect(() => parseDriveSyncPayload(driveSyncPayload({...local, ...patch}))).toThrow('不存在');
        }
    });

    it('复合外观按组比较，提示词仍隐藏，常见单位与枚举直接可读', () => {
        const diff = buildDriveSyncDiff(null,
            {translationAppearance: {color: 'fixture-secret', weight: 300}, system_role: 'fixture-secret', translationCacheMaxBytes: 10485760, theme: 'light', floatingBallCollapsedOpacity: 75, videoSubtitleOffsetMs: 100, translationCacheMaxEntries: 10000, on: null},
            {translationAppearance: {color: 'other-secret', weight: 400}, system_role: 'other-secret', translationCacheMaxBytes: 5242880, theme: 'dark', floatingBallCollapsedOpacity: 50, videoSubtitleOffsetMs: 200, translationCacheMaxEntries: 2000, on: true});
        expect(diff.changes.filter(change => change.label === '译文外观')).toHaveLength(1);
        expect(JSON.stringify(diff.changes)).not.toMatch(/fixture-secret|other-secret/u);
        expect(diff.changes.find(change => change.label === '翻译缓存容量上限')).toMatchObject({local: '10 MiB', remote: '5 MiB'});
        expect(diff.changes.find(change => change.label === '主题')).toMatchObject({local: '亮色主题', remote: '暗色主题'});
        expect(diff.changes.find(change => change.label === '悬浮球收起不透明度')).toMatchObject({local: '75%', remote: '50%'});
        expect(diff.changes.find(change => change.label === '字幕时间偏移')).toMatchObject({local: '100 ms', remote: '200 ms'});
        expect(diff.changes.find(change => change.label === '翻译缓存条数上限')).toMatchObject({local: '10000', remote: '2000'});
        const selected = resolveDriveSyncDiff(diff, Object.fromEntries(diff.changes.map(change => [change.id, 'remote'])));
        expect(selected.translationAppearance).toEqual({color: 'other-secret', weight: 400});
        for (const patch of [{from: 'en'}, {to: 'fr'}, {style: 1}, {inputBoxTranslationInterval: 100}, {videoSubtitleFontSize: 100}, {theme: 'unknown'}, {translationCacheMaxBytes: Infinity}]) {
            expect(buildDriveSyncDiff(null, {}, patch).changes).toHaveLength(1);
        }
    });

});


describe('普通云备份范围与 v1 兼容', () => {
    it.each([false, true])('自定义网站规则保留正文标签和模板，content.key 存在：%s', withKey => {
        const reddit = structuredClone(builtinSiteRulePack.rules.find(rule => rule.id === 'reddit')!);
        expect(reddit.content![0].key).toBe('reddit-post-title');
        if (!withKey) reddit.content!.forEach(content => {delete content.key;});
        const siteAdaptation = {
            enabled: false, disabledRuleIds: ['reddit'],
            custom: {version: 1, profiles: {custom: {content: [{css: ['article p'], ...(withKey ? {key: 'article-body'} : {})}]}},
                rules: [reddit, {id: 'mine', name: '我的规则', match: {hosts: ['example.com']}, profile: 'custom'}]},
        };
        const local = complete({siteAdaptation});
        expect(local.siteAdaptation).toEqual(siteAdaptation);
        const settings = projectDriveSyncConfig(local);
        expect(settings.siteAdaptation).toEqual(siteAdaptation);
        const payload = completePayload(local);
        expect(parseDriveSyncSnapshot(payload)).toEqual({config: settings, includesSensitive: false});
        expect(projectDriveSyncConfig(parseDriveSyncPayload(completePayload(local, true))).siteAdaptation).toEqual(siteAdaptation);
        (settings.siteAdaptation as typeof siteAdaptation).custom.rules[0].name = 'changed clone';
        expect(local.siteAdaptation).toEqual(siteAdaptation);
    });
    it('普通备份保留默认网站规则开关，恢复和合并可覆盖已有本机规则', () => {
        const base = complete();
        expect(projectDriveSyncConfig(base).siteAdaptation).toEqual(new Config().siteAdaptation);
        const local = complete({siteAdaptation: {...new Config().siteAdaptation, disabledRuleIds: ['reddit']}});
        const remote = projectDriveSyncConfig(base);
        expect(restoreDriveSyncSettings(local, remote).siteAdaptation).toEqual(base.siteAdaptation);
        const diff = buildDriveSyncDiff(null, projectDriveSyncConfig(local), remote);
        expect(diff.changes).toHaveLength(1);
        expect(diff.changes[0]).toMatchObject({label: '网站规则', sensitive: true});
        const merged = resolveDriveSyncDiff(diff, {'0': 'remote'});
        expect(restoreDriveSyncSettings(local, merged).siteAdaptation).toEqual(base.siteAdaptation);
        // 旧普通快照从未带入网站规则，恢复时不能把本机规则重置为空。
        const {siteAdaptation: _omitted, ...oldSettings} = remote;
        expect(restoreDriveSyncSettings(local, oldSettings).siteAdaptation).toEqual(local.siteAdaptation);
    });
    it('网站规则的结构白名单拒绝嵌套凭据、未知字段与伪装标量', () => {
        const base = complete();
        const siteAdaptation = new Config().siteAdaptation;
        const reddit = structuredClone(builtinSiteRulePack.rules.find(rule => rule.id === 'reddit')!);
        const invalid = [
            {...siteAdaptation, token: 'fixture-secret'},
            {...siteAdaptation, enabled: 'fixture-secret'},
            {...siteAdaptation, disabledRuleIds: [{key: 'fixture-secret'}]},
            {...siteAdaptation, custom: {...siteAdaptation.custom, opaque: 'fixture-secret'}},
            {...siteAdaptation, custom: {version: 1, rules: [{...reddit, apiKey: 'fixture-secret'}]}},
            {...siteAdaptation, custom: {version: 1, rules: [{...reddit, content: [{css: ['p'], key: {token: 'fixture-secret'}}]}]}},
            {...siteAdaptation, custom: {version: 1, rules: [{...reddit, content: [{css: ['p'], authorization: 'fixture-secret'}]}]}},
            {...siteAdaptation, custom: {version: 1, profiles: {mine: {token: 'fixture-secret'}}, rules: []}},
        ];
        for (const value of invalid) {
            expect(projectDriveSyncConfig({siteAdaptation: value})).toEqual({});
            const payload = {format: 'fluentread-complete-config', version: 2, scope: 'settings',
                config: {...projectDriveSyncConfig(base), siteAdaptation: value}};
            expect(() => parseDriveSyncSnapshot(payload)).toThrow('不属于此范围');
        }
        // 规则字段的例外不能作用于连接配置或其他偏好中的同名字段。
        expect(projectDriveSyncConfig({key: 'fixture-secret', custom: 'https://fixture.invalid',
            shareCard: {...base.shareCard as object, css: ['p'], key: 'fixture-secret'}})).toEqual({});
    });
    it('普通旧备份的标量列表去重或移除退役服务时仍可读取，嵌入对象仍拒绝', () => {
        const payload = completePayload(complete()) as {config: Record<string, unknown>};
        const order = ['microsoft', 'deeplx', 'google', 'lingvaFree', 'google'];
        const old = {...payload, config: {...payload.config, freeTranslationOrder: order}};
        expect(parseDriveSyncSnapshot(old)).toEqual({config: old.config, includesSensitive: false});
        expect(toDriveSyncConfig(parseDriveSyncPayload(old)).freeTranslationOrder).toEqual(['microsoft', 'google']);
        for (const injected of [{opaque: 'fixture-hidden-field'}, {token: 'fixture-secret'}, ['nested']]) {
            expect(() => parseDriveSyncPayload({...old, config: {...old.config, freeTranslationOrder: [...order, injected]}})).toThrow('不属于此范围');
        }
        expect(() => parseDriveSyncPayload({...old, config: {...old.config, shareCard: {...payload.config.shareCard as object, fontSize: []}}})).toThrow('不属于此范围');
    });
    it('默认 v2 明确排除整个连接组、私密字段及未知根字段，任意请求体内容也不会泄露', () => {
        const local = complete({token: {openai: 'fixture-key'}, apiKeys: {openai: ['fixture-key']},
            customBody: {openai: '{"opaque":"fixture-arbitrary-secret"}'}, customHeaders: {openai: '{}'},
            proxy: {openai: 'https://fixture.invalid'}, system_role: {openai: 'fixture-private-prompt'},
            areaVisionPrompt: 'fixture-private-vision', inputBoxTranslationPrompt: 'fixture-private-writing',
            future: {opaque: 'fixture-future-secret'}, theme: 'dark'});
        const payload = completePayload(local) as {version: number; scope: string; config: Record<string, unknown>};
        expect(payload).toMatchObject({version: 2, scope: 'settings', config: {theme: 'dark'}});
        for (const key of [...CONFIG_CREDENTIAL_FIELDS, 'service', 'proxy', 'customBody', 'customOpenAIProviders',
            'writing', 'harness', 'system_role', 'areaVisionPrompt', 'inputBoxTranslationPrompt', 'future']) expect(payload.config).not.toHaveProperty(key);
        expect(JSON.stringify(payload)).not.toMatch(/fixture-key|fixture-arbitrary-secret|fixture-private|fixture-future-secret/u);
        expect(parseDriveSyncSnapshot(payload)).toEqual({config: payload.config, includesSensitive: false});
        expect(parseDriveSyncPayload(payload)).toEqual(payload.config);
        expect(parseDriveSyncSnapshot(completePayload(local, true))).toEqual({config: local, includesSensitive: true});
        // 旧 v1 解码器只接受 version === 1，v2 会安全失败且 service 没有补默认值。
        expect(payload.version).not.toBe(1);
        expect(payload.config).not.toHaveProperty('service');
    });
    it('嵌套凭据与未知结构整组排除，恢复保留本机整组并更新普通设置', () => {
        const base = complete();
        const local = {...base, translationAppearance: {...base.translationAppearance as object, token: {opaque: 'fixture-nested-secret'}},
            shareCard: {...base.shareCard as object, futureOpaque: 'fixture-unknown-nested'}, hotkey: {opaque: 'fixture-disguised-object'}};
        const settings = projectDriveSyncConfig(local);
        for (const key of ['translationAppearance', 'shareCard', 'hotkey']) expect(settings).not.toHaveProperty(key);
        const restored = restoreDriveSyncSettings(local, {...projectDriveSyncConfig(base), theme: 'dark'});
        expect(restored).toMatchObject({theme: 'dark', translationAppearance: local.translationAppearance, shareCard: local.shareCard, hotkey: local.hotkey});
        expect(restored.token).toEqual(base.token);
        expect(projectDriveSyncConfig({glossaryLibraries: [{id: 'invalid', opaque: 'fixture-unknown'}]})).toEqual({});
        expect(projectDriveSyncConfig({theme: null, alwaysTranslateDomains: []})).toEqual({theme: null, alwaysTranslateDomains: []});
        expect(projectDriveSyncConfig(local, true)).toEqual(local);
    });
    it('普通 payload 拒绝私密、未知、嵌套和恶意字段，范围不能靠 truthy 值开启', () => {
        const payload = completePayload(complete()) as {config: Record<string, unknown>};
        for (const config of [{...payload.config, token: {}}, {...payload.config, unknown: 'fixture'},
            {...payload.config, shareCard: {token: 'fixture'}}, {...payload.config, on: 1},
            {...payload.config, display: 2}, {...payload.config, from: ''}, {...payload.config, to: ''}]) {
            expect(() => parseDriveSyncSnapshot({...payload, config})).toThrow();
        }
        const malicious = JSON.parse('{"__proto__":{"polluted":true}}');
        expect(() => parseDriveSyncSnapshot({...payload, config: {...payload.config, ...malicious}})).toThrow('无效字段');
        for (const consent of [null, 0, 1, 'true', {}, []]) {
            expect(() => validateDriveSyncConsent(consent)).toThrow('布尔值');
            expect(() => completePayload(complete(), consent as boolean)).toThrow('布尔值');
        }
        validateDriveSyncConsent(false); validateDriveSyncConsent(true);
    });
});
