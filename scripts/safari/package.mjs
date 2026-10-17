#!/usr/bin/env node

/**
 * Safari 交付边界：校验 WXT Safari 产物，检测本机 Apple 打包工具，并生成不打开、不签名的 Xcode 包装。
 * 通过真实路径与文件系统对象身份隔离输入和输出，不构建网页代码、不申请账号、不改写已有工程。实际安装、签名与 App Store 分发仍由维护者执行。
 */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, lstatSync, readFileSync, realpathSync, statSync} from 'node:fs';
import {lstat, mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const toolNames = ['safari-web-extension-packager', 'safari-web-extension-converter'];
// Node20 原生脚本与 WXT/平台共用 JSON 单一源，不解析 TypeScript 或维护第二份域表。
const freeProviderOrigins = JSON.parse(readFileSync(new URL('../../src/core/config/freeProviderOrigins.json', import.meta.url), 'utf8'));
const optionalProviderOrigins = Object.values(freeProviderOrigins).flat();
const bundleIdentifierPattern = /^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z][A-Za-z0-9-]*){2,}$/u;

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

/** 检查最终清单而非源配置，避免 WXT 的 MV 转换或入口配置造成静默漂移。 */
export function verifySafariManifest(manifest) {
    assert(manifest.manifest_version === 2, 'Safari 包装需要 build:safari 生成的 MV2 产物');
    assert(manifest.background?.persistent === false, 'iOS Safari 后台必须为非持久模式');
    assert(manifest.background?.page === 'safari-background.html'
        && Object.keys(manifest.background).every(key => key === 'persistent' || key === 'page'),
    'Safari 产物必须使用独立显式 UTF-8 后台页，不能使用自动 scripts 或 service_worker');
    assert(manifest.browser_specific_settings?.safari?.strict_min_version === '26.0', 'Safari 最低版本必须为 26.0');
    assert(!manifest.browser_specific_settings?.gecko && !manifest.oauth2 && !manifest.key, 'Safari 清单不能包含 Firefox/Chrome 身份字段');
    const permissions = manifest.permissions ?? [];
    for (const permission of ['storage', 'alarms', 'declarativeNetRequestWithHostAccess', '<all_urls>']) {
        assert(permissions.includes(permission), `Safari 产物缺少权限 ${permission}`);
    }
    for (const permission of ['offscreen', 'identity']) {
        assert(!permissions.includes(permission), `Safari 产物包含不支持的权限 ${permission}`);
    }
    assert(manifest.optional_host_permissions === undefined, 'Safari MV2 不能使用 optional_host_permissions，必须声明精确 optional_permissions');
    const optional = manifest.optional_permissions;
    assert(Array.isArray(optional) && optional.length === optionalProviderOrigins.length
        && new Set(optional).size === optionalProviderOrigins.length
        && optional.every(permission => optionalProviderOrigins.includes(permission)),
    'Safari optional_permissions 必须与免费服务目录的精确域集合一致，不能缺少、重复或扩大授权范围');
    assert(manifest.content_scripts?.length > 0, 'Safari 产物缺少网页内容脚本');
    assert(manifest.browser_action?.default_popup, 'Safari 产物缺少扩展菜单入口');
    return manifest;
}

async function artifactPath(directory, relative) {
    assert(typeof relative === 'string' && relative.split('/').every(segment =>
        /^[A-Za-z0-9_.-]+$/u.test(segment) && segment !== '.' && segment !== '..'),
    `产物引用必须是包内相对路径：${relative}`);
    const absolute = path.resolve(directory, relative);
    assert(absolute.startsWith(`${directory}${path.sep}`), `产物引用越界：${relative}`);
    let cursor = directory;
    const segments = relative.split('/');
    for (const [index, segment] of segments.entries()) {
        cursor = path.join(cursor, segment);
        const info = await lstat(cursor);
        assert(index === segments.length - 1 ? info.isFile() : info.isDirectory(), `产物引用不能包含符号链接或特殊文件：${relative}`);
    }
    return absolute;
}

