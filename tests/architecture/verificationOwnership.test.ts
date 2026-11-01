import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {relative, resolve, sep} from 'node:path';
import ts from 'typescript';
import {Script} from 'node:vm';
import {execFileSync} from 'node:child_process';
import {describe, expect, it} from 'vitest';
import {auditVueOwners, isDeclarativeVue, sourceHash, type VueOwner} from '../helpers/vueVerificationOwnership';

const PROJECT_ROOT = resolve(__dirname, '../..');
const AUDITED_EXTENSIONS = /\.(?:cjs|css|html|js|mjs|ts|vue)$/u;
const PRODUCT_ROOTS = [
    'docs/.vitepress',
    'entrypoints',
    'examples',
    'scripts',
    'src',
    'styles',
    'userscript',
] as const;
const ROOT_FILES = [
    'vitest.config.ts',
    'vitest.coverage.config.ts',
    'vitest.cloud-backup.config.ts',
    'wxt.config.ts',
] as const;
const PRODUCT_TOOL_SCRIPTS = [
    'scripts/build-product-assets.cjs', 'scripts/capture-product-assets.cjs',
    'scripts/package-product-kit.cjs', 'scripts/verify-product-site.cjs', 'scripts/verify-support-ui.cjs',
];
const DOCS_TOOL_SCRIPTS = [
    'scripts/capture-docs-ui.cjs',
    'scripts/verify-brand-copy.mjs',
    'scripts/verify-docs-build.mjs',
    'scripts/verify-storybook-build.mjs',
];
// 评测/报告/传输由 translationQuality 专项验证；运行器与供应商入口另由显式在线评测记录源码哈希。
const QUALITY_TOOL_SCRIPTS = [
    'scripts/quality/audit.mjs', 'scripts/quality/evaluate.mjs', 'scripts/quality/provider-entry.ts',
    'scripts/quality/render.mjs', 'scripts/quality/report.mjs', 'scripts/quality/run.mjs', 'scripts/quality/transport.mjs',
];

type VerificationOwner =
    | 'brand-copy-functional'
    | 'chrome-firefox-build'
    | 'config-storage-functional'
    | 'document-browser-functional'
    | 'docs-build'
    | 'full-page-state-functional'
    | 'isolated-browser-regression'
    | 'strict-v8-coverage'
    | 'test-infrastructure-contract'
    | 'thunderbird-build'
    | 'safari-build'
    | 'userscript-build';

interface OwnedFile {
    path: string;
    owners: VerificationOwner[];
}

function projectPath(...parts: string[]): string {
    return resolve(PROJECT_ROOT, ...parts);
}

function relativePath(path: string): string {
    return relative(PROJECT_ROOT, path).split(sep).join('/');
}

function listFiles(directory: string): string[] {
    const root = projectPath(directory);
    const files: string[] = [];

    const visit = (current: string) => {
        for (const entry of readdirSync(current)) {
            const absolute = resolve(current, entry);
            if (statSync(absolute).isDirectory()) {
                visit(absolute);
            } else if (AUDITED_EXTENSIONS.test(entry) && !entry.endsWith('.d.ts')) {
                files.push(relativePath(absolute));
            }
        }
    };

    visit(root);
    return files;
}

function coverageSourcePaths(): Set<string> {
    const file = projectPath('vitest.coverage.config.ts');
    const sourceFile = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const declaration = sourceFile.statements.find(ts.isExportAssignment);
    if (!declaration || !ts.isCallExpression(declaration.expression)
        || !ts.isObjectLiteralExpression(declaration.expression.arguments[0])) {
        throw new Error('Strict coverage configuration must export defineConfig with an object');
    }
    const property = (object: ts.ObjectLiteralExpression, name: string): ts.Expression => {
        const entry = object.properties.find((node) => ts.isPropertyAssignment(node)
            && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === name);
        if (!entry || !ts.isPropertyAssignment(entry)) throw new Error(`Missing strict coverage property: ${name}`);
        return entry.initializer;
    };
    const test = property(declaration.expression.arguments[0], 'test');
    if (!ts.isObjectLiteralExpression(test)) throw new Error('Strict coverage test must be an object');
    const coverage = property(test, 'coverage');
    if (!ts.isObjectLiteralExpression(coverage)) throw new Error('Strict coverage settings must be an object');
    const include = property(coverage, 'include');
    if (!ts.isArrayLiteralExpression(include)) throw new Error('Strict coverage include must be a literal array');
    return new Set(include.elements.map((element) => {
        if (!ts.isStringLiteral(element)) throw new Error('Strict coverage source must be a literal path');
        return element.text;
    }).filter((path) => path.startsWith('src/') && /\.(?:ts|vue)$/u.test(path)));
}

