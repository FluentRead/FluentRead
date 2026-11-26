import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const artifact = resolve(root, '.output/userscript-standalone/fluent-read.user.js');
const source = readFileSync(artifact, 'utf8');
const metadataEnd = source.indexOf('// ==/UserScript==');
if (metadataEnd < 0) throw new Error('Standalone userscript metadata is missing');
const metadata = source.slice(0, metadataEnd);
const {userscriptVersion} = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const {version: vueVersion} = JSON.parse(readFileSync(resolve(root, 'node_modules/vue/package.json'), 'utf8'));
const {version: elementPlusVersion} = JSON.parse(readFileSync(resolve(root, 'node_modules/element-plus/package.json'), 'utf8'));
const assertions = [
    [source.startsWith('// ==UserScript==\n'), 'Metadata must be the first bytes'],
    [metadata.includes(`// @version      ${userscriptVersion}`), 'Standalone version is stale'],
    [metadata.includes('// @inject-into  content'), 'GM APIs require content-world injection'],
    [metadata.includes('// @grant        GM.xmlHttpRequest'), 'Safari request grant is missing'],
    [metadata.includes('// @grant        GM_xmlhttpRequest'), 'Classic request grant is missing'],
    [metadata.includes('// @grant        GM.openInTab') && metadata.includes('// @grant        GM_openInTab'), 'Settings tab grants are missing'],
    [!/^\/\/ @require\s/gmu.test(metadata), 'Standalone installation must not need remote JavaScript'],
    [source.includes('fluentread-userscript-settings'), 'Full Options route is missing'],
    [!source.includes('fluent-read-writing-assistant'), 'Writing assistant runtime must be excluded'],
    [!source.includes('data-fr-slot'), 'Extension-only image context protocol must be excluded'],
    [!source.includes('imageLabelContext') && !source.includes('imageLabelSlots'), 'Extension-only image label metadata must be excluded'],
    [!source.includes('fr-selection-highlight') && !source.includes('fr-selection-underline'), 'Native PDF annotation controls must be excluded'],
    [!source.includes('hypothesis/build/'), 'Packaged Hypothesis client must be excluded'],
    [source.includes('__FLUENTREAD_BROWSER_CAPABILITY_BUILD__:userscript:mv2__'), 'Userscript browser capability marker is missing'],
    [source.includes('pako 2.1.0 —'), 'Bundled gzip fallback or license notice is missing'],
    [source.includes(`@vue/runtime-dom ${vueVersion} — MIT`), 'Bundled Vue or license notice is missing'],
    [source.includes(`element-plus ${elementPlusVersion} — MIT`), 'Bundled UI or license notice is missing'],
];
for (const [passed, message] of assertions) {
    if (!passed) throw new Error(message);
}
const bytes = Buffer.byteLength(source);
// Full Options adds its navigation, settings forms, and CSS to the direct-install build.
// This build is hosted outside Greasy Fork, whose separate rules cap scripts at 2 MB.
// Current main f9ca5ec6f builds to 3,685,253 bytes; provider-default migration adds 2,968 bytes.
// Raise this cap by the measured 3 kB and retain 1,779 bytes of headroom; Greasy Fork and compact-build limits stay unchanged.
// Current local-main locale corrections, with eight obsolete rows removed, add 3,742 bytes to
// the 1963a380f release candidate (3,688,936 → 3,692,678); use the existing headroom first.
// Add only the remaining rounded 3 kB for text; dependencies, model assets and compact-build limits stay unchanged.
// Integrating #1353 adds 751 bytes (3,692,678 → 3,693,429) with no new dependency or model asset.
// Use the existing 322-byte headroom, then add only the remaining rounded 1 kB.
// #1360's persistent rule editor and region guidance build to 3,698,213 bytes in CI.
// The existing cap is exceeded by 4,213 bytes; register only the rounded 5 kB for UI/text.
// Dependencies, model assets, metadata checks and the compact-build limits stay unchanged.
// #1362's WebDAV settings and shared Chinese text add 866 bytes on e31c81d89
// (3,693,429 → 3,694,295). Use the existing 571-byte headroom and add the remaining rounded 1 kB.
// Keep every protocol assertion, dependency and compact/Greasy Fork budget unchanged.
// #1356's media controls and feedback exceed the existing cap by less than 3 kB on abdbbcc88.
// Register only that rounded text/UI increment; dependencies, metadata checks and compact/Greasy Fork limits stay unchanged.
// JSON 合批与共享退避增加代码，按 1 kB 步长利用原余量后追加 4 kB。
// 合入最新 main（含 #1383/#1387/#1422/#1425/#1429/#1431）与 Calm Reading 统一令牌、批量缓存事务及紧凑批量协议后，
// 独立油猴脚本 CI 实测为 3,730,373 字节，无新增依赖或模型资源，Greasy Fork 与精简版上限不变，追加 26 kB。
// 合入 #1374/#1382/#1415 及 #1421 内联 br 拆分与通用双 br 分段后实测为 3,733,845 字节，无新增依赖或资源，追加 3 kB。
// 合入 #1416（可配置不翻译的标签与 CSS 选择器组件、核心跳过逻辑及七语界面文案）后实测为 3,742,643 字节，无新增依赖或资源，Greasy Fork 与精简版上限不变，追加 9 kB。
const maxBytes = 3_745_000;
if (bytes > maxBytes) throw new Error(`Standalone userscript grew past ${maxBytes.toLocaleString('en-US')} bytes: ${bytes}`);
console.log(`Verified ${artifact} (${bytes.toLocaleString()} bytes; no @require)`);