async function hashBuild(directory) {
    const hash = createHash('sha256');
    let artifactCount = 0;
    const visit = async (relative = '') => {
        const entries = await readdir(path.join(directory, relative), {withFileTypes: true});
        entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
        for (const entry of entries) {
            const file = path.posix.join(relative, entry.name);
            if (entry.isDirectory()) await visit(file);
            else {
                assert(entry.isFile(), `Safari 产物不能包含符号链接或特殊文件：${file}`);
                const bytes = await readFile(path.join(directory, file));
                hash.update(`${file}\0${bytes.length}\0`);
                hash.update(bytes);
                artifactCount++;
            }
        }
    };
    await visit();
    return {buildSha256: hash.digest('hex'), artifactCount};
}

export async function verifySafariBuild(directory) {
    const absolute = path.resolve(directory);
    const manifestBytes = await readFile(path.join(absolute, 'manifest.json'));
    const manifest = verifySafariManifest(JSON.parse(manifestBytes));
    const pageBytes = await readFile(await artifactPath(absolute, manifest.background.page));
    const utf8 = new TextDecoder('utf-8', {fatal: true});
    const page = utf8.decode(pageBytes);
    assert(page.includes('<meta charset="utf-8">'), 'Safari 后台页必须显式声明 UTF-8 编码');
    // 与 WXT 生成页保持封闭契约，拒绝内联脚本、base、远程/重复脚本和改变编码的额外节点。
    assert(/^<!doctype html>\s*<html>\s*<head>\s*<meta charset="utf-8">\s*<\/head>\s*<body>\s*<script src="\.\/background\.js"><\/script>\s*<\/body>\s*<\/html>\s*$/u.test(page),
        'Safari 后台页必须仅加载包内 ./background.js，不能包含额外脚本或节点');
    const scripts = ['background.js'];
    const references = [
        manifest.background.page,
        ...scripts,
        manifest.browser_action.default_popup,
        ...(manifest.options_ui?.page === undefined ? [] : [manifest.options_ui.page]),
        ...manifest.content_scripts.flatMap(entry => [...(entry.js ?? []), ...(entry.css ?? [])]),
    ];
    for (const file of references) await readFile(await artifactPath(absolute, file));
    const background = utf8.decode(await readFile(await artifactPath(absolute, scripts[0])));
    assert(background.includes('__FLUENTREAD_BROWSER_CAPABILITY_BUILD__:safari:mv2__'), '后台缺少 Safari/MV2 能力标记，请勿复制 Chrome 或 Firefox 产物');
    assert(!existsSync(path.join(absolute, 'offscreen.html')), 'Safari 产物不能包含 Chromium/Firefox 专用 Offscreen 页面');
    return {
        extension: absolute,
        version: manifest.version,
        manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
        checkedReferences: references.length,
        ...await hashBuild(absolute),
    };
}

/** 使用 xcrun 查找新旧工具名，兼容仍只提供 converter 的 Xcode。 */
export function findPackager(run = spawnSync, env = process.env) {
    for (const name of toolNames) {
        const result = run('xcrun', ['--find', name], {encoding: 'utf8', env});
        if (result.status === 0 && result.stdout?.trim()) return {name, executable: result.stdout.trim()};
    }
    throw new Error('未找到 Safari packager/converter。请安装完整 Xcode 并设置 DEVELOPER_DIR，Command Line Tools 单独安装不含此工具。');
}

export function packagingArguments({extension, projectLocation, bundleId, platform}) {
    assert(typeof bundleId === 'string' && bundleIdentifierPattern.test(bundleId), '请用 --bundle-id 指定维护者自己的反向域名标识，例如 org.example.FluentRead');
    assert(['both', 'ios', 'macos'].includes(platform), '--platform 只能为 both、ios 或 macos');
    return [extension, '--project-location', projectLocation, '--app-name', 'FluentRead',
        '--bundle-identifier', bundleId, '--swift', '--copy-resources', '--no-open', '--no-prompt',
        ...(platform === 'both' ? [] : [`--${platform}-only`])];
}

/** realpath 在大小写不敏感卷上仍可能保留输入拼写；按 dev/ino 比较真实祖先，避免全局折叠大小写。 */
function hasAncestorIdentity(directory, identity) {
    for (let cursor = directory;; cursor = path.dirname(cursor)) {
        const info = statSync(cursor, {bigint: true});
        if (info.dev === identity.dev && info.ino === identity.ino) return true;
        if (path.dirname(cursor) === cursor) return false;
    }
}