function verificationOwners(path: string, strictCoverage: Set<string>): VerificationOwner[] {
    const owners = new Set<VerificationOwner>();

    // 步骤 1：迁移到 src 的业务模块优先由严格 V8 门禁验证行为。
    if (strictCoverage.has(path)) owners.add('strict-v8-coverage');

    // 步骤 2：WXT 入口、Vue 页面和共享样式必须同时经过 Chrome 与 Firefox 构建。
    if (path.startsWith('components/')
        || path.startsWith('entrypoints/')
        || path.startsWith('src/')
        || path.startsWith('styles/')
        || path === 'wxt.config.ts') {
        owners.add('chrome-firefox-build');
    }

    // 步骤 3：各自独立的发布出口和测试基础设施由对应流水线负责。
    if (path.startsWith('userscript/')) owners.add('userscript-build');
    if (path.startsWith('scripts/thunderbird/')) owners.add('thunderbird-build');
    if (path.startsWith('scripts/safari/')) owners.add('safari-build');
    if (path === 'src/services/config/store.ts') owners.add('config-storage-functional');
    if (path === 'src/features/document-translation/ui/pdfPreview.ts') owners.add('document-browser-functional');
    if (path === 'src/features/full-page-translation/content/state.ts') owners.add('full-page-state-functional');
    if (path.startsWith('docs/.vitepress/')) owners.add('docs-build');
    if (path === 'scripts/verify-docs-build.mjs' || path === 'scripts/verify-storybook-build.mjs') owners.add('docs-build');
    if (path === 'scripts/verify-brand-copy.mjs') owners.add('brand-copy-functional');
    if (path.startsWith('examples/')) owners.add('isolated-browser-regression');
    if (path.startsWith('scripts/run-') || path.startsWith('scripts/site-translation/')
        || path === 'scripts/quality/review-browser.cjs'
        || path === 'scripts/capture-docs-ui.cjs') {
        owners.add('isolated-browser-regression');
    }
    if (path.startsWith('scripts/testing/')
        // 发布脚本的真实归档和 gh 失败/恢复夹具由 processRegression 统一执行。
        || path.startsWith('scripts/release/')
        || path.startsWith('scripts/quality/')
        || path.startsWith('scripts/agent-bridge/')
        || path.startsWith('scripts/wasm/')
        || PRODUCT_TOOL_SCRIPTS.includes(path)
        || DOCS_TOOL_SCRIPTS.includes(path)
        || QUALITY_TOOL_SCRIPTS.includes(path)
        || path === 'scripts/generate-userscript-language-data.mjs'
        || path === 'scripts/build-userscript-standalone.mjs'
        || path === 'scripts/build-userscript-greasyfork.mjs'
        || path === 'scripts/verify-userscript-build.mjs'
        || path === 'scripts/verify-userscript-greasyfork-build.mjs'
        || path === 'scripts/verify-userscript-standalone-build.mjs'
        || path === 'scripts/export-site-rule-pack.mjs'
        || path === 'scripts/update-readme-contributors.mjs'
        || path.startsWith('vitest.')) {
        owners.add('test-infrastructure-contract');
    }

    return [...owners].sort();
}

