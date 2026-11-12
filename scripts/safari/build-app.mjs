#!/usr/bin/env node
/**
 * 构建 Safari 容器应用：生成/复用 Xcode 工程 → xcodebuild → 复制 .app 到 build/dist。
 *
 * 本地无开发者证书时使用临时签名（CODE_SIGN_IDENTITY="-"）。Safari 仍要求
 * 在“开发”菜单打开“允许未签名的扩展”，详见 SAFARI.md。
 */
import {execFileSync} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {convert, patchXcodeProject, syncExtensionResources, BUNDLE_ID, XCODE_PROJECT_DIR} from './convert.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OUT_DIR = path.join(ROOT, 'build', 'dist');
const DERIVED = path.join(ROOT, 'build', 'safari');
const ICON_BUNDLE = path.join(ROOT, 'safari', '流畅阅读', '流畅阅读', 'AppIcon.icon');
const ASSET_CATALOG = path.join(ROOT, 'safari', '流畅阅读', '流畅阅读', 'Assets.xcassets');
const MACOS_DEPLOYMENT_TARGET = '12.0';

/**
 * 用 Icon Composer 的分层图标重新编译 Assets.car。
 * macOS 26 会按外观重绘 .appiconset 里的位图：深色外观下底色被系统底板替换，
 * 品牌粉变成黑色。只有 .icon（浅色/深色图层）能保证两种外观都用品牌底色，
 * 因此在拷贝产物后覆盖 Assets.car，并重新做临时签名。
 */
function applyLayeredIcon(appPath) {
    if (!existsSync(ICON_BUNDLE)) {
        console.warn(`[safari] 未找到 ${path.relative(ROOT, ICON_BUNDLE)}，跳过分层图标`);
        return;
    }
    const out = mkdtempSync(path.join(tmpdir(), 'fluentread-icon-'));
    try {
        execFileSync('xcrun', [
            'actool', ASSET_CATALOG, ICON_BUNDLE,
            '--compile', out,
            '--platform', 'macosx',
            '--minimum-deployment-target', MACOS_DEPLOYMENT_TARGET,
            '--app-icon', 'AppIcon',
            '--output-partial-info-plist', path.join(out, 'partial.plist'),
        ], {cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit']});
        const car = path.join(out, 'Assets.car');
        if (!existsSync(car)) throw new Error('actool 未生成 Assets.car，无法应用分层图标');
        cpSync(car, path.join(appPath, 'Contents', 'Resources', 'Assets.car'));
        // 同时替换旧式 .icns：部分系统界面（Dock、启动台缓存）会走 .icns 路径，
        // 两套表示保持一致，避免同一应用在不同界面显示不同图标。
        const icns = path.join(out, 'AppIcon.icns');
        if (existsSync(icns)) cpSync(icns, path.join(appPath, 'Contents', 'Resources', 'AppIcon.icns'));
    } finally {
        rmSync(out, {recursive: true, force: true});
    }
    resign(appPath);
    console.log('[safari] 已应用分层图标（浅色/深色）并重新签名');
}

/**
 * 选择签名身份。
 *
 * Safari 的「允许未签名的扩展」在退出浏览器时会被重置（Apple 官方文档明确说明），
 * 因此 ad-hoc 签名（`-`）只能用于临时调试。一旦本机存在开发者证书，就用它签名，
 * 扩展的启用状态才能跨重启保留。
 *
 * 优先读 FLUENTREAD_SIGN_IDENTITY，其次取钥匙串里第一个可用于代码签名的身份。
 */
function resolveSigningIdentity() {
    if (process.env.FLUENTREAD_SIGN_IDENTITY) return process.env.FLUENTREAD_SIGN_IDENTITY;
    try {
        const out = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {encoding: 'utf8'});
        const match = out.match(/"([^"]+)"/);
        if (match) return match[1];
    } catch {
        // 没有证书时按 ad-hoc 处理。
    }
    return '-';
}

/**
 * 重签应用。
 *
 * 内层先签、外层后签，且不使用 --deep：`--deep` 会把内嵌 appex 的授权
 * （app-sandbox 等）一并抹掉，导致 Safari 无法稳定保留扩展。
 */
