#!/usr/bin/env node

/** 从已验证的 Firefox MV2 产物生成独立 Thunderbird MailExtension。 */
import {cp, mkdir, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import JSZip from 'jszip';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const thunderbirdId = '{a3fb7e32-c9a3-4211-90e0-197710bae017}';
const messageContentScript = 'content-scripts/content.js';

export function createThunderbirdManifest(firefox) {
    if (firefox.manifest_version !== 2 || !firefox.background?.scripts?.length) {
        throw new Error('Thunderbird 安装包需要 Firefox MV2 后台脚本产物');
    }
    if (!firefox.browser_specific_settings?.gecko?.id) {
        throw new Error('Firefox 产物缺少 Gecko 元数据');
    }
    const gecko = {...firefox.browser_specific_settings.gecko, id: thunderbirdId};
    // Firefox AMO 的数据收集分类不是 Thunderbird MailExtension manifest 字段。
    delete gecko.data_collection_permissions;
    const {content_scripts: _webContentScripts, ...shared} = firefox;
    return {
        ...shared,
        name: `${firefox.name} (Thunderbird)`,
        description: '在 Thunderbird 邮件正文中使用 FluentRead 双语翻译。',
        // 邮件工具栏沿用扩展名称，网页功能提示只用于浏览器。
        ...(firefox.browser_action && {browser_action: {...firefox.browser_action, default_title: firefox.name}}),
        // Thunderbird 只暴露 menus 权限；浏览器版的 contextMenus 声明会产生安装警告。
        // 邮件操作由 message_display_action 完成，无需请求菜单权限。
        permissions: [...new Set([...firefox.permissions.filter(permission => permission !== 'contextMenus'), 'messagesModify'])],
        browser_specific_settings: {gecko},
        message_display_action: {
            default_title: '翻译 / 恢复当前邮件',
            default_icon: {'16': 'icon/16.png', '32': 'icon/32.png'},
        },
    };
}

async function listFiles(directory, relative = '') {
    const files = [];
    for (const entry of await readdir(path.join(directory, relative), {withFileTypes: true})) {
        const next = path.posix.join(relative, entry.name);
        if (entry.isDirectory()) files.push(...await listFiles(directory, next));
        else if (entry.isFile()) files.push(next);
        else throw new Error(`不支持打包非普通文件: ${next}`);
    }
    return files.sort();
}

async function main() {
    const firefoxDir = path.join(root, '.output/firefox-mv2');
    const thunderbirdDir = path.join(root, '.output/thunderbird-mv2');
    const sourceManifest = JSON.parse(await readFile(path.join(firefoxDir, 'manifest.json'), 'utf8'));
    const manifest = createThunderbirdManifest(sourceManifest);
    await stat(path.join(firefoxDir, messageContentScript));

    await rm(thunderbirdDir, {recursive: true, force: true});
    await mkdir(path.dirname(thunderbirdDir), {recursive: true});
    await cp(firefoxDir, thunderbirdDir, {recursive: true});
    await writeFile(path.join(thunderbirdDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    const archivePath = path.join(root, `.output/fluent-read-${manifest.version}-thunderbird.xpi`);
    const archive = new JSZip();
    for (const file of await listFiles(thunderbirdDir)) {
        archive.file(file, await readFile(path.join(thunderbirdDir, file)));
    }
    await pipeline(
        archive.generateNodeStream({type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE'}),
        createWriteStream(archivePath),
    );
    console.log(JSON.stringify({directory: thunderbirdDir, archive: archivePath, version: manifest.version}));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(`[thunderbird-package] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    });
}
