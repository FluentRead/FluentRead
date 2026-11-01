#!/usr/bin/env node
/**
 * 把 WXT 的 Safari 产物转换成 Xcode 容器工程。
 *
 * 转换前会复核并修正 manifest：Safari 不识别 use_dynamic_url，且要求 MV3 的
 * background 使用 service_worker。产物缺失时先提示执行 pnpm build:safari。
 */
import {execFileSync} from 'node:child_process';
import {cpSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const EXTENSION_DIR = path.join(ROOT, '.output', 'safari-mv3');
export const PROJECT_DIR = path.join(ROOT, 'safari');
export const APP_NAME = '流畅阅读';
export const BUNDLE_ID = process.env.FLUENTREAD_SAFARI_BUNDLE_ID || 'com.fluentread.safari';
export const EXTENSION_RESOURCES_DIR = path.join(PROJECT_DIR, APP_NAME, `${APP_NAME} Extension`, 'Resources');
export const XCODE_PROJECT_DIR = path.join(PROJECT_DIR, APP_NAME, `${APP_NAME}.xcodeproj`);

export function patchSafariManifest(manifestPath) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.manifest_version !== 3) {
        throw new Error(`Safari 16.4+ 需要 Manifest V3，当前产物为 MV${manifest.manifest_version}；请确认 wxt.config.ts 的 safari 目标。`);
    }
    let changed = false;
    for (const entry of manifest.web_accessible_resources || []) {
        if ('use_dynamic_url' in entry) {
            delete entry.use_dynamic_url;
            changed = true;
        }
    }
    // Safari 只接受 service_worker 或非持久 background page；WXT 已生成 service_worker，
    // 这里只拦住未来误改成 background.scripts 的回归。
    if (!manifest.background?.service_worker) {
        throw new Error('Safari 产物缺少 background.service_worker；MV3 后台必须以 service worker 运行。');
    }
    if (changed) writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
}

/**
 * 转换器会用应用名生成产物 Bundle ID；中文应用名会被转义成 `----`，
 * 导致内嵌扩展（Bundle ID 以 ASCII 前缀生成）不满足“必须以上级 App 前缀开头”的校验。
 * 这里把主 App 的 Bundle ID 固定回 --bundle-identifier 的值。
 */
export function patchXcodeProject(projectDir, bundleId) {
    const candidates = [
        path.join(projectDir, 'project.xcproj'),
        path.join(projectDir, 'project.pbxproj'),
    ];
    for (const file of candidates) {
        if (!existsSync(file)) continue;
        const source = readFileSync(file, 'utf8');
        // 只修正“整段都是连字符”的产物 ID，扩展目标（xxx.Extension）保持原样。
        const patched = source.replace(
            /(PRODUCT_BUNDLE_IDENTIFIER[^\n]*?)[\w.]*-{2,}/g,
            (_match, head) => `${head}${bundleId}`,
        );
        if (patched !== source) writeFileSync(file, patched);
    }
}

/**
 * 把最新的扩展产物同步到已有 Xcode 工程的 Resources。
 * 重复执行转换器会覆盖容器应用的定制界面，因此扩展代码变更走“同步”，不重建工程。
 */
export function syncExtensionResources() {
    if (!existsSync(path.join(EXTENSION_DIR, 'manifest.json'))) {
        throw new Error('未找到 .output/safari-mv3，请先运行 npm run build:safari');
    }
    if (!existsSync(EXTENSION_RESOURCES_DIR)) {
        throw new Error(`未找到 ${path.relative(ROOT, EXTENSION_RESOURCES_DIR)}，请先运行 npm run safari:convert`);
    }
    patchSafariManifest(path.join(EXTENSION_DIR, 'manifest.json'));
    cpSync(EXTENSION_DIR, EXTENSION_RESOURCES_DIR, {recursive: true, force: true});
    console.log(`[safari] 已同步扩展资源到 ${path.relative(ROOT, EXTENSION_RESOURCES_DIR)}`);
}

export function convert({force = true} = {}) {
    if (!existsSync(path.join(EXTENSION_DIR, 'manifest.json'))) {
        throw new Error('未找到 .output/safari-mv3，请先运行 npm run build:safari');
    }
    patchSafariManifest(path.join(EXTENSION_DIR, 'manifest.json'));
    const args = [
        'safari-web-extension-converter', EXTENSION_DIR,
        '--project-location', PROJECT_DIR,
        '--app-name', APP_NAME,
        '--bundle-identifier', BUNDLE_ID,
        '--swift', '--macos-only',
        '--copy-resources', '--no-open', '--no-prompt',
        ...(force ? ['--force'] : []),
    ];
    execFileSync('xcrun', args, {cwd: ROOT, stdio: 'inherit'});
    if (existsSync(XCODE_PROJECT_DIR)) patchXcodeProject(XCODE_PROJECT_DIR, BUNDLE_ID);
    console.log(`\nSafari 容器工程已生成：${path.relative(ROOT, PROJECT_DIR)}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    convert();
}
