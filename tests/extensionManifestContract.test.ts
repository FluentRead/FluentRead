import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {describe, expect, it} from 'vitest';
import {createHash} from 'node:crypto';
import {GOOGLE_DRIVE_DEFAULT_CLIENT_ID, GOOGLE_DRIVE_EXTENSION_ID, GOOGLE_DRIVE_EXTENSION_PUBLIC_KEY, GOOGLE_DRIVE_SCOPES} from '@/src/platform/google-drive/constants';
import type {Entrypoint, EntrypointGroup} from 'wxt';
import {remoteConfigStorageBuildPlugin, createExtensionManifest, extendRemoteConfigBuildConfig, groupModuleWorkers} from '@/wxt.config';

const PROJECT_ROOT = resolve(__dirname, '..');

function buildEntrypoint(name: string, type: Entrypoint['type'] = 'unlisted-script'): Entrypoint {
    return {name, type, inputPath: `/entrypoints/${name}.ts`, outputDir: '/output', options: {}} as Entrypoint;
}

describe('module worker build groups', () => {
    it('三个已知模块 Worker 共享构建，保留其顺序及其他构建组的对象', () => {
        const workers = ['localTranslationWorker', 'localTtsWorker', 'videoTranscriptionWorker'].map(name => buildEntrypoint(name));
        const background = buildEntrypoint('background', 'background');
        const content = buildEntrypoint('content', 'content-script');
        const classic = buildEntrypoint('otherWorker');
        const pages = [buildEntrypoint('options', 'options'), buildEntrypoint('popup', 'popup')];
        const groups: EntrypointGroup[] = [background, workers[0], content, workers[1], classic, workers[2], pages];

        groupModuleWorkers(groups);

        expect(groups).toEqual([background, workers, content, classic, pages]);
        expect(groups[1]).not.toBe(workers);
        for (const entry of [background, content, classic, pages]) expect(groups).toContain(entry);
        for (const worker of workers) expect(groups[1]).toContain(worker);
        const grouped = [...groups];
        groupModuleWorkers(groups);
        expect(groups).toEqual(grouped);
        expect(groups[1]).toBe(grouped[1]);
    });

    it('部分构建仍可以组合两个模块 Worker', () => {
        const workers = ['videoTranscriptionWorker', 'localTranslationWorker'].map(name => buildEntrypoint(name));
        const groups: EntrypointGroup[] = [...workers];
        groupModuleWorkers(groups);
        expect(groups).toEqual([workers]);
    });

    it('不足两个可组合入口时保留原有构建方式', () => {
        for (const groups of [[], [buildEntrypoint('localTtsWorker')], [buildEntrypoint('unknown')]]) {
            const before = [...groups];
            groupModuleWorkers(groups);
            expect(groups).toEqual(before);
        }
    });

    it('同名的内容脚本、后台或已分组入口不会被改成模块 Worker', () => {
        const groups: EntrypointGroup[] = [
            buildEntrypoint('localTranslationWorker', 'content-script'),
            buildEntrypoint('localTtsWorker', 'background'),
            [buildEntrypoint('videoTranscriptionWorker')],
        ];
        const before = [...groups];
        groupModuleWorkers(groups);
        expect(groups).toEqual(before);
    });
});

function sourceBody(path: string): string {
    const source = readFileSync(resolve(PROJECT_ROOT, path), 'utf8');
    const header = source.match(/^\/\*\*[\s\S]*?\*\/\s*/u)?.[0];
    return header?.includes(`@file ${path}`) ? source.slice(header.length) : source;
}

function permissionsFor(browser: string, manifestVersion: 2 | 3): string[] {
    const manifest = createExtensionManifest({browser, manifestVersion} as Parameters<typeof createExtensionManifest>[0]);
    return manifest.permissions as string[];
}

