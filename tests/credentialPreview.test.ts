import {describe, expect, it} from 'vitest';
import {buildCredentialPreviewChanges} from '@/src/features/settings/model/credentialPreview';

describe('配置凭据变化预览', () => {
    it('does not preview unchanged secondary cloud credentials as an import replacement', () => {
        const before={secret:{tencent:'unchanged-private-secondary-key'}},after={secret:{tencent:'unchanged-private-secondary-key'}};
        expect(buildCredentialPreviewChanges(before,after)).toEqual([]);
    });
    it('previews secondary cloud key replacement and removal without showing either key', () => {
        const changes = buildCredentialPreviewChanges(
            {secret:{tencent:'old-private-secondary-key',unknown:'removed-private-key'}},
            {secret:{tencent:'new-private-secondary-key'}},
        );
        expect(changes.map(change=>change.key)).toEqual(['secret.tencent','secret.unknown']);
        expect(JSON.stringify(changes)).not.toMatch(/old-private|new-private|removed-private/);
    });
    it('只显示新增、替换和清除状态，不泄露任何凭据明文', () => {
        const changes = buildCredentialPreviewChanges({
            token: {openai: 'sk-old-secret'},
            ak: 'old-access-key',
            extra: {privateHeader: 'old-extra-secret'},
        }, {
            token: {openai: 'sk-new-secret', deepseek: 'sk-added-secret'},
            ak: '',
            extra: {},
        });

        expect(changes).toEqual(expect.arrayContaining([
            expect.objectContaining({key: 'token.openai', before: '已配置（内容已隐藏）', after: '将替换（内容已隐藏）'}),
            expect.objectContaining({key: 'token.deepseek', before: '未设置', after: '将新增（内容已隐藏）'}),
            expect.objectContaining({key: 'ak', after: '将清除'}),
            expect.objectContaining({key: 'extra.privateHeader', after: '将清除'}),
        ]));
        const serialized = JSON.stringify(changes);
        expect(serialized).not.toContain('sk-old-secret');
        expect(serialized).not.toContain('sk-new-secret');
        expect(serialized).not.toContain('sk-added-secret');
        expect(serialized).not.toContain('old-access-key');
        expect(serialized).not.toContain('old-extra-secret');
    });

    it('相同或都未配置的凭据不产生噪音', () => {
        expect(buildCredentialPreviewChanges({token: {}, ak: ''}, {token: {}, ak: ''})).toEqual([]);
        expect(buildCredentialPreviewChanges(null, undefined)).toEqual([]);
    });

    it('预览备用 Key 的新增、替换和清除，不重复显示首个 Key 或泄露内容', () => {
        const before = {token: {openai: 'first-private'}, apiKeys: {openai: ['first-private', 'backup-private']}};
        const after = {token: {openai: 'first-private'}, apiKeys: {openai: ['first-private', 'new-private']}};
        const changes = buildCredentialPreviewChanges(before, after);
        expect(changes).toEqual([expect.objectContaining({key: 'apiKeys.openai', after: '将替换（内容已隐藏）'})]);
        expect(JSON.stringify(changes)).not.toContain('private');
        expect(buildCredentialPreviewChanges({}, after)).toEqual([expect.objectContaining({key: 'apiKeys.openai', after: '将新增（内容已隐藏）'})]);
        expect(buildCredentialPreviewChanges(before, {apiKeys: {openai: []}})).toEqual([expect.objectContaining({key: 'apiKeys.openai', after: '将清除'})]);
        expect(buildCredentialPreviewChanges(after, {...after, apiKeys: {openai: ['first-private', 'new-private', ' ']}})).toEqual([]);
    });

    it('使用导入配置中的动态服务名称标注 API Key', () => {
        const changes = buildCredentialPreviewChanges({token: {}}, {
            token: {'custom:team': 'private-team-key'},
            customOpenAIProviders: [{
                id: 'custom:team',
                name: '团队模型网关',
                endpoint: 'https://gateway.example/v1',
                models: ['team-model'],
            }],
        });

        expect(changes).toEqual([
            expect.objectContaining({
                key: 'token.custom:team',
                label: '团队模型网关 API Key',
                after: '将新增（内容已隐藏）',
            }),
        ]);
        expect(JSON.stringify(changes)).not.toContain('private-team-key');
    });

    it('覆盖扩展凭据的数组、对象和原始值，并为未知服务使用稳定回退标签', () => {
        const changes = buildCredentialPreviewChanges({
            token: {},
            extra: {
                arrayAdded: [],
                arrayCleared: ['secret'],
                objectAdded: {},
                objectCleared: {secret: true},
                truthyFlag: null,
                undefinedFlag: false,
                falseFlag: undefined,
                whitespace: ' ',
            },
        }, {
            token: {customProvider: 'custom-secret'},
            extra: {
                arrayAdded: ['secret'],
                arrayCleared: [],
                objectAdded: {secret: true},
                objectCleared: {},
                truthyFlag: true,
                undefinedFlag: undefined,
                falseFlag: false,
                whitespace: '',
            },
        });

        expect(changes).toEqual(expect.arrayContaining([
            expect.objectContaining({key: 'token.customProvider', label: 'customProvider API Key'}),
            expect.objectContaining({key: 'extra.arrayAdded', after: '将新增（内容已隐藏）'}),
            expect.objectContaining({key: 'extra.arrayCleared', after: '将清除'}),
            expect.objectContaining({key: 'extra.objectAdded', after: '将新增（内容已隐藏）'}),
            expect.objectContaining({key: 'extra.objectCleared', after: '将清除'}),
            expect.objectContaining({key: 'extra.truthyFlag', after: '将新增（内容已隐藏）'}),
        ]));
        expect(changes.map(({key}) => key)).not.toEqual(expect.arrayContaining([
            'extra.undefinedFlag',
            'extra.falseFlag',
            'extra.whitespace',
        ]));
        expect(JSON.stringify(changes)).not.toContain('custom-secret');
        expect(JSON.stringify(changes)).not.toContain('secret');
    });
});


it('请求头变化只显示状态和所属服务，绝不显示认证内容', () => {
    const before = {customHeaders: {'custom:a': '{"x-auth":"old-private"}', 'custom:same': '{}', 'custom:clear': '{"x":"clear-private"}'}};
    const after = {customOpenAIProviders: [{id: 'custom:a', name: 'Gateway', endpoint: 'https://test.example', models: []}],
        customHeaders: {'custom:a': '{"x-auth":"new-private"}', 'custom:same': '{}', 'custom:new': '{"x":"new-private"}'}};
    const changes = buildCredentialPreviewChanges(before, after);
    expect(changes.map(item => item.key)).toEqual(['customHeaders.custom:a', 'customHeaders.custom:clear', 'customHeaders.custom:new']);
    expect(changes[0].label).toContain('Gateway');
    expect(JSON.stringify(changes)).not.toContain('private');
});