function resign(appPath) {
    const identity = resolveSigningIdentity();
    if (identity !== '-') {
        const pluginDir = path.join(appPath, 'Contents', 'PlugIns');
        if (existsSync(pluginDir)) {
            for (const name of readdirSync(pluginDir).filter(entry => entry.endsWith('.appex'))) {
                execFileSync('codesign', [
                    '--force', '--sign', identity,
                    '--preserve-metadata=entitlements,flags',
                    '--timestamp=none',
                    path.join(pluginDir, name),
                ], {stdio: 'inherit'});
            }
        }
    }
    execFileSync('codesign', [
        '--force', '--sign', identity,
        '--preserve-metadata=entitlements,flags',
        '--timestamp=none',
        appPath,
    ], {stdio: 'inherit'});
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], {stdio: 'inherit'});
    console.log(identity === '-'
        ? '[safari] ad-hoc 签名：Safari 每次启动都需重新勾选「允许未签名的扩展」'
        : `[safari] 已用证书签名：${identity}`);
}

function findProject() {
    const safariDir = path.join(ROOT, 'safari');
    if (!existsSync(safariDir)) return undefined;
    const scan = (directory, depth) => {
        if (depth > 3) return undefined;
        for (const entry of readdirSync(directory, {withFileTypes: true})) {
            if (!entry.isDirectory()) continue;
            const full = path.join(directory, entry.name);
            if (entry.name.endsWith('.xcodeproj')) return full;
            const nested = scan(full, depth + 1);
            if (nested) return nested;
        }
        return undefined;
    };
    return scan(safariDir, 0);
}

function listSchemes(project) {
    const output = execFileSync('xcodebuild', ['-list', '-json', '-project', project], {encoding: 'utf8'});
    const parsed = JSON.parse(output);
    return parsed.project?.schemes ?? [];
}

function main() {
    let project = findProject();
    if (!project) {
        convert();
        project = findProject();
    } else {
        // 工程已存在时只刷新扩展资源，保留容器应用的 Swift/界面改动。
        syncExtensionResources();
        if (existsSync(XCODE_PROJECT_DIR)) patchXcodeProject(XCODE_PROJECT_DIR, BUNDLE_ID);
    }
    if (!project) throw new Error('未找到 Safari Xcode 工程，请先运行 pnpm safari:convert');
    const schemes = listSchemes(project);
    if (schemes.length === 0) throw new Error('Xcode 工程中没有可用的 scheme');
    mkdirSync(OUT_DIR, {recursive: true});
    // 有开发者团队时交给 Xcode 自动签名：沙盒应用需要配套的描述文件，
    // 手工 codesign 只能重签已有产物，无法生成 profile。
    const team = process.env.FLUENTREAD_DEVELOPMENT_TEAM;
    const signingArgs = team
        ? [
            'CODE_SIGN_STYLE=Automatic',
            `DEVELOPMENT_TEAM=${team}`,
            'CODE_SIGN_IDENTITY=Apple Development',
            '-allowProvisioningUpdates',
        ]
        : ['CODE_SIGN_IDENTITY=-', 'CODE_SIGNING_REQUIRED=YES', 'CODE_SIGNING_ALLOWED=YES'];
    for (const scheme of schemes) {
        console.log(`[safari] 构建 scheme: ${scheme}${team ? `（团队 ${team}）` : '（ad-hoc）'}`);
        execFileSync('xcodebuild', [
            '-project', project,
            '-scheme', scheme,
            '-configuration', 'Release',
            '-derivedDataPath', DERIVED,
            ...signingArgs,
            'build',
        ], {cwd: ROOT, stdio: 'inherit'});
    }
    const products = path.join(DERIVED, 'Build', 'Products', 'Release');
    const apps = readdirSync(products).filter(name => name.endsWith('.app'));
    if (apps.length === 0) throw new Error('构建完成但未找到 .app 产物');
    for (const app of apps) {
        const target = path.join(OUT_DIR, app);
        rmSync(target, {recursive: true, force: true});
        cpSync(path.join(products, app), target, {recursive: true});
        applyLayeredIcon(target);
        console.log(`[safari] 已生成 ${path.relative(ROOT, target)}`);
    }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
