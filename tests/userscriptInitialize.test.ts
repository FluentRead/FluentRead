import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {Config} from '@/src/core/config/model';
import {getApiKeyRequirementKey} from '@/src/core/config/validation';
import {customModelString, defaultModels, services} from '@/src/core/config/catalog';
import {normalizeUserscriptConfig} from '@/userscript/initialize';

async function ensureUserscriptConfigForTest(): Promise<void> {
    const {ensureUserscriptConfig} = await import('@/userscript/initialize');
    await ensureUserscriptConfig();
}

function installLegacyStorage(entries: Array<[string, unknown]>) {
    const values = new Map<string, unknown>(entries);
    let writes = 0;
    globalThis.GM_getValue = ((key, fallback) => values.has(key) ? values.get(key) : fallback) as NonNullable<typeof globalThis.GM_getValue>;
    globalThis.GM_setValue = (key, value) => {
        writes += 1;
        values.set(key, value);
    };
    globalThis.GM_listValues = () => [...values.keys()];
    return {values, get writes() { return writes; }};
}

function readStoredConfig(values: Map<string, unknown>): Config {
    return JSON.parse(String(values.get('local:config'))) as Config;
}

describe('legacy userscript migration', () => {
    beforeEach(() => vi.resetModules());

    afterEach(() => {
        globalThis.GM_getValue = undefined;
        globalThis.GM_setValue = undefined;
        globalThis.GM_listValues = undefined;
    });

    it('migrates legacy identity-scoped GM settings into Config', async () => {
        const {values} = installLegacyStorage([
            ['model', 'openai'],
            ['from', 'auto'],
            ['to', 'en'],
            ['hotkey', 'Alt'],
            ['model_openai', 'gpt-5.4-mini'],
            ['token_openai', 'legacy-test-token'],
            ['openai_url', 'https://gateway.example.test/v1/chat/completions'],
        ]);

        await ensureUserscriptConfigForTest();

        const stored = readStoredConfig(values);
        expect(stored.service).toBe('openai');
        expect(stored.to).toBe('en');
        expect(stored.hotkey).toBe('Alt');
        expect(stored.model.openai).toBe('gpt-5.4-mini');
        expect(stored.token.openai).toBe('legacy-test-token');
        expect(stored.proxy.openai).toBe('https://gateway.example.test/v1/chat/completions');
        expect(stored.disableFloatingBall).toBe(false);
        expect(stored.disableImageTranslator).toBe(true);
    });

    it('migrates the v1.31 defaults, arbitrary Ollama model, prompts, and object credentials', async () => {
        const yiyanCredentials = {
            ak: 'legacy-yiyan-ak',
            sk: 'legacy-yiyan-sk',
            token: 'legacy-yiyan-access-token',
            expiration: Date.now() + 60_000,
        };
        const {values} = installLegacyStorage([
            ['model', 'ollama'],
            ['model_openai', 'gpt-3.5-turbo'],
            ['model_gemini', 'gemini-pro'],
            ['model_yiyan', 'completions'],
            ['model_tongyi', 'qwen-turbo'],
            ['model_zhipu', 'glm-3-turbo'],
            ['model_moonshot', 'moonshot-v1-8'],
            ['model_ollama', 'private-ollama-model:latest'],
            ['token_yiyan', yiyanCredentials],
            ['token_zhipu', {apikey: 'legacy-zhipu-key', token: 'discard-generated-jwt'}],
            ['ollama_url', 'http://127.0.0.1:11434/v1/chat/completions'],
            ['systemMsg', 'Legacy system prompt'],
            ['userMsg', 'Legacy user prompt with {{origin}} and {{to}}'],
        ]);

        await ensureUserscriptConfigForTest();

        const stored = readStoredConfig(values);
        expect(stored.service).toBe(services.custom);
        expect(stored.model[services.openai]).toBe(defaultModels.get(services.openai));
        expect(stored.model[services.gemini]).toBe(defaultModels.get(services.gemini));
        expect(stored.model[services.yiyan]).toBe(defaultModels.get(services.yiyan));
        expect(stored.model[services.tongyi]).toBe(defaultModels.get(services.tongyi));
        expect(stored.model[services.zhipu]).toBe(defaultModels.get(services.zhipu));
        expect(stored.model[services.moonshot]).toBe(defaultModels.get(services.moonshot));
        expect(stored.model[services.custom]).toBe('private-ollama-model:latest');
        expect(stored.customModel[services.custom]).toBeUndefined();
        expect(stored.customOpenAIProviders).toEqual([{
            id: services.custom,
            name: '自定义接口',
            endpoint: 'http://127.0.0.1:11434/v1/chat/completions',
            models: ['private-ollama-model:latest'],
        }]);
        expect(stored.custom).toBe('http://127.0.0.1:11434/v1/chat/completions');
        expect(stored.requireApiKey[getApiKeyRequirementKey(services.custom, stored)]).toBe(false);
        expect(stored.token[services.yiyan]).toBe('legacy-yiyan-access-token');
        expect(stored.ak).toBe('legacy-yiyan-ak');
        expect(stored.sk).toBe('legacy-yiyan-sk');
        expect(stored.token[services.zhipu]).toBe('legacy-zhipu-key');
        expect(stored.system_role[services.openai]).toBe('Legacy system prompt');
        expect(stored.system_role[services.custom]).toBe('Legacy system prompt');
        expect(stored.user_role[services.gemini]).toBe('Legacy user prompt with {{origin}} and {{to}}');
        expect(values.get('token_yiyan')).toEqual(yiyanCredentials);
    });

    it.each([services.chromeTranslator, 'removed-service'])('sanitizes an existing userscript config using unsupported service %s', async (service) => {
        const existing = new Config();
        existing.service = service;
        existing.videoService = service;
        existing.inputBoxTranslationService = service;
        existing.contextMenuEnabled = true;
        existing.selectionAreaEnabled = true;
        existing.disableImageTranslator = false;
        existing.videoTranslationEnabled = true;
        existing.videoSubtitleModeHotkeyEnabled = true;
        existing.videoSubtitleModeHotkey = 'Alt+M';
        existing.quickTranslationProfiles = [{
            id: 'quick-alt-m',
            action: 'full-page',
            enabled: true,
            hotkey: 'Alt+M',
            service: '',
            model: '',
            targetLanguage: '',
            displayMode: 'inherit',
            fullPageMode: 'inherit',
            glossaryIds: [],
        }];
        existing.maxConcurrentTranslations = 99;
        existing.token[services.openai] = 'preserved-token';
        existing.extra = {preserved: true};
        const {values} = installLegacyStorage([
            ['local:config', JSON.stringify(existing)],
        ]);

        await ensureUserscriptConfigForTest();

        const stored = readStoredConfig(values);
        expect(stored.service).toBe(services.microsoft);
        expect(stored.videoService).toBe(services.microsoft);
        expect(stored.inputBoxTranslationService).toBe(services.microsoft);
        expect(stored.contextMenuEnabled).toBe(false);
        expect(stored.selectionAreaEnabled).toBe(false);
        expect(stored.disableImageTranslator).toBe(true);
        expect(stored.videoTranslationEnabled).toBe(false);
        expect(stored.videoSubtitleModeHotkeyEnabled).toBe(false);
        expect(stored.quickTranslationProfiles[0]?.enabled).toBe(true);
        expect(stored.maxConcurrentTranslations).toBe(20);
        expect(stored.token[services.openai]).toBe('preserved-token');
        expect(stored.extra).toEqual({preserved: true});
    });

    it('preserves a configured dynamic OpenAI-compatible service and its saved model', () => {
        const existing = new Config();
        existing.customOpenAIProviders = [{
            id: 'custom:1',
            name: '本地网关',
            endpoint: 'http://127.0.0.1:11434/v1/chat/completions',
            models: ['qwen-local', 'gemma:7b'],
        }];
        existing.service = 'custom:1';
        existing.model['custom:1'] = 'gemma:7b';
        existing.token['custom:1'] = 'dynamic-provider-token';

        const normalized = normalizeUserscriptConfig(existing);

        expect(normalized.service).toBe('custom:1');
        expect(normalized.model['custom:1']).toBe('gemma:7b');
        expect(normalized.token['custom:1']).toBe('dynamic-provider-token');
        expect(normalized.customOpenAIProviders).toEqual(existing.customOpenAIProviders);
    });

    it('往返保留内置服务的多个自定义模型与当前选择', () => {
        const existing = new Config();
        existing.service = services.grok;
        existing.model[services.grok] = customModelString;
        existing.customModel[services.grok] = 'grok-private-b';
        existing.customModels[services.grok] = ['grok-private-a', 'grok-private-b'];

        const normalized = normalizeUserscriptConfig(existing);
        expect(normalized.customModels[services.grok]).toEqual(['grok-private-a', 'grok-private-b']);
        expect(normalized.model[services.grok]).toBe(customModelString);
        expect(normalized.customModel[services.grok]).toBe('grok-private-b');
        expect(normalizeUserscriptConfig(normalized)).toEqual(normalized);
    });

    it('只为已有安全配置建立一次计数基数，不因内部 revision 重写配置', async () => {
        const safe = normalizeUserscriptConfig(new Config()) as Config & {__fluentConfigRevision?: number};
        safe.__fluentConfigRevision = 7;
        const storage = installLegacyStorage([
            ['local:config', JSON.stringify(safe)],
        ]);

        await ensureUserscriptConfigForTest();

        expect(storage.writes).toBe(1);
        expect([...storage.values.keys()].some((key) => key.startsWith('fluentread:count:v1:base:'))).toBe(true);
        expect((readStoredConfig(storage.values) as Config & {__fluentConfigRevision?: number}).__fluentConfigRevision).toBe(7);
    });

    it('在配置 store 水合前把陈旧计数投影恢复为专用副本总数', async () => {
        const existing = normalizeUserscriptConfig(new Config());
        existing.count = 15;
        const {values} = installLegacyStorage([
            ['local:config', JSON.stringify(existing)],
            ['fluentread:count:v1:base:existing', JSON.stringify({version: 1, value: 14})],
            ['fluentread:count:v1:replica:first', JSON.stringify({
                version: 1,
                value: 1,
                recentOperations: [{id: 'count-first-tab', delta: 1}],
            })],
            ['fluentread:count:v1:replica:second', JSON.stringify({
                version: 1,
                value: 1,
                recentOperations: [{id: 'count-second-tab', delta: 1}],
            })],
        ]);

        await ensureUserscriptConfigForTest();

        expect(readStoredConfig(values).count).toBe(16);
    });

    it('非对象配置输入在 userscript 归一化后同样关闭视频字幕模式快捷键', () => {
        const normalized = normalizeUserscriptConfig(null);
        expect(normalized.videoTranslationEnabled).toBe(false);
        expect(normalized.videoSubtitleModeHotkeyEnabled).toBe(false);
    });
});
