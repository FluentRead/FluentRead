import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import vm from 'node:vm';

const root = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const artifactPath = path.join(root, '.output/userscript/fluent-read.user.js');
const source = fs.readFileSync(artifactPath, 'utf8');
const artifactBytes = Buffer.byteLength(source);
// 合入 PDF 与字幕更新并修正语言资源固定提交后，本轮 UI 产物实测 1,963,242 字节；
// 相对 main 的 1,960,000 字节预算增加 4 KB，继续校验协议、体积和运行边界。
// 智能高亮的共享偏好（快捷键、开关、配色与浓度的归一化）使脚本增至 1,964,630 字节；功能本身不进入脚本。
// 为保持与扩展的配置导入导出兼容，预算再放宽 1 KB。
// 时间展示过滤与动态来源交接增加 2,939 字节：同依赖下基线 e754aa680 为 1,964,913，修复后为 1,967,852。
// 预算仅增加 3 KB，保留体积守门；独立基线与构建记录见 docs/reports/time-changing-source-20261010/。
// 失败摘要、受限局部重试及对应文案增加 7,324 字节（0.3722%）：
// 同依赖独立基线 ce36085f7 为 1,967,852，候选为 1,975,176；预算增加 8 KB。
// 实测与重现步骤见 docs/reports/reading-reliability-experience-20261010/。
// Google 合批、共享请求节奏与 429 退避增加 2,536 字节（0.1284%）：
// 同依赖独立基线 f3f6016e8 为 1,975,252，候选为 1,977,788；预算增加 3 KB。
// 实测与重现步骤见 docs/reports/google-batching-backoff-20261010/。
// 原生数组完整校验、同预算逐段恢复、实体拒收与 AI 会话隔离另增加 6 KB 预算；
// 同依赖独立基线 36952b0fe 与增量证据见 docs/reports/native-batch-translation-20261010/。
// 原生合批独立开关及冻结策略增加 2,560 字节（0.1291%）：
// 同依赖基线 e4932521f 为 1,982,807，候选为 1,985,367；预算最小增加 1 KB。
// 增量与语言固定提交验证见 docs/reports/native-batch-setting-20261011/。
// 20 个译文样式预设（规则、注册表与中文名称）增加 8,193 字节（0.4127%）：
// 同依赖独立基线 fe7005dd9 为 1,985,255，候选为 1,993,448；预算增加 8 KB。
// 实测与截图见 docs/reports/translation-style-presets-20261010/。
// 区域分片、精确取消与动态选择协作在独立基线 fe7005dd9 上增加 5,222 字节（0.2630%）。
// 合入最新主线后复验体积，沿用主线预算；保留全部协议与执行边界校验。
// 原始对照与集成证据见 docs/reports/section-translation-quality-20261011/。
// 右键来源保护及通知交互的原始对照增加 3,443 字节（0.1734%）；原生菜单专属逻辑和文案按目标剔除。
// 合入新版主分支后沿用现有预算，不另行增加；原始对照与集成实测见 docs/reports/context-menu-experience-20261011/。
const MAX_USERSCRIPT_BYTES = 1_994_000;
const preludeStartMarker = '/* FluentRead userscript compatibility prelude:start */';
const preludeEndMarker = '/* FluentRead userscript compatibility prelude:end */';
const preludeStart = source.indexOf(preludeStartMarker);
const preludeEnd = source.indexOf(preludeEndMarker, preludeStart) + preludeEndMarker.length;
const bootstrapStart = source.indexOf('globalThis.__FLUENTREAD_ICON_DATA__=');
const guardStartMarker = '/* FluentRead userscript execution guard:start */';
const guardEndMarker = '/* FluentRead userscript execution guard:end */';
const guardStart = source.indexOf(guardStartMarker);
const guardCondition = source.indexOf('if (!globalThis.__fluentReadUserscriptBootstrapped) {', guardStart);
const guardEnd = source.indexOf(guardEndMarker, guardCondition);