describe('extension manifest capability contract', () => {
    it('Chrome 原生 OAuth 绑定公开商店身份；其他构建不声明 Chrome 客户端', () => {
        const chrome = createExtensionManifest({browser: 'chrome', manifestVersion: 3});
        expect(chrome.oauth2).toEqual({client_id: GOOGLE_DRIVE_DEFAULT_CLIENT_ID, scopes: GOOGLE_DRIVE_SCOPES});
        expect(chrome.key).toBe(GOOGLE_DRIVE_EXTENSION_PUBLIC_KEY);
        const digest = createHash('sha256').update(Buffer.from(GOOGLE_DRIVE_EXTENSION_PUBLIC_KEY, 'base64')).digest('hex').slice(0, 32);
        expect([...digest].map(value => String.fromCharCode(97 + parseInt(value, 16))).join('')).toBe(GOOGLE_DRIVE_EXTENSION_ID);
        expect(permissionsFor('chrome', 3).filter(permission => permission === 'identity')).toHaveLength(1);
        for (const browser of ['edge', 'firefox', 'safari']) {
            const manifest = createExtensionManifest({browser, manifestVersion: browser === 'firefox' ? 2 : 3});
            expect(manifest.oauth2).toBeUndefined(); expect(manifest.key).toBeUndefined();
            if (['edge', 'firefox'].includes(browser)) expect(manifest.permissions).toContain('identity');
            else expect(manifest.permissions).not.toContain('identity');
        }
    });
    it('builds a separate Thunderbird package with mail display access and no browser page injection', async () => {
        const packageUrl = pathToFileURL(resolve(PROJECT_ROOT, 'scripts/thunderbird/package.mjs')).href;
        const {createThunderbirdManifest} = await import(/* @vite-ignore */ packageUrl) as {
            createThunderbirdManifest(source: any): any;
        };
        const firefox = {
            manifest_version: 2,
            name: 'FluentRead',
            version: '0.0.35',
            background: {scripts: ['background.js']},
            permissions: ['storage', '<all_urls>'],
            browser_specific_settings: {gecko: {
                id: '{3096bd53-3bda-4556-b076-ebf47442a5c1}',
                strict_min_version: '140.0',
                data_collection_permissions: {required: ['websiteContent']},
            }},
            content_scripts: [{matches: ['<all_urls>'], js: ['content-scripts/content.js']}],
        };
        const mail = createThunderbirdManifest(firefox);
        expect(mail.manifest_version).toBe(2);
        expect(mail.background).toEqual(firefox.background);
        expect(mail.content_scripts).toBeUndefined();
        expect(mail.permissions).toContain('messagesModify');
        expect(mail.permissions).not.toContain('contextMenus');
        expect(mail.permissions.filter((permission: string) => permission === 'messagesModify')).toHaveLength(1);
        expect(mail.browser_specific_settings.gecko.id).not.toBe(firefox.browser_specific_settings.gecko.id);
        expect(mail.browser_specific_settings.gecko.strict_min_version).toBe('140.0');
        expect(mail.browser_specific_settings.gecko.data_collection_permissions).toBeUndefined();
        expect(mail.message_display_action.default_icon['16']).toBe('icon/16.png');
        expect(firefox.content_scripts).toHaveLength(1);
        expect(() => createThunderbirdManifest({...firefox, manifest_version: 3})).toThrow('MV2');
        expect(() => createThunderbirdManifest({...firefox, browser_specific_settings: {}})).toThrow('Gecko');
    });

    it('旧 QQ 与受限正文共用子 frame 入口，通用网页仍保持顶层注入', () => {
        const entry = sourceBody('entrypoints/supportedFrame.content.ts');
        expect(entry).toContain("'https://mail.qq.com/cgi-bin/readmail*'");
        expect(entry).toContain("'https://disqus.com/embed/comments/*'");
        expect(entry).toContain("'https://www.kaggleusercontent.com/kf/*/__results__.html*'");
        expect(entry).toContain("window.location.hostname === 'mail.qq.com'");
        expect(entry).toContain('startQqMailFrameApp(ctx) : startEmbeddedFrameApp(ctx)');
        expect(entry).toContain('allFrames: true');
        expect(entry).not.toContain('matchAboutBlank');
        expect(entry).not.toContain('matchOriginAsFallback');
        expect(sourceBody('entrypoints/content.ts')).not.toContain('allFrames');
    });

    it('网易邮箱独立入口覆盖受限主机及 about:blank 正文 frame', () => {
        const entry = sourceBody('entrypoints/neteaseMailFrame.content.ts');
        for (const host of ['mail.163.com', 'mail.126.com', 'mail.yeah.net']) {
            expect(entry).toContain(`https://*.${host}/*`);
        }
        expect(entry).toContain('allFrames: true');
        expect(entry).toContain('matchAboutBlank: true');
        expect(entry).not.toContain('matchOriginAsFallback');
        expect(sourceBody('entrypoints/content.ts')).not.toContain('allFrames');
    });

    it('通用网页内容脚本在基础 DOM 出现前注入，让 loading 页面也能建立翻译入口', () => {
        expect(sourceBody('entrypoints/content.ts')).toContain("runAt: 'document_start'");
    });

    it('declares the literal all-URLs host permission required by captureVisibleTab', () => {
        for (const [browser, manifestVersion] of [
            ['chrome', 3],
            ['edge', 3],
            ['firefox', 2],
        ] as const) {
            const manifest = createExtensionManifest({browser, manifestVersion} as Parameters<typeof createExtensionManifest>[0]);
            expect(manifest.host_permissions, `${browser}-mv${manifestVersion}`).toContain('<all_urls>');
        }
    });

    it('declares Offscreen exactly once only for supported Chrome and Edge MV3 builds', () => {
        for (const [browser, manifestVersion, expected] of [
            ['chrome', 3, 1],
            ['edge', 3, 1],
            ['chrome', 2, 0],
            ['firefox', 2, 0],
            ['firefox', 3, 0],
            ['opera', 3, 0],
        ] as const) {
            const permissions = permissionsFor(browser, manifestVersion);
            expect(permissions.filter((permission) => permission === 'offscreen'), `${browser}-mv${manifestVersion}`)
                .toHaveLength(expected);
            expect(permissions).toEqual(expect.arrayContaining([
                'storage',
                'unlimitedStorage',
                'alarms',
                'contextMenus',
            ]));
        }
    });

    it('keeps the Offscreen page entrypoint target-limited and delegates to the app composition root', () => {
        const html = readFileSync(resolve(PROJECT_ROOT, 'entrypoints/offscreen/index.html'), 'utf8');
        const main = sourceBody('entrypoints/offscreen/main.ts');
        expect(html).toContain('<meta name="wxt.include" content="[\'chrome\', \'edge\', \'firefox\']">');
        expect(html).toContain('<script type="module" src="./main.ts"></script>');
        expect(html).not.toContain('opera');
        expect(main).toBe(
            "import {startOffscreenApp} from '@/src/app/offscreen/runtime';\n\nstartOffscreenApp();\n",
        );
    });

    it('uses the capability-derived manifest factory instead of a static Offscreen permission', () => {
        const source = readFileSync(resolve(PROJECT_ROOT, 'wxt.config.ts'), 'utf8');
        expect(source).toContain('manifest: createExtensionManifest');
        expect(source).toContain("...(capabilities.offscreenDocument ? ['offscreen'] : [])");
        expect(source).not.toContain("permissions: ['storage', 'alarms', 'contextMenus', 'offscreen']");
    });

    it('只给 Firefox 声明稳定 AMO 身份、最低版本和准确的数据传输分类', () => {
        const firefox = createExtensionManifest({browser: 'firefox', manifestVersion: 2} as never) as any;
        const chrome = createExtensionManifest({browser: 'chrome', manifestVersion: 3} as never) as any;

        expect(firefox.browser_specific_settings?.gecko).toEqual({
            id: '{3096bd53-3bda-4556-b076-ebf47442a5c1}',
            strict_min_version: '140.0',
            data_collection_permissions: {
                required: ['websiteContent', 'authenticationInfo', 'personalCommunications'],
            },
        });
        expect(chrome.browser_specific_settings).toBeUndefined();
    });

    it('固定发布包英文名称，并为 Firefox 保留共享 OCR 资产', () => {
        const source = readFileSync(resolve(PROJECT_ROOT, 'wxt.config.ts'), 'utf8');

        expect(source).toContain("name: 'fluent-read'");
        expect(source).toContain("excludeSources: ['coverage/**']");
        expect(source).toContain("'build:publicAssets'");
        expect(source).not.toContain("files.splice(index, 1)");
    });

    it('拒绝当前版本的非期望 Firefox 归档名，但允许其他版本归档留存', async () => {
        const verifierUrl = pathToFileURL(
            resolve(PROJECT_ROOT, 'scripts/testing/verify-extension-manifests.mjs'),
        ).href;
        const verifier = await import(/* @vite-ignore */ verifierUrl) as {
            findUnexpectedCurrentVersionArchives(
                files: string[],
                version: string,
                expected: string[],
            ): string[];
        };
        const expected = [
            'fluent-read-0.0.35-firefox.zip',
            'fluent-read-0.0.35-sources.zip',
        ];

        expect(verifier.findUnexpectedCurrentVersionArchives([
            ...expected,
            '-0.0.30-firefox.zip',
            'legacy-10.0.35-sources.zip',
        ], '0.0.35', expected)).toEqual([]);
        expect(verifier.findUnexpectedCurrentVersionArchives([
            ...expected,
            '-0.0.35-firefox.zip',
            'legacy-v0.0.35-sources.zip',
            'fluent-read-0.0.30-firefox.zip',
        ], '0.0.35', expected)).toEqual([
            '-0.0.35-firefox.zip',
            'legacy-v0.0.35-sources.zip',
        ]);
    });

    it('从任意 YouTube 起始页预注入 timedtext bridge，但不扩大到非 YouTube 站点', () => {
        const source = sourceBody('entrypoints/youtubeBridge.content.ts');
        const matches = [...source.matchAll(/['"](\*:\/\/[^'"]+)['"]/gu)].map((match) => match[1]);

        expect(matches).toEqual([
            '*://*.youtube.com/*',
            '*://youtube.com/*',
        ]);
        expect(source).toContain("runAt: 'document_start'");
        expect(source).toContain("world: 'MAIN'");
        expect(matches).not.toContain('*://*/*');
        expect(matches.some((match) => match.includes('youtube-nocookie'))).toBe(false);
        expect(matches.every((match) => match.includes('youtube'))).toBe(true);
    });

    it('网页及扩展 UI 构建组使用远程配置存储，后台和未知入口保留完整运行时', () => {
        const plugin = remoteConfigStorageBuildPlugin();
        expect(plugin.enforce).toBe('pre');
        expect(plugin.resolveId(resolve(PROJECT_ROOT, 'src/platform/storage/configStorageRuntime')))
            .toBe(resolve(PROJECT_ROOT, 'src/platform/storage/remoteConfigStorageRuntime.ts'));
        expect(plugin.resolveId(resolve(PROJECT_ROOT, 'src/platform/storage/configStorageRuntime.ts')))
            .toBe(resolve(PROJECT_ROOT, 'src/platform/storage/remoteConfigStorageRuntime.ts'));
        expect(plugin.resolveId(resolve(PROJECT_ROOT, 'src/platform/storage/configStorage.ts'))).toBeNull();

        const contentGroup: {plugins?: unknown[]} = {plugins: ['existing']};
        extendRemoteConfigBuildConfig([{type: 'content-script'}, {type: 'content-script'}], contentGroup);
        expect(contentGroup.plugins).toEqual(['existing', expect.objectContaining({name: 'fluentread-remote-config-storage'})]);
        const emptyPlugins: {plugins?: unknown[]} = {};
        extendRemoteConfigBuildConfig([{type: 'content-script'}], emptyPlugins);
        expect(emptyPlugins.plugins).toHaveLength(1);

        for (const group of [[{type: 'popup'}], [{type: 'options'}], [{type: 'popup'}, {type: 'options'}, {type: 'unlisted-page'}]]) {
            const config: {plugins?: unknown[]} = {plugins: []};
            extendRemoteConfigBuildConfig(group, config);
            expect(config.plugins).toHaveLength(1);
        }
        for (const group of [[], [{type: 'background'}], [{type: 'options'}, {type: 'background'}], [{type: 'content-script'}, {type: 'unlisted-script'}], [{type: 'unknown'}]]) {
            const config: {plugins?: unknown[]} = {plugins: []};
            extendRemoteConfigBuildConfig(group, config);
            expect(config.plugins).toEqual([]);
        }
    });
});
