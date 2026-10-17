import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import JSZip from 'jszip';
import {createRequire} from 'node:module';
import {dirname, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {describe, expect, it, vi} from 'vitest';
import ts from 'typescript';
import {defineUnlistedScript} from 'wxt/utils/define-unlisted-script';
import {createHash, generateKeyPairSync} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {FREE_PROVIDER_ORIGINS} from '@/src/core/config/freeProviderOrigins';
import {GOOGLE_DRIVE_DEFAULT_CLIENT_ID, GOOGLE_DRIVE_EXTENSION_ID, GOOGLE_DRIVE_EXTENSION_PUBLIC_KEY, GOOGLE_DRIVE_SCOPES} from '@/src/platform/google-drive/constants';
import {createDriveAuth, type DriveAuthPorts} from '@/src/platform/google-drive/auth';
import type {Entrypoint, EntrypointGroup} from 'wxt';
import {remoteConfigStorageBuildPlugin, createExtensionManifest, extendRemoteConfigBuildConfig, groupModuleWorkers, finalizeExtensionZip, createSafariBackgroundPage, configureSafariBackgroundPage} from '@/wxt.config';

const PROJECT_ROOT = resolve(__dirname, '..');

describe('Safari unsigned delivery contract', () => {
    async function safariTools() {
        return import(/* @vite-ignore */ pathToFileURL(resolve(PROJECT_ROOT, 'scripts/safari/package.mjs')).href);
    }

    function safariFixture() {
        const source = createExtensionManifest({browser: 'safari', manifestVersion: 2});
        return {...source, manifest_version: 2, version: '0.0.38',
            permissions: [...source.permissions!, ...source.host_permissions!],
            background: {page: 'safari-background.html', persistent: false},
            browser_action: {default_popup: 'popup.html'},
            content_scripts: [{matches: ['<all_urls>'], js: ['content.js']}],
        };
    }

    const backgroundPage = () => createSafariBackgroundPage({browser: 'safari', manifestVersion: 2})[0];

    type SafariTargetIdentity = {
        id: string;
        productType: string;
        configurationListId: string;
        configurations: {name: string; bundleId: string; sdk: string}[];
    };

    // Apple 工程的实际多行对象结构：target 顺序/名称不用于猜测配置身份。
    function bundleProject(platform: 'both' | 'ios' | 'macos') {
        let sequence = 0;
        const id = () => (++sequence).toString(16).toUpperCase().padStart(24, '0');
        const object = (key: string, type: string, body: string) => `\t\t${key} /* ${type} */ = {\n\t\t\tisa = ${type};\n${body}\t\t};`;
        const section = (type: string, entries: string[]) => `/* Begin ${type} section */\n${entries.join('\n')}\n/* End ${type} section */`;
        const configs: string[] = [], lists: string[] = [], targets: string[] = [], targetIds: string[] = [];
        const configurations = (sdk: string, bundleId: string) => {
            const listId = id();
            const ids = ['Debug', 'Release'].map(name => {
                const configId = id();
                configs.push(object(configId, 'XCBuildConfiguration', `\t\t\tbuildSettings = {\n\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = ${bundleId};\n\t\t\t\tSDKROOT = ${sdk};\n\t\t\t};\n\t\t\tname = ${name};\n`));
                return `\t\t\t\t${configId} /* ${name} */,`;
            });
            lists.push(object(listId, 'XCConfigurationList', `\t\t\tbuildConfigurations = (\n${ids.join('\n')}\n\t\t\t);\n`));
            return listId;
        };
        const projectId = id(), projectList = configurations(platform === 'macos' ? 'macosx' : 'iphoneos', 'org.example.FluentRead');
        for (const sdk of platform === 'both' ? ['macosx', 'iphoneos'] : [platform === 'ios' ? 'iphoneos' : 'macosx']) {
            for (const kind of ['app-extension', 'application']) {
                const targetId = id(), listId = configurations(sdk, `org.example.FluentRead${kind === 'app-extension' ? 'Development.Extension' : ''}`);
                targetIds.push(targetId);
                targets.push(object(targetId, 'PBXNativeTarget', `\t\t\tbuildConfigurationList = ${listId} /* configurations */;\n\t\t\tname = "${kind === 'application' ? 'Misleading Extension' : 'Misleading App'} ${sdk}";\n\t\t\tproductType = "com.apple.product-type.${kind}";\n`));
            }
        }
        const project = object(projectId, 'PBXProject', `\t\t\tbuildConfigurationList = ${projectList} /* configurations */;\n\t\t\ttargets = (\n${targetIds.map(key => `\t\t\t\t${key} /* target */,`).join('\n')}\n\t\t\t);\n`);
        return [section('PBXNativeTarget', targets), section('PBXProject', [project]), section('XCBuildConfiguration', configs), section('XCConfigurationList', lists)].join('\n\n');
    }

    it.each(['both', 'ios', 'macos'] as const)('按真实 target 配置关联修正 %s 的 App/Extension 身份，不全局替换并可重复校验', async platform => {
        const {applySafariBundleIdentifiers, verifySafariBundleIdentifiers} = await safariTools();
        const original = bundleProject(platform), requested = 'org.example.FluentReadDevelopment';
        expect(() => verifySafariBundleIdentifiers(original, requested, platform)).toThrow('实际 bundle identifier');
        const updated = applySafariBundleIdentifiers(original, requested, platform);
        const actual: SafariTargetIdentity[] = verifySafariBundleIdentifiers(updated, requested, platform);
        expect(actual).toHaveLength(platform === 'both' ? 4 : 2);
        expect(actual.flatMap(target => target.configurations)).toHaveLength(platform === 'both' ? 8 : 4);
        for (const target of actual) {
            expect(target.id).toMatch(/^[A-F0-9]{24}$/u);
            expect(target.configurationListId).toMatch(/^[A-F0-9]{24}$/u);
            const expected = `${requested}${target.productType.endsWith('app-extension') ? '.Extension' : ''}`;
            expect(target.configurations.map(config => config.name)).toEqual(['Debug', 'Release']);
            expect(target.configurations.every(config => config.bundleId === expected)).toBe(true);
            expect(target.configurations.every(config => !('start' in config) && !('length' in config))).toBe(true);
        }
        // 项目层两处同名默认值仍在；已正确的 Extension 配置不改，只有 App 的值改变。
        expect(updated.match(/PRODUCT_BUNDLE_IDENTIFIER = org\.example\.FluentRead;/gu)).toHaveLength(2);
        expect(updated.replaceAll(`${requested};`, 'org.example.FluentRead;')).toBe(original);
        expect(applySafariBundleIdentifiers(updated, requested, platform)).toBe(updated);
        expect(() => verifySafariBundleIdentifiers(updated.replace(`${requested};`, 'org.example.Other;'), requested, platform)).toThrow('实际 bundle identifier');
    });

    it('单平台继承项目 SDK，支持字面值引号；错平台和无效请求身份在写入前失败', async () => {
        const {applySafariBundleIdentifiers, verifySafariBundleIdentifiers} = await safariTools();
        const original = bundleProject('ios');
        const configs = [...original.matchAll(/^\t{4}SDKROOT = iphoneos;\n/gmu)];
        let inherited = original;
        for (const match of configs.slice(2).reverse()) inherited = inherited.slice(0, match.index) + inherited.slice(match.index! + match[0].length);
        inherited = inherited.replaceAll('PRODUCT_BUNDLE_IDENTIFIER = org.example.FluentRead;', 'PRODUCT_BUNDLE_IDENTIFIER = "org.example.FluentRead";');
        const updated = applySafariBundleIdentifiers(inherited, 'org.test.Reader', 'ios');
        const actual: SafariTargetIdentity[] = verifySafariBundleIdentifiers(updated, 'org.test.Reader', 'ios');
        expect(actual.every(target => target.configurations.every(config => config.sdk === 'iphoneos'))).toBe(true);
        for (const platform of ['both', 'macos', 'unknown']) expect(() => applySafariBundleIdentifiers(original, 'org.test.Reader', platform)).toThrow();
        for (const bundleId of ['', 'org.bad;VALUE', '$(PRODUCT_NAME)', undefined]) expect(() => applySafariBundleIdentifiers(original, bundleId, 'ios')).toThrow('bundle-id');
    });

    it('拒绝未知、缺失、重复、共享及混淆的 native target/config 结构，不在部分图上写身份', async () => {
        const {applySafariBundleIdentifiers} = await safariTools();
        const source = bundleProject('ios');
        const targetIds = [...source.matchAll(/^\t\t([A-F0-9]{24}) \/\* PBXNativeTarget \*\/ =/gmu)].map(match => match[1]);
        const targetLists = [...source.matchAll(/^\t{3}buildConfigurationList = ([A-F0-9]{24}) \/\* configurations \*\/;/gmu)].slice(0, 2).map(match => match[1]);
        const configIds = [...source.matchAll(/^\t\t([A-F0-9]{24}) \/\* XCBuildConfiguration \*\/ =/gmu)].map(match => match[1]);
        const appBundleLine = 'PRODUCT_BUNDLE_IDENTIFIER = org.example.FluentRead;';
        const appOffset = source.lastIndexOf(appBundleLine);
        const editApp = (replacement: string) => source.slice(0, appOffset) + replacement + source.slice(appOffset + appBundleLine.length);
        const invalid = [
            source.replace('/* Begin PBXNativeTarget section */', '/* Unknown section */'),
            `${source}\n/* Begin XCBuildConfiguration section */`,
            source.replace('com.apple.product-type.application', 'com.apple.product-type.framework'),
            source.replace(targetLists[0], 'FFFFFFFFFFFFFFFFFFFFFFFF'),
            source.replaceAll(targetLists[1], targetLists[0]),
            source.replace(`${targetIds[1]} /* target */,`, `${targetIds[0]} /* target */,`),
            source.replace(`${targetIds[0]} /* target */,`, 'FFFFFFFFFFFFFFFFFFFFFFFF /* target */,'),
            source.replace(`${configIds[2]} /* Debug */,`, `${configIds[0]} /* Debug */,`),
            source.replace(`${configIds[2]} /* Debug */,`, 'FFFFFFFFFFFFFFFFFFFFFFFF /* Debug */,'),
            source.replace(`${configIds[2]} /* Debug */,`, `${configIds[3]} /* Release */,`),
            source.replace('name = Release;', 'name = Unknown;'),
            source.replace(/\n\t{2}[A-F0-9]{24} \/\* PBXNativeTarget \*\/ = \{[\s\S]*?\n\t{2}\};/u, ''),
            editApp(''),
            editApp(`${appBundleLine}\n\t\t\t\t${appBundleLine}`),
            editApp('PRODUCT_BUNDLE_IDENTIFIER = "$(inherited)";'),
            editApp(`${appBundleLine}\n\t\t\t\t"PRODUCT_BUNDLE_IDENTIFIER[sdk=iphoneos*]" = org.bad.Override;`),
            editApp(`${appBundleLine}\n\t\t\t\tINFOPLIST_KEY_CFBundleIdentifier = org.bad.Override;`),
            source.replace('isa = XCBuildConfiguration;', 'isa = XCBuildConfiguration;\n\t\t\tbaseConfigurationReference = FFFFFFFFFFFFFFFFFFFFFFFF;'),
            source.replaceAll('SDKROOT = iphoneos;', 'SDKROOT = macosx;'),
            source.replace('/* PBXNativeTarget */ = {', '/* PBXNativeTarget */ = {\n\t\t\tname = Duplicate;'),
        ];
        for (const project of invalid) expect(() => applySafariBundleIdentifiers(project, 'org.test.Reader', 'ios')).toThrow();
    });

    it('只在 Safari MV2 的 WXT 后处理生成显式 UTF-8 页，保持原脚本及非持久生命周期', () => {
        const manifest: Parameters<typeof configureSafariBackgroundPage>[1] = {background: {scripts: ['background.js'], persistent: false}};
        configureSafariBackgroundPage({browser: 'safari', manifestVersion: 2}, manifest);
        expect(manifest.background).toEqual({page: 'safari-background.html', persistent: false});
        expect(backgroundPage()).toEqual({relativeDest: 'safari-background.html', contents: expect.stringMatching(/^<!doctype html>\n<html>\n<head><meta charset="utf-8">/u)});
        for (const env of [{browser: 'chrome', manifestVersion: 3}, {browser: 'firefox', manifestVersion: 2}, {browser: 'safari', manifestVersion: 3}] as const) {
            const untouched = {background: {scripts: ['original.js'], persistent: true}};
            configureSafariBackgroundPage(env, untouched);
            expect(untouched.background).toEqual({scripts: ['original.js'], persistent: true});
            expect(createSafariBackgroundPage(env)).toEqual([]);
        }
        for (const background of [undefined, {}, {scripts: ['renamed.js'], persistent: false}, {scripts: ['background.js', 'extra.js'], persistent: false},
            {scripts: ['background.js'], persistent: true}, {scripts: ['background.js'], persistent: false, page: 'other.html'},
            {scripts: ['background.js'], persistent: false, service_worker: 'worker.js'}]) {
            expect(() => configureSafariBackgroundPage({browser: 'safari', manifestVersion: 2}, {background})).toThrow('入口已变化');
        }
    });

    it('Safari 使用独立版本门槛及能力权限，保留共享网页业务入口', async () => {
        const {verifySafariManifest} = await safariTools();
        const manifest = safariFixture();
        expect(verifySafariManifest(manifest)).toBe(manifest);
        expect(manifest.browser_specific_settings).toEqual({safari: {strict_min_version: '26.0'}});
        expect(manifest.web_accessible_resources).toEqual(expect.arrayContaining([
            expect.objectContaining({resources: ['popup.html']}),
        ]));
        expect(JSON.stringify(manifest.web_accessible_resources)).not.toContain('use_dynamic_url');
        for (const invalid of [
            {...manifest, manifest_version: 3},
            {...manifest, background: {scripts: ['background.js'], persistent: true}},
            {...manifest, background: {scripts: ['background.js'], persistent: false}},
            {...manifest, background: {page: '../safari-background.html', persistent: false}},
            {...manifest, background: {page: 'safari-background.html', scripts: ['background.js'], persistent: false}},
            {...manifest, background: {page: 'safari-background.html', service_worker: 'background.js', persistent: false}},
            {...manifest, permissions: [...manifest.permissions, 'offscreen']},
            {...manifest, permissions: [...manifest.permissions, 'identity']},
            {...manifest, permissions: ['storage']},
            {...manifest, browser_specific_settings: {safari: {strict_min_version: '15.0'}}},
            {...manifest, key: 'chromium-id'},
            {...manifest, content_scripts: []},
            {...manifest, browser_action: undefined},
        ]) expect(() => verifySafariManifest(invalid)).toThrow();
        expect(readFileSync(resolve(PROJECT_ROOT, 'entrypoints/background.ts'), 'utf8')).toContain('safari: false');
    });

    it('只在 Safari MV2 声明免费池单一目录的二十一个精确 optional permissions，required 网页权限不扩大', async () => {
        const {verifySafariManifest} = await safariTools();
        const source = createExtensionManifest({browser: 'safari', manifestVersion: 2});
        const expected = Object.values(FREE_PROVIDER_ORIGINS).flat();
        expect(source.optional_permissions).toEqual(expected);
        expect(expected).toHaveLength(21); expect(new Set(expected).size).toBe(21);
        expect(expected.every(origin => /^https:\/\/[a-z0-9.-]+\/\*$/u.test(origin))).toBe(true);
        expect(source.optional_host_permissions).toBeUndefined();
        expect(verifySafariManifest({...safariFixture(), optional_permissions: [...expected].reverse()})).toBeTruthy();
        for (const env of [{browser: 'chrome', manifestVersion: 3}, {browser: 'chrome', manifestVersion: 2},
            {browser: 'edge', manifestVersion: 3}, {browser: 'firefox', manifestVersion: 2}, {browser: 'firefox', manifestVersion: 3},
            {browser: 'safari', manifestVersion: 3}] as const) {
            const manifest = createExtensionManifest(env);
            expect(manifest.optional_permissions).toBeUndefined(); expect(manifest.optional_host_permissions).toBeUndefined();
            expect(manifest.host_permissions).toEqual(source.host_permissions);
        }
    });

    it('Safari verifier 拒绝缺域、额外宽域、重复项和 MV3 optional_host_permissions 错字段', async () => {
        const {verifySafariManifest} = await safariTools();
        const manifest = safariFixture(); const exact = [...manifest.optional_permissions!];
        for (const optional_permissions of [undefined, [], 'https://edge.microsoft.com/*', exact.slice(1),
            ['<all_urls>'], ['https://*/*'], [...exact, '<all_urls>'], [...exact, 'https://*.google.com/*'],
            [...exact.slice(1), exact[1]], [...exact.slice(1), 'http://edge.microsoft.com/*'],
            [...exact.slice(1), 'https://unrelated.example/*']]) {
            expect(() => verifySafariManifest({...manifest, optional_permissions})).toThrow('精确域集合');
        }
        for (const optional_host_permissions of [[], exact]) {
            expect(() => verifySafariManifest({...manifest, optional_host_permissions})).toThrow('optional_host_permissions');
        }
    });

    it('打包新旧工具回退可用，生成参数始终复制资源且不打开、覆盖或签名', async () => {
        const {findPackager, packagingArguments, applyDeploymentTargets} = await safariTools();
        const probe = vi.fn((_command, args) => args[1] === 'safari-web-extension-packager'
            ? {status: 1, stdout: ''} : {status: 0, stdout: '/Xcode/safari-web-extension-converter\n'});
        expect(findPackager(probe, {})).toEqual({name: 'safari-web-extension-converter', executable: '/Xcode/safari-web-extension-converter'});
        expect(probe).toHaveBeenCalledTimes(2);
        expect(() => findPackager(() => ({status: 1}), {})).toThrow('Xcode');
        const config = {extension: '/build/safari-mv2', projectLocation: '/output/FluentRead', bundleId: 'org.example.FluentRead', platform: 'both'};
        const args = packagingArguments(config);
        expect(args).toEqual([config.extension, '--project-location', config.projectLocation, '--app-name', 'FluentRead', '--bundle-identifier', config.bundleId,
            '--swift', '--copy-resources', '--no-open', '--no-prompt']);
        expect(packagingArguments({...config, platform: 'ios'})).toContain('--ios-only');
        expect(packagingArguments({...config, platform: 'macos'})).toContain('--macos-only');
        expect(() => packagingArguments({...config, bundleId: ''})).toThrow('bundle-id');
        expect(() => packagingArguments({...config, platform: 'windows'})).toThrow('platform');
        expect(applyDeploymentTargets('IPHONEOS_DEPLOYMENT_TARGET = 15.0;\nMACOSX_DEPLOYMENT_TARGET = 10.14;', 'both'))
            .toBe('IPHONEOS_DEPLOYMENT_TARGET = 26.0;\nMACOSX_DEPLOYMENT_TARGET = 14.0;');
        expect(applyDeploymentTargets('IPHONEOS_DEPLOYMENT_TARGET = 27.0;', 'ios')).toContain('27.0');
        expect(applyDeploymentTargets('MACOSX_DEPLOYMENT_TARGET = 15.0;', 'macos')).toContain('15.0');
        expect(() => applyDeploymentTargets('unknown template', 'both')).toThrow('deployment target');
    });

    it('CLI 目录预检拒绝双向嵌套、相同路径与已有输出；相邻目录不误判且不修改输入', async () => {
        const {validatePackagingDirectories} = await safariTools();
        const directory = mkdtempSync(resolve(tmpdir(), 'fluentread-safari-preflight-'));
        const source = resolve(directory, 'source');
        mkdirSync(source); writeFileSync(resolve(source, 'sentinel.txt'), 'input stays unchanged');
        const existing = resolve(directory, 'existing'); mkdirSync(existing);
        const target = resolve(directory, 'output'), sibling = resolve(directory, 'source-copy');
        try {
            for (const output of [source, resolve(source, 'new-wrapper'), directory,
                resolve(source, 'nested/../normalized-wrapper')]) {
                expect(() => validatePackagingDirectories(source, output)).toThrow('不能相同或互相包含');
            }
            expect(() => validatePackagingDirectories(source, existing)).toThrow('目标已存在');
            expect(() => validatePackagingDirectories(source, target)).not.toThrow();
            expect(() => validatePackagingDirectories(source, sibling)).not.toThrow();
            expect(existsSync(target)).toBe(false); expect(existsSync(sibling)).toBe(false);
            expect(readdirSync(source)).toEqual(['sentinel.txt']);
            expect(readFileSync(resolve(source, 'sentinel.txt'), 'utf8')).toBe('input stays unchanged');
        } finally {rmSync(directory, {recursive: true, force: true});}
    });

    it('CLI 目录预检解析源与输出祖先的真实路径，拒绝符号链接嵌套及不可解析路径', async () => {
        const {validatePackagingDirectories} = await safariTools();
        const directory = mkdtempSync(resolve(tmpdir(), 'fluentread-safari-physical-path-'));
        const source = resolve(directory, 'source'), sourceAlias = resolve(directory, 'source-alias');
        const parentAlias = resolve(directory, 'parent-alias'), dangling = resolve(directory, 'dangling');
        mkdirSync(source);writeFileSync(resolve(source, 'sentinel.txt'), 'input stays unchanged');
        symlinkSync(source, sourceAlias, 'dir');symlinkSync(directory, parentAlias, 'dir');
        symlinkSync(resolve(directory, 'missing'), dangling, 'dir');
        try {
            for (const [input, output] of [
                [sourceAlias, resolve(source, 'new/wrapper')],
                [source, resolve(sourceAlias, 'new/wrapper')],
                [source, resolve(parentAlias, 'source/new/wrapper')],
                [sourceAlias, parentAlias],
                [source, sourceAlias],
            ]) expect(() => validatePackagingDirectories(input, output)).toThrow('不能相同或互相包含');
            for (const [input, output] of [
                [dangling, resolve(directory, 'output')],
                [source, dangling],
                [source, resolve(dangling, 'new/wrapper')],
                [source, resolve(source, 'sentinel.txt/wrapper')],
            ]) expect(() => validatePackagingDirectories(input, output)).toThrow();
            const allowed = resolve(parentAlias, 'source-copy/new/wrapper');
            expect(() => validatePackagingDirectories(sourceAlias, allowed)).not.toThrow();
            expect(existsSync(allowed)).toBe(false);
            expect(readdirSync(source)).toEqual(['sentinel.txt']);
            expect(readFileSync(resolve(source, 'sentinel.txt'), 'utf8')).toBe('input stays unchanged');
        } finally {rmSync(directory, {recursive: true, force: true});}
    });

    it('CLI 目录预检按真实对象拒绝双向大小写别名嵌套，大小写敏感卷仍允许独立相邻目录', async () => {
        const {validatePackagingDirectories} = await safariTools();
        const directory = mkdtempSync(resolve(tmpdir(), 'fluentread-safari-case-identity-'));
        const source = resolve(directory, 'source'), caseAlias = resolve(directory, 'SOURCE');
        const identity = (file: string) => {
            const info = statSync(file, {bigint: true});
            return {dev: info.dev, ino: info.ino};
        };
        mkdirSync(resolve(source, 'nested'), {recursive: true});
        writeFileSync(resolve(source, 'sentinel.txt'), 'input stays unchanged');
        try {
            if (existsSync(caseAlias)) {
                // 在实际大小写不敏感卷上验证别名身份，不用平台名推断文件系统行为。
                expect(identity(caseAlias)).toEqual(identity(source));
                for (const [input, output] of [
                    [source, resolve(caseAlias, 'new/wrapper')],
                    [caseAlias, resolve(source, 'new/wrapper')],
                    [resolve(source, 'nested'), caseAlias],
                    [resolve(caseAlias, 'nested'), source],
                    [source, caseAlias],
                    [caseAlias, source],
                ]) expect(() => validatePackagingDirectories(input, output)).toThrow('不能相同或互相包含');
            } else {
                // 大小写敏感卷实际执行不同目录的允许断言，不跳过测试或强制转小写。
                expect(() => statSync(caseAlias)).toThrow(expect.objectContaining({code: 'ENOENT'}));
                expect(() => validatePackagingDirectories(source, resolve(caseAlias, 'new/wrapper'))).not.toThrow();
                expect(existsSync(caseAlias)).toBe(false);
                mkdirSync(caseAlias);
                expect(identity(caseAlias)).not.toEqual(identity(source));
                expect(() => validatePackagingDirectories(source, resolve(caseAlias, 'new/wrapper'))).not.toThrow();
                expect(() => validatePackagingDirectories(caseAlias, resolve(source, 'new/wrapper'))).not.toThrow();
                expect(readdirSync(caseAlias)).toEqual([]);
            }
            const sibling = resolve(directory, 'source-copy/new/wrapper');
            expect(() => validatePackagingDirectories(source, sibling)).not.toThrow();
            expect(existsSync(sibling)).toBe(false);
            expect(readdirSync(source).sort()).toEqual(['nested', 'sentinel.txt']);
            expect(readFileSync(resolve(source, 'sentinel.txt'), 'utf8')).toBe('input stays unchanged');
        } finally {rmSync(directory, {recursive: true, force: true});}
    });

    it('检查最终文件，拒绝错放的浏览器后台、缺失引用和 Offscreen 容器', async () => {
        const {verifySafariBuild} = await safariTools();
        const directory = mkdtempSync(resolve(tmpdir(), 'fluentread-safari-contract-'));
        try {
            writeFileSync(resolve(directory, 'manifest.json'), JSON.stringify(safariFixture()));
            writeFileSync(resolve(directory, backgroundPage().relativeDest), backgroundPage().contents);
            writeFileSync(resolve(directory, 'background.js'), '__FLUENTREAD_BROWSER_CAPABILITY_BUILD__:safari:mv2__');
            writeFileSync(resolve(directory, 'popup.html'), '<html></html>');
            writeFileSync(resolve(directory, 'content.js'), 'sharedContent();');
            const verified = await verifySafariBuild(directory);
            expect(verified).toEqual(expect.objectContaining({extension: directory, version: '0.0.38', checkedReferences: 4, artifactCount: 5}));
            writeFileSync(resolve(directory, 'content.js'), 'changedSharedContent();');
            const changed = await verifySafariBuild(directory);
            expect(changed.manifestSha256).toBe(verified.manifestSha256);
            expect(changed.buildSha256).not.toBe(verified.buildSha256);
            writeFileSync(resolve(directory, 'background.js'), '__FLUENTREAD_BROWSER_CAPABILITY_BUILD__:chrome:mv3__');
            await expect(verifySafariBuild(directory)).rejects.toThrow('能力标记');
            writeFileSync(resolve(directory, 'background.js'), '__FLUENTREAD_BROWSER_CAPABILITY_BUILD__:safari:mv2__');
            writeFileSync(resolve(directory, 'offscreen.html'), '<html></html>');
            await expect(verifySafariBuild(directory)).rejects.toThrow('Offscreen');
            rmSync(resolve(directory, 'offscreen.html'));
            rmSync(resolve(directory, 'content.js'));
            await expect(verifySafariBuild(directory)).rejects.toThrow('ENOENT');
        } finally {rmSync(directory, {recursive: true, force: true});}
    });

    it('拒绝后台页编码漂移、内联或远程脚本、缺失脚本及包内引用逃逸', async () => {
        const {verifySafariBuild} = await safariTools();
        const directory = mkdtempSync(resolve(tmpdir(), 'fluentread-safari-utf8-'));
        const page = backgroundPage();
        const reset = () => {
            writeFileSync(resolve(directory, 'manifest.json'), JSON.stringify(safariFixture()));
            writeFileSync(resolve(directory, page.relativeDest), page.contents);
            writeFileSync(resolve(directory, 'background.js'), '__FLUENTREAD_BROWSER_CAPABILITY_BUILD__:safari:mv2__');
            writeFileSync(resolve(directory, 'popup.html'), '<html></html>');
            writeFileSync(resolve(directory, 'content.js'), 'sharedContent();');
        };
        try {
            reset();
            for (const invalid of [
                page.contents.replace('<meta charset="utf-8">', ''),
                page.contents.replace('utf-8', 'gb18030'),
                page.contents.replace('./background.js', 'https://example.invalid/background.js'),
                page.contents.replace('./background.js', '../background.js'),
                page.contents.replace('./background.js', './%2e%2e/background.js'),
                page.contents.replace('./background.js', './background.js?charset=gb18030'),
                page.contents.replace('</head>', '<base href="https://example.invalid/"></head>'),
                page.contents.replace('</script>', 'globalThis.inline = true;</script>'),
                page.contents.replace('</body>', '<script src="./background.js"></script></body>'),
                page.contents.replace('<!doctype html>', '<!-- <meta charset="utf-8"> --><!doctype html>'),
                Buffer.from([0xff, 0xfe, 0x3c, 0x00]),
            ]) {
                writeFileSync(resolve(directory, page.relativeDest), invalid);
                await expect(verifySafariBuild(directory)).rejects.toThrow();
            }
            reset();
            writeFileSync(resolve(directory, 'background.js'), Buffer.from([0xff, 0xfe]));
            await expect(verifySafariBuild(directory)).rejects.toThrow();
            reset();
            rmSync(resolve(directory, 'background.js'));
            await expect(verifySafariBuild(directory)).rejects.toThrow('ENOENT');
            reset();
            rmSync(resolve(directory, page.relativeDest));
            await expect(verifySafariBuild(directory)).rejects.toThrow('ENOENT');
            for (const invalid of ['../outside.js', '/outside.js', 'https://example.invalid/a.js', 'assets/../content.js', 'assets\\content.js', '%2e%2e/outside.js', 'content.js?x=1', '']) {
                reset();
                const manifest = safariFixture();
                manifest.content_scripts[0].js = [invalid];
                writeFileSync(resolve(directory, 'manifest.json'), JSON.stringify(manifest));
                await expect(verifySafariBuild(directory)).rejects.toThrow('包内相对路径');
            }
            reset();
            rmSync(resolve(directory, 'background.js'));
            symlinkSync(resolve(directory, 'content.js'), resolve(directory, 'background.js'));
            await expect(verifySafariBuild(directory)).rejects.toThrow('符号链接');
            rmSync(resolve(directory, 'background.js'));
            reset();
            symlinkSync(directory, resolve(directory, 'linked-assets'));
            const manifest = safariFixture();
            manifest.content_scripts[0].js = ['linked-assets/content.js'];
            writeFileSync(resolve(directory, 'manifest.json'), JSON.stringify(manifest));
            await expect(verifySafariBuild(directory)).rejects.toThrow('符号链接');
        } finally {rmSync(directory, {recursive: true, force: true});}
    });

    it('新包装验证 Apple 容器布局后复制本地指引，不写入扩展资源或遗留示例身份', async () => {
        const {applyContainerGuide} = await safariTools();
        const directory = mkdtempSync(resolve(tmpdir(), 'fluentread-safari-guide-'));
        try {
            const app = resolve(directory, 'Shared (App)');
            mkdirSync(resolve(app, 'Resources/Base.lproj'), {recursive: true});
            mkdirSync(resolve(directory, 'Shared (Extension)/Resources'), {recursive: true});
            writeFileSync(resolve(app, 'ViewController.swift'), 'class ViewController: NSObject {}');
            writeFileSync(resolve(app, 'Resources/Base.lproj/Main.html'), '<html></html>');
            writeFileSync(resolve(app, 'Resources/Style.css'), ':root {}');
            writeFileSync(resolve(app, 'Resources/Script.js'), 'unknown template');
            mkdirSync(resolve(directory, 'iOS (App)'));
            writeFileSync(resolve(directory, 'iOS (App)/Info.plist'), '<plist><dict><key>SFSafariWebExtensionConverterVersion</key><string>26.2</string><key>UIApplicationSceneManifest</key><dict></dict></dict></plist>');
            mkdirSync(resolve(directory, 'macOS (App)'));
            writeFileSync(resolve(directory, 'macOS (App)/Info.plist'), '<plist><dict><key>SFSafariWebExtensionConverterVersion</key><string>26.2</string></dict></plist>');
            const project = resolve(directory, 'FluentRead.xcodeproj');
            await expect(applyContainerGuide(project, 'org.test.Reader')).rejects.toThrow('模板布局');
            expect(readFileSync(resolve(app, 'ViewController.swift'), 'utf8')).toBe('class ViewController: NSObject {}');
            writeFileSync(resolve(app, 'Resources/Script.js'), 'function show() {}');
            const report = await applyContainerGuide(project, 'org.test.Reader');
            expect(report.files).toHaveLength(5);
            expect(report.iosSettingsMinimum).toBe('26.2');
            const swift = readFileSync(resolve(app, 'ViewController.swift'), 'utf8');
            expect(swift).toContain('"org.test.Reader.Extension"');
            expect(swift).toContain('#available(iOS 26.2, *)');
            expect(swift).toContain('SFSafariSettings.openExtensionsSettings');
            expect(swift).toContain('SFSafariApplication.showPreferencesForExtension');
            expect(swift).toContain('Locale.preferredLanguages');
            expect(swift).toContain('private weak var delegate: WKScriptMessageHandler?');
            expect(swift).toContain('userContentController.add(WeakScriptMessageHandler(self), name: "controller")');
            expect(swift).not.toContain('userContentController.add(self,');
            expect(swift).toMatch(/deinit\s*\{\s*webView\?\.configuration\.userContentController\.removeScriptMessageHandler\(forName: "controller"\)/u);
            expect(swift).toContain('#if targetEnvironment(simulator)');
            expect(swift).toContain('canOpen = extensionSettingsIdentifier != nil');
            expect(swift).toContain('forInfoDictionaryKey: "FluentReadDevelopmentTeam"');
            expect(swift).toContain('return "\\(extensionBundleIdentifier) (\\(team))"');
            expect(readFileSync(resolve(directory, 'iOS (App)/Info.plist'), 'utf8')).toContain('<string>$(DEVELOPMENT_TEAM)</string>');
            expect(report.iosSettingsPolicy).toContain('manual steps');
            expect(swift).not.toMatch(/prefs:|App-prefs:|org\.example|__FLUENTREAD_/i);
            expect(existsSync(resolve(directory, 'Shared (Extension)/Resources/Script.js'))).toBe(false);
        } finally {rmSync(directory, {recursive: true, force: true});}
    });

    it('三种 Apple 模板按平台严格定位，iOS-only 新增脚本引用且拒绝错配及符号链接', async () => {
        const {applyContainerGuide, locateSafariTemplate, addIOSGuideScriptReference} = await safariTools();
        const plist = (ios: boolean) => `<plist><dict><key>SFSafariWebExtensionConverterVersion</key><string>26.2</string>${ios ? '<key>UIApplicationSceneManifest</key><dict></dict>' : ''}</dict></plist>`;
        const pbx = `\tAAAAAAAAAAAAAAAAAAAAAAAA /* Style.css */ = {isa = PBXFileReference; lastKnownFileType = text.css; path = Style.css; sourceTree = "<group>"; };\n\tBBBBBBBBBBBBBBBBBBBBBBBB /* Style.css in Resources */ = {isa = PBXBuildFile; fileRef = AAAAAAAAAAAAAAAAAAAAAAAA /* Style.css */; };\n\t\tAAAAAAAAAAAAAAAAAAAAAAAA /* Style.css */,\n\t\tBBBBBBBBBBBBBBBBBBBBBBBB /* Style.css in Resources */,\n`;
        for (const platform of ['both', 'ios', 'macos']) {
            const directory = mkdtempSync(resolve(tmpdir(), `fluentread-safari-${platform}-`));
            try {
                const app = platform === 'both' ? 'Shared (App)' : 'FluentRead';
                const extension = platform === 'both' ? 'Shared (Extension)' : 'FluentRead Extension';
                mkdirSync(resolve(directory, app, 'Resources/Base.lproj'), {recursive: true});
                mkdirSync(resolve(directory, extension, 'Resources'), {recursive: true});
                writeFileSync(resolve(directory, extension, 'Resources/sentinel'), 'unchanged');
                const project = resolve(directory, 'FluentRead.xcodeproj');
                mkdirSync(project);
                writeFileSync(resolve(project, 'project.pbxproj'), pbx);
                writeFileSync(resolve(directory, app, 'ViewController.swift'), 'class ViewController: NSObject {}');
                writeFileSync(resolve(directory, app, 'Resources/Base.lproj/Main.html'), '<html></html>');
                writeFileSync(resolve(directory, app, 'Resources/Style.css'), ':root {}');
                if (platform !== 'ios') writeFileSync(resolve(directory, app, 'Resources/Script.js'), 'function show() {}');
                if (platform === 'both') {
                    for (const [folder, ios] of [['iOS (App)', true], ['macOS (App)', false]] as const) {
                        mkdirSync(resolve(directory, folder)); writeFileSync(resolve(directory, folder, 'Info.plist'), plist(ios));
                    }
                } else writeFileSync(resolve(directory, app, 'Info.plist'), plist(platform === 'ios'));
                const layout = await locateSafariTemplate(project, platform);
                expect(layout.extensionResources).toBe(resolve(directory, extension, 'Resources'));
                for (const wrong of ['both', 'ios', 'macos'].filter(mode => mode !== platform)) await expect(locateSafariTemplate(project, wrong)).rejects.toThrow();
                const guide = await applyContainerGuide(project, 'org.test.Reader', platform);
                expect(guide.layout).toBe(platform === 'both' ? 'shared' : 'single-platform');
                expect(readFileSync(resolve(directory, app, 'Resources/Script.js'), 'utf8')).toContain('function show(');
                expect(readFileSync(resolve(directory, extension, 'Resources/sentinel'), 'utf8')).toBe('unchanged');
                if (platform === 'ios') {
                    const updated = readFileSync(resolve(project, 'project.pbxproj'), 'utf8');
                    expect(updated.match(/\/\* Script.js in Resources \*\//g)).toHaveLength(2);
                    expect(updated).toContain('sourcecode.javascript; path = Script.js;');
                    expect(readFileSync(resolve(directory, app, 'Info.plist'), 'utf8')).toContain('$(DEVELOPMENT_TEAM)');
                }
                rmSync(resolve(directory, app, 'Resources/Script.js'));
                symlinkSync(resolve(directory, app, 'Resources/Style.css'), resolve(directory, app, 'Resources/Script.js'));
                await expect(applyContainerGuide(project, 'org.test.Reader', platform)).rejects.toThrow('符号链接');
                rmSync(resolve(directory, app, 'Resources/Script.js'));
                symlinkSync(resolve(directory, 'missing-script'), resolve(directory, app, 'Resources/Script.js'));
                await expect(applyContainerGuide(project, 'org.test.Reader', platform)).rejects.toThrow('符号链接');
            } finally {rmSync(directory, {recursive: true, force: true});}
        }
        expect(() => addIOSGuideScriptReference('unknown Apple template')).toThrow('模板已变化');
        expect(() => addIOSGuideScriptReference(`${pbx}${pbx}`)).toThrow('模板已变化');
    });

    it('容器根据原生语言展示中英短步骤，旧 iOS 隐藏按钮，打开失败提供手动回退', () => {
        const nodes = new Map<string, {textContent: string; hidden: boolean; addEventListener: ReturnType<typeof vi.fn>}>();
        const node = (id: string) => {
            if (!nodes.has(id)) nodes.set(id, {textContent: '', hidden: false, addEventListener: vi.fn()});
            return nodes.get(id)!;
        };
        const document = {documentElement: {lang: ''}, title: '', getElementById: node, querySelector: node};
        const postMessage = vi.fn();
        const context = {document, window: {webkit: {messageHandlers: {controller: {postMessage}}}}};
        const script = readFileSync(resolve(PROJECT_ROOT, 'scripts/safari/container/Script.js'), 'utf8');
        runInNewContext(`(() => {${script}\nshow('ios', 'zh-Hans-CN', false);})();`, context);
        expect(document.documentElement.lang).toBe('zh-Hans');
        expect(document.title).toBe('流畅阅读');
        expect(node('open-settings').hidden).toBe(true);
        expect(node('manual-path').textContent).toContain('设置 → App → Safari浏览器 → 扩展 → 流畅阅读');
        for (const id of ['step-enable', 'step-use']) {
            expect(node(id).textContent).toContain('流畅阅读');
            expect(node(id).textContent).not.toContain('FluentRead');
        }
        runInNewContext(`(() => {${script}\nshow('ios', 'en-US', true); settingsFailed();})();`, context);
        expect(document.documentElement.lang).toBe('en');
        expect(node('open-settings').hidden).toBe(false);
        expect(node('status').textContent).toContain('manual path');
        const listener = node('open-settings').addEventListener.mock.calls.at(-1)![1];
        listener();
        expect(postMessage).toHaveBeenCalledWith('open-settings');
        runInNewContext(`(() => {${script}\nshow('mac', 'en', true, true);})();`, context);
        expect(node('status').textContent).toContain('enabled');
        expect(node('manual-path').textContent).toContain('Safari → Settings');
    });
});

describe('Chrome unified ZIP packaging', () => {
    async function verifier() {
        const url = pathToFileURL(resolve(PROJECT_ROOT, 'scripts/testing/verify-extension-manifests.mjs')).href;
        return import(/* @vite-ignore */ url);
    }

    async function fixture(manifest: Record<string, unknown>) {
        const directory = mkdtempSync(resolve(tmpdir(), 'fluentread-single-zip-'));
        const zipPath = resolve(directory, 'fluent-read-0.0.37-chrome.zip');
        const buildDirectory = resolve(directory, 'chrome-mv3');
        const files = {
            'manifest.json': JSON.stringify(manifest),
            'background.js': 'globalThis.packagingProbe = true;',
            'asset.wasm': Buffer.from([0, 97, 115, 109, 255, 0]),
            '_locales/zh_CN/messages.json': '{"name":{"message":"流畅阅读"}}',
        };
        const archive = new JSZip();
        for (const [name, bytes] of Object.entries(files)) {
            archive.file(name, bytes);
            const file = resolve(buildDirectory, name);
            mkdirSync(dirname(file), {recursive: true});
            writeFileSync(file, bytes);
        }
        writeFileSync(zipPath, await archive.generateAsync({type: 'nodebuffer'}));
        return {directory, zipPath, buildDirectory, storePath: zipPath.replace(/\.zip$/u, '-store.zip')};
    }

    it('唯一 ZIP 保留全部原字节，清理同版本旧商店包且重复执行稳定', async () => {
        const manifest = createExtensionManifest({browser: 'chrome', manifestVersion: 3});
        const {directory, zipPath, buildDirectory, storePath} = await fixture(manifest);
        try {
            const originalBytes = readFileSync(zipPath);
            writeFileSync(storePath, 'old store archive');
            const unrelated = ['fluent-read-0.0.36-chrome-store.zip', 'fluent-read-0.0.37-edge.zip', 'notes.txt'];
            for (const name of unrelated) writeFileSync(resolve(directory, name), name);
            expect(await finalizeExtensionZip('chrome', zipPath)).toBeUndefined();
            expect(readFileSync(zipPath)).toEqual(originalBytes);
            expect(existsSync(storePath)).toBe(false);
            const archive = await JSZip.loadAsync(readFileSync(zipPath), {checkCRC32: true});
            expect(JSON.parse(await archive.file('manifest.json')!.async('string'))).toEqual(manifest);
            const {verifyChromeArchive} = await verifier();
            await expect(verifyChromeArchive(originalBytes, manifest, buildDirectory)).resolves.toBeUndefined();
            await finalizeExtensionZip('chrome', zipPath);
            expect(readFileSync(zipPath)).toEqual(originalBytes);
            expect(existsSync(storePath)).toBe(false);
            for (const name of unrelated) expect(readFileSync(resolve(directory, name), 'utf8')).toBe(name);
        } finally {rmSync(directory, {recursive: true, force: true});}
    });

    it.each(['edge', 'firefox'])('%s ZIP 保持原字节，不清理 Chrome 旧包', async (browser) => {
        const {directory, zipPath, storePath} = await fixture({manifest_version: 3, version: '0.0.37', key: 'control'});
        try {
            const before = readFileSync(zipPath);
            writeFileSync(storePath, 'retained store archive');
            expect(await finalizeExtensionZip(browser, zipPath)).toBeUndefined();
            expect(readFileSync(zipPath)).toEqual(before);
            expect(readFileSync(storePath, 'utf8')).toBe('retained store archive');
        } finally {rmSync(directory, {recursive: true, force: true});}
    });

    it('缺少清单时拒绝交付，不改写原 ZIP 或删除旧包', async () => {
        const {directory, zipPath, storePath} = await fixture({manifest_version: 3});
        try {
            const zip = await JSZip.loadAsync(readFileSync(zipPath)); zip.remove('manifest.json');
            writeFileSync(zipPath, await zip.generateAsync({type: 'nodebuffer'}));
            writeFileSync(storePath, 'retained store archive');
            const before = readFileSync(zipPath);
            await expect(finalizeExtensionZip('chrome', zipPath)).rejects.toThrow('缺少 manifest.json');
            expect(readFileSync(zipPath)).toEqual(before);
            expect(readFileSync(storePath, 'utf8')).toBe('retained store archive');
        } finally {rmSync(directory, {recursive: true, force: true});}
    });

    it('缺少 key 的 ZIP 拒绝交付，不改原包或删除旧包', async () => {
        const manifest = createExtensionManifest({browser: 'chrome', manifestVersion: 3}); delete manifest.key;
        const {directory, zipPath, storePath} = await fixture(manifest);
        try {
            const before = readFileSync(zipPath);
            writeFileSync(storePath, 'retained store archive');
            await expect(finalizeExtensionZip('chrome', zipPath)).rejects.toThrow('key');
            expect(readFileSync(zipPath)).toEqual(before);
            expect(readFileSync(storePath, 'utf8')).toBe('retained store archive');
        } finally {rmSync(directory, {recursive: true, force: true});}
    });

    it('非 ZIP 路径拒绝处理，避免删除输入文件', async () => {
        const manifest = createExtensionManifest({browser: 'chrome', manifestVersion: 3});
        const {directory, zipPath} = await fixture(manifest);
        try {
            const file = resolve(directory, 'archive.txt');
            const before = readFileSync(zipPath); writeFileSync(file, before);
            await expect(finalizeExtensionZip('chrome', file)).rejects.toThrow('.zip');
            expect(readFileSync(file)).toEqual(before);
        } finally {rmSync(directory, {recursive: true, force: true});}
    });

    it('单包发行校验拒绝清单变化或公钥缺失，接受完整原清单', async () => {
        const {verifyChromeOfflineManifest} = await verifier();
        const local = createExtensionManifest({browser: 'chrome', manifestVersion: 3});
        const withoutKey = {...local}; delete withoutKey.key;
        expect(() => verifyChromeOfflineManifest({...local, description: 'changed'}, local)).toThrow('本地构建一致');
        expect(() => verifyChromeOfflineManifest(withoutKey, local)).toThrow('本地构建一致');
        expect(() => verifyChromeOfflineManifest(withoutKey, withoutKey)).toThrow('key');
        expect(verifyChromeOfflineManifest(local, local)).toBe(GOOGLE_DRIVE_EXTENSION_ID);
    });

    it('身份校验拒绝无效公钥与默认客户端错配，仍允许独立开发客户端', async () => {
        const {verifyChromeOfflineManifest} = await verifier();
        const local = createExtensionManifest({browser: 'chrome', manifestVersion: 3});
        for (const key of ['', 'invalid']) {
            const invalid = {...local, key};
            expect(() => verifyChromeOfflineManifest(invalid, invalid)).toThrow('key');
        }
        const otherKey = generateKeyPairSync('ed25519').publicKey.export({type: 'spki', format: 'der'}).toString('base64');
        const mismatched = {...local, key: otherKey};
        expect(() => verifyChromeOfflineManifest(mismatched, mismatched)).toThrow('默认 Google OAuth 客户端不匹配');
        const custom = {...mismatched, oauth2: {...local.oauth2, client_id: 'custom-developer.apps.googleusercontent.com'}};
        expect(() => verifyChromeOfflineManifest(custom, custom)).not.toThrow();
        for (const invalid of [
            {...local, oauth2: undefined},
            {...local, oauth2: {...local.oauth2, client_id: ''}},
            {...local, permissions: local.permissions!.filter(permission => permission !== 'identity')},
            {...local, oauth2: {...local.oauth2, scopes: []}},
        ]) expect(() => verifyChromeOfflineManifest(invalid, invalid)).toThrow(/OAuth|identity/u);
    });

    it('统一 ZIP 的真实清单与派生 ID 满足默认 OAuth，错误 ID 不发起授权', async () => {
        const manifest = createExtensionManifest({browser: 'chrome', manifestVersion: 3});
        const {directory, zipPath} = await fixture(manifest);
        try {
            await finalizeExtensionZip('chrome', zipPath);
            const archive = await JSZip.loadAsync(readFileSync(zipPath), {checkCRC32: true});
            const offline = JSON.parse(await archive.file('manifest.json')!.async('string'));
            const {verifyChromeOfflineManifest} = await verifier();
            const runtimeId = verifyChromeOfflineManifest(offline, manifest);
            const ports: DriveAuthPorts = {
                userAgent: () => 'Chrome/142.0.0.0',
                identity: {getAuthToken: vi.fn(async () => ({})), removeCachedAuthToken: vi.fn(async () => undefined), clearAllCachedAuthTokens: vi.fn(async () => undefined)},
                runtime: {id: runtimeId, getManifest: () => offline}, fetch: vi.fn(),
            };
            const auth = createDriveAuth(ports);
            expect(auth.availability()).toEqual({available: true, reason: ''});
            ports.runtime.id = 'aakdnohjinpalkgcdkjpbbfbkieohfce';
            expect(auth.availability().reason).toContain('扩展 ID');
            await expect(auth.open(true)).rejects.toThrow('OAuth 客户端不匹配');
            expect(ports.identity!.getAuthToken).not.toHaveBeenCalled();
            expect(ports.fetch).not.toHaveBeenCalled();
        } finally {rmSync(directory, {recursive: true, force: true});}
    });

    it('发行校验检查 CRC 和构建目录全部文件，拒绝资产损坏、增删或清单缺失', async () => {
        const manifest = createExtensionManifest({browser: 'chrome', manifestVersion: 3});
        const {directory, zipPath, buildDirectory, storePath} = await fixture(manifest);
        try {
            const bytes = readFileSync(zipPath);
            const {verifyChromeArchive} = await verifier();
            const broken = Buffer.from(bytes);
            const offset = broken.indexOf(Buffer.from('globalThis.packagingProbe = true;'));
            expect(offset).toBeGreaterThan(-1); broken[offset] ^= 1;
            await expect(verifyChromeArchive(broken, manifest, buildDirectory)).rejects.toThrow('CRC32');
            writeFileSync(zipPath, broken); writeFileSync(storePath, 'retained store archive');
            await expect(finalizeExtensionZip('chrome', zipPath)).rejects.toThrow('CRC32');
            expect(readFileSync(storePath, 'utf8')).toBe('retained store archive');
            for (const change of ['add', 'remove', 'content', 'manifest', 'manifest-format']) {
                const archive = await JSZip.loadAsync(bytes, {checkCRC32: true});
                if (change === 'add') archive.file('extra.js', 'extra');
                else if (change === 'remove') archive.remove('asset.wasm');
                else if (change === 'content') archive.file('asset.wasm', Buffer.from([0, 97, 115, 109, 0, 0]));
                else if (change === 'manifest-format') archive.file('manifest.json', JSON.stringify(manifest, null, 2));
                else archive.remove('manifest.json');
                await expect(verifyChromeArchive(await archive.generateAsync({type: 'nodebuffer'}), manifest, buildDirectory))
                    .rejects.toThrow(change === 'content' || change === 'manifest-format' ? '文件内容' : change === 'manifest' ? 'manifest.json' : '文件条目');
            }
        } finally {rmSync(directory, {recursive: true, force: true});}
    });

    it('当前版本只接受统一 Chrome 包，拒绝旧商店包残留并保留其他浏览器与版本', async () => {
        const {verifyChromeArchiveNames} = await verifier();
        const archive = 'fluent-read-0.0.37-chrome.zip';
        const files = [archive, 'fluent-read-0.0.36-chrome-store.zip', 'fluent-read-0.0.37-edge.zip', 'fluent-read-0.0.37-firefox.zip'];
        expect(verifyChromeArchiveNames(files, '0.0.37')).toBe(archive);
        expect(() => verifyChromeArchiveNames([...files, 'fluent-read-0.0.37-chrome-store.zip'], '0.0.37')).toThrow('不得残留');
        expect(() => verifyChromeArchiveNames(files.filter(name => name !== archive), '0.0.37')).toThrow('缺失');
    });
});

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

describe('TTS worker entrypoint metadata isolation', () => {
    it('WXT 的实际元数据转换移除 TTS 运行时导入，避免在 Node 中装载另一版 ONNX', async () => {
        const transformUrl = pathToFileURL(resolve(dirname(createRequire(import.meta.url).resolve('wxt')), 'core/utils/transform.mjs')).href;
        const {removeMainFunctionCode} = await import(/* @vite-ignore */ transformUrl) as {
            removeMainFunctionCode(source: string): {code: string};
        };
        const source = sourceBody('entrypoints/localTtsWorker.ts');
        const metadata = removeMainFunctionCode(source).code;
        expect(metadata).toContain('defineUnlistedScript');
        expect(metadata).not.toContain('startLocalTtsWorkerApp');
        expect(metadata).not.toContain('@/src/app/offscreen/localTtsWorker');
    });

    it('真实入口保留静态导入，并在 main 调用时同步启动 Worker 一次', () => {
        const source = sourceBody('entrypoints/localTtsWorker.ts');
        expect(source).toContain("import {startLocalTtsWorkerApp} from '@/src/app/offscreen/localTtsWorker';");
        const start = vi.fn();
        const requireApp = vi.fn((path: string) => {
            expect(path).toBe('@/src/app/offscreen/localTtsWorker');
            return {startLocalTtsWorkerApp: start};
        });
        const exports: {default?: {main?: () => void}} = {};
        const compiled = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS}}).outputText;
        new Function('require', 'exports', 'defineUnlistedScript', compiled)(requireApp, exports, defineUnlistedScript);
        expect(requireApp).toHaveBeenCalledOnce();
        expect(start).not.toHaveBeenCalled();
        expect(exports.default!.main!()).toBeUndefined();
        expect(start).toHaveBeenCalledOnce();
        expect(start).toHaveBeenCalledWith();
    });
});

function permissionsFor(browser: string, manifestVersion: 2 | 3): string[] {
    const manifest = createExtensionManifest({browser, manifestVersion} as Parameters<typeof createExtensionManifest>[0]);
    return manifest.permissions as string[];
}

describe('extension manifest capability contract', () => {
    it.each(['chrome', 'firefox', 'edge'] as const)('%s 安装名称使用浏览器本地化 metadata，不复用技术包名', (browser) => {
        const manifest = createExtensionManifest({browser, manifestVersion: browser === 'firefox' ? 2 : 3});
        expect(manifest.name).toBe('__MSG_extensionName__');
        expect(manifest.default_locale).toBe('en');
        expect(manifest.version).toBeUndefined();
    });

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
            expect(manifest.permissions).not.toContain('identity');
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
        // 验证排除 coverage 的契约，允许其他合法排除项与多行格式。
        const excludedSources = source.match(/excludeSources:\s*\[([\s\S]*?)\]/)?.[1];
        expect(excludedSources).toContain("'coverage/**'");
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
