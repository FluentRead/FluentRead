#!/usr/bin/env node
/**
 * 构建 Safari 容器应用：生成/复用 Xcode 工程 → xcodebuild → 复制 .app 到 build/dist。
 *
 * 本地无开发者证书时使用临时签名（CODE_SIGN_IDENTITY="-"）。Safari 仍要求
 * 在“开发”菜单打开“允许未签名的扩展”，详见 SAFARI.md。
 */
import {execFileSync} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, readdirSync, rmSync} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {convert, patchXcodeProject, syncExtensionResources, BUNDLE_ID, XCODE_PROJECT_DIR} from './convert.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OUT_DIR = path.join(ROOT, 'build', 'dist');
const DERIVED = path.join(ROOT, 'build', 'safari');

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
    for (const scheme of schemes) {
        console.log(`[safari] 构建 scheme: ${scheme}`);
        execFileSync('xcodebuild', [
            '-project', project,
            '-scheme', scheme,
            '-configuration', 'Release',
            '-derivedDataPath', DERIVED,
            'CODE_SIGN_IDENTITY=-',
            'CODE_SIGNING_REQUIRED=YES',
            'CODE_SIGNING_ALLOWED=YES',
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
        console.log(`[safari] 已生成 ${path.relative(ROOT, target)}`);
    }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