/** 创建任何目录或调用 Apple 复制前，按真实路径及对象身份拒绝双向嵌套，保证输入产物树保持只读。 */
export function validatePackagingDirectories(extension, projectLocation) {
    const source = realpathSync(path.resolve(extension));
    const requestedTarget = path.resolve(projectLocation);
    let ancestor = requestedTarget;
    const suffix = [];
    // 输出通常还不存在；先找真实祖先再补回后缀，不能把悬空链接或权限错误当成不存在。
    for (;;) {
        try {lstatSync(ancestor);}
        catch (error) {
            if (error?.code !== 'ENOENT') throw error;
            const parent = path.dirname(ancestor);
            assert(parent !== ancestor, '无法解析包装目录的已有祖先');
            suffix.unshift(path.basename(ancestor));
            ancestor = parent;
            continue;
        }
        break;
    }
    const canonicalAncestor = realpathSync(ancestor);
    const ancestorInfo = statSync(canonicalAncestor, {bigint: true});
    if (suffix.length) assert(ancestorInfo.isDirectory(), '包装目录的已有祖先必须为目录');
    const target = path.join(canonicalAncestor, ...suffix);
    const sourcePrefix = source.endsWith(path.sep) ? source : `${source}${path.sep}`;
    const targetPrefix = target.endsWith(path.sep) ? target : `${target}${path.sep}`;
    // 尚不存在的目标不能成为已有源的祖先；不能把两者共同的已有父目录误判为输出包含源。
    const sourceContainsTarget = hasAncestorIdentity(canonicalAncestor, statSync(source, {bigint: true}));
    const targetContainsSource = suffix.length === 0 && hasAncestorIdentity(source, ancestorInfo);
    assert(source !== target && !source.startsWith(targetPrefix) && !target.startsWith(sourcePrefix)
        && !sourceContainsTarget && !targetContainsSource,
        '源产物目录与包装目录不能相同或互相包含');
    assert(!existsSync(requestedTarget), `目标已存在，请保留现有工程并指定新的 --project-location：${requestedTarget}`);
}

/** Apple 默认模板仍允许 iOS 15/macOS 10.14；使 App 安装范围与 Safari 26 能力门槛一致。 */
export function applyDeploymentTargets(project, platform) {
    const seen = new Set();
    const minimums = {IPHONEOS_DEPLOYMENT_TARGET: 26, MACOSX_DEPLOYMENT_TARGET: 14};
    const updated = project.replace(/\b(IPHONEOS_DEPLOYMENT_TARGET|MACOSX_DEPLOYMENT_TARGET) = ([0-9.]+);/gu, (line, key, version) => {
        seen.add(key);
        return Number(version.split('.')[0]) < minimums[key] ? `${key} = ${minimums[key]}.0;` : line;
    });
    if (platform !== 'macos') assert(seen.has('IPHONEOS_DEPLOYMENT_TARGET'), 'Apple 工程缺少 iOS deployment target，请检查模板变化');
    if (platform !== 'ios') assert(seen.has('MACOSX_DEPLOYMENT_TARGET'), 'Apple 工程缺少 macOS deployment target，请检查模板变化');
    return updated;
}

/** 只识别 Apple 生成的多行对象格式；未知布局停止，不把注释或名称当作 target 关联。 */
function projectObjects(project, section) {
    const begin = `/* Begin ${section} section */`, end = `/* End ${section} section */`;
    assert(project.split(begin).length === 2 && project.split(end).length === 2, `Apple 工程 ${section} section 缺失或重复`);
    const start = project.indexOf(begin) + begin.length, stop = project.indexOf(end);
    assert(stop > start, `Apple 工程 ${section} section 顺序错误`);
    const contents = project.slice(start, stop), objects = new Map();
    const pattern = /^\t\t([A-F0-9]{24}) \/\* [^\n]* \*\/ = \{\n([\s\S]*?)^\t\t\};$/gmu;
    let cursor = 0;
    for (const match of contents.matchAll(pattern)) {
        assert(!contents.slice(cursor, match.index).trim() && !objects.has(match[1]), `Apple 工程 ${section} 对象布局或 ID 重复`);
        const bodyStart = start + match.index + match[0].indexOf('\n') + 1;
        const object = {id: match[1], body: match[2], bodyStart};
        assert(projectProperty(object, 'isa') === section, `Apple 工程 ${section} 对象类型不符`);
        assert([...project.matchAll(new RegExp(`^\\t\\t${object.id} /\\* [^\\n]* \\*/ = \\{`, 'gmu'))].length === 1,
            'Apple 工程对象 ID 重复');
        objects.set(object.id, object);
        cursor = match.index + match[0].length;
    }
    assert(objects.size > 0 && !contents.slice(cursor).trim(), `Apple 工程 ${section} 对象布局已变化`);
    return objects;
}