const classificationCompilerOptions = Object.freeze({module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext});
const classificationOptions = JSON.stringify([classificationCompilerOptions, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS, ts.ScriptKind.TS]);
type ModuleClassification = Readonly<{typeOnly: boolean; pureBarrel: boolean}>;
const moduleClassifications = new Map<string, {source: string; options: string; result: ModuleClassification}>();
function classifyModule(path: string): ModuleClassification {
    const source = readFileSync(projectPath(path), 'utf8');
    const cached = moduleClassifications.get(path);
    if (cached?.source === source && cached.options === classificationOptions) return cached.result;
    // 仍按实际输出判断纯声明；只缓存两个布尔结果，不共享可变 AST 或模块执行状态。
    const emitted = ts.transpileModule(source, {compilerOptions: classificationCompilerOptions}).outputText;
    const runtime = ts.createSourceFile(path + '.js', emitted, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const typeOnly = runtime.statements.every((statement) => ts.isEmptyStatement(statement)
        || (ts.isExportDeclaration(statement)
            && !statement.moduleSpecifier
            && !!statement.exportClause
            && ts.isNamedExports(statement.exportClause)
            && statement.exportClause.elements.length === 0));
    const original = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const pureBarrel = original.statements.length > 0
        && original.statements.every((statement) => ts.isExportDeclaration(statement));
    const result = Object.freeze({typeOnly, pureBarrel});
    moduleClassifications.set(path, {source, options: classificationOptions, result});
    return result;
}

function isTypeOnlyModule(path: string): boolean {
    if (path.endsWith('.d.ts')) return true;
    return path.endsWith('.ts') && classifyModule(path).typeOnly;
}

function isPureBarrel(path: string): boolean {
    return path.endsWith('.ts') && classifyModule(path).pureBarrel;
}

function isCoverageExemptSrcModule(path: string): boolean {
    return isTypeOnlyModule(path)
        || isPureBarrel(path)
        || BUILD_ONLY_SRC_ALLOWLIST.has(path);
}

const BUILD_ONLY_SRC_ALLOWLIST = new Set([
    // 后台同步 composition root 仅装配已有配置端口；协议和事务经严格覆盖，真实端口由隔离浏览器专项验证。
    'src/app/background/googleDriveSyncRuntime.ts',
    'src/app/background/webDavBackupRuntime.ts',
    // i18n 资源和 Vue 文案适配由纯资源测试、扩展双浏览器构建与隔离 UI 回归共同验证。
    'src/core/i18n/index.ts',
    'src/core/i18n/language.ts',
    'src/core/i18n/messages/en-US.ts',
    'src/core/i18n/messages/es-ES.ts',
    'src/core/i18n/messages/fr-FR.ts',
    'src/core/i18n/messages/ja-JP.ts',
    'src/core/i18n/messages/ko-KR.ts',
    'src/core/i18n/messages/ru-RU.ts',
    'src/core/i18n/messages/zh-CN.ts',
    'src/ui/i18n.ts',
    // WXT ShadowRootUi/Vue 挂载适配器绑定真实 DOM 与组件生命周期；由 shadowUi 单测和双浏览器构建验证。
    'src/platform/shadow-ui/vue.ts',
    // 内容脚本构建专用的纯远程配置端口，只调用严格覆盖的 createRemoteConfigStorage；替换规则由 manifest/构建契约测试验证。
    'src/platform/storage/remoteConfigStorageRuntime.ts',
    // 翻译节点标记绑定页面 DOM 与通知 UI；交互由 indicators 功能测试验证，纯错误分类进入 strict coverage。
    'src/features/full-page-translation/ui/translationIndicators.ts',
    // popup composition root 等待配置就绪再注册 Vue/Element Plus 并挂载；由 popup 契约、逐帧启动回归和双浏览器构建验证。
    'src/app/popup/index.ts',
    // 抽屉入口只重导出 Element Plus 组件和 CSS；由 popup 启动/抽屉浏览器回归与双浏览器构建验证。
    'src/app/popup/PopupDrawer.ts',
    // Offscreen composition root 只注入真实 Audio/Blob/Chrome runtime 与 OCR 能力；协议、翻译和播放状态机均已严格覆盖。
    'src/app/offscreen/runtime.ts',
    // background composition root 只串联菜单、静态消息 registry 和缓存维护；由 handler 单测、入口契约与双浏览器构建验证。
    'src/app/background/runtime.ts',
    // 视频字幕菜单文案只绑定已拥有的播放器 DOM；由视频单测与双浏览器构建验证。
    'src/features/video-subtitle/content/ui.ts',
    // 后台消息 composition 只把 provider、feature handler 与 browser API 静态注入；各 handler/路由均已严格覆盖。
    'src/app/background/messageRuntime.ts',
    // Thunderbird 邮件显示 API 接线由定向测试和隔离 Thunderbird 邮件实测共同验证。
    'src/app/background/thunderbirdMessageRuntime.ts',
    // content composition root 绑定 WXT context、页面生命周期和静态 feature registry；由内容功能测试与隔离浏览器回归验证。
    'src/app/content/runtime.ts',
    // 邮件 frame 组合根绑定真实 WXT/DOM；纯同步器严格覆盖，注入和恢复由隔离浏览器验证。
    'src/app/content/qqMailFrameRuntime.ts',
    // 受限跨域正文 frame 的入口只组装可信消息、配置订阅、DOM 生命周期与翻译能力；URL/消息授权由严格覆盖的纯模块与后台 handler 验证。
    'src/app/content/embeddedFrameRuntime.ts',
    // 这是 WXT/provider/config 的静态组装根；行为由被注入模块的单测和双浏览器构建验证。
    'src/app/translation/runtime.ts',
    // 文档组合根只把 config/store 与 app translation client 注入严格覆盖的编排服务；由文档功能回归和双浏览器构建验证。
    'src/app/document-translation/runtime.ts',
    // 默认组装根只注入存储及可信上下文并显式启动应用；authority/client/history/纯策略严格覆盖，既有导入与集成行为由 config.test 验证。
    'src/services/config/store.ts',
    // 自动备份 store 绑定加密配置仓库 watch 与配置保存队列；纯状态机严格覆盖，集成读写和恢复由 configAutoBackupStore.test 验证。
    'src/services/config/autoBackupStore.ts',
    // WeakRef、MutationObserver、DOM lease 与 GC 时序属于浏览器生命周期状态机；由 translationState 功能测试和隔离浏览器回归验证。
    'src/features/full-page-translation/content/state.ts',
    // 全文翻译内容脚本 runtime 绑定页面 DOM、MutationObserver 与 WXT 翻译 glue；纯状态/布局/渲染已单独纳入 strict coverage。
    'src/features/full-page-translation/content/runtime.ts',
    // 视频字幕内容脚本 runtime 绑定 YouTube 播放器 DOM、浏览器消息与字幕下载流程；YouTube 数据逻辑已单独纳入 strict coverage。
    'src/features/video-subtitle/content/runtime.ts',
    // 平台字幕适配器绑定真实 DOM、TextTrack 与 Shadow DOM；专属生命周期单测及生产扩展浏览器夹具验证。
    'src/features/video-subtitle/content/platformRuntime.ts',
    // X 浏览器适配器接入 Fetch/AudioContext；URL、读取预算、取消策略和字幕解析由严格覆盖模块负责。
    'src/features/video-subtitle/content/hlsAudioRuntime.ts',
    // X 原生 TextTrack 与视频帧时钟的 DOM 映射由生产扩展同步夹具验证。
    'src/features/video-subtitle/content/xCaptionSource.ts',
    // PDF Canvas 预览绑定 PDF.js worker、真实 Canvas 像素采样与对象 URL；由隔离文档浏览器回归和双浏览器构建验证。
    'src/features/document-translation/ui/pdfPreview.ts',
    // 图片悬停 runtime 绑定页面 Image/Canvas/Shadow DOM；协议、OCR 与修复规则由 strict coverage 验证，跨域读取边界由安全契约验证。
    'src/features/image-translation/content/runtime.ts',
    // MAIN world adapter 只把 Element/History/Navigation 注入严格覆盖的 ShadowRoute bridge core。
    'src/platform/shadow-ui/pageBridge.ts',
    // Edge TTS 运行时绑定 Web Crypto、第三方网络协议与 AbortSignal；纯音色、SSML、分段和 token 时效策略已严格覆盖。
    'src/features/selection-translation/services/edgeTts.ts',
    // Provider 注册表是依赖注入组装；OpenAI 的共享边界、SDK 与 standalone 执行器已按真实离线合同进入严格覆盖。
    'src/providers/translation/registry.ts',
    'src/providers/translation/local-translation.ts',
    // 以下文件逐一绑定真实网络协议或浏览器 offscreen API；纯端点、错误和鉴权逻辑已拆出并纳入 strict coverage。
    // DeepLX 自身包含模式选择、有序故障转移、共享时限及响应校验，现通过外部传输端口测试进入严格覆盖，不再按仅组装模块豁免。
    'src/providers/translation/azure-openai.ts',
    'src/providers/translation/claude.ts',
    // 豆包按生效模型分流并直连方舟 Responses API；模型识别、语言映射与协议工具已拆出并纳入 strict coverage。
    'src/providers/translation/doubao.ts',
    'src/providers/translation/gemini.ts',
    'src/providers/translation/google.ts',
    'src/providers/translation/tongyi.ts',
    'src/providers/translation/zhipu.ts',
    // 本地翻译目录与真实 Cache Storage/Worker 生命周期保留专项归属；后台命令和 Offscreen 请求适配已进入严格覆盖。
    'src/features/local-translation/background/runtime.ts',
    'src/features/local-translation/offscreen/modelCache.ts',
    'src/features/local-translation/offscreen/translation.ts',
    'src/features/local-translation/offscreen/translation.worker.ts',
    'src/features/settings/ui/LocalTranslationModelSettings.vue',
    // 本地 TTS 的 Worker 与 Cache Storage 保留专项归属；生命周期 owner 和协议进入严格覆盖。
    'src/features/local-tts/background/runtime.ts',
    'src/features/local-tts/offscreen/modelCache.ts',
    'src/features/local-tts/offscreen/tts.worker.ts',
]);

describe('repository verification ownership', () => {
    it('质量评测工具入口可解析，核心行为专项已登记', () => {
        for (const path of listFiles('scripts/quality').filter(path => /\.(?:cjs|mjs)$/u.test(path))) {
            expect(() => execFileSync(process.execPath, ['--check', projectPath(path)], {stdio: 'pipe'})).not.toThrow();
        }
        const matrix = JSON.parse(readFileSync(projectPath('tests/test-matrix.json'), 'utf8')) as {groups: Record<string, string[]>};
        const registered = new Set(Object.values(matrix.groups).flat());
        for (const test of ['translationQualityEvaluation', 'translationQualityReport', 'translationQualityTransport']) {
            expect(registered.has(`tests/${test}.test.ts`)).toBe(true);
        }
    });

    it('按实际输出识别非 types 文件的纯声明，并保留运行时常量归属', () => {
        expect(isTypeOnlyModule('src/features/vocabulary/content/reencounterState.ts')).toBe(true);
        expect(isTypeOnlyModule('src/services/model-usage/types.ts')).toBe(false);
        expect(isTypeOnlyModule('src/services/translation-stats/types.ts')).toBe(false);
        expect(isTypeOnlyModule('src/app/content/learningFeatures.ts')).toBe(false);
    });

    it.each(PRODUCT_TOOL_SCRIPTS)('产品工具 %s 保持可解析的 CommonJS 入口', path => {
        expect(() => new Script(readFileSync(projectPath(path), 'utf8'), {filename: path})).not.toThrow();
    });
    it.each(DOCS_TOOL_SCRIPTS)('文档工具 %s 保持可解析的 Node 入口且不执行浏览器或校验流程', path => {
        expect(() => execFileSync(process.execPath, ['--check', projectPath(path)], {stdio: 'pipe'})).not.toThrow();
    });
    it('文档与品牌校验入口连接实际 npm 命令，截图工具遵循隔离后台浏览器契约', () => {
        const {scripts} = JSON.parse(readFileSync(projectPath('package.json'), 'utf8'));
        expect(scripts['docs:check']).toBe('node scripts/verify-docs-build.mjs');
        expect(scripts['verify:brand']).toBe('node scripts/verify-brand-copy.mjs');
        const captureSource = readFileSync(projectPath('scripts/capture-docs-ui.cjs'), 'utf8');
        expect(captureSource).toContain('helper.launchFocusSafePersistentContext');
        expect(captureSource).toContain('helper.newPageWithoutForeground');
        expect(captureSource).toContain('helper.activateExtensionTabWithoutForeground');
        expect(captureSource).toContain('background: true');
        expect(captureSource).toContain('headless: false');
        expect(captureSource).not.toContain('.bringToFront(');
        expect(captureSource).not.toContain('ctx.newPage(');
    });
    const strictCoverage = coverageSourcePaths();
    it('Vue 客户端编译白名单不冒充严格覆盖率边界', () => {
        expect(strictCoverage.has('src/features/area-translation/ui/AreaTranslator.vue')).toBe(false);
        expect(strictCoverage.has('src/core/harness/loop.ts')).toBe(true);
    });
    const auditedFiles = [
        ...PRODUCT_ROOTS.flatMap(listFiles),
        ...ROOT_FILES,
    ].sort();
    const ownership: OwnedFile[] = auditedFiles.map((path) => ({
        path,
        owners: verificationOwners(path, strictCoverage),
    }));

    it('每个产品、构建和测试基础设施文件都有明确验证归属', () => {
        const unowned = ownership.filter(({owners}) => owners.length === 0);
        expect(unowned).toEqual([]);
    });

    it('src 中每个未豁免的可执行模块都进入四维 100% 覆盖率边界', () => {
        const uncovered = auditedFiles.filter((path) => path.startsWith('src/')
            && path.endsWith('.ts')
            && !isCoverageExemptSrcModule(path)
            && !strictCoverage.has(path));

        expect(uncovered).toEqual([]);
    });

    it('Vue 业务组件具有真实消费者，展示例外保持无状态，历史债务不能随源码变化续期', () => {
        const registry = JSON.parse(readFileSync(projectPath('tests/architecture/vue-verification-owners.json'), 'utf8')) as {
            schemaVersion: number; baselineCommit: string; components: Record<string, VueOwner>;
        };
        expect(registry.schemaVersion).toBe(1);
        // 固定基线使新增组件/更新hash不能伪装成未修改的历史债务；迁出必须补真实行为证明。
        const baseline = 'e765165d0b707a6e9cd8f5bac2d5fbbcaff79dd3';
        expect(registry.baselineCommit).toBe(baseline);
        const baselineBlobs = Object.fromEntries(execFileSync('git', ['ls-tree', '-r', baseline, '--', 'src', 'userscript'], {
            cwd: PROJECT_ROOT, encoding: 'utf8',
        }).trim().split('\n').flatMap(line => {
            const match = line.match(/^\d+ blob ([a-f0-9]+)\t(.+\.vue)$/u);
            return match ? [[match[2], match[1]]] : [];
        }));
        const components = Object.fromEntries(auditedFiles.filter(path => /^(?:src|userscript)\//u.test(path) && path.endsWith('.vue'))
            .map(path => [path, readFileSync(projectPath(path), 'utf8')]));
        const tests = Object.fromEntries([...new Set(Object.values(registry.components)
            .flatMap(owner => owner.kind === 'behavior' ? owner.tests : []))]
            .filter(path => existsSync(projectPath(path))).map(path => [path, readFileSync(projectPath(path), 'utf8')]));
        const matrix = JSON.parse(readFileSync(projectPath('tests/test-matrix.json'), 'utf8')) as {groups: Record<string, string[]>};
        expect(auditVueOwners({components, records: registry.components, strictCoverage, tests,
            matrixTests: new Set(Object.values(matrix.groups).flat()), knownFiles: new Set(auditedFiles), baselineBlobs})).toEqual([]);
    });

    it('新增业务 Vue、被 mock 的 SFC 与只读源码断言不能借 build 归属通过', () => {
        const component = 'src/features/example/ui/Card.vue', test = 'tests/card.test.ts';
        const source = '<script setup>const value = ref(0)</script><template><button @click="value++">{{ value }}</button></template>';
        const input = {components: {[component]: source}, records: {} as Record<string, VueOwner>, strictCoverage: new Set<string>(),
            tests: {} as Record<string, string>, matrixTests: new Set([test]), knownFiles: new Set([component]), baselineBlobs: {}};
        expect(auditVueOwners(input)).toEqual([expect.stringContaining('build 不替代行为')]);
        input.records[component] = {kind: 'behavior', tests: [test], scenario: '实际按钮事件'};
        input.tests[test] = `it('source only',()=>expect(readFileSync('${component}','utf8')).toContain('button'));`;
        expect(auditVueOwners(input)).toEqual([expect.stringContaining('不是可追踪的实际组件消费者')]);
        input.tests[test] = `vi.mock('@/${component}',()=>({default:{}}));import Card from '@/${component}';
            it('mock only',()=>{const app=createApp(Card);expect(app).toBeDefined()});`;
        expect(auditVueOwners(input)).toEqual([expect.stringContaining('不是可追踪的实际组件消费者')]);
        input.tests[test] = `import Card from '@/${component}';it('actual component',()=>{const app=createApp(Card);expect(app).toBeDefined()});`;
        expect(auditVueOwners(input)).toEqual([]);
        input.tests[test] = `import Card from '@/${component}';it('actual component alias',()=>{const view=true?Card:{...Card,render:()=>null};const mounted=view;createApp(mounted);expect(mounted).toBeDefined()});`;
        expect(auditVueOwners(input)).toEqual([]);
        for (const declaration of ['let view=Card', 'const view={component:Card}', 'const view=makeFake(Card)']) {
            input.tests[test] = `import Card from '@/${component}';it('unproven alias',()=>{${declaration};createApp(view);expect(view).toBeDefined()});`;
            expect(auditVueOwners(input)).toEqual([expect.stringContaining('不是可追踪的实际组件消费者')]);
        }
        input.tests[test] = `import Card from '@/${component}';const view=Card;it('shadowed alias',(view)=>{createApp(view);expect(view).toBeDefined()});`;
        expect(auditVueOwners(input)).toEqual([expect.stringContaining('不是可追踪的实际组件消费者')]);
        input.tests[test] = `import Card from '@/${component}';it('mount removed',()=>expect(Card).toBeDefined());`;
        expect(auditVueOwners(input)).toEqual([expect.stringContaining('不是可追踪的实际组件消费者')]);
        input.tests[test] = `import Other from '@/src/ui/Other.vue';it('unrelated mount',()=>{createApp(Other);expect(Other).toBeDefined()});`;
        expect(auditVueOwners(input)).toEqual([expect.stringContaining('不是可追踪的实际组件消费者')]);
        input.tests[test] = `import Card from '@/${component}';import Other from '@/src/ui/Other.vue';
            it('source name plus unrelated mount',()=>{createApp(Other);expect(Card).toBeDefined()});`;
        expect(auditVueOwners(input)).toEqual([expect.stringContaining('不是可追踪的实际组件消费者')]);
    });

    it('展示形态审计拒绝脚本状态、模板方法与隐藏的模板副作用', () => {
        const path = 'src/ui/Card.vue';
        expect(isDeclarativeVue('<script setup>defineProps<{name:string}>()</script><template><p>{{name}}</p></template>', path)).toBe(true);
        expect(isDeclarativeVue('<script setup>const count=ref(0)</script><template><p>{{count}}</p></template>', path)).toBe(false);
        expect(isDeclarativeVue('<template><button @click="save()">Save</button></template>', path)).toBe(false);
        expect(isDeclarativeVue('<template><p>{{ fetch("/secret") }}</p></template>', path)).toBe(false);
        expect(isDeclarativeVue('<template><p :title="config.value = 1">Save</p></template>', path)).toBe(false);
        expect(isDeclarativeVue('<template><input v-model="config.value" /></template>', path)).toBe(false);
        expect(isDeclarativeVue('<template><div v-persist="config" /></template>', path)).toBe(false);
        expect(isDeclarativeVue('<script setup>import {save} from "@/src/services/config/store"</script><template><p>Save</p></template>', path)).toBe(false);
    });

    it('冻结债务不能通过刷新hash接纳修改文件或新增文件', () => {
        const path = 'src/ui/Legacy.vue', old = '<template><p>old</p></template>', next = '<template><p>changed</p></template>';
        const baselineBlobs: Record<string, string> = {[path]: execFileSync('git', ['hash-object', '--stdin'], {input: old, encoding: 'utf8'}).trim()};
        const input = {components: {[path]: old}, records: {[path]: {kind: 'frozen-debt', sourceSha256: sourceHash(old),
            reason: '缺少组件消费者的固定历史缺口', exitCriteria: '补真实组件事件测试后迁出'} as VueOwner}, strictCoverage: new Set<string>(),
            tests: {}, matrixTests: new Set<string>(), knownFiles: new Set([path]),
            baselineBlobs};
        expect(auditVueOwners(input)).toEqual([]);
        input.components[path] = next;
        expect(auditVueOwners(input)).toContainEqual(expect.stringContaining('历史 Vue 债务源码已变化'));
        input.records[path] = {...input.records[path], kind: 'frozen-debt', reason: '试图续期', exitCriteria: '补行为测试', sourceSha256: sourceHash(next)};
        expect(auditVueOwners(input)).toEqual([expect.stringContaining('不能重新冻结修改后的组件或新增组件')]);
        input.components[path] = old;input.records[path] = {...input.records[path], sourceSha256: sourceHash(old)};
        delete input.baselineBlobs[path];
        expect(auditVueOwners(input)).toEqual([expect.stringContaining('不能重新冻结修改后的组件或新增组件')]);
    });

    it('覆盖率清单只包含存在且未被豁免的可执行源码', () => {
        const audited = new Set(auditedFiles);
        const invalid = [...strictCoverage].filter((path) => !audited.has(path)
            || isCoverageExemptSrcModule(path));

        expect(invalid).toEqual([]);
    });

    it('验证归属覆盖所有审计文件且路径不重复', () => {
        const unique = new Set(ownership.map(({path}) => path));
        expect(unique.size).toBe(auditedFiles.length);
        expect(ownership.length).toBeGreaterThan(150);
    });
});