const assertions = [
  [source.startsWith('// ==UserScript==\n'), 'metadata header must be the first bytes'],
  [source.includes(`// @version      ${packageJson.userscriptVersion}`), 'metadata must use userscriptVersion'],
  [source.includes(`FluentRead V${packageJson.version} · Userscript V${packageJson.userscriptVersion}`), 'settings must distinguish the FluentRead and userscript versions'],
  [source.includes('// @grant        GM_xmlhttpRequest'), 'GM_xmlhttpRequest grant is required'],
  [source.includes('// @grant        GM.getValue') && source.includes('// @grant        GM.setValue'), 'Safari GM storage grants are required'],
  [source.includes('// @grant        GM.xmlHttpRequest'), 'Safari GM request grant is required'],
  [source.includes('// @inject-into  content'), 'Safari GM APIs require content-world injection'],
  [source.includes('// @connect      *'), 'provider requests require @connect'],
  [source.includes('// @require      https://cdn.jsdelivr.net/npm/vue@3.5.13/dist/vue.global.prod.js'), 'pinned Vue @require is missing'],
  [source.includes('// @require      https://cdn.jsdelivr.net/gh/FluentRead/FluentRead@184a3d74f61b9d2a8d47080787f7e0180b98414d/userscript/vueElementPlusBridge.v1.js'), 'pinned Vue / Element Plus UMD bridge @require is missing'],
  [!source.includes('FluentRead/FluentRead@main/userscript/'), 'userscript resources must use an immutable commit'],
  [source.indexOf('vue.global.prod.js') < source.indexOf('vueElementPlusBridge.v1.js')
    && source.indexOf('vueElementPlusBridge.v1.js') < source.indexOf('element-plus@2.9.3/dist/index.full.min.js'), 'Vue bridge must load between Vue and Element Plus'],
  [source.includes('// @require      https://cdn.jsdelivr.net/npm/element-plus@2.9.3/dist/index.full.min.js'), 'pinned Element Plus @require is missing'],
  [source.includes('// @require      https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako_inflate.min.js'), 'pako fallback @require is missing'],
  [source.includes('globalThis.__fluentReadUserscriptCssCompressed='), 'userscript CSS must be compressed'],
  [source.includes('__FLUENTREAD_BROWSER_CAPABILITY_BUILD__:userscript:mv2__'), 'userscript browser capability marker is missing'],
  [artifactBytes <= MAX_USERSCRIPT_BYTES, `artifact exceeds the ${MAX_USERSCRIPT_BYTES.toLocaleString()}-byte size budget`],
  [!/(^|[^\w])import\s*\(/u.test(source), 'the artifact must not contain runtime dynamic imports'],
  [!/\bglobalThis\s*(?:\.\s*(?:browser|chrome)\b|\[\s*['"](?:browser|chrome)['"]\s*\])/u.test(source), 'privileged browser shims must stay lexical'],
  [source.split('// ==UserScript==').length === 2, 'metadata header must occur exactly once'],
  [preludeStart >= 0 && preludeEnd > preludeStart, 'compatibility prelude markers are missing'],
  [guardStart >= 0 && guardCondition > guardStart && preludeStart > guardCondition && guardEnd > bootstrapStart, 'complete runtime must be inside the duplicate-injection guard'],
  [source.split(guardStartMarker).length === 2 && source.split(guardEndMarker).length === 2, 'execution guard markers must occur exactly once'],
  [bootstrapStart > preludeEnd, 'compatibility prelude must run before the artifact bootstrap and IIFE'],
  [source.length > 10_000, 'artifact is unexpectedly small'],
  [!source.includes('fluent-read-area-translator-container'), 'area translator must be excluded from userscript'],
  [!source.includes('fluent-read-image-translation-root'), 'image translator must be excluded from userscript'],
  [!source.includes('fluent-read-video-subtitle-style'), 'video subtitle runtime must be excluded from userscript'],
  [!source.includes('onnx-community/Qwen3-0.6B-ONNX') && !source.includes('onnx-community/Qwen2.5-0.5B'), 'highlight model artifacts must be excluded from userscript while retaining preference compatibility'],
  [!source.includes('90ad34e62bb47572a06e0235696076976d59e9fcf5ab173d9a44689ba01b7d52') && !source.includes('8a04114ba59cc42b47d804d35d1d5c61d746ae4634f41f796768c6e302d39b9e'), 'highlight artifact manifests must be removed when only model preferences are used'],
  [!source.includes('fluent-read-writing-assistant'), 'writing assistant runtime must be excluded from userscript'],
  [!source.includes('fluent-read-vocabulary-reencounter'), 'vocabulary reencounter runtime must be excluded from userscript'],
  [!source.includes('fluent-read-sentence-actions'), 'sentence actions runtime must be excluded from userscript'],
  [!source.includes('fluent:prefill'), 'page-driven New API config bridge must be excluded from userscript'],
  [!source.includes('CHROME_TRANSLATE_OFFSCREEN'), 'Chrome offscreen translator must be excluded from userscript'],
  [!source.includes('FLUENT_READ_OFFSCREEN_READY'), 'extension Offscreen client must be excluded from userscript'],
  [!source.includes('fluent-read-background-dom-runtime'), 'Firefox background DOM host must be excluded from userscript'],
  [!source.includes('LOCAL_TRANSLATION_TRANSLATE'), 'local translation Offscreen transport must be excluded from userscript'],
];

const failure = assertions.find(([passed]) => !passed);
if (failure) throw new Error(`Userscript verification failed: ${failure[1]}`);

const context = vm.createContext({});
vm.runInContext(`
  globalThis.browser = {sentinel: 'page-browser'};
  globalThis.chrome = {sentinel: 'page-chrome'};
  delete Object.fromEntries;
  delete Promise.allSettled;
  delete Array.prototype.flatMap;
`, context);
vm.runInContext(source.slice(preludeStart, preludeEnd), context);

const runtimeAssertions = [
  [vm.runInContext(`JSON.stringify(Object.fromEntries([['first', 1], ['second', 2]]))`, context) === '{"first":1,"second":2}', 'Object.fromEntries polyfill failed'],
  [vm.runInContext(`JSON.stringify([1, , 3].flatMap(function (value, index) { return [value, index]; }))`, context) === '[1,0,3,2]', 'Array.prototype.flatMap polyfill failed'],
  [vm.runInContext(`Object.getOwnPropertyDescriptor(Object, 'fromEntries').enumerable === false`, context), 'Object.fromEntries polyfill must be non-enumerable'],
  [vm.runInContext(`Object.getOwnPropertyDescriptor(Promise, 'allSettled').enumerable === false`, context), 'Promise.allSettled polyfill must be non-enumerable'],
  [vm.runInContext(`Object.getOwnPropertyDescriptor(Array.prototype, 'flatMap').enumerable === false`, context), 'Array.prototype.flatMap polyfill must be non-enumerable'],
  [vm.runInContext(`globalThis.browser.sentinel === 'page-browser' && globalThis.chrome.sentinel === 'page-chrome'`, context), 'compatibility prelude must not replace page globals'],
];
const settled = await vm.runInContext(`
  Promise.allSettled([Promise.resolve('ok'), Promise.reject('failed')]).then(function (values) {
    return JSON.stringify(values);
  })
`, context);
runtimeAssertions.push([
  settled === '[{"status":"fulfilled","value":"ok"},{"status":"rejected","reason":"failed"}]',
  'Promise.allSettled polyfill failed',
]);

const runtimeFailure = runtimeAssertions.find(([passed]) => !passed);
if (runtimeFailure) throw new Error(`Userscript compatibility verification failed: ${runtimeFailure[1]}`);

console.log(`Verified ${path.relative(root, artifactPath)} (${artifactBytes.toLocaleString()} bytes)`);