function projectProperty(object, key) {
    const matches = [...object.body.matchAll(new RegExp(`^\\t\\t\\t${key} = ([^;\\n]+);$`, 'gmu'))];
    assert(matches.length === 1, `Apple 工程 ${object.id} 的 ${key} 缺失或重复`);
    const raw = matches[0][1];
    return /^"[^"\\]*"$/u.test(raw) ? raw.slice(1, -1) : raw;
}

function projectReference(object, key) {
    const value = projectProperty(object, key);
    assert(/^[A-F0-9]{24}(?: \/\* [^\n]* \*\/)?$/u.test(value), `Apple 工程 ${key} 引用格式已变化`);
    return value.slice(0, 24);
}

function projectReferences(object, key) {
    const matches = [...object.body.matchAll(new RegExp(`^\\t\\t\\t${key} = \\(\\n([\\s\\S]*?)^\\t\\t\\t\\);$`, 'gmu'))];
    assert(matches.length === 1, `Apple 工程 ${key} 列表缺失或重复`);
    const references = matches[0][1].trimEnd().split('\n').map(line => {
        assert(/^\t{4}[A-F0-9]{24} \/\* [^\n]* \*\/,$/u.test(line), `Apple 工程 ${key} 列表布局已变化`);
        return line.slice(4, 28);
    });
    assert(new Set(references).size === references.length, `Apple 工程 ${key} 引用重复`);
    return references;
}

/** 按 productType → 配置列表 → 配置读取身份；同时拒绝共享配置、额外 target 和身份覆盖。 */
function safariTargetConfigurations(project, platform) {
    assert(['both', 'ios', 'macos'].includes(platform), '未知 Apple 模板平台');
    const targets = projectObjects(project, 'PBXNativeTarget'), projects = projectObjects(project, 'PBXProject');
    const lists = projectObjects(project, 'XCConfigurationList'), configs = projectObjects(project, 'XCBuildConfiguration');
    assert(projects.size === 1, 'Apple 工程必须只有一个 PBXProject');
    const owner = [...projects.values()][0], linkedTargets = projectReferences(owner, 'targets');
    assert(linkedTargets.length === targets.size && linkedTargets.every(id => targets.has(id)), 'Apple 工程 target 关联不完整');
    const usedLists = new Set(), usedConfigs = new Set();
    const readConfigurations = object => {
        const listId = projectReference(object, 'buildConfigurationList'), list = lists.get(listId);
        assert(list && !usedLists.has(listId), 'Apple 工程配置列表缺失或被多个对象共享');
        usedLists.add(listId);
        const ids = projectReferences(list, 'buildConfigurations');
        const result = ids.map(id => {
            const config = configs.get(id);
            assert(config && !usedConfigs.has(id), 'Apple 工程构建配置缺失或被多个对象共享');
            usedConfigs.add(id);
            assert(!/\bbaseConfigurationReference\s*=/u.test(config.body), 'Apple 模板不能通过外部配置覆盖身份');
            const settings = [...config.body.matchAll(/^\t{3}buildSettings = \{\n([\s\S]*?)^\t{3}\};$/gmu)];
            assert(settings.length === 1, 'Apple 工程 buildSettings 布局已变化');
            return {...config, name: projectProperty(config, 'name'), settings: settings[0][1],
                settingsStart: config.bodyStart + settings[0].index + settings[0][0].indexOf('\n') + 1};
        });
        assert(result.length === 2 && new Set(result.map(config => config.name)).size === 2
            && result.every(config => ['Debug', 'Release'].includes(config.name)), 'Apple 模板必须包含唯一 Debug/Release 配置');
        return {listId, configurations: result};
    };
    const projectConfigs = readConfigurations(owner).configurations;
    const setting = (config, key, required = true) => {
        const matches = [...config.settings.matchAll(new RegExp(`^\\t{4}${key} = ([^;\\n]+);$`, 'gmu'))];
        assert(matches.length === 1 || (!required && matches.length === 0), `Apple 配置 ${config.id} 的 ${key} 缺失或重复`);
        return matches[0];
    };
    const expectedSDKs = platform === 'both' ? ['iphoneos', 'macosx'] : [platform === 'ios' ? 'iphoneos' : 'macosx'];
    const targetKinds = new Set();
    const result = [...targets.values()].map(target => {
        const productType = projectProperty(target, 'productType');
        assert(['com.apple.product-type.application', 'com.apple.product-type.app-extension'].includes(productType), 'Apple 模板包含不认识的 target 类型');
        const {listId, configurations} = readConfigurations(target);
        const values = configurations.map(config => {
            assert(!/\bPRODUCT_BUNDLE_IDENTIFIER\s*\[|\bINFOPLIST_KEY_CFBundleIdentifier\b/u.test(config.settings), 'Apple 模板包含条件或 Info.plist 身份覆盖');
            const match = setting(config, 'PRODUCT_BUNDLE_IDENTIFIER');
            const bundleId = match[1].replace(/^"([^"\\]*)"$/u, '$1');
            assert(bundleIdentifierPattern.test(bundleId), 'Apple 模板 bundle identifier 不是确定的字面值');
            const inherited = projectConfigs.find(item => item.name === config.name);
            const sdk = (setting(config, 'SDKROOT', false) ?? setting(inherited, 'SDKROOT'))[1];
            assert(expectedSDKs.includes(sdk), 'Apple target SDK 与请求的平台不符');
            return {id: config.id, name: config.name, bundleId, sdk,
                start: config.settingsStart + match.index + match[0].indexOf(' = ') + 3, length: match[1].length};
        });
        assert(values[0].sdk === values[1].sdk, 'Apple target 的 Debug/Release 平台混淆');
        const kind = `${productType}:${values[0].sdk}`;
        assert(!targetKinds.has(kind), 'Apple 模板包含重复的 App/Extension 平台 target');
        targetKinds.add(kind);
        return {id: target.id, name: projectProperty(target, 'name'), productType, configurationListId: listId, configurations: values};
    });
    assert(result.length === expectedSDKs.length * 2 && usedLists.size === lists.size && usedConfigs.size === configs.size,
        'Apple 模板 App/Extension 或配置关联不完整');
    return result;
}

/** Apple 单平台工具可能保留默认 App ID；仅修改实际 native target 所属配置的值。 */
export function applySafariBundleIdentifiers(project, bundleId, platform) {
    assert(typeof bundleId === 'string' && bundleIdentifierPattern.test(bundleId), '无效的 Safari bundle-id');
    const edits = safariTargetConfigurations(project, platform).flatMap(target => target.configurations.map(config =>
        ({...config, value: `${bundleId}${target.productType === 'com.apple.product-type.app-extension' ? '.Extension' : ''}`})));
    for (const edit of edits.sort((left, right) => right.start - left.start)) {
        project = project.slice(0, edit.start) + edit.value + project.slice(edit.start + edit.length);
    }
    verifySafariBundleIdentifiers(project, bundleId, platform);
    return project;
}

/** 在所有工程写入完成后重新读取实际配置，报告中不能以命令参数代替真实身份。 */
export function verifySafariBundleIdentifiers(project, bundleId, platform) {
    assert(typeof bundleId === 'string' && bundleIdentifierPattern.test(bundleId), '无效的 Safari bundle-id');
    return safariTargetConfigurations(project, platform).map(target => ({...target, configurations: target.configurations.map(config => {
        const expected = `${bundleId}${target.productType === 'com.apple.product-type.app-extension' ? '.Extension' : ''}`;
        assert(config.bundleId === expected, `Apple target ${target.name}/${config.name} 实际 bundle identifier 与请求不符`);
        const {start, length, ...identity} = config;
        return identity;
    })}));
}

async function templatePath(directory, relative, kind = 'file') {
    let cursor = directory;
    for (const segment of relative.split('/')) {
        cursor = path.join(cursor, segment);
        const info = await lstat(cursor);
        assert(!info.isSymbolicLink(), `Apple 容器模板不能包含符号链接：${relative}`);
    }
    const info = await lstat(cursor);
    assert(kind === 'directory' ? info.isDirectory() : info.isFile(), `Apple 容器模板布局已变化：${relative}`);
    return cursor;
}

/** Apple 双平台使用 Shared 分组，单平台使用 App 名分组；严格按请求的平台识别，不静默回退。 */
export async function locateSafariTemplate(project, platform) {
    assert(['both', 'ios', 'macos'].includes(platform), '未知 Apple 模板平台');
    const directory = path.dirname(project);
    const name = path.basename(project, '.xcodeproj');
    const app = platform === 'both' ? 'Shared (App)' : name;
    const extension = platform === 'both' ? 'Shared (Extension)' : `${name} Extension`;
    await templatePath(directory, app, 'directory');
    const extensionResources = await templatePath(directory, `${extension}/Resources`, 'directory');
    const iosInfo = platform === 'macos' ? null : `${platform === 'both' ? 'iOS (App)' : app}/Info.plist`;
    const info = iosInfo ?? `${app}/Info.plist`;
    const plist = await readFile(await templatePath(directory, info), 'utf8');
    assert(plist.includes('<key>SFSafariWebExtensionConverterVersion</key>')
        && (platform === 'macos' ? !plist.includes('<key>UIApplicationSceneManifest</key>') : plist.includes('<key>UIApplicationSceneManifest</key>')),
    `Apple 容器模板与 ${platform} 平台不匹配`);
    if (platform === 'both') {
        const macPlist = await readFile(await templatePath(directory, 'macOS (App)/Info.plist'), 'utf8');
        assert(macPlist.includes('<key>SFSafariWebExtensionConverterVersion</key>') && !macPlist.includes('<key>UIApplicationSceneManifest</key>'), 'Apple macOS 容器模板平台不匹配');
    }
    return {directory, app, extensionResources, iosInfo, layout: platform === 'both' ? 'shared' : 'single-platform'};
}

/** iOS-only Apple 模板没有 Script.js；复用唯一 Style.css 的分组/资源锚点登记本地脚本，拒绝未知 pbxproj 布局。 */
export function addIOSGuideScriptReference(project) {
    const references = [...project.matchAll(/^([\t ]*)([A-F0-9]{24}) \/\* Style\.css \*\/ = \{isa = PBXFileReference; lastKnownFileType = text\.css; path = Style\.css; sourceTree = "<group>"; \};$/gmu)];
    assert(references.length === 1 && !project.includes('path = Script.js;'), 'Apple iOS-only Script.js 资源引用模板已变化');
    const styleRef = references[0][2];
    const builds = [...project.matchAll(new RegExp(`^([\\t ]*)([A-F0-9]{24}) /\\* Style\\.css in Resources \\*/ = \\{isa = PBXBuildFile; fileRef = ${styleRef} /\\* Style\\.css \\*/; \\};$`, 'gmu'))];
    assert(builds.length === 1, 'Apple iOS-only Style.css 构建引用模板已变化');
    const styleBuild = builds[0][2];
    const scriptRef = createHash('sha256').update(`FluentRead-guide-ref:${styleRef}`).digest('hex').slice(0, 24).toUpperCase();
    const scriptBuild = createHash('sha256').update(`FluentRead-guide-build:${styleBuild}`).digest('hex').slice(0, 24).toUpperCase();
    assert(!project.includes(scriptRef) && !project.includes(scriptBuild), 'Apple 工程资源 ID 冲突');
    const rules = [
        [references[0][0], line => line.replace(styleRef, scriptRef).replaceAll('Style.css', 'Script.js').replace('text.css', 'sourcecode.javascript')],
        [builds[0][0], line => line.replace(styleBuild, scriptBuild).replace(styleRef, scriptRef).replaceAll('Style.css', 'Script.js')],
    ];
    for (const [id, label, replacement] of [[styleRef, 'Style.css', scriptRef], [styleBuild, 'Style.css in Resources', scriptBuild]]) {
        const matches = [...project.matchAll(new RegExp(`^[\\t ]*${id} /\\* ${label.replaceAll('.', '\\.')} \\*/,?$`, 'gmu'))];
        assert(matches.length === 1, 'Apple iOS-only 分组/资源构建列表模板已变化');
        rules.push([matches[0][0], line => line.replace(id, replacement).replaceAll('Style.css', 'Script.js')]);
    }
    for (const [anchor, clone] of rules) project = project.replace(anchor, `${anchor}\n${clone(anchor)}`);
    return project;
}

/** 只覆盖新生成工程中已识别的 Apple 容器文件；所有预检通过后才复制。 */
export async function applyContainerGuide(project, bundleId, platform = 'both') {
    const {directory, app, iosInfo, layout} = await locateSafariTemplate(project, platform);
    const files = [
        ['ViewController.swift', `${app}/ViewController.swift`, 'class ViewController:'],
        ['Main.html', `${app}/Resources/Base.lproj/Main.html`, '<html'],
        ['Style.css', `${app}/Resources/Style.css`, ':root'],
        ['Script.js', `${app}/Resources/Script.js`, 'function show('],
    ];
    const replacements = [];
    for (const [source, relative, marker] of files) {
        const target = path.join(directory, relative);
        const targetInfo = await lstat(target).catch(error => {
            if (error.code === 'ENOENT') return null;
            throw error;
        });
        if (platform === 'ios' && source === 'Script.js' && targetInfo === null) {
            const projectRelative = `${path.basename(project)}/project.pbxproj`;
            const projectFile = await templatePath(directory, projectRelative);
            replacements.push({target: projectFile, relative: projectRelative,
                contents: addIOSGuideScriptReference(await readFile(projectFile, 'utf8'))});
        } else {
            await templatePath(directory, relative);
            assert((await readFile(target, 'utf8')).includes(marker), `Apple 容器模板布局已变化：${relative}`);
        }
        const contents = (await readFile(path.join(root, 'scripts/safari/container', source), 'utf8'))
            .replace('__FLUENTREAD_EXTENSION_BUNDLE_ID__', `${bundleId}.Extension`);
        replacements.push({target, contents, relative});
    }
    if (iosInfo) {
        const relative = iosInfo;
        const target = path.join(directory, relative);
        const plist = await readFile(target, 'utf8');
        assert(plist.includes('<key>SFSafariWebExtensionConverterVersion</key>') && plist.includes('<key>UIApplicationSceneManifest</key>')
            && !plist.includes('<key>FluentReadDevelopmentTeam</key>') && /<\/dict>\s*<\/plist>\s*$/u.test(plist), 'Apple iOS App Info.plist 模板布局已变化');
        const contents = plist.replace(/<\/dict>(\s*<\/plist>\s*)$/u, '\t<key>FluentReadDevelopmentTeam</key>\n\t<string>$(DEVELOPMENT_TEAM)</string>\n</dict>$1');
        replacements.push({target, contents, relative});
    }
    const hash = createHash('sha256');
    for (const {target, contents, relative} of replacements) {
        await writeFile(target, contents);
        hash.update(`${relative}\0${Buffer.byteLength(contents)}\0`);
        hash.update(contents);
    }
    return {sha256: hash.digest('hex'), files: replacements.map(file => file.relative), layout, locales: ['en', 'zh-Hans'], iosSettingsMinimum: '26.2',
        iosSettingsPolicy: 'physical device with actual DEVELOPMENT_TEAM only; Simulator and no-team builds use manual steps; physical-device API not accepted yet'};
}

function options(args) {
    const result = {extension: path.join(root, '.output/safari-mv2'), projectLocation: path.join(root, '.output/safari-xcode'), platform: 'both'};
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (['--check', '--verify', '--help'].includes(arg)) result[arg.slice(2)] = true;
        else {
            const key = {'--extension': 'extension', '--project-location': 'projectLocation', '--bundle-id': 'bundleId', '--platform': 'platform'}[arg];
            assert(key && args[index + 1] && !args[index + 1].startsWith('--'), `未知参数或缺少值：${arg}`);
            result[key] = args[++index];
        }
    }
    result.extension = path.resolve(result.extension);
    result.projectLocation = path.resolve(result.projectLocation);
    return result;
}

async function findProjects(directory) {
    const projects = [];
    for (const entry of await readdir(directory, {withFileTypes: true})) {
        if (!entry.isDirectory()) continue;
        const absolute = path.join(directory, entry.name);
        if (entry.name.endsWith('.xcodeproj')) projects.push(absolute);
        else projects.push(...await findProjects(absolute));
    }
    return projects;
}

async function main() {
    const config = options(process.argv.slice(2));
    if (config.help) {
        console.log('Safari 本地交付（不签名、不发布）\n  pnpm build:safari\n  pnpm safari:verify [--extension DIR]\n  pnpm safari:check\n  pnpm safari:package --bundle-id org.example.FluentRead [--platform both|macos|ios] [--project-location NEW_DIR]');
        return;
    }
    if (config.verify) {
        console.log(JSON.stringify(await verifySafariBuild(config.extension), null, 2));
        return;
    }
    assert(process.platform === 'darwin', '生成 Safari Xcode 包装需要安装 Xcode 的 macOS；产物清单可在其他系统用 safari:verify 检查');
    const packager = findPackager();
    if (config.check) {
        const xcode = spawnSync('xcrun', ['xcodebuild', '-version'], {encoding: 'utf8'});
        assert(xcode.status === 0, xcode.stderr || '无法读取 Xcode 版本');
        const sdks = Object.fromEntries(['macosx', 'iphoneos', 'iphonesimulator'].map(sdk => {
            const result = spawnSync('xcrun', ['--sdk', sdk, '--show-sdk-path'], {encoding: 'utf8'});
            return [sdk, {available: result.status === 0, path: result.status === 0 ? result.stdout.trim() : null}];
        }));
        console.log(JSON.stringify({packager, xcode: xcode.stdout.trim(), sdks,
            developerDir: process.env.DEVELOPER_DIR ?? null, deviceAcceptance: 'not-run'}, null, 2));
        return;
    }
    validatePackagingDirectories(config.extension, config.projectLocation);
    const build = await verifySafariBuild(config.extension);
    const args = packagingArguments(config);
    await mkdir(path.dirname(config.projectLocation), {recursive: true});
    const result = spawnSync(packager.executable, args, {stdio: 'inherit'});
    assert(result.status === 0, result.error?.message ?? 'Apple 打包工具未成功，保留部分输出以便检查；请使用新的目录重试');
    const projects = await findProjects(config.projectLocation);
    assert(projects.length > 0, 'Apple 工具未生成 Xcode 工程，请检查上方输出');
    const copiedExtensions = [];
    const containerGuides = [];
    const targetBundleIdentifiers = [];
    for (const project of projects) {
        const template = await locateSafariTemplate(project, config.platform);
        const copied = await verifySafariBuild(template.extensionResources);
        assert(copied.buildSha256 === build.buildSha256, 'Apple 包装内的资源与已校验的 Safari 构建不一致');
        copiedExtensions.push(copied.extension);
        const file = path.join(project, 'project.pbxproj');
        const deploymentProject = applyDeploymentTargets(await readFile(file, 'utf8'), config.platform);
        await writeFile(file, applySafariBundleIdentifiers(deploymentProject, config.bundleId, config.platform));
        containerGuides.push(await applyContainerGuide(project, config.bundleId, config.platform));
        targetBundleIdentifiers.push({project, targets: verifySafariBundleIdentifiers(await readFile(file, 'utf8'), config.bundleId, config.platform)});
    }
    const report = {...build, packager, projects, copiedExtensions, containerGuides, targetBundleIdentifiers, bundleId: config.bundleId, platform: config.platform,
        minimumOS: {ios: '26.0', macos: '14.0'}, minimumSafari: '26.0', signed: false, installed: false};
    await writeFile(path.join(config.projectLocation, 'fluentread-package-report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => {
        console.error(`[safari-package] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    });
}
