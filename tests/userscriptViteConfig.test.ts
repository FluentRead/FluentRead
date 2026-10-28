import ts from 'typescript';
import {createUserscriptSettingsDataPlugin} from '@/userscript/settingsDataPlugin';
import * as originalAppearance from '@/src/core/config/interfaceAppearance';
import {readFileSync, readdirSync, realpathSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {createHash, createHmac, createCipheriv} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {resolve} from 'node:path';
import {gunzipSync, gzipSync} from 'node:zlib';
import {runInNewContext} from 'node:vm';
import {describe, expect, it, vi} from 'vitest';
import {ungzip} from 'pako';
import {gzipLargeStandaloneUserscriptData, gzipUserscriptBuildData} from '@/userscript/buildGzip';
import {unpackLanguageUpdates, unpackUiLanguageBundle} from '@/userscript/languageData';
import {decodeUserscriptData} from '@/userscript/dataEncoding';
import {zhCNMessages, UI_LANGUAGE_BUNDLES, userscriptMessages, currentUserscriptLanguageBundle, createUserscriptLanguageUpdate} from '@/userscript/languageBundles';
import {zhCNMessages as extensionChinese} from '@/src/core/i18n/messages/zh-CN';
import {UI_LANGUAGE_BUNDLES as extensionBundles} from '@/src/core/i18n/bundles';
import {aiRequestTimeoutChineseMessages, aiRequestTimeoutMessages} from '@/src/core/i18n/messages/aiRequestTimeout';
import {learningMaterialLegacyText, learningMaterialPatterns} from '@/src/core/i18n/messages/learningMaterials';
import {installInformationHighlight} from '@/userscript/informationHighlight';
import {inflateWithPako} from '@/userscript/pakoRuntime';
import * as chineseCharacterData from '@/src/core/language/chineseVariants';
import * as functionWordData from '@/src/core/language/functionWordData';
import {createUserscriptCharacterDataCompressionPlugin} from '@/userscript/characterDataPlugin';
import {createUserscriptFrancDataCompressionPlugin} from '@/userscript/francDataPlugin';
import {createUserscriptTldtsDataCompressionPlugin} from '@/userscript/tldtsDataPlugin';
import {createUserscriptAboutImagesCompressionPlugin} from '@/userscript/aboutImagesPlugin';
import {createUserscriptServiceBrandIconsCompressionPlugin} from '@/userscript/serviceBrandIconsPlugin';
import originalServiceBrandPaths from '@/src/ui/assets/serviceBrandPaths.json';
import {getSupportImageUrl as getNormalSupportImageUrl, getContactImageUrl as getNormalContactImageUrl} from '@/src/app/options/aboutImages';
import ordinaryContactAsset from '@/src/app/options/assets/wechat-contact.jpg';
import {inflateWithPako as inflateBundledFrancData} from '@/userscript/pakoBundled';
import {inflateBytesWithPako as inflateBundledTldtsData, decodeUtf8WithPako as decodeBundledTldtsLabels} from '@/userscript/pakoBundled';
import {data as lockedFrancData} from 'franc-min/data.js';
import {createUserscriptInlineCssCompressionPlugin} from '@/userscript/inlineCssPlugin';
import {
    default as userscriptConfig,
    bundledLibraryNotices,
    executionGuardEnd,
    executionGuardStart,
    createUserscriptCatalogCompressionPlugin,
    gzipStandaloneUiMessages,
    createStandaloneOpenAITransportPlugin,
    findDexieGlobalRegistration,
    findFreeBrowserGlobals,
    injectUserscriptBrowserImports,
    userscriptAliases,
    wrapUserscriptEntry,
} from '@/userscript/vite.config';

const pakoGzip = createRequire(import.meta.url)('pako').gzip as
    (data: Uint8Array, options: {level: 9; memLevel: 8}) => Uint8Array;

function encodedDataBytes(source: string, decoder = 'decodeUserscriptData'): Uint8Array[] {
    const pattern = new RegExp(`\\b${decoder}\\(("[^"\\n]+")\\)`, 'gu');
    const values = [...source.matchAll(pattern)].map(match => JSON.parse(match[1]) as string);
    expect(values.length).toBeGreaterThan(0);
    return values.map(value => {
        expect(value).toMatch(/^~(?:85:[0-3]|91:)/u);
        return decodeUserscriptData(value);
    });
}

// Observe the existing production decoder inside real consumer builds, retaining its complete implementation.
function observeDataDecoder(): import('vite').Plugin {
    return {name: 'observe-userscript-data-decoder', enforce: 'pre', transform(code, id) {
        if (id !== resolve(process.cwd(), 'userscript/dataEncoding.ts')) return null;
        const declaration = 'export function decodeUserscriptData(value: string): Uint8Array {';
        expect(code.split(declaration)).toHaveLength(2);
        return code.replace(declaration, declaration + '\n globalThis.__observeUserscriptDataDecode(value);');
    }};
}

const entrypointId = resolve(process.cwd(), 'entrypoints/userscript-injection-fixture.ts');
const sourceModuleId = resolve(process.cwd(), 'src/app/content/runtime.ts');
const vueScriptModuleId = `${resolve(process.cwd(), 'src/features/selection-translation/ui/SelectionTranslator.vue')}?vue&type=script&setup=true&lang.ts`;

// 使用真实 Vite/CommonJS 与发布配置的同一选项，验证 require 时序而不是断言配置字面量。
async function bundledCommonjsOwner(entry: string, files: Record<string, string> = {}) {
    const fixture = mkdtempSync(resolve(tmpdir(), 'fluentread-commonjs-owner-'));
    try {
        const entryPath = resolve(fixture, 'entry.mjs');
        writeFileSync(entryPath, entry);
        for (const [relative, source] of Object.entries(files)) {
            const file = resolve(fixture, 'node_modules/initialization-owner', relative);
            mkdirSync(resolve(file, '..'), {recursive: true});
            writeFileSync(file, source);
        }
        const {build} = await import('vite');
        const configured = (userscriptConfig as import('vite').UserConfig).build!;
        const result = await build({root: process.cwd(), configFile: false, publicDir: false, logLevel: 'silent',
            build: {...configured, write: false, outDir: resolve(fixture, 'unused-output'),
                lib: {entry: entryPath, name: 'CommonjsOwnerFixture', formats: ['iife']},
                rollupOptions: {output: {inlineDynamicImports: true}}}});
        const outputs = Array.isArray(result) ? result : [result];
        if (outputs.length !== 1 || !('output' in outputs[0]) || outputs[0].output.length !== 1) {
            throw new Error('Expected exactly one private owner bundle');
        }
        const chunk = outputs[0].output[0];
        if (chunk.type !== 'chunk' || chunk.imports.length || chunk.dynamicImports.length) {
            throw new Error('Owner bundle must be complete and self contained');
        }
        return chunk.code;
    } finally {
        rmSync(fixture, {recursive: true, force: true});
    }
}

describe('userscript bundled CommonJS initialization', () => {
    it('runs a child at the first require after its parent starts and reuses the initialized exports', async () => {
        const code = await bundledCommonjsOwner(
            'import value from "./node_modules/initialization-owner/parent.cjs"; globalThis.commonjsOwnerResult = value;', {
                'parent.cjs': 'globalThis.commonjsOwnerEvents.push("parent-before"); const first=require("./child.cjs"); const second=require("./child.cjs"); globalThis.commonjsOwnerEvents.push("parent-after"); module.exports={first,second};',
                'child.cjs': 'globalThis.commonjsOwnerEvents.push("child"); module.exports={ready:true};',
            });
        const realm = {commonjsOwnerEvents: [] as string[], commonjsOwnerResult: undefined as unknown};
        runInNewContext(code, realm, {timeout: 5000});
        expect(Array.from(realm.commonjsOwnerEvents)).toEqual(['parent-before', 'child', 'parent-after']);
        const result = realm.commonjsOwnerResult as {first: {ready: boolean}; second: unknown};
        expect(result.first.ready).toBe(true);
        expect(result.second).toBe(result.first);
    });

    it('preserves partially initialized cyclic exports without loading either module twice', async () => {
        const code = await bundledCommonjsOwner(
            'import value from "./node_modules/initialization-owner/a.cjs"; globalThis.commonjsOwnerResult=value;', {
                'a.cjs': 'globalThis.commonjsOwnerEvents.push("a"); exports.phase="a-before"; exports.fromB=require("./b.cjs").observed; exports.phase="a-after";',
                'b.cjs': 'globalThis.commonjsOwnerEvents.push("b"); exports.observed=require("./a.cjs").phase;',
            });
        const realm = {commonjsOwnerEvents: [] as string[], commonjsOwnerResult: undefined as unknown};
        runInNewContext(code, realm, {timeout: 5000});
        expect(Array.from(realm.commonjsOwnerEvents)).toEqual(['a', 'b']);
        expect(realm.commonjsOwnerResult).toEqual({phase: 'a-after', fromB: 'a-before'});
    });

    it.each(['md5-first', 'aes-first'] as const)('keeps %s locked crypto, inflation and host-safe Dexie behavior in the actual bundle', async order => {
        const requirePackage = createRequire(resolve(process.cwd(), 'package.json'));
        const cryptoImports = {
            md5: 'crypto-js/md5', sha256: 'crypto-js/sha256', hmac: 'crypto-js/hmac-sha256',
            aes: 'crypto-js/aes', utf8: 'crypto-js/enc-utf8', base64: 'crypto-js/enc-base64',
            ecb: 'crypto-js/mode-ecb', pkcs7: 'crypto-js/pad-pkcs7',
        };
        const imports = Object.entries(cryptoImports);
        if (order === 'aes-first') imports.sort(([left], [right]) => left === 'aes' ? -1 : right === 'aes' ? 1 : 0);
        const source = imports.map(([name, file]) => `import ${name} from ${JSON.stringify(requirePackage.resolve(file))};`).join('\n')
            + `\nimport * as pako from ${JSON.stringify(resolve(process.cwd(), 'userscript/pakoBundled.ts'))};`
            + `\nimport Dexie from ${JSON.stringify(resolve(process.cwd(), 'userscript/dexie.ts'))};`
            + '\nglobalThis.commonjsOwnerResult={md5,sha256,hmac,aes,utf8,base64,ecb,pkcs7,pako,Dexie};';
        const code = await bundledCommonjsOwner(source);
        const sentinel = {version: 'synthetic-host-version'};
        const realm = {commonjsOwnerResult: undefined as any, [Symbol.for('Dexie')]: sentinel,
            Uint8Array, ArrayBuffer, setTimeout, clearTimeout, console};
        runInNewContext(code, realm, {timeout: 5000});
        const api = realm.commonjsOwnerResult;
        for (const text of ['', 'abc', '流畅阅读 🦦', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64)]) {
            expect(api.md5(text).toString()).toBe(createHash('md5').update(text).digest('hex'));
            expect(api.sha256(text).toString()).toBe(createHash('sha256').update(text).digest('hex'));
            expect(api.hmac(text, 'synthetic-key-中文').toString()).toBe(createHmac('sha256', 'synthetic-key-中文').update(text).digest('hex'));
            const cipher = createCipheriv('aes-128-ecb', Buffer.from('0123456789abcdef'), null);
            const expected = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString('base64');
            const encrypted = api.aes.encrypt(text, api.utf8.parse('0123456789abcdef'), {mode: api.ecb, padding: api.pkcs7});
            expect(encrypted.toString()).toBe(expected);
            expect(api.aes.decrypt(expected, api.utf8.parse('0123456789abcdef'), {mode: api.ecb, padding: api.pkcs7}).toString(api.utf8)).toBe(text);
            expect(api.base64.stringify(api.utf8.parse(text))).toBe(Buffer.from(text).toString('base64'));
        }
        // 固定 salt 使 AES 的密码短语路径实际经过 EvpKDF/MD5；预期密文由 Node 独立生成。
        const passphrase = 'synthetic-passphrase-中文', salt = Buffer.from('12345678');
        let previous: Buffer = Buffer.alloc(0), derived = Buffer.alloc(0);
        while (derived.length < 48) {
            previous = createHash('md5').update(previous).update(passphrase).update(salt).digest();
            derived = Buffer.concat([derived, previous]);
        }
        const passphraseText = '首次 require 保留 AES 与 MD5 的注册顺序 🦦';
        const cbc = createCipheriv('aes-256-cbc', derived.subarray(0, 32), derived.subarray(32, 48));
        const expectedPassphrase = Buffer.concat([Buffer.from('Salted__'), salt,
            cbc.update(passphraseText, 'utf8'), cbc.final()]).toString('base64');
        expect(api.aes.encrypt(passphraseText, passphrase, {salt: api.utf8.parse('12345678')}).toString()).toBe(expectedPassphrase);
        expect(api.aes.decrypt(expectedPassphrase, passphrase).toString(api.utf8)).toBe(passphraseText);
        const text = '完整保留 Unicode 与字节 🦦';
        const compressed = new Uint8Array(gzipSync(Buffer.from(text)));
        expect(api.pako.inflateWithPako(compressed)).toBe(text);
        const restored = api.pako.inflateBytesWithPako(compressed);
        expect(Array.from(restored)).toEqual(Array.from(Buffer.from(text)));
        expect(api.pako.decodeUtf8WithPako(restored)).toBe(text);
        expect(typeof api.Dexie).toBe('function');
        expect(realm[Symbol.for('Dexie')]).toBe(sentinel);
    });
});

describe('userscript build gzip portability', () => {
    it('keeps the compact UI message gzip if an isolated candidate is not smaller and propagates worker errors', async () => {
        const input = Buffer.from('流畅阅读 — café 🙂\n'.repeat(500));
        const baseline = gzipUserscriptBuildData(input, undefined, true);
        const larger = vi.fn(async () => Buffer.alloc(baseline.length + 1));
        const chosen = await gzipStandaloneUiMessages(input, larger);
        expect(chosen).toEqual(baseline);
        expect(gunzipSync(chosen)).toEqual(input);
        expect(larger).toHaveBeenCalledOnce();
        await expect(gzipStandaloneUiMessages(input, async () => {throw new Error('message worker failed');}))
            .rejects.toThrow('message worker failed');
    });
    it('compresses large standalone data reproducibly without changing the parent process error listeners', async () => {
        const input = Buffer.from('CSS 数据与离线目录🙂\0\n'.repeat(10_000));
        const before = Buffer.from(input);
        const uncaught = process.listeners('uncaughtException');
        const unhandled = process.listeners('unhandledRejection');
        const first = await gzipLargeStandaloneUserscriptData(input, process.cwd());
        const second = await gzipLargeStandaloneUserscriptData(new Uint8Array(input), process.cwd());
        expect(first).toEqual(second);
        expect(first.byteLength).toBeLessThanOrEqual(gzipUserscriptBuildData(input).byteLength);
        expect(gunzipSync(first)).toEqual(before);
        expect(input).toEqual(before);
        expect(process.listeners('uncaughtException')).toEqual(uncaught);
        expect(process.listeners('unhandledRejection')).toEqual(unhandled);
    });

    it('rejects worker startup, exit and invalid gzip while falling back for larger results', async () => {
        const root = mkdtempSync(resolve(tmpdir(), 'fluentread-zopfli-worker-'));
        const directory = resolve(root, 'userscript');
        const worker = resolve(directory, 'zopfliBuildWorker.cjs');
        const input = Buffer.from('compressible resource '.repeat(5_000));
        mkdirSync(directory);
        try {
            await expect(gzipLargeStandaloneUserscriptData(input, root)).rejects.toThrow();
            writeFileSync(worker, 'process.exit(0);');
            await expect(gzipLargeStandaloneUserscriptData(input, root)).rejects.toThrow('提前退出');
            writeFileSync(worker, 'throw new Error("controlled worker failure");');
            await expect(gzipLargeStandaloneUserscriptData(input, root)).rejects.toThrow('controlled worker failure');
            writeFileSync(worker, 'require("node:worker_threads").parentPort.postMessage("invalid");');
            await expect(gzipLargeStandaloneUserscriptData(input, root)).rejects.toThrow('返回了无效数据');
            writeFileSync(worker, 'require("node:worker_threads").parentPort.postMessage(Uint8Array.of(1,2,3));');
            await expect(gzipLargeStandaloneUserscriptData(input, root)).rejects.toThrow();
            const wrong = [...gzipSync(Buffer.from('not the original data'))];
            writeFileSync(worker, `require("node:worker_threads").parentPort.postMessage(Uint8Array.from(${JSON.stringify(wrong)}));`);
            await expect(gzipLargeStandaloneUserscriptData(input, root)).rejects.toThrow('构建压缩器校验失败');
            writeFileSync(worker, 'require("node:worker_threads").parentPort.postMessage(new Uint8Array(100000));');
            expect(await gzipLargeStandaloneUserscriptData(input, root)).toEqual(gzipUserscriptBuildData(input));
        } finally {rmSync(root, {recursive: true, force: true});}
    });

    it('uses the existing compressor for small data without accessing a worker', async () => {
        const input = Buffer.from('small offset view 😀');
        const missingRoot = resolve(tmpdir(), 'fluentread-no-such-worker');
        expect(await gzipLargeStandaloneUserscriptData(input, missingRoot)).toEqual(gzipUserscriptBuildData(input));
    });

    it('terminates a stalled compressor and fails the build after the time limit', async () => {
        const root = mkdtempSync(resolve(tmpdir(), 'fluentread-zopfli-timeout-'));
        const directory = resolve(root, 'userscript');
        mkdirSync(directory);
        writeFileSync(resolve(directory, 'zopfliBuildWorker.cjs'), 'setInterval(() => {}, 1000);');
        vi.useFakeTimers();
        try {
            const assertion = expect(gzipLargeStandaloneUserscriptData(Buffer.from('data '.repeat(20_000)), root))
                .rejects.toThrow('构建压缩器超时');
            await vi.advanceTimersByTimeAsync(60_000);
            await assertion;
        } finally {vi.useRealTimers();rmSync(root, {recursive: true, force: true});}
    });

    it('ignores a queued worker response after a timeout while termination is still pending', async () => {
        let instance!: EventEmitter;
        let finishTermination!: (code: number) => void;
        const terminate = vi.fn(() => new Promise<number>(resolve => {finishTermination = resolve;}));
        class DelayedWorker extends EventEmitter {
            constructor() {super(); instance = this;}
            terminate = terminate;
        }
        vi.useFakeTimers();
        vi.doMock('node:worker_threads', () => ({Worker: DelayedWorker}));
        vi.resetModules();
        try {
            const {gzipLargeStandaloneUserscriptData: compress} = await import('@/userscript/buildGzip');
            const assertion = expect(compress(Buffer.from('data '.repeat(20_000)), process.cwd()))
                .rejects.toThrow('构建压缩器超时');
            await vi.advanceTimersByTimeAsync(60_000);
            instance.emit('message', Uint8Array.of(1, 2, 3));
            expect(terminate).toHaveBeenCalledOnce();
            finishTermination(0);
            await assertion;
        } finally {vi.doUnmock('node:worker_threads');vi.useRealTimers();vi.resetModules();}
    });

    it('roundtrips every byte and an offset view through independent gzip and existing binary decoders', () => {
        const storage = Uint8Array.from({length: 4_098}, (_, index) => index % 256);
        const input = storage.subarray(1, storage.length - 1);
        const before = input.slice();
        const encoded = gzipUserscriptBuildData(input);
        expect(gunzipSync(encoded)).toEqual(Buffer.from(before));
        expect(inflateBundledTldtsData(encoded)).toEqual(before);
        expect(input).toEqual(before);
        expect(gunzipSync(gzipUserscriptBuildData(new Uint8Array()))).toEqual(Buffer.alloc(0));
    });

    it('keeps standalone gzip lossless, deterministic, and no larger than the selected normal encoding', () => {
        const input = Buffer.from('流畅阅读 — café e\u0301 🙂\0\n'.repeat(300));
        for (const level of [undefined, 8, 9] as const) {
            const standard = gzipUserscriptBuildData(input, level);
            const compact = gzipUserscriptBuildData(input, level, true);
            expect(compact.length).toBeLessThanOrEqual(standard.length);
            expect(gunzipSync(compact)).toEqual(input);
            expect(Buffer.from(ungzip(compact))).toEqual(input);
            expect(gzipUserscriptBuildData(input, level, true)).toEqual(compact);
        }
    });

    it('preserves complete UTF-8 strings including combining marks, supplementary code points and NUL', () => {
        const text = '流畅阅读 — café e\u0301 🙂\0\n'.repeat(32);
        const input = Buffer.from(text, 'utf8');
        const encoded = gzipUserscriptBuildData(input);
        expect(gunzipSync(encoded)).toEqual(input);
        expect(inflateBundledFrancData(encoded)).toBe(text);
    });

    it('repeats exact bytes across fresh input views and intervening unrelated encodes without mutating input', () => {
        const input = Buffer.from('中文 CSS/data repeatability 🙂\n'.repeat(96));
        const before = Buffer.from(input);
        const first = gzipUserscriptBuildData(input);
        for (let index = 0; index < 4; index++) {
            gzipUserscriptBuildData(Uint8Array.of(index, 255, 0));
            expect(gzipUserscriptBuildData(new Uint8Array(input))).toEqual(first);
        }
        expect(input).toEqual(before);
        expect(gunzipSync(first)).toEqual(before);
    });

    it('never enlarges actual static assets versus the former gzip default and saves bytes on an existing asset', () => {
        const inputs = [
            Buffer.from(JSON.stringify(zhCNMessages)),
            Buffer.from(JSON.stringify(UI_LANGUAGE_BUNDLES['en-US'])),
            ...['public/misc/approve.jpg', 'src/app/options/assets/wechat-contact.jpg'].map(file =>
                Buffer.from(`data:image/jpeg;base64,${readFileSync(resolve(process.cwd(), file)).toString('base64')}`)),
        ];
        let savedBytes = 0;
        for (const input of inputs) {
            const previous = pakoGzip(input, {level: 9, memLevel: 8});
            const encoded = gzipUserscriptBuildData(input);
            expect(encoded.byteLength).toBeLessThanOrEqual(previous.byteLength);
            expect(gunzipSync(encoded)).toEqual(input);
            expect(Buffer.from(ungzip(encoded))).toEqual(input);
            expect(gzipUserscriptBuildData(new Uint8Array(input))).toEqual(encoded);
            savedBytes += previous.byteLength - encoded.byteLength;
        }
        expect(savedBytes).toBeGreaterThan(0);
        // Empty input offers no improvement; preserve the previous standard gzip bytes on ties.
        expect(gzipUserscriptBuildData(new Uint8Array())).toEqual(Buffer.from(pakoGzip(new Uint8Array(), {level: 9, memLevel: 8})));
    });

    it.each([8,9] as const)('keeps filtered strategy %s deterministic, bounded and byte-exact', level => {
        const input=Buffer.from('有序静态目录 / offline image data'.repeat(500));
        const encoded=gzipUserscriptBuildData(input,level);
        expect(encoded.byteLength).toBeLessThanOrEqual(gzipUserscriptBuildData(input).byteLength);
        expect(gzipUserscriptBuildData(new Uint8Array(input),level)).toEqual(encoded);
        expect(gunzipSync(encoded)).toEqual(input);
        expect(Buffer.from(ungzip(encoded))).toEqual(input);
    });

    it('restores complete real catalog plugin data when the host native gzip encoder is unavailable', async () => {
        const zlib = await import('node:zlib');
        const {syncBuiltinESMExports} = await import('node:module');
        const spy = vi.spyOn(zlib.default, 'gzipSync').mockImplementation(() => {
            throw new Error('Host native gzip encoder is unavailable');
        });
        syncBuiltinESMExports();
        try {
            const plugin = createUserscriptCatalogCompressionPlugin() as unknown as {
                resolveId: (source: string, importer: string) => string | null;
                load: (id: string) => string | null;
            };
            const importer = resolve(process.cwd(), 'src/core/site-adaptation/catalog.ts');
            for (const name of ['established', 'websites', 'profiles']) {
                const expected = JSON.parse(readFileSync(resolve(process.cwd(), `src/core/site-adaptation/catalog/${name}.json`), 'utf8'));
                const id = plugin.resolveId(`./catalog/${name}.json`, importer);
                expect(id).not.toBeNull();
                const source = plugin.load(id!);
                const encoded = encodedDataBytes(source!)[0];
                expect(gunzipSync(encoded)).toEqual(Buffer.from(JSON.stringify(expected)));
                expect(JSON.parse(inflateBundledFrancData(encoded))).toEqual(expected);
            }
            expect(spy).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
            syncBuiltinESMExports();
        }
    });
});

describe('userscript bundled library notices', () => {
    it('retains every installed package heading and every complete license while sharing only exact bodies', () => {
        const root = process.cwd();
        const vueRoot = realpathSync(resolve(root, 'node_modules/vue'));
        const fromVue = createRequire(resolve(vueRoot, 'package.json'));
        const domRoot = resolve(realpathSync(fromVue.resolve('@vue/runtime-dom/package.json')), '..');
        const fromDom = createRequire(resolve(domRoot, 'package.json'));
        const packages = ['@vue/reactivity', '@vue/runtime-core', '@vue/runtime-dom', '@vue/shared']
            .map(name => ({moduleId: realpathSync(fromDom.resolve(name)),
                packageRoot: resolve(realpathSync(fromDom.resolve(`${name}/package.json`)), '..')}));
        for (const name of ['@ctrl/tinycolor', 'pako']) {
            const packageRoot = realpathSync(resolve(root, 'node_modules', name));
            packages.push({moduleId: realpathSync(createRequire(resolve(root, 'package.json')).resolve(name)), packageRoot});
        }
        const originals = packages.map(({moduleId, packageRoot}) => {
            const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
            const file = readdirSync(packageRoot).find(name => /^LICEN[CS]E(?:[.-].*)?$/iu.test(name))!;
            return {moduleId, heading: `${manifest.name} ${manifest.version} — ${manifest.license}`,
                body: readFileSync(resolve(packageRoot, file), 'utf8').trim()};
        });
        const shared = originals.slice(0, 4), tinycolor = originals[4], pako = originals[5];
        expect(shared.every(notice => notice.body === shared[0].body)).toBe(true);
        // 相同 MIT 授权正文不能掩盖不同的完整版权文本。
        expect(tinycolor.body).toContain('Permission is hereby granted');
        expect(shared[0].body).toContain('Permission is hereby granted');
        expect(tinycolor.body).not.toBe(shared[0].body);
        const ids = originals.map(notice => notice.moduleId);
        const result = bundledLibraryNotices([
            `\0${ids[0]}`, resolve(root, 'src/app/content/runtime.ts'), ...ids, ids[0],
        ]);
        expect(result).toBe([
            `/*\n${tinycolor.heading}\n${tinycolor.body}\n*/`,
            `/*\n${shared.map(notice => notice.heading).join('\n')}\n${shared[0].body}\n*/`,
            `/*\n${pako.heading}\n${pako.body}\n*/`,
        ].join('\n'));
        for (const notice of originals) expect(result.split(notice.heading)).toHaveLength(2);
        expect(bundledLibraryNotices([...ids].reverse())).toBe(result);
        expect(bundledLibraryNotices([`\0${ids[0]}`, resolve(root, 'src/app/content/runtime.ts')])).toBe('');
    });

    it('does not merge copyright or internal whitespace differences and keeps each first-seen group intact', () => {
        const fixture = mkdtempSync(resolve(tmpdir(), 'fluentread-library-notices-'));
        const permission = 'Permission is hereby granted, free of charge.\nTHE SOFTWARE IS PROVIDED "AS IS".';
        const first = `Copyright (c) First owner\n\n${permission}`;
        const differentCopyright = `Copyright (c) Second owner\n\n${permission}`;
        const differentWhitespace = first.replace('\n\n', '\r\n\r\n');
        const bodies = [first, differentCopyright, `\n ${first}\n`, differentWhitespace];
        try {
            const ids = bodies.map((body, index) => {
                const directory = resolve(fixture, `node_modules/.pnpm/notice-${index}@1.0.0/node_modules/notice-${index}`);
                mkdirSync(directory, {recursive: true});
                writeFileSync(resolve(directory, 'package.json'), JSON.stringify({name: `notice-${index}`, version: '1.0.0', license: 'MIT'}));
                writeFileSync(resolve(directory, 'LICENSE'), body);
                return resolve(directory, 'index.js');
            });
            expect(bundledLibraryNotices(ids)).toBe([
                `/*\nnotice-0 1.0.0 — MIT\nnotice-2 1.0.0 — MIT\n${first}\n*/`,
                `/*\nnotice-1 1.0.0 — MIT\n${differentCopyright}\n*/`,
                `/*\nnotice-3 1.0.0 — MIT\n${differentWhitespace}\n*/`,
            ].join('\n'));
        } finally {rmSync(fixture, {recursive: true, force: true});}
    });

    it('still rejects a complete license containing a closing comment delimiter', () => {
        const fixture = mkdtempSync(resolve(tmpdir(), 'fluentread-unsafe-notice-'));
        const directory = resolve(fixture, 'node_modules/.pnpm/unsafe@1.0.0/node_modules/unsafe');
        try {
            mkdirSync(directory, {recursive: true});
            writeFileSync(resolve(directory, 'package.json'), JSON.stringify({name: 'unsafe', version: '1.0.0', license: 'MIT'}));
            writeFileSync(resolve(directory, 'LICENSE'), 'Copyright (c) Owner\n*/\nUntrusted code');
            expect(() => bundledLibraryNotices([resolve(directory, 'index.js')]))
                .toThrow('Unsafe bundled library license comment: unsafe');
        } finally {rmSync(fixture, {recursive: true, force: true});}
    });

    // Real standalone Vite configuration compresses large catalogs in workers. Give
    // those tests time to finish cleanup before another case changes the environment.
    it('standalone shares only complete canonical MIT terms across real bundled dependencies and nested notices', async () => {
        vi.stubEnv('FLUENTREAD_USERSCRIPT_STANDALONE', '1');
        vi.stubEnv('FLUENTREAD_USERSCRIPT_GREASYFORK_SOURCE', '0');
        try {
            vi.resetModules();
            const {bundledLibraryNotices: standaloneNotices} = await import('@/userscript/vite.config');
            const root = process.cwd();
            const require = createRequire(resolve(root, 'package.json'));
            const packages = [
                realpathSync(resolve(root, 'node_modules/@ctrl/tinycolor')),
                realpathSync(resolve(root, 'node_modules/pako')),
                realpathSync(resolve(root, 'node_modules/.pnpm/lodash-es@4.17.21/node_modules/lodash-es')),
                realpathSync(resolve(root, 'node_modules/.pnpm/node-fetch-native@1.6.7/node_modules/node-fetch-native')),
            ].map(packageRoot => {
                const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
                const file = readdirSync(packageRoot).find(name => /^LICEN[CS]E(?:[.-].*)?$/iu.test(name))!;
                return {moduleId: require.resolve(resolve(packageRoot, 'package.json')),
                    heading: `${manifest.name} ${manifest.version} — ${manifest.license}`,
                    body: readFileSync(resolve(packageRoot, file), 'utf8').trim()};
            });
            const license = readFileSync(resolve(root, 'public/third-party-notices/tinycolor-MIT.txt'), 'utf8');
            const terms = license.slice(license.indexOf('Permission is hereby granted')).trim();
            const result = standaloneNotices(packages.map(item => item.moduleId));
            const marker = '[Shared MIT terms below]';
            const normalize = (text: string) => text.replace(/\s+/gu, ' ').trim();
            const restored = normalize(result.replaceAll(marker, terms));
            for (const notice of packages) {
                expect(result.split(notice.heading)).toHaveLength(2);
                expect(restored).toContain(normalize(notice.body));
            }
            // node-fetch-native 的四段完整 MIT 与 lodash 后附说明均来自真实依赖许可。
            expect(result.split(marker)).toHaveLength(8);
            expect(result.split(terms)).toHaveLength(2);
            expect(result.lastIndexOf(terms)).toBeGreaterThan(result.lastIndexOf('Copyright'));
            const completeNotices = packages.map(item => `/*\n${item.heading}\n${item.body}\n*/`).join('\n');
            expect(Buffer.byteLength(completeNotices) - Buffer.byteLength(result)).toBeGreaterThan(5_000);
            expect(standaloneNotices(packages.map(item => item.moduleId).reverse())).toBe(result);
        } finally {vi.unstubAllEnvs();vi.resetModules();}
    }, 30_000);

    it('standalone preserves copyright, sources, surrounding clauses, different terms and non-MIT notices', async () => {
        const fixture = mkdtempSync(resolve(tmpdir(), 'fluentread-shared-mit-notices-'));
        vi.stubEnv('FLUENTREAD_USERSCRIPT_STANDALONE', '1');
        vi.stubEnv('FLUENTREAD_USERSCRIPT_GREASYFORK_SOURCE', '0');
        try {
            vi.resetModules();
            const {bundledLibraryNotices: standaloneNotices} = await import('@/userscript/vite.config');
            const license = readFileSync(resolve(process.cwd(), 'public/third-party-notices/tinycolor-MIT.txt'), 'utf8');
            const terms = license.slice(license.indexOf('Permission is hereby granted')).trim();
            const firstPrefix = 'Copyright (c) First owner\nSource: https://example.com/first\n\n';
            const firstSuffix = '\n\nAdditional attribution must remain with this package.';
            const secondPrefix = 'Copyright (c) Second owner\r\nSource: https://example.com/second\r\n\r\n';
            const bodies = [
                firstPrefix + terms + firstSuffix,
                secondPrefix + terms.replace(/\s+/gu, '\r\n  '),
                'Copyright (c) Different terms\n\n' + terms.replace('free of charge', 'subject to a fee'),
                'Apache License, Version 2.0\nCopyright (c) Another owner\nAll non-MIT terms remain unchanged.',
            ];
            const ids = bodies.map((body, index) => {
                const directory = resolve(fixture, `node_modules/.pnpm/mit-${index}@1.0.0/node_modules/mit-${index}`);
                mkdirSync(directory, {recursive: true});
                writeFileSync(resolve(directory, 'package.json'), JSON.stringify({name: `mit-${index}`, version: '1.0.0', license: index === 3 ? 'Apache-2.0' : 'MIT'}));
                writeFileSync(resolve(directory, 'LICENSE'), body);
                return resolve(directory, 'index.js');
            });
            const result = standaloneNotices([...ids, ids[0]]);
            expect(result).toContain(firstPrefix + '[Shared MIT terms below]' + firstSuffix);
            expect(result).toContain(secondPrefix + '[Shared MIT terms below]');
            expect(result).toContain(bodies[2]);
            expect(result).toContain(bodies[3]);
            expect(result.split('mit-0 1.0.0 — MIT')).toHaveLength(2);
            expect(result.split('[Shared MIT terms below]')).toHaveLength(3);
            expect(result.split(terms)).toHaveLength(2);
            expect(standaloneNotices([ids[0]])).toBe(`/*\nmit-0 1.0.0 — MIT\n${bodies[0]}\n*/`);
            expect(standaloneNotices([ids[2], ids[3]])).not.toContain('Shared MIT');
            expect(standaloneNotices([])).toBe('');
            writeFileSync(resolve(ids[0], '../LICENSE'), 'Copyright (c) Owner\n*/\nUntrusted code');
            expect(() => standaloneNotices([ids[0]])).toThrow('Unsafe bundled library license comment: mit-0');
        } finally {rmSync(fixture, {recursive: true, force: true});vi.unstubAllEnvs();vi.resetModules();}
    }, 30_000);
});

describe('standalone settings compression compatibility', () => {
    it('keeps standard Base85 and standalone Base91 gzip data byte-identical', () => {
        const root = process.cwd(), id = resolve(root, 'src/core/config/translationAppearance.ts');
        const original = readFileSync(id, 'utf8');
        const transform = (full: boolean) => Reflect.apply(createUserscriptSettingsDataPlugin(root, true, full).transform as Function, {}, [original, id]) as {code:string};
        const standard = transform(false).code, standalone = transform(true).code;
        expect(standard).toContain('~85:'); expect(standalone).toContain('~91:');
        const before = encodedDataBytes(standard, '__fluentreadDecodeSettingsData');
        const after = encodedDataBytes(standalone, '__fluentreadDecodeSettingsData');
        expect(after.map(bytes=>Buffer.from(bytes))).toEqual(before.map(bytes=>Buffer.from(bytes)));
    });
});

describe('userscript inline CSS compression', () => {
    const root = process.cwd();
    const id = `${resolve(root, 'src/app/content/page.css')}?inline`;
    const plugin = createUserscriptInlineCssCompressionPlugin(root);
    const transform = (code: string, moduleId = id) => Reflect.apply((plugin.transform as {handler: Function}).handler, {}, [code, moduleId]);

    it('standalone uses the existing compact codec without changing decoded CSS', () => {
        const css = '.sample::after{content:"中文 🦦";margin:1px}\n'.repeat(100);
        const code = `export default ${JSON.stringify(css)};`;
        const standard = transform(code);
        const compactPlugin = createUserscriptInlineCssCompressionPlugin(root, true, true);
        const compact = Reflect.apply((compactPlugin.transform as {handler: Function}).handler, {}, [code, id]) as {code:string};
        expect(standard.code).toContain('~85:');
        expect(compact.code).toContain('~91:');
        const [before] = encodedDataBytes(standard.code), [after] = encodedDataBytes(compact.code);
        expect(after.length).toBeLessThanOrEqual(before.length);
        expect(gunzipSync(after)).toEqual(gunzipSync(before));
        expect(gunzipSync(after).toString('utf8')).toBe(css);
    });

    it('restores each inline CSS resource observed at userscript startup without changing decoded bytes', () => {
        const files = [
            'src/features/page-notice/content/notice.css', 'src/ui/styles/translation-loading-indicator.css',
            'src/features/section-translation/content/reminder.css', 'src/features/section-translation/content/picker.css',
            'src/ui/styles/translation-display.css', 'src/app/content/page.css', 'src/ui/styles/bilingual-sentence-highlight.css',
        ];
        const compact = createUserscriptInlineCssCompressionPlugin(root, true, true);
        for (const file of files) {
            const css = readFileSync(resolve(root, file), 'utf8'), source = `export default ${JSON.stringify(css)};`, cssId = `${resolve(root, file)}?inline`;
            const standard = transform(source, cssId) as {code:string}|null;
            const encoded = Reflect.apply((compact.transform as {handler: Function}).handler, {}, [source, cssId]) as {code:string}|null;
            if (!standard || !encoded) {expect(encoded).toBe(standard); continue;}
            const [before] = encodedDataBytes(standard.code), [after] = encodedDataBytes(encoded.code);
            expect(after.length, file).toBeLessThanOrEqual(before.length);
            expect(gunzipSync(after), file).toEqual(gunzipSync(before));
            expect(gunzipSync(after).toString('utf8'), file).toBe(css);
        }
    });

    it.each(['quoted', 'template'] as const)('restores exact Unicode, escaped content and CSS order from %s exports synchronously', kind => {
        const css = '.first::after{content:"中文 🦦 \\" \\\\ \\n"}\n@media(max-width:390px){.first{color:var(--theme)}}\n'.repeat(80);
        const code = kind === 'quoted' ? `export default ${JSON.stringify(css)};` : 'export default `' + css.replace(/\\/gu, '\\\\').replace(/`/gu, '\\`') + '`;';
        const result = transform(code);
        expect(result.map).toBeNull(); expect(Buffer.byteLength(result.code)).toBeLessThan(Buffer.byteLength(code));
        const [bytes] = encodedDataBytes(result.code);
        expect(Buffer.from(bytes)).toEqual(gzipUserscriptBuildData(Buffer.from(css, 'utf8')));
        expect(gunzipSync(bytes).toString('utf8')).toBe(css);
        vi.stubGlobal('pako', {ungzip});
        try {
            const realm = {inflateWithPako, decodeUserscriptData, Uint8Array, atob, restored: undefined};
            runInNewContext(result.code.replace(/^import[^\n]+\n/gmu, '').replace('export default ', 'restored = '), realm);
            expect(realm.restored).toBe(css);
        } finally {vi.unstubAllGlobals();}
    });

    it.each([
        ['small CSS', 'export default ".a{color:red}";', id],
        ['raw CSS before Vite', '.a{color:red}', id],
        ['executable module', 'const value = readCss(); export default value;', id],
        ['non-export statement', 'const value = "css";', id],
        ['non-string export', 'export default 42;', id],
        ['export equals', 'export = "css";', id],
        ['plain CSS import', 'export default "css";', id.split('?')[0]],
        ['non-CSS module', 'export default "css";', id.replace('.css', '.ts')],
        ['external dependency', 'export default "css";', `${resolve(root, 'node_modules/vendor/style.css')}?inline`],
    ])('leaves %s unchanged', (_name, code, moduleId) => {expect(transform(code, moduleId)).toBeNull();});

    it('keeps Greasy Fork source readable and runs only after Vite CSS conversion', () => {
        const source = 'export default ' + JSON.stringify('.repeat{color:red}'.repeat(80)) + ';';
        const disabled = createUserscriptInlineCssCompressionPlugin(root, false);
        expect(Reflect.apply((disabled.transform as {handler: Function}).handler, {}, [source, id])).toBeNull();
        expect(plugin.enforce).toBe('post'); expect((plugin.transform as {order: string}).order).toBe('post');
    });
});

describe('authoritative site catalogs with an external pinned data asset', () => {
    it.each(['unchanged', 'old-asset', 'reordered', 'removed-rule', 'missing-runtime-rule'] as const)
    ('reconciles %s without mutating the external asset', async variant => {
        const vm = await vi.importActual<typeof import('node:vm')>('node:vm');
        const authoritative = JSON.parse(readFileSync(resolve(process.cwd(), 'src/core/site-adaptation/catalog/established.json'), 'utf8'));
        const data = vm.runInNewContext(readFileSync(resolve(process.cwd(), 'userscript/resources/fluentread-data.v1.js'), 'utf8'), {}, {timeout: 5000});
        data.siteCatalogs.established = structuredClone(authoritative);
        // 固定资源刷新后仍明确构造旧版本和重排资源，避免依赖当前磁盘恰好陈旧。
        if (variant === 'old-asset') data.siteCatalogs.established.shift();
        if (variant === 'reordered' || variant === 'missing-runtime-rule') data.siteCatalogs.established.reverse();
        if (variant === 'removed-rule') data.siteCatalogs.established.push({id: 'removed-pinned-rule', match: {hosts: ['removed.invalid']}});
        vi.doMock('node:vm', () => ({...vm, runInNewContext: () => data}));
        vi.stubEnv('FLUENTREAD_USERSCRIPT_GREASYFORK_SOURCE', '1');
        vi.stubEnv('FLUENTREAD_USERSCRIPT_VENDOR_URL', 'https://fixture.invalid/vendor.js');
        vi.stubEnv('FLUENTREAD_USERSCRIPT_DATA_URL', 'https://fixture.invalid/data.js');
        try {
            vi.resetModules();
            const {createUserscriptCatalogCompressionPlugin: createPlugin} = await import('@/userscript/vite.config');
            const {transformWithEsbuild} = await import('vite');
            const plugin = createPlugin();
            const resolveId = typeof plugin.resolveId === 'function' ? plugin.resolveId : plugin.resolveId!.handler;
            const load = typeof plugin.load === 'function' ? plugin.load : plugin.load!.handler;
            const id = await Reflect.apply(resolveId, {}, ['./catalog/established.json', resolve(process.cwd(), 'src/core/site-adaptation/pack.ts')]);
            const source = await Reflect.apply(load, {}, [id]);
            const compiled = await transformWithEsbuild(source, 'pinned-catalog.js', {format: 'cjs', target: 'es2018'});
            if (variant === 'missing-runtime-rule') data.siteCatalogs.established = data.siteCatalogs.established.filter((rule: {id: string}) => rule.id !== 'openrouter');
            const before = JSON.stringify(data), original = data.siteCatalogs.established;
            const realm = {module: {exports: {} as any}, __FLUENTREAD_USERSCRIPT_DATA__: data};
            if (variant === 'missing-runtime-rule') {
                expect(() => vm.runInNewContext(compiled.code, realm, {timeout: 5000})).toThrow('Missing pinned userscript site rule: openrouter');
            } else {
                vm.runInNewContext(compiled.code, realm, {timeout: 5000});
                const result = realm.module.exports.default;
                expect(result).toEqual(authoritative);
                if (variant === 'unchanged') expect(result).toBe(original);
                for (const rule of original) {
                    const expected = authoritative.find((current: {id: string}) => current.id === rule.id);
                    if (expected && JSON.stringify(rule) === JSON.stringify(expected)) expect(result.find((current: {id: string}) => current.id === rule.id)).toBe(rule);
                }
            }
            expect(JSON.stringify(data)).toBe(before);
        } finally {vi.doUnmock('node:vm');vi.unstubAllEnvs();vi.resetModules();}
    }, 30_000);
});

describe('userscript browser shim injection', () => {
    const registeredSupplementKeys = ['learning.panelLoadError', 'learning.reloadPage', ...Object.keys(aiRequestTimeoutMessages['en-US']),
        'sectionTranslation.picker.dragging', 'sectionTranslation.scope.selected', 'settings.services.deeplx.defaultRoute'];
    const pinnedLanguageFiles = {
        'ja-JP': 'ja-JP.b81984c57e32c317.json',
        'ko-KR': 'ko-KR.f9dd4e317a3ccbac.json',
        'fr-FR': 'fr-FR.fcc79905550b3705.json',
        'ru-RU': 'ru-RU.83347fe7c1e5f5da.json',
        'es-ES': 'es-ES.ccf366fbe218633c.json',
    };
    const retiredLegacySources = ['鼠标悬停翻译设置', '将鼠标停在段落上，按快捷键查看译文。', '服务优先顺序'];
    const publishedBundles: Record<string, {messages: Record<string, string>; legacyText: Record<string, string>}> = Object.fromEntries(Object.entries(pinnedLanguageFiles)
        .map(([language, file]) => [language, JSON.parse(readFileSync(resolve(process.cwd(), 'userscript/languages', file), 'utf8'))]));
    it('preserves pinned remote dictionaries and derives current embedded settings copy', () => {
        const build = (userscriptConfig as {build: {cssCodeSplit: boolean; rollupOptions: {output: {inlineDynamicImports: boolean}}}}).build;
        expect(build.cssCodeSplit).toBe(false);
        expect(build.rollupOptions.output.inlineDynamicImports).toBe(true);
        for (const key of registeredSupplementKeys) {
            expect((zhCNMessages as Record<string, string>)[key]).toBe((extensionChinese as Record<string, string>)[key]);
            expect(UI_LANGUAGE_BUNDLES['en-US'].messages[key]).toBe(extensionBundles['en-US'].messages[key]);
        }
        expect(UI_LANGUAGE_BUNDLES['en-US']).toEqual({...currentUserscriptLanguageBundle('en-US'),
            messages: userscriptMessages(extensionBundles['en-US'].messages)});
        for (const [language, file] of Object.entries(pinnedLanguageFiles)) {
            const bundle = UI_LANGUAGE_BUNDLES[language as keyof typeof UI_LANGUAGE_BUNDLES];
            expect(JSON.stringify(bundle) + '\n').toBe(readFileSync(resolve(process.cwd(), 'userscript/languages', file), 'utf8'));
            for (const source of retiredLegacySources) {
                expect(extensionBundles[language as keyof typeof extensionBundles].legacyText).not.toHaveProperty(source);
                expect(bundle.legacyText[source]).toBe(publishedBundles[language]!.legacyText[source]);
            }
        }
    });
    it.each(Object.keys(pinnedLanguageFiles) as Array<keyof typeof extensionBundles>)('keeps the published %s resource while deriving every current supported override', language => {
        const original = extensionBundles[language], baseline = UI_LANGUAGE_BUNDLES[language];
        const before = JSON.stringify(baseline), originalBefore = JSON.stringify(original);
        const current = currentUserscriptLanguageBundle(language), update = createUserscriptLanguageUpdate(current, baseline);
        const merged = {...baseline.messages, ...update.messages}, mergedLegacy = {...baseline.legacyText, ...update.legacyText};
        for (const [key, value] of Object.entries(current.messages)) expect(merged[key]).toBe(value);
        for (const [source, value] of Object.entries(current.legacyText)) expect(mergedLegacy[source]).toBe(value);
        const materialSources = new Set(Object.keys(learningMaterialLegacyText[language as keyof typeof learningMaterialLegacyText]));
        for (const source of materialSources) expect(current.legacyText).not.toHaveProperty(source);
        const materialPatterns = learningMaterialPatterns.map(({pattern}) => pattern);
        for (const phase of ['early', 'late'] as const) {
            expect(current.legacyPatterns[phase]).toEqual(original.legacyPatterns[phase].filter(([source]) => !materialPatterns.includes(source)));
        }
        // 文档页不属于脚本；旧固定资源保留原发布字节，当前扩展仍有自己的文档说明。
        for (const key of Object.keys(current.messages)) expect(key.startsWith('document.') || key.startsWith('translationStats.')).toBe(false);
        const file = pinnedLanguageFiles[language as keyof typeof pinnedLanguageFiles];
        expect(before + '\n').toBe(readFileSync(resolve(process.cwd(), 'userscript/languages', file), 'utf8'));
        expect(JSON.stringify(baseline)).toBe(before);
        expect(JSON.stringify(original)).toBe(originalBefore);
    });
    it.each(['standard', 'standalone'] as const)('keeps %s runtime icon inline and pins only the standard manager icon', async mode => {
        vi.stubEnv('FLUENTREAD_USERSCRIPT_STANDALONE', mode === 'standalone' ? '1' : '');
        vi.stubEnv('FLUENTREAD_USERSCRIPT_GREASYFORK_SOURCE', '');
        try {
            vi.resetModules();
            const {default: config} = await import('@/userscript/vite.config');
            const plugins = (config as {plugins: Array<{name: string; generateBundle?: {handler: Function}}>}).plugins;
            const plugin = plugins.find(item => item.name === 'bundle-userscript-css')!;
            const entry = {type: 'chunk', isEntry: true, code: 'var fixture = 1;', moduleIds: []};
            await Reflect.apply(plugin.generateBundle!.handler, {}, [{}, {'entry.js': entry}]);
            const iconBytes = readFileSync(resolve(process.cwd(), 'public/icon/64.png'));
            const encodedIcon = JSON.parse(entry.code.match(/globalThis\.__FLUENTREAD_ICON_DATA__=("[^"]+");/u)![1]) as string;
            const {restoreUserscriptIcon} = await import('@/userscript/iconData');
            const runtimeIcon = restoreUserscriptIcon(encodedIcon);
            expect(Buffer.from(runtimeIcon.split(',')[1], 'base64')).toEqual(iconBytes);
            const metadataIcon = entry.code.match(/^\/\/ @icon\s+(.+)$/mu)![1];
            if (mode === 'standalone') expect(metadataIcon).toBe(runtimeIcon);
            else {
                const pinned = metadataIcon.match(/^https:\/\/cdn\.jsdelivr\.net\/gh\/FluentRead\/FluentRead@([a-f0-9]{40})\/public\/icon\/64\.png$/u);
                expect(pinned).not.toBeNull();
                // 固定公开资源不属于 main 的祖先，干净 CI 不必包含其旧 Git 对象；
                // 对照已发布 PNG 的精确 pin 和 SHA256，继续拒绝图标漂移或非固定地址。
                expect(pinned![1]).toBe('184a3d74f61b9d2a8d47080787f7e0180b98414d');
                expect(createHash('sha256').update(iconBytes).digest('hex')).toBe('4226fc057f80b2308a6153b3316bc02b31b74f1a7f92504e9f45f30d245b5535');
                expect(metadataIcon).not.toBe(runtimeIcon);
            }
        } finally {vi.unstubAllEnvs();vi.resetModules();}
    }, 30_000);
    it.each<readonly [string, Record<string, string>, Record<string, string>]>([
        ['zh-CN', extensionChinese, zhCNMessages],
        ...Object.entries(extensionBundles).map(([language, bundle]) => [language, bundle.messages, userscriptMessages(bundle.messages)] as const),
    ])('retains extension-only copy in %s while preserving userscript menu and settings copy', (_language, extension, projected) => {
        const noticeKeys = Object.keys(extension).filter(key => key.startsWith('contextMenu.notice.'));
        expect(noticeKeys).toHaveLength(6);
        for (const key of noticeKeys) {
            expect(extension[key]).toBeTruthy();
            expect(Object.hasOwn(projected, key)).toBe(false);
        }
        const learningKeys = Object.keys(extension).filter(key => key.startsWith('video.learning.'));
        expect(learningKeys).not.toHaveLength(0);
        for (const key of learningKeys) {
            expect(extension[key]).toBeTruthy();
            expect(Object.hasOwn(projected, key)).toBe(false);
        }
        const readingAnnotationKeys = Object.keys(extension).filter(key => key.startsWith('video.readingAnnotation.'));
        expect(readingAnnotationKeys).not.toHaveLength(0);
        for (const key of readingAnnotationKeys) {
            expect(extension[key]).toBeTruthy();
            expect(Object.hasOwn(projected, key)).toBe(false);
        }
        for (const key of ['popup.compact.translate', 'popup.compact.restore', 'popup.displayMode.bilingual', 'popup.displayMode.translationOnly', 'popup.displayMode.googleBilingualOnly']) {
            expect(extension[key]).toBeTruthy();
            expect(Object.hasOwn(projected, key)).toBe(false);
        }
        expect(extension['video.nativeFullscreenHint']).toBeTruthy();
        expect(Object.hasOwn(projected, 'video.nativeFullscreenHint')).toBe(false);
        const diagnosticKeys = Object.keys(extension).filter(key => key.startsWith('diagnostics.'));
        expect(diagnosticKeys.length).toBeGreaterThan(0);
        const readerDialogKeys = ['waitingTranslation', 'crossPageContext', 'fullPassage', 'closePassage'].map(name => `document.pdfReading.${name}`);
        const safariPermissionKeys = Object.keys(extension).filter(key => key.startsWith('safari.freePool.'));
        expect(safariPermissionKeys).toHaveLength(8);
        const pageFontKeys = Object.keys(extension).filter(key => key.startsWith('popup.pageFont.'));
        const expectedPageFontKeys = ['title', 'original', 'browserDefault', 'hostAction', 'browserAction', 'changing', 'retryAction',
            'hint', 'loading', 'unavailable', 'readError', 'changeError', 'retry'].map(name => `popup.pageFont.${name}`);
        expect([...pageFontKeys].sort()).toEqual([...expectedPageFontKeys].sort());
        expect(Object.keys(projected).filter(key => key.startsWith('popup.pageFont.'))).toEqual([]);
        for (const key of [...diagnosticKeys, ...readerDialogKeys, ...safariPermissionKeys, ...pageFontKeys]) {
            expect(extension[key]).toBeTruthy();
            expect(Object.hasOwn(projected, key)).toBe(false);
        }
        expect(extension['document.config.loadFailed']).toBeTruthy();
        const readerRecoveryKeys = Object.keys(extension).filter(key => key.startsWith('document.config.') || key.startsWith('document.translationRecovery.')
            || key.startsWith('document.retainedRevisions.') || key.startsWith('document.translationProgress.'));
        expect(readerRecoveryKeys.length).toBeGreaterThan(0);
        for (const key of readerRecoveryKeys) {
            expect(extension[key]).toBeTruthy();
            expect(Object.hasOwn(projected, key)).toBe(false);
        }
        const extensionOnlyUndoKeys = ['learning.collection.undoExtensionNotice'];
        for (const key of extensionOnlyUndoKeys) expect(Object.hasOwn(projected,key)).toBe(false);
        const retainedKeys = Object.keys(extension).filter(key => !extensionOnlyUndoKeys.includes(key) && !key.startsWith('informationHighlight.')
            && (!key.startsWith('learning.collection.speech') || key === 'learning.collection.speechFailed')
            && !noticeKeys.includes(key) && !learningKeys.includes(key) && !readingAnnotationKeys.includes(key) && !readerRecoveryKeys.includes(key)
            && !diagnosticKeys.includes(key) && !readerDialogKeys.includes(key)
            && key !== 'video.nativeFullscreenHint'
            && !safariPermissionKeys.includes(key) && !pageFontKeys.includes(key)
            && key !== 'popup.compact.translate' && key !== 'popup.compact.restore' && !key.startsWith('popup.displayMode.'));
        expect(Object.keys(projected)).toHaveLength(retainedKeys.length);
        for (const key of retainedKeys) expect(projected[key]).toBe(extension[key]);
        expect(projected['contextMenu.translateSelection']).toBeTruthy();
        expect(projected['contextMenu.translatePage']).toBeTruthy();
        expect(projected['contextMenu.restorePage']).toBeTruthy();
    });
    it('excludes unreachable highlight code and copy while keeping an explicitly unavailable state', () => {
        expect(userscriptMessages(extensionChinese)).toEqual(zhCNMessages);
        expect(Object.keys(zhCNMessages).some(key => key.startsWith('informationHighlight.'))).toBe(false);
        const controller = installInformationHighlight({} as Document, {enabled: true, hotkey: 'Alt+H', hotkeyEnabled: true, mode: 'keywords', model: 'qwen2.5-0.5b', density: 'medium', color: 'amber', style: 'background', intensity: 'standard'});
        expect(controller.setEnabled(true)).toMatchObject({enabled: false, phase: 'unsupported', mode: 'keywords'});
        controller.updatePreferences({enabled: true, hotkey: 'Alt+H', hotkeyEnabled: true, mode: 'surprisal-local', model: 'qwen2.5-0.5b', density: 'low', color: 'mint', style: 'underline', intensity: 'standard'});
        expect(controller.retry()).toMatchObject({enabled: false, mode: 'surprisal-local'});
        controller.refresh();controller.dispose();expect(controller.getState().enabled).toBe(false);
        expect(userscriptAliases.find(alias => alias.find === '@/src/features/information-highlight/public')?.replacement).toMatch(/userscript\/informationHighlight\.ts$/u);
    });
    it('isolates material capture without replacing the original-text, vocabulary or reading contracts', () => {
        const alias = userscriptAliases.find(entry => entry.replacement.endsWith('/userscript/materialCapture.ts'));
        expect(alias?.find).toBeInstanceOf(RegExp);
        const boundary = alias!.find as RegExp;
        expect(boundary.test('@/src/features/vocabulary/material/public')).toBe(true);
        for (const path of ['@/src/features/vocabulary/material/text/public', '@/src/features/vocabulary/public',
            '@/src/features/reading-assistant/public', '@/src/features/vocabulary/material/public/nested']) {
            expect(boundary.test(path)).toBe(false);
        }
    });
    it('replaces only the vocabulary UI barrel and keeps every neighboring public contract distinct', () => {
        const alias = userscriptAliases.find(entry => entry.replacement.endsWith('/userscript/vocabularyUi.ts'));
        expect(alias?.find).toBeInstanceOf(RegExp);
        const boundary = alias!.find as RegExp;
        expect(boundary.test('@/src/features/vocabulary/ui/public')).toBe(true);
        for (const path of ['@/src/features/vocabulary/public', '@/src/features/vocabulary/material/public',
            '@/src/features/vocabulary/material/text/public', '@/src/features/reading-assistant/ui/public',
            '@/src/features/vocabulary/ui/public/nested', '@/src/features/vocabulary/ui/VocabularyBook.vue']) {
            expect(boundary.test(path)).toBe(false);
        }
    });
    it('pins each remote language file to a commit containing exactly its built contents', () => {
        const defines = (userscriptConfig as {define: Record<string, string>}).define;
        const commit = JSON.parse(defines.__FLUENTREAD_USERSCRIPT_RESOURCE_COMMIT__);
        const bundles = JSON.parse(defines.__FLUENTREAD_USERSCRIPT_REMOTE_LANGUAGES__) as Record<string, string>;
        expect(commit).toBe('f804e1b39dbd3313c8bdae9738ebd69a51ad2074');
        expect(bundles).toEqual(pinnedLanguageFiles);
        for (const file of Object.values(bundles)) {
            const path = `userscript/languages/${file}`;
            const committed = execFileSync('git', ['show', `${commit}:${path}`], {cwd: process.cwd(), encoding: 'utf8'});
            expect(committed).toBe(readFileSync(resolve(process.cwd(), path), 'utf8'));
        }
    });
    it('embeds the Chinese fallback catalog, minus the extension document and full-options statistics keys, as lossless static data', () => {
        const plugin = createUserscriptCatalogCompressionPlugin() as unknown as {
            resolveId: (source: string, importer: string) => string | null;
            load: (id: string) => string | null;
        };
        const id = plugin.resolveId('./messages/zh-CN', resolve(process.cwd(), 'src/core/i18n/index.ts'));
        expect(id).toBeTruthy();
        const moduleSource = plugin.load(id!);
        const base64 = moduleSource?.match(/atob\("([A-Za-z0-9+/=]+)"\)/u)?.[1];
        expect(base64).toBeTruthy();
        const restored = JSON.parse(gunzipSync(Buffer.from(base64!, 'base64')).toString('utf8'));
        // 标准脚本不挂载文档页与完整设置里的请求统计；其余文案逐项验证。
        const readerOnly = Object.keys(zhCNMessages).filter(key => (key.startsWith('document.') || key.startsWith('translationStats.')));
        expect(readerOnly.length).toBeGreaterThan(0);
        const embedded = Object.fromEntries(Object.entries(zhCNMessages).filter(([key]) => !(key.startsWith('document.') || key.startsWith('translationStats.'))));
        expect(Object.keys(embedded)).toHaveLength(Object.keys(zhCNMessages).length - readerOnly.length);
        expect(restored).toEqual(embedded);
        vi.stubGlobal('pako', {ungzip});
        try {
            expect(JSON.parse(inflateWithPako(new Uint8Array(Buffer.from(base64!, 'base64'))))).toEqual(embedded);
        } finally {
            vi.unstubAllGlobals();
        }
        expect(moduleSource).toContain(createHash('sha256').update(gunzipSync(Buffer.from(base64!, 'base64'))).digest('hex'));
    });

    it.each(['0', '1'])('emits immutable Greasy Fork data except in explicit resource preparation mode %s', async prepare => {
        vi.stubEnv('FLUENTREAD_USERSCRIPT_GREASYFORK_SOURCE', '1');
        vi.stubEnv('FLUENTREAD_USERSCRIPT_PREPARE_RESOURCES', prepare);
        vi.stubEnv('FLUENTREAD_USERSCRIPT_VENDOR_URL', 'https://fixture.invalid/vendor.js');
        vi.stubEnv('FLUENTREAD_USERSCRIPT_DATA_URL', 'https://fixture.invalid/data.js');
        try {
            vi.resetModules();
            const {default: config} = await import('@/userscript/vite.config');
            const plugin = (config as {plugins: any[]}).plugins.find(item => item.name === 'bundle-userscript-css');
            const emitFile = vi.fn();
            const entry = {type: 'chunk', isEntry: true, code: 'var fixture = 1;', moduleIds: []};
            await Reflect.apply(plugin.generateBundle.handler, {emitFile}, [{}, {'entry.js': entry}]);
            const resource = emitFile.mock.calls[0][0];
            expect(resource.fileName).toBe('fluentread-data.v1.js');
            const pinned = readFileSync(resolve(process.cwd(), 'userscript/resources/fluentread-data.v1.js'), 'utf8');
            if (prepare === '0') {
                expect(resource.source).toBe(pinned);
                await expect(Reflect.apply(plugin.generateBundle.handler, {emitFile}, [{}, {'entry.js': entry,
                    'fixture.css': {type: 'asset', fileName: 'fixture.css', source: 'changed CSS'},
                }])).rejects.toThrow('Greasy Fork CSS changed');
            }
            else {
                expect(resource.source).not.toBe(pinned);
                const current = runInNewContext(resource.source, {}, {timeout: 5000});
                expect(current.english).toEqual(UI_LANGUAGE_BUNDLES['en-US']);
                expect(current.zhCNMessages).toEqual(zhCNMessages);
            }
        } finally {vi.unstubAllEnvs();vi.resetModules();}
    }, 30_000);

    it('updates every changed Chinese message when Greasy Fork uses its pinned old data', async () => {
        vi.stubEnv('FLUENTREAD_USERSCRIPT_GREASYFORK_SOURCE', '1');
        vi.stubEnv('FLUENTREAD_USERSCRIPT_VENDOR_URL', 'https://fixture.invalid/vendor.js');
        vi.stubEnv('FLUENTREAD_USERSCRIPT_DATA_URL', 'https://fixture.invalid/data.js');
        try {
            vi.resetModules();
            const {createUserscriptCatalogCompressionPlugin: createPlugin} = await import('@/userscript/vite.config');
            const {transformWithEsbuild} = await import('vite');
            const plugin = createPlugin();
            const resolveId = typeof plugin.resolveId === 'function' ? plugin.resolveId : plugin.resolveId!.handler;
            const load = typeof plugin.load === 'function' ? plugin.load : plugin.load!.handler;
            const id = await Reflect.apply(resolveId, {}, ['./messages/zh-CN', resolve(process.cwd(), 'src/core/i18n/index.ts')]);
            const source = await Reflect.apply(load, {}, [id]);
            const compiled = await transformWithEsbuild(source, 'pinned-chinese.js', {format: 'cjs', target: 'es2018'});
            const data = runInNewContext(readFileSync(resolve(process.cwd(), 'userscript/resources/fluentread-data.v1.js'), 'utf8'), {}, {timeout: 5000});
            const before = JSON.stringify(data);
            const realm = {module: {exports: {} as {zhCNMessages: Record<string, string>}}, __FLUENTREAD_USERSCRIPT_DATA__: data,
                Uint8Array, atob, require: () => ({inflateWithPako: (bytes: Uint8Array) => ungzip(bytes, {to: 'string'})})};
            runInNewContext(compiled.code, realm, {timeout: 5000});
            const result = realm.module.exports.zhCNMessages;
            const current = Object.fromEntries(Object.entries(zhCNMessages).filter(([key]) => !key.startsWith('document.') && !key.startsWith('translationStats.')));
            for (const [key, value] of Object.entries(current)) expect(result[key]).toBe(value);
            expect(result['settings.floatingBall.hoverDelayHelp']).toBeTruthy();
            expect(Object.keys(result).some(key => result[key] !== data.zhCNMessages[key])).toBe(true);
            expect(JSON.stringify(data)).toBe(before);
        } finally {vi.unstubAllEnvs();vi.resetModules();}
    }, 30_000);

    it('embeds the English bundle without the extension document and full-options statistics keys and preserves every other field', () => {
        const defines = (userscriptConfig as {define: Record<string, string>}).define;
        const compressed = JSON.parse(defines.__FLUENTREAD_USERSCRIPT_LANGUAGE_BUNDLES__) as Record<string, string>;
        expect(Object.keys(compressed)).toEqual(['en-US']);
        const original = UI_LANGUAGE_BUNDLES['en-US'];
        const readerOnly = Object.keys(original.messages).filter(key => (key.startsWith('document.') || key.startsWith('translationStats.')));
        expect(readerOnly.length).toBeGreaterThan(0);
        const messages = Object.fromEntries(Object.entries(original.messages).filter(([key]) => !readerOnly.includes(key)));
        const expected = {...original, messages};
        const bytes = Buffer.from(compressed['en-US'], 'base64');
        const restored = unpackUiLanguageBundle(JSON.parse(gunzipSync(bytes).toString('utf8')));
        // 整包比较同时约束保留 messages、legacyText、legacyPatterns 及其余 bundle 字段。
        expect(restored).toEqual(expected);
        expect(Object.keys(restored.messages)).toHaveLength(Object.keys(original.messages).length - readerOnly.length);
        // 读出实际 define 后再走现有脚本解码端口，不以另造的 fixture 压缩串代替构建配置。
        vi.stubGlobal('pako', {ungzip});
        try {
            expect(unpackUiLanguageBundle(JSON.parse(inflateWithPako(bytes)))).toEqual(expected);
        } finally {
            vi.unstubAllGlobals();
        }
    });
    it('applies the same page capability boundary to the embedded English catalog and preserves learning-center source copy', () => {
        const defines = (userscriptConfig as {define: Record<string, string>}).define;
        const compressed = JSON.parse(defines.__FLUENTREAD_USERSCRIPT_LANGUAGE_BUNDLES__)['en-US'];
        const restored = unpackUiLanguageBundle(JSON.parse(gunzipSync(Buffer.from(compressed, 'base64')).toString('utf8')));
        const english = UI_LANGUAGE_BUNDLES['en-US'];
        const messages = Object.fromEntries(Object.entries(english.messages).filter(([key]) => !(key.startsWith('document.') || key.startsWith('translationStats.'))));
        expect(Object.keys(messages).length).toBeLessThan(Object.keys(english.messages).length);
        expect(restored).toEqual({...english, messages});
        expect(restored.legacyText['回到视频片段']).toBe(extensionBundles['en-US'].legacyText['回到视频片段']);
    });

    it.each([[false, false], [true, false], [false, true], [true, true]])(
        'preserves every actual UI update and Chinese loader mode, standalone=%s greasy=%s', async (standalone, greasy) => {
            vi.stubEnv('FLUENTREAD_USERSCRIPT_STANDALONE', standalone ? '1' : '0');
            vi.stubEnv('FLUENTREAD_USERSCRIPT_GREASYFORK_SOURCE', greasy ? '1' : '0');
            vi.stubEnv('FLUENTREAD_USERSCRIPT_VENDOR_URL', 'https://fixture.invalid/vendor.js');
            vi.stubEnv('FLUENTREAD_USERSCRIPT_DATA_URL', 'https://fixture.invalid/data.js');
            try {
                vi.resetModules();
                const {default: config, createUserscriptCatalogCompressionPlugin: createPlugin} = await import('@/userscript/vite.config');
                const defines = (config as {define: Record<string, string>}).define;
                const value = JSON.parse(defines.__FLUENTREAD_USERSCRIPT_LANGUAGE_UPDATES__) as string;
                const bytes = standalone ? decodeUserscriptData(value) : Buffer.from(value, 'base64');
                const actual = unpackLanguageUpdates(JSON.parse(gunzipSync(bytes).toString('utf8')));
                const pinned = greasy ? runInNewContext(readFileSync(resolve(process.cwd(), 'userscript/resources/fluentread-data.v1.js'), 'utf8'), {}, {timeout: 5000}) as {english: typeof UI_LANGUAGE_BUNDLES['en-US']} : undefined;
                const expected = Object.fromEntries(Object.entries(UI_LANGUAGE_BUNDLES).flatMap(([language, baseline]) => {
                    if (language === 'en-US' && !pinned) return [];
                    const current = currentUserscriptLanguageBundle(language as Parameters<typeof currentUserscriptLanguageBundle>[0]);
                    return [[language, createUserscriptLanguageUpdate(current, language === 'en-US' ? pinned!.english : baseline)]];
                }));
                expect(actual).toEqual(expected);
                const plugin = createPlugin() as unknown as {resolveId: (source: string, importer: string) => string; load: (id: string) => string | Promise<string>};
                const source = plugin.load(plugin.resolveId('./messages/zh-CN', resolve(process.cwd(), 'src/core/i18n/index.ts')));
                expect(source instanceof Promise).toBe(standalone && !greasy);
                expect(await source).toContain('zhCNMessages');
            } finally {vi.unstubAllEnvs(); vi.resetModules();}
        }, 30_000,
    );

    it('applies the same absent-page boundary to standalone and preserves every remaining message', async () => {
        vi.stubEnv('FLUENTREAD_USERSCRIPT_STANDALONE', '1');
        try {
            vi.resetModules();
            const {default: standalone, createUserscriptCatalogCompressionPlugin: createPlugin} = await import('@/userscript/vite.config');
            const defines = (standalone as {define: Record<string, string>}).define;
            const plugin = createPlugin() as unknown as {resolveId: (source: string, importer: string) => string; load: (id: string) => Promise<string>};
            const source = await plugin.load(plugin.resolveId('./messages/zh-CN', resolve(process.cwd(), 'src/core/i18n/index.ts')));
            const {transformWithEsbuild} = await import('vite');
            const provider = await import('@/userscript/defaultMessageData');
            const compiled = await transformWithEsbuild(source, 'standalone-chinese.js', {format: 'cjs', target: 'es2018'});
            const realm = {module: {exports: {} as {zhCNMessages: Record<string, string>}}, require: (id: string) => {
                if (id === '@/userscript/pakoRuntime') return {inflateWithPako: (bytes: Uint8Array) => ungzip(bytes, {to: 'string'})};
                if (id === '@/userscript/dataEncoding') return {decodeUserscriptData};
                if (id === '@/userscript/defaultMessageData') return provider;
                throw new Error(`Unexpected generated import: ${id}`);
            }};
            runInNewContext(compiled.code, realm, {timeout: 5000});
            const chinese = realm.module.exports.zhCNMessages;
            const english = unpackUiLanguageBundle(JSON.parse(gunzipSync(decodeUserscriptData(JSON.parse(defines.__FLUENTREAD_USERSCRIPT_LANGUAGE_BUNDLES__)['en-US'])).toString('utf8')), provider.readDefaultMessageKeys());
            for (const [original, restored] of [[UI_LANGUAGE_BUNDLES['en-US'].messages, english.messages], [zhCNMessages, chinese]]) {
                const keys = Object.keys(original).filter(key => key.startsWith('translationStats.'));
                expect(keys.length).toBeGreaterThan(100);
                for (const key of keys) expect(restored).not.toHaveProperty(key);
                expect(restored).toEqual(Object.fromEntries(Object.entries(original).filter(([key]) => !key.startsWith('document.') && !key.startsWith('translationStats.'))));
                expect(Object.keys(restored).some(key => key.startsWith('document.'))).toBe(false);
            }
            expect(defines.__FLUENTREAD_USERSCRIPT_REMOTE_LANGUAGES__).toBe((userscriptConfig as {define: Record<string, string>}).define.__FLUENTREAD_USERSCRIPT_REMOTE_LANGUAGES__);
        } finally {vi.unstubAllEnvs();vi.resetModules();}
    }, 30_000);

    it('rejects the standalone Chinese catalog load if its isolated compression fails', async () => {
        vi.stubEnv('FLUENTREAD_USERSCRIPT_STANDALONE', '1');
        vi.stubEnv('FLUENTREAD_USERSCRIPT_GREASYFORK_SOURCE', '0');
        try {
            vi.resetModules();
            const {createUserscriptCatalogCompressionPlugin: createPlugin} = await import('@/userscript/vite.config');
            const gzipModule = await import('@/userscript/buildGzip');
            const worker = vi.spyOn(gzipModule, 'gzipLargeStandaloneUserscriptData')
                .mockRejectedValueOnce(new Error('controlled Chinese catalog failure'));
            const plugin = createPlugin() as unknown as {resolveId:(source:string, importer:string)=>string;load:(id:string)=>Promise<string>};
            const id = plugin.resolveId('./messages/zh-CN', resolve(process.cwd(), 'src/core/i18n/index.ts'));
            await expect(plugin.load(id)).rejects.toThrow('controlled Chinese catalog failure');
            expect(worker).toHaveBeenCalledOnce();
            worker.mockRestore();
        } finally {vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules();}
    }, 30_000);

    it('initializes shared keys through the actual standalone loader dependency graph without provider prewarming', async () => {
        vi.stubEnv('FLUENTREAD_USERSCRIPT_STANDALONE', '1');
        const fixture = mkdtempSync(resolve(tmpdir(), 'fluentread-language-owner-'));
        try {
            vi.resetModules();
            const {default: standalone, createUserscriptCatalogCompressionPlugin: createPlugin} = await import('@/userscript/vite.config');
            const config = standalone as import('vite').UserConfig;
            const entry = resolve(fixture, 'entry.mjs');
            writeFileSync(entry, [
                'import {ensureUiLanguageBundle} from "@/userscript/uiLanguageBundles";',
                'import {readDefaultMessageKeys} from "@/userscript/defaultMessageData";',
                'import {translate,translateLegacyText,hasUiLanguageBundle} from "@/src/core/i18n";',
                'globalThis.languageOwner={ensureUiLanguageBundle,readDefaultMessageKeys,translate,translateLegacyText,hasUiLanguageBundle};',
            ].join('\n'));
            const {build} = await import('vite');
            const result = await build({root: process.cwd(), configFile: false, publicDir: false, logLevel: 'silent',
                plugins: [createPlugin()], resolve: config.resolve, define: config.define,
                build: {...config.build, write: false, outDir: resolve(fixture, 'unused-output'),
                    lib: {entry, name: 'LanguageOwner', formats: ['iife']},
                    rollupOptions: {output: {inlineDynamicImports: true}}}});
            const output = Array.isArray(result) ? result : [result];
            expect(output).toHaveLength(1);
            if (!('output' in output[0])) throw new Error('Expected bundled language owner');
            expect(output[0].output).toHaveLength(1);
            const chunk = output[0].output[0];
            if (chunk.type !== 'chunk') throw new Error('Expected complete language owner chunk');
            expect(chunk.imports).toEqual([]);expect(chunk.dynamicImports).toEqual([]);
            expect(chunk.moduleIds.filter(id => id.endsWith('/userscript/defaultMessageData.ts'))).toHaveLength(1);
            expect(chunk.moduleIds).toContain('\0fluentread-userscript-zh-cn.js');
            expect(chunk.moduleIds.some(id => id.endsWith('/src/core/i18n/messages/zh-CN.ts')
                || id.endsWith('/userscript/languageBundles.ts') || id.includes('/userscript/languages/'))).toBe(false);
            const request = vi.fn(() => {throw new Error('Unexpected language request');});
            const realm = {languageOwner: undefined as any, Uint8Array, ArrayBuffer, TextDecoder, atob, console,
                DecompressionStream: undefined, GM: {xmlHttpRequest: request}};
            runInNewContext(chunk.code, realm, {timeout: 5000});
            const api = realm.languageOwner;
            const expectedChinese = Object.fromEntries(Object.entries(zhCNMessages).filter(([key]) => !key.startsWith('document.') && !key.startsWith('translationStats.')));
            expect(Array.from(api.readDefaultMessageKeys())).toEqual(Object.keys(expectedChinese).sort());
            expect(api.hasUiLanguageBundle('en-US')).toBe(false);
            for (const [key, text] of Object.entries(expectedChinese)) expect(api.translate(key, 'zh-CN')).toBe(text);
            await expect(api.ensureUiLanguageBundle('en-US')).resolves.toBe(true);
            const expectedEnglish = Object.fromEntries(Object.entries(UI_LANGUAGE_BUNDLES['en-US'].messages).filter(([key]) => !key.startsWith('document.') && !key.startsWith('translationStats.')));
            for (const [key, text] of Object.entries(expectedEnglish)) expect(api.translate(key, 'en-US')).toBe(text);
            expect(api.translateLegacyText('翻译连接：Google；自定义服务：2；凭据和地址已隐藏', 'en-US'))
                .toBe('Connection: Google; custom services: 2; credentials and addresses hidden');
            expect(api.hasUiLanguageBundle('fr-FR')).toBe(false);
            expect(request).not.toHaveBeenCalled();
        } finally {rmSync(fixture, {recursive: true, force: true});vi.unstubAllEnvs();vi.resetModules();}
    }, 30_000);

    // Two modes each compress three catalogs using multiple gzip configurations.
    it('standard and standalone site catalogs preserve the same decoded rules', async () => {
        const results: Array<Array<{encoded:string; bytes:Buffer}>> = [];
        try {
            for (const standalone of ['0', '1']) {
                vi.stubEnv('FLUENTREAD_USERSCRIPT_STANDALONE', standalone);
                vi.stubEnv('FLUENTREAD_USERSCRIPT_GREASYFORK_SOURCE', '0');
                vi.resetModules();
                const {createUserscriptCatalogCompressionPlugin} = await import('@/userscript/vite.config');
                const plugin = createUserscriptCatalogCompressionPlugin() as unknown as {resolveId:(source:string,importer:string)=>string|null;load:(id:string)=>string|null|Promise<string>};
                const importer = resolve(process.cwd(), 'src/core/site-adaptation/catalog.ts');
                const sample=[];
                for (const name of ['established', 'websites', 'profiles']) {
                    const id = plugin.resolveId(`./catalog/${name}.json`, importer)!;
                    const source = (await plugin.load(id))!;
                    const encoded = JSON.parse(source.match(/decodeUserscriptData\(("[^"\n]+")\)/u)![1]) as string;
                    const bytes = Buffer.from(decodeUserscriptData(encoded));
                    const original = JSON.parse(readFileSync(resolve(process.cwd(), `src/core/site-adaptation/catalog/${name}.json`), 'utf8'));
                    expect(gunzipSync(bytes)).toEqual(Buffer.from(JSON.stringify(original)));
                    if (standalone === '1') expect(bytes.length).toBeLessThanOrEqual(gzipUserscriptBuildData(Buffer.from(JSON.stringify(original)), undefined, true).length);
                    sample.push({encoded, bytes});
                }
                results.push(sample);
            }
            expect(results[0].every(item=>item.encoded.startsWith('~85:'))).toBe(true);
            expect(results[1].every(item=>item.encoded.startsWith('~91:'))).toBe(true);
            for (let index = 0; index < results[0].length; index++) {
                expect(results[1][index].bytes.length).toBeLessThanOrEqual(results[0][index].bytes.length);
                expect(gunzipSync(results[1][index].bytes)).toEqual(gunzipSync(results[0][index].bytes));
            }
        } finally {vi.unstubAllEnvs();vi.resetModules();}
    }, 15_000);

    it('propagates a standalone site catalog worker failure', async () => {
        try {
            vi.stubEnv('FLUENTREAD_USERSCRIPT_STANDALONE', '1');
            vi.stubEnv('FLUENTREAD_USERSCRIPT_GREASYFORK_SOURCE', '0');
            vi.resetModules();
            const {createUserscriptCatalogCompressionPlugin: createPlugin} = await import('@/userscript/vite.config');
            const gzipModule = await import('@/userscript/buildGzip');
            const worker = vi.spyOn(gzipModule, 'gzipLargeStandaloneUserscriptData').mockRejectedValueOnce(new Error('controlled catalog worker failure'));
            const plugin = createPlugin() as unknown as {resolveId:(source:string,importer:string)=>string;load:(id:string)=>Promise<string>};
            const id = plugin.resolveId('./catalog/websites.json', resolve(process.cwd(), 'src/core/site-adaptation/catalog.ts'));
            await expect(plugin.load(id)).rejects.toThrow('controlled catalog worker failure');
            expect(worker).toHaveBeenCalledOnce();
            worker.mockRestore();
        } finally {vi.unstubAllEnvs();vi.resetModules();}
    }, 30_000);

    it('keeps the compact catalog gzip when the worker candidate is larger', async () => {
        try {
            vi.stubEnv('FLUENTREAD_USERSCRIPT_STANDALONE', '1');
            vi.stubEnv('FLUENTREAD_USERSCRIPT_GREASYFORK_SOURCE', '0');
            vi.resetModules();
            const {createUserscriptCatalogCompressionPlugin: createPlugin} = await import('@/userscript/vite.config');
            const gzipModule = await import('@/userscript/buildGzip');
            const worker = vi.spyOn(gzipModule, 'gzipLargeStandaloneUserscriptData')
                .mockImplementationOnce(async data => Buffer.alloc(data.byteLength + 1));
            try {
                const plugin = createPlugin() as unknown as {resolveId:(source:string,importer:string)=>string;load:(id:string)=>Promise<string>};
                const id = plugin.resolveId('./catalog/websites.json', resolve(process.cwd(), 'src/core/site-adaptation/catalog.ts'));
                const input = Buffer.from(JSON.stringify(JSON.parse(readFileSync(resolve(process.cwd(), 'src/core/site-adaptation/catalog/websites.json'), 'utf8'))));
                const bytes = Buffer.from(encodedDataBytes(await plugin.load(id))[0]);
                expect(bytes).toEqual(gzipUserscriptBuildData(input, undefined, true));
                expect(gunzipSync(bytes)).toEqual(input);
            } finally {worker.mockRestore();}
        } finally {vi.unstubAllEnvs();vi.resetModules();}
    }, 30_000);

    it('keeps all site rule JSON data intact when embedding compressed offline catalogs', async () => {
        const plugin = createUserscriptCatalogCompressionPlugin() as unknown as {
            resolveId: (source: string, importer: string) => string | null;
            load: (id: string) => string | null;
        };
        const importer = resolve(process.cwd(), 'src/core/site-adaptation/catalog.ts');
        for (const name of ['established', 'websites', 'profiles']) {
            const id = plugin.resolveId(`./catalog/${name}.json`, importer);
            expect(id).toContain('fluentread-userscript-site-catalog:');
            const moduleSource = plugin.load(id!);
            const encoded = encodedDataBytes(moduleSource!)[0];
            const original = JSON.parse(readFileSync(resolve(process.cwd(), `src/core/site-adaptation/catalog/${name}.json`), 'utf8'));
            expect(JSON.parse(gunzipSync(encoded).toString('utf8'))).toEqual(original);
            const {transformWithEsbuild} = await import('vite');
            const compiled = await transformWithEsbuild(moduleSource!, 'offline-catalog.js', {format: 'cjs', target: 'es2018'});
            const inflate = vi.fn(inflateBundledFrancData), decode = vi.fn(decodeUserscriptData);
            const realm = {module: {exports: {} as {default: unknown}}, require: (id: string) => {
                if (id === '@/userscript/pakoRuntime') return {inflateWithPako: inflate};
                if (id === '@/userscript/dataEncoding') return {decodeUserscriptData: decode};
                throw new Error(`Unexpected catalog import: ${id}`);
            }};
            runInNewContext(compiled.code, realm, {timeout: 5_000});
            expect(realm.module.exports.default).toEqual(original);
            expect(decode).toHaveBeenCalledTimes(1);expect(inflate).toHaveBeenCalledTimes(1);
            expect(moduleSource).toContain(createHash('sha256').update(JSON.stringify(original)).digest('hex'));
        }
        expect(plugin.resolveId('./catalog/other.json', importer)).toBeNull();
    });

    it('wraps the complete single-file runtime in a duplicate-injection guard', () => {
        const wrapped = wrapUserscriptEntry('ENTRY_SENTINEL', 'BOOTSTRAP_SENTINEL');
        const guardStart = wrapped.indexOf(executionGuardStart);
        const condition = wrapped.indexOf('if (!globalThis.__fluentReadUserscriptBootstrapped) {');
        const bootstrap = wrapped.indexOf('BOOTSTRAP_SENTINEL');
        const entry = wrapped.indexOf('ENTRY_SENTINEL');
        const guardEnd = wrapped.indexOf(executionGuardEnd);

        expect(guardStart).toBeGreaterThan(-1);
        expect(condition).toBeGreaterThan(guardStart);
        expect(bootstrap).toBeGreaterThan(condition);
        expect(entry).toBeGreaterThan(bootstrap);
        expect(guardEnd).toBeGreaterThan(entry);

        const notices = wrapped.slice(0, guardStart);
        const iconsLicense = readFileSync(resolve(process.cwd(), 'public/third-party-notices/lobe-icons-MIT.txt'), 'utf8');
        const tinycolorLicense = readFileSync(resolve(process.cwd(), 'public/third-party-notices/tinycolor-MIT.txt'), 'utf8');
        const permissionStart = 'Permission is hereby granted';
        const iconsStart = iconsLicense.indexOf(permissionStart);
        const tinycolorStart = tinycolorLicense.indexOf(permissionStart);
        expect(notices).toContain(iconsLicense.slice(0, iconsStart).trimEnd());
        expect(notices).toContain('@ctrl/tinycolor 3.6.1 — MIT');
        expect(notices).toContain(tinycolorLicense.slice(0, tinycolorStart).trimEnd());
        expect(notices).toContain(iconsLicense.slice(iconsStart).trimEnd());
        const sharedMitStart = notices.indexOf(`/*\n${iconsLicense.slice(0, iconsStart).trimEnd()}`);
        expect(sharedMitStart).toBeGreaterThanOrEqual(0);
        const sharedMitEnd = notices.indexOf('\n*/', sharedMitStart);
        expect(sharedMitEnd).toBeGreaterThan(sharedMitStart);
        expect(notices.slice(sharedMitStart, sharedMitEnd + 3).split(permissionStart)).toHaveLength(2);
        const unicodeLicense = readFileSync(resolve(process.cwd(), 'public/third-party-notices/unicode-17.0.0.txt'), 'utf8');
        expect(notices).toContain(`/*\n${unicodeLicense}\n*/`);
        expect(wrapped.slice(guardStart)).toBe([
            executionGuardStart,
            'if (!globalThis.__fluentReadUserscriptBootstrapped) {',
            'BOOTSTRAP_SENTINEL', 'ENTRY_SENTINEL', '}', executionGuardEnd,
        ].join('\n'));
    });

    it('在 app 使用的 public contract 边界替换扩展专属 feature 与可信 GM 凭据上下文', () => {
        const stringAliases = new Map(userscriptAliases
            .filter((entry): entry is {find: string; replacement: string} => typeof entry.find === 'string')
            .map((entry) => [entry.find, entry.replacement]));

        for (const feature of ['area-translation', 'image-translation', 'video-subtitle', 'personal-corrections']) {
            expect(stringAliases.get(`@/src/features/${feature}/public`)).toMatch(/userscript\/unsupportedCapabilities\.ts$/u);
        }
        expect(stringAliases.get('@/src/features/writing-assistant/public')).toMatch(/userscript\/writingAssistant\.ts$/u);
        expect(stringAliases.get('@/src/platform/storage/credentialContext')).toMatch(/userscript\/credentialContext\.ts$/u);
        expect(stringAliases.get('@/src/platform/storage/configStorageRuntime')).toMatch(/userscript\/storage\.ts$/u);
        expect(userscriptAliases.at(-1)?.find).toBe('@');
    });

    it('移除 userscript 不可达的字幕外观组件后才排除其专用读音文案', async () => {
        const {parse, compileScript} = await import('vue/compiler-sfc');
        const {transformWithEsbuild} = await import('vite');
        const filename = resolve(process.cwd(), 'src/features/settings/ui/SettingsSections.vue');
        const {descriptor} = parse(readFileSync(filename, 'utf8'), {filename});
        const source = compileScript(descriptor, {id: 'userscript-video-appearance-boundary'}).content;
        const compile = async (browser: string) => (await transformWithEsbuild(source, 'settings-sections.ts', {
            loader: 'ts', define: {'import.meta.env.BROWSER': JSON.stringify(browser)}, treeShaking: true, minifySyntax: true,
        })).code;
        const userscript = await compile('userscript');
        expect(userscript).not.toContain('VideoSubtitleAppearanceSettings.vue');
        expect(userscript).toMatch(/\bVideoSubtitleAppearanceSettings = null\b/u);
        expect(await compile('chrome')).toContain('VideoSubtitleAppearanceSettings.vue');
    });

    it('阻止个人校订 UI 绕过 public 空适配器进入任意 userscript chunk', async () => {
        const plugins = (userscriptConfig as {plugins: Array<{name: string; generateBundle?: {handler: Function}}>}).plugins;
        const plugin = plugins.find(item => item.name === 'bundle-userscript-css')!;
        const entry = {type: 'chunk', isEntry: true, code: 'var fixture = 1;', moduleIds: []};
        const correctionModule = `${resolve(process.cwd(), 'src/features/personal-corrections/ui/PersonalCorrectionsPanel.vue')}?vue&type=script`;
        const otherChunk = {type: 'chunk', isEntry: false, code: '', moduleIds: [correctionModule]};
        await expect(Reflect.apply(plugin.generateBundle!.handler, {}, [{}, {'entry.js': entry, 'other.js': otherChunk}]))
            .rejects.toThrow(`Userscript bundle contains unsupported personal correction feature: ${correctionModule}`);
        expect(entry.code).toBe('var fixture = 1;');

        otherChunk.moduleIds = [resolve(process.cwd(), 'src/features/personal-corrections-other/public.ts')];
        await expect(Reflect.apply(plugin.generateBundle!.handler, {}, [{}, {'entry.js': entry, 'other.js': otherChunk}])).resolves.toBeUndefined();
    });

    it('只在 userscript 构建中移除 inline page.css 的扩展校订来源提示，保留重试样式', () => {
        const plugins = (userscriptConfig as {plugins: Array<{name: string; transform?: {order: string; handler: Function}}>}).plugins;
        const plugin = plugins.find(item => item.name === 'bundle-userscript-css')!;
        const pageCss = resolve(process.cwd(), 'src/app/content/page.css');
        const source = readFileSync(pageCss, 'utf8');
        expect(source).toContain('data-fr-personal-correction');
        expect(plugin.transform!.order).toBe('pre');
        const transformed = Reflect.apply(plugin.transform!.handler, {}, [source, `${pageCss}?inline`]);
        expect(transformed.code).not.toContain('data-fr-personal-correction');
        expect(transformed.code).toContain('.fluent-read-retry-wrapper');
        expect(transformed.map).toBeNull();
        expect(Reflect.apply(plugin.transform!.handler, {}, [transformed.code, pageCss])).toBeNull();
        expect(Reflect.apply(plugin.transform!.handler, {}, [source, `${pageCss}.other.css?inline`])).toBeNull();
        expect(readFileSync(pageCss, 'utf8')).toBe(source);
    });

    it('把 dexie 换成不注册全局单例的入口，且不改写 dexie 自身的实现产物路径', () => {
        const dexieAlias = userscriptAliases.find((entry) => entry.find instanceof RegExp
            && (entry.find as RegExp).test('dexie'));

        expect(dexieAlias?.replacement).toMatch(/userscript\/dexie\.ts$/u);
        // 别名必须严格匹配裸模块名；否则 userscript/dexie.ts 内部对实现产物的引用会被改写回自身。
        expect((dexieAlias!.find as RegExp).test('dexie/dist/dexie.min.js')).toBe(false);
    });

    it('产物中残留 Dexie 全局注册时能被构建守卫识别', () => {
        expect(findDexieGlobalRegistration('const s=Symbol.for("Dexie");globalThis[s]=D;')).toBe(true);
        expect(findDexieGlobalRegistration("globalThis[Symbol.for('Dexie')]=D;")).toBe(true);
        expect(findDexieGlobalRegistration('Symbol . for ( "Dexie" )')).toBe(true);
        expect(findDexieGlobalRegistration('Symbol.for("vercel.ai.schema")')).toBe(false);
        expect(findDexieGlobalRegistration('const label="Dexie";')).toBe(false);
    });

    it('imports only unresolved browser globals', () => {
        const transformed = injectUserscriptBrowserImports(
            'browser.runtime.sendMessage({}); chrome.runtime.getURL("icon.png");',
            entrypointId,
        );

        expect(transformed).toContain('import {default as browser, chrome}');

        expect(injectUserscriptBrowserImports(
            'browser.runtime.sendMessage({type: "from-app"});',
            sourceModuleId,
        )).toContain('import {default as browser}');
        expect(injectUserscriptBrowserImports(
            'chrome.runtime.getURL("from-vue.png");',
            vueScriptModuleId,
        )).toContain('import {chrome}');
    });

    it('ignores property names and lexically bound identifiers', () => {
        expect(injectUserscriptBrowserImports(
            'const extensionGlobal = {} as {browser?: unknown}; void extensionGlobal.browser;',
            entrypointId,
        )).toBeNull();
        expect(injectUserscriptBrowserImports(
            'function useBrowser(browser: {runtime: unknown}) { return browser.runtime; }',
            entrypointId,
        )).toBeNull();
        expect(injectUserscriptBrowserImports(
            'import chrome from "webextension-polyfill"; void chrome.runtime;',
            entrypointId,
        )).toBeNull();
        expect(injectUserscriptBrowserImports(
            'browser.runtime.sendMessage({});',
            '/tmp/fluentread-external-module.ts',
        )).toBeNull();
        expect(injectUserscriptBrowserImports(
            '<script setup>browser.runtime.sendMessage({})</script>',
            resolve(process.cwd(), 'src/RawComponent.vue'),
        )).toBeNull();
    });

    it('checks generated JavaScript for free extension globals', () => {
        const bundleId = resolve(process.cwd(), '.output/userscript/fluent-read.user.js');
        expect(findFreeBrowserGlobals(
            'const browser = {runtime: {}}; void browser.runtime; const chrome = browser; void chrome.runtime;',
            bundleId,
        )).toEqual([]);
        expect(findFreeBrowserGlobals(
            'browser.runtime.sendMessage({}); chrome.runtime.getURL("icon.png");',
            bundleId,
        )).toEqual(['browser', 'chrome']);
    });
});


describe('userscript lossless Unicode character data', () => {
    const dataPath = resolve(process.cwd(), 'src/core/language/chineseVariants.ts');
    const wordDataPath = resolve(process.cwd(), 'src/core/language/functionWordData.ts');
    const createPlugin = (enabled = true) => createUserscriptCharacterDataCompressionPlugin(process.cwd(), enabled) as unknown as {
        transform: (code: string, id: string) => {code: string; map: null} | null;
    };
    const restoreExports = (moduleSource: string, names: readonly string[]) => {
        const body = moduleSource.replace("import {inflateWithPako} from '@/userscript/pakoRuntime';", '')
            .replace("import {decodeUserscriptData} from '@/userscript/dataEncoding';", '')
            .replace(/export const /gu, 'const ');
        // 使用生产解压适配器和真实 pako；禁止 fromCodePoint，覆盖旧内核上的补充平面还原。
        return runInNewContext(
            'String.fromCodePoint = undefined;\n' + body + '\n({' + names.join(',') + '})',
            {atob: (value: string) => Buffer.from(value, 'base64').toString('binary'), Uint8Array, inflateWithPako, decodeUserscriptData},
        );
    };

    it.each([[dataPath, chineseCharacterData], [wordDataPath, functionWordData]])(
        'roundtrips the complete standalone character data from %s', (path, expected) => {
            const plugin = createUserscriptCharacterDataCompressionPlugin(process.cwd(), true, true) as unknown as {
                transform: (code: string, id: string) => {code: string} | null;
            };
            const transformed = plugin.transform(readFileSync(path, 'utf8'), path)!;
            vi.stubGlobal('pako', {ungzip});
            try {
                expect(restoreExports(transformed.code, Object.keys(expected))).toEqual({...expected});
            } finally {vi.unstubAllGlobals();}
        },
    );

    it('restores every generated Unicode character exactly before Chinese detection consumes it', () => {
        const original = readFileSync(dataPath, 'utf8');
        const transformed = createPlugin().transform(original, dataPath);
        expect(transformed).not.toBeNull();
        encodedDataBytes(transformed!.code)[0];
        vi.stubGlobal('pako', {ungzip});
        try {
            const restored = restoreExports(transformed!.code, Object.keys(chineseCharacterData));
            expect(restored).toEqual({...chineseCharacterData});
            for (const value of Object.values(chineseCharacterData)) {
                expect(typeof value).toBe('string');
                expect(value.length).toBeGreaterThan(0);
            }
            expect(Array.from(restored.simplifiedOnlyCharacters as string).some((character) => character.codePointAt(0)! > 0xFFFF)).toBe(true);
            expect(Array.from(restored.traditionalOnlyCharacters as string).some((character) => character.codePointAt(0)! > 0xFFFF)).toBe(true);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('restores all 46 function-word strings byte for byte and preserves the audited lexicon digest', () => {
        const entries = Object.entries(functionWordData).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
        expect(entries).toHaveLength(46);
        // 提取前四组功能词原始字符串的摘要；按导出名排序，不依赖 module namespace 的枚举实现。
        expect(createHash('sha256').update(JSON.stringify(entries)).digest('hex'))
            .toBe('998dc8f897b31a8b91eaaec8ffe4e563b513fe856a6f91d8d528209d90f15ca1');
        const transformed = createPlugin().transform(readFileSync(wordDataPath, 'utf8'), wordDataPath)!;
        vi.stubGlobal('pako', {ungzip});
        try {
            const restored = restoreExports(transformed.code, Object.keys(functionWordData));
            expect(restored).toEqual({...functionWordData});
            for (const [name, value] of entries) {
                expect(Buffer.from(restored[name], 'utf8')).toEqual(Buffer.from(value, 'utf8'));
            }
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it.each([[dataPath, [[65, 128]], 'AÁ'], [wordDataPath, ['AÁ'], 'AÁ']] as const)(
        'changes only the byte representation of the original gzip payload in %s', (path, tables, value) => {
            const source = 'export const sample = ' + JSON.stringify(value) + ';';
            const [bytes] = encodedDataBytes(createPlugin().transform(source, path)!.code);
            expect(Buffer.from(bytes)).toEqual(gzipUserscriptBuildData(Buffer.from(JSON.stringify(tables))));
        });

    it.each([dataPath, wordDataPath])('preserves unsorted strings, repeated characters, surrogate pairs and empty exports in %s', currentPath => {
        const values = {sample: 'A𱊯A\0\ud800', empty: ''};
        const original = Object.entries(values).map(([name, value]) => 'export const ' + name + ' = ' + JSON.stringify(value) + ';').join('\n');
        const transformed = createPlugin().transform(original, currentPath)!;
        vi.stubGlobal('pako', {ungzip});
        try {
            expect(restoreExports(transformed.code, Object.keys(values))).toEqual(values);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it.each([dataPath, wordDataPath])('rejects executable additions to %s instead of dropping or compressing them', currentPath => {
        const original = readFileSync(currentPath, 'utf8');
        expect(() => createPlugin().transform(original + '\nsideEffect();', currentPath)).toThrow('only exported const strings');
        expect(() => createPlugin().transform('export const data = makeData();', currentPath)).toThrow('only exported const strings');
        expect(() => createPlugin().transform('const privateData = "data";', currentPath)).toThrow('only exported const strings');
    });

    it('leaves Greasy Fork source and every other module untouched', () => {
        const original = readFileSync(dataPath, 'utf8');
        expect(createPlugin(false).transform(original, dataPath)).toBeNull();
        expect(createPlugin(false).transform(readFileSync(wordDataPath, 'utf8'), wordDataPath)).toBeNull();
        expect(createPlugin().transform(original, resolve(process.cwd(), 'src/core/language/chinese.ts'))).toBeNull();
        expect(createPlugin().transform(original, resolve(process.cwd(), 'src/core/language/lexicon.ts'))).toBeNull();
        expect(createPlugin().transform(original, wordDataPath + '.backup')).toBeNull();
    });
});


describe('userscript locked franc pure-data encoding', () => {
    const require = createRequire(resolve(process.cwd(), 'package.json'));
    const dataPath = realpathSync(require.resolve('franc-min/data.js'));
    const original = readFileSync(dataPath, 'utf8');
    const createPlugin = (enabled = true, root = process.cwd(), compact = false) => createUserscriptFrancDataCompressionPlugin(root, enabled, compact) as unknown as {
        name: string;
        transform: (code: string, id: string) => {code: string; map: null} | null;
    };
    const restoreData = (moduleSource: string, inflate = inflateBundledFrancData): typeof lockedFrancData => {
        const body = moduleSource.replace("import {inflateWithPako} from '@/userscript/pakoRuntime';", '')
            .replace("import {decodeUserscriptData} from '@/userscript/dataEncoding';", '')
            .replace('export const data =', 'const data =');
        // 执行生成的纯数据模块与生产 bundled pako；不执行整包，也不复制检测算法。
        return runInNewContext(body + '\ndata;', {atob, Uint8Array, JSON, decodeUserscriptData, inflateWithPako: inflate}, {timeout: 5_000});
    };

    it('preserves every model when standalone compresses the real payload in the isolated worker', async () => {
        const plugin = createUserscriptFrancDataCompressionPlugin(process.cwd(), true, true, true) as unknown as {
            transform: (code: string, id: string) => Promise<{code: string; map: null}>;
        };
        const transformed = await plugin.transform(original, dataPath);
        const [bytes] = encodedDataBytes(transformed.code);
        expect(gunzipSync(bytes)).toEqual(Buffer.from(JSON.stringify(lockedFrancData)));
        expect(restoreData(transformed.code)).toEqual(lockedFrancData);
        expect(Object.values(restoreData(transformed.code)).reduce((sum, models) => sum + Object.keys(models).length, 0)).toBe(66);
    });

    it('restores every locked model string and its iteration order before the unchanged franc algorithm consumes it', () => {
        const transformed = createPlugin(true, process.cwd(), true).transform(original, dataPath)!;
        expect(transformed.map).toBeNull();
        const [bytes] = encodedDataBytes(transformed.code);
        expect(Buffer.from(bytes)).toEqual(gzipUserscriptBuildData(Buffer.from(JSON.stringify(lockedFrancData))));
        const restored = restoreData(transformed.code);
        expect(Object.keys(restored)).toEqual(Object.keys(lockedFrancData));
        expect(Object.getPrototypeOf(restored)).toBe(Object.getPrototypeOf(lockedFrancData));
        let models = 0;
        for (const [script, values] of Object.entries(lockedFrancData)) {
            expect(Object.keys(restored[script])).toEqual(Object.keys(values));
            expect(Object.getPrototypeOf(restored[script])).toBe(Object.getPrototypeOf(values));
            for (const [language, text] of Object.entries(values)) {
                expect(restored[script][language]).toBe(text);
                expect(Buffer.from(restored[script][language], 'utf8')).toEqual(Buffer.from(text, 'utf8'));
                models++;
            }
        }
        expect(models).toBe(66);
    });

    it('compact standalone franc data decodes the identical gzip bytes and all models through the existing codec', () => {
        const legacy = createPlugin().transform(original, dataPath)!.code;
        const compact = createPlugin(true, process.cwd(), true).transform(original, dataPath)!.code;
        const base64 = JSON.parse(legacy.match(/atob\(("[^"]+")\)/u)![1]);
        const encoded = JSON.parse(compact.match(/decodeUserscriptData\(("[^"]+")\)/u)![1]);
        expect(encoded.startsWith('~91:')).toBe(true);expect(compact).not.toContain('atob(');
        expect(Buffer.from(decodeUserscriptData(encoded))).toEqual(Buffer.from(base64, 'base64'));
        expect(restoreData(compact)).toEqual(restoreData(legacy));
        expect(Buffer.byteLength(compact)).toBeLessThan(Buffer.byteLength(legacy));
        // The same legacy call remains byte-for-byte stable when compact is omitted/false.
        expect(createPlugin(true, process.cwd(), false).transform(original, dataPath)!.code).toBe(legacy);
    });

    it('preserves repeated characters, supplementary characters, escapes and empty model strings without sorting keys', () => {
        const data = structuredClone(lockedFrancData);
        const models = data.Latin;
        const [first, second] = Object.keys(models);
        models[first] = 'A𱊯A\0\ud800';
        models[second] = '';
        const source = 'export const data = ' + JSON.stringify(data) + ';';
        const transformed = createPlugin().transform(source, dataPath)!;
        const restored = restoreData(transformed.code);
        expect(restored).toEqual(data);
        expect(Object.keys(restored.Latin)).toEqual(Object.keys(models));
        expect(restored.Latin[first]).toBe(models[first]);
        expect(restored.Latin[second]).toBe('');
    });

    it('restores no-substitution template strings through the same complete two-level data schema', () => {
        const expected = structuredClone(lockedFrancData);
        const first = Object.keys(expected.Latin)[0];
        expected.Latin[first] = 'line1\n𱊯\0\ud800';
        const placeholder = structuredClone(expected);
        placeholder.Latin[first] = '__franc_template_fixture__';
        const source = 'export const data = ' + JSON.stringify(placeholder)
            .replace('"__franc_template_fixture__"', '`line1\\n𱊯\\0\\ud800`') + ';';
        const restored = restoreData(createPlugin().transform(source, dataPath)!.code);
        expect(restored).toEqual(expected);
        expect(restored.Latin[first]).toBe(expected.Latin[first]);
        expect(Object.keys(restored.Latin)).toEqual(Object.keys(expected.Latin));
    });

    it('defaults to disabled without resolving a dependency in an unavailable root', () => {
        const disabled = createUserscriptFrancDataCompressionPlugin('/unavailable-franc-root');
        if (typeof disabled.transform !== 'function') throw new Error('Expected the public plugin transform hook');
        expect(Reflect.apply(disabled.transform, disabled, ['export const data = {', dataPath])).toBeNull();
        expect(createPlugin(false, '/unavailable-franc-root').transform(original, dataPath)).toBeNull();
    });

    it.each([
        ['logic', original + '\nsideEffect();'],
        ['let', original.replace('export const data', 'export let data')],
        ['wrong-export', original.replace('export const data', 'export const other')],
        ['default', 'export default {};'],
        ['extra-declaration', 'export const data = {}, other = 1;'],
        ['syntax', 'export const data = {'],
        ['call', 'export const data = {Latin: {eng: makeData()}};'],
        ['getter', 'export const data = {get Latin() { return {}; }};'],
        ['spread', 'export const data = {...other};'],
        ['computed-key', 'export const data = {["Latin"]: {eng: "a"}};'],
        ['proto', 'export const data = {"__proto__": {eng: "a"}};'],
        ['duplicate', 'export const data = {Latin: {eng: "a", eng: "b"}};'],
        ['wrong-depth', 'export const data = {Latin: {eng: {text: "a"}}};'],
        ['number', 'export const data = {Latin: {eng: 42}};'],
        ['empty', 'export const data = {};'],
        ['wrong-model-count', 'export const data = {Latin: {eng: "a"}, Cyrillic: {rus: "b"}, Arabic: {arb: "c"}, Devanagari: {hin: "d"}};'],
        ['wrong-script-order', 'export const data = ' + JSON.stringify(Object.fromEntries(Object.entries(lockedFrancData).reverse())) + ';'],
        ['missing-export', original.replace('export const data', 'const data')],
        ['extra-modifier', original.replace('export const data', 'export declare const data')],
        ['destructured-binding', 'export const {data} = {data: {}};'],
        ['missing-initializer', 'export const data;'],
        ['top-level-string', 'export const data = "data";'],
        ['inner-string', 'export const data = {Latin: "data"};'],
        ['inner-empty-object', 'export const data = {Latin: {}};'],
        ['interpolated-template', 'export const data = {Latin: {eng: `a${sideEffect()}`}};'],
        ['numeric-key', 'export const data = {Latin: {1: "a"}};'],
        ['duplicate-script', 'export const data = {Latin: {eng: "a"}, Latin: {eng: "b"}};'],
        ['empty-source', ''],

    ])('rejects %s rather than evaluating or silently compressing executable/unknown source', (_label, source) => {
        expect(() => createPlugin().transform(source, dataPath)).toThrow('one exported const data object of model strings');
    });

    it.each([
        ['raw', dataPath + '?raw'],
        ['proxy', dataPath + '?commonjs-proxy'],
        ['virtual', '\0' + dataPath],
        ['expressions', require.resolve('franc-min/expressions.js')],
        ['unrelated', resolve(process.cwd(), 'data.js')],
    ])('leaves %s and disabled modules untouched without trying to parse them', (_label, id) => {
        expect(createPlugin().transform('throw Error("must not parse")', id)).toBeNull();
        expect(createPlugin(false).transform(original, dataPath)).toBeNull();
        expect(createPlugin(false, '/unavailable-root').transform('export const data = {', dataPath)).toBeNull();
    });

    it.each([
        ['ordinary', '0', '0', true],
        ['standalone', '1', '0', true],
        ['greasy-fork', '0', '1', false],
        ['standalone-and-greasy', '1', '1', false],
    ] as const)('binds the actual %s config target to the exact data plugin and existing pako alias', async (_label, standalone, greasy, enabled) => {
        vi.stubEnv('FLUENTREAD_USERSCRIPT_STANDALONE', standalone);
        vi.stubEnv('FLUENTREAD_USERSCRIPT_GREASYFORK_SOURCE', greasy);
        vi.stubEnv('FLUENTREAD_USERSCRIPT_VENDOR_URL', 'https://fixture.invalid/vendor.js');
        vi.stubEnv('FLUENTREAD_USERSCRIPT_DATA_URL', 'https://fixture.invalid/data.js');
        try {
            vi.resetModules();
            const {default: configuration, userscriptAliases: aliases} = await import('@/userscript/vite.config');
            const config = configuration as unknown as {plugins: Array<{name?: string; transform?: unknown}>};
            const plugin = config.plugins.find(item => item.name === 'compress-standalone-franc-data') as unknown as ReturnType<typeof createPlugin>;
            expect(plugin).toBeDefined();
            const result = await plugin.transform(original, dataPath);
            if (enabled) {
                expect(restoreData(result!.code)).toEqual(lockedFrancData);
                expect(result!.code.includes('decodeUserscriptData(')).toBe(enabled);
            }
            else expect(result).toBeNull();
            const bundled = aliases.find(alias => alias.find === '@/userscript/pakoRuntime');
            expect(bundled?.replacement).toBe(standalone === '1' ? resolve(process.cwd(), 'userscript/pakoBundled.ts') : undefined);
        } finally {
            vi.unstubAllEnvs();
            vi.resetModules();
        }
    }, 30_000);

    it.each([
        ['new-version', {name: 'franc-min', version: '6.3.0'}],
        ['other-package', {name: 'other-package', version: '6.2.0'}],
        ['missing-version', {name: 'franc-min'}],
    ])('fails closed for %s before transforming any dependency data', (_label, manifest) => {
        const fixture = mkdtempSync(resolve(tmpdir(), 'fluentread-franc-data-owner-'));
        try {
            writeFileSync(resolve(fixture, 'package.json'), '{}');
            const packageRoot = resolve(fixture, 'node_modules/franc-min');
            mkdirSync(packageRoot, {recursive: true});
            writeFileSync(resolve(packageRoot, 'package.json'), JSON.stringify({...manifest, main: 'index.js'}));
            writeFileSync(resolve(packageRoot, 'index.js'), 'export {};');
            writeFileSync(resolve(packageRoot, 'data.js'), original);
            expect(() => createPlugin(true, fixture)).toThrow('requires locked franc-min 6.2.0');
        } finally {
            rmSync(fixture, {recursive: true, force: true});
        }
    });

    it('propagates restoration failure and retains the original module heading/digest instead of a fallback detector', () => {
        const transformed = createPlugin().transform(original, dataPath)!;
        const failure = new Error('controlled decoder failure');
        expect(() => restoreData(transformed.code, () => {throw failure;})).toThrow(failure);
        expect(transformed.code.startsWith(original.slice(0, original.indexOf('export const data')))).toBe(true);
        expect(transformed.code).toContain('source sha256 ' + createHash('sha256').update(original).digest('hex'));
        // 不改真实库文件/module id，现有 bundledLibraryNotices 根据原 package 归属保留 MIT。
        expect(readFileSync(dataPath, 'utf8')).toBe(original);
        const manifest = JSON.parse(readFileSync(resolve(dataPath, '../package.json'), 'utf8'));
        expect(manifest).toMatchObject({name: 'franc-min', version: '6.2.0', license: 'MIT'});
    });
});


describe('standalone locked public and private suffix pure-data encoding', () => {
    const require = createRequire(resolve(process.cwd(), 'package.json'));
    const packageRoot = resolve(realpathSync(require.resolve('tldts/package.json')), '..');
    const dataPath = realpathSync(resolve(packageRoot, 'dist/es6/src/data/trie.js'));
    const original = readFileSync(dataPath, 'utf8');
    const originalLicense = readFileSync(resolve(packageRoot, 'LICENSE'), 'utf8');
    const exportNames = ['nodeFlags', 'edgeStart', 'edgeLength', 'edgeChild', 'labelText', 'rulesRoot', 'exceptionsRoot'] as const;
    const arrayNames = ['nodeFlags', 'edgeStart', 'edgeLength', 'edgeChild'] as const;
    type TrieData = {
        nodeFlags: Uint8Array;
        edgeStart: Uint16Array;
        edgeLength: Uint8Array;
        edgeChild: Uint16Array;
        labelText: string;
        rulesRoot: number;
        exceptionsRoot: number;
    };
    const createPlugin = (enabled = true, root = process.cwd(), compact = false, standalone = false) => createUserscriptTldtsDataCompressionPlugin(root, enabled, compact, standalone) as unknown as {
        name: string;
        transform: (code: string, id: string) => {code: string; map: null} | null;
    };
    const restoreData = (moduleSource: string, inflate = inflateBundledTldtsData, decode = decodeBundledTldtsLabels): TrieData => {
        const body = moduleSource.replace("import {inflateBytesWithPako, decodeUtf8WithPako} from '@/userscript/pakoBundled';", '')
            .replace("import {decodeUserscriptData} from '@/userscript/dataEncoding';", '')
            .replace(/\bexport const\b/gu, 'const');
        // 仅执行原厂或生成的纯数据声明，复用真实 bundled decoder；不运行匹配算法或完整 userscript。
        return runInNewContext(body + '\n({' + exportNames.join(', ') + '});', {
            atob, Uint8Array, Uint16Array, JSON, decodeUserscriptData, inflateBytesWithPako: inflate, decodeUtf8WithPako: decode,
        }, {timeout: 5_000}) as TrieData;
    };
    const locked = restoreData(original);
    const fixtureSource = (data: TrieData): string => [
        'export const nodeFlags = new Uint8Array(' + JSON.stringify(Array.from(data.nodeFlags)) + ');',
        'export const edgeStart = new Uint16Array(' + JSON.stringify(Array.from(data.edgeStart)) + ');',
        'export const edgeLength = new Uint8Array(' + JSON.stringify(Array.from(data.edgeLength)) + ');',
        'export const edgeChild = new Uint16Array(' + JSON.stringify(Array.from(data.edgeChild)) + ');',
        'export const labelText = ' + JSON.stringify(data.labelText) + ';',
        'export const rulesRoot = ' + JSON.stringify(data.rulesRoot) + ';',
        'export const exceptionsRoot = ' + JSON.stringify(data.exceptionsRoot) + ';',
    ].join('\n');

    it('restores all seven exports, every typed-array value and both ICANN/private flag classes without changing order', () => {
        const transformed = createPlugin(true, process.cwd(), true).transform(original, dataPath)!;
        const tables = arrayNames.map(name => {
            const array = locked[name], buffer = Buffer.alloc(array.byteLength);
            for (const [index, value] of array.entries()) {
                if (array.BYTES_PER_ELEMENT === 1) buffer[index] = value;
                else buffer.writeUInt16LE(value, index * 2);
            }
            return buffer;
        });
        const [bytes] = encodedDataBytes(transformed.code);
        expect(Buffer.from(bytes)).toEqual(gzipUserscriptBuildData(Buffer.concat([
            ...tables, Buffer.from(JSON.stringify(locked.labelText), 'utf8'),
        ]), undefined, true));
        const restored = restoreData(transformed.code);
        expect(transformed.map).toBeNull();
        expect(Object.keys(restored)).toEqual(exportNames);
        expect(Object.keys(locked)).toEqual(exportNames);
        for (const name of arrayNames) {
            const actual = restored[name];
            const expected = locked[name];
            expect(actual.constructor).toBe(expected.constructor);
            expect(Object.getPrototypeOf(actual)).toBe(Object.getPrototypeOf(expected));
            expect(actual.length).toBe(expected.length);
            expect(Array.from(actual)).toEqual(Array.from(expected));
            expect(Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength))
                .toEqual(Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength));
        }
        expect(locked.nodeFlags).toContain(1);
        expect(locked.nodeFlags).toContain(2);
        // String equality preserves every UTF-16 code unit, including labels in the exception/private tries.
        expect(restored.labelText).toBe(locked.labelText);
        expect(Buffer.from(restored.labelText, 'utf8')).toEqual(Buffer.from(locked.labelText, 'utf8'));
        expect(restored.rulesRoot).toBe(locked.rulesRoot);
        expect(restored.exceptionsRoot).toBe(locked.exceptionsRoot);
    });

    it('compact standalone suffix data retains decoded bytes, typed arrays, roots and UTF-16 label order', () => {
        const legacy = createPlugin().transform(original, dataPath)!.code;
        const compact = createPlugin(true, process.cwd(), true).transform(original, dataPath)!.code;
        const base64 = JSON.parse(legacy.match(/atob\(("[^"]+")\)/u)![1]);
        const encoded = JSON.parse(compact.match(/decodeUserscriptData\(("[^"]+")\)/u)![1]);
        expect(encoded.startsWith('~91:')).toBe(true);expect(compact).not.toContain('atob(');
        const compactBytes = Buffer.from(decodeUserscriptData(encoded)), legacyBytes = Buffer.from(base64, 'base64');
        expect(compactBytes.length).toBeLessThanOrEqual(legacyBytes.length);
        expect(gunzipSync(compactBytes)).toEqual(gunzipSync(legacyBytes));
        const a = restoreData(legacy), b = restoreData(compact);
        for (const name of arrayNames) {expect(b[name].constructor).toBe(a[name].constructor);expect(Buffer.from(b[name].buffer)).toEqual(Buffer.from(a[name].buffer));}
        expect(b.labelText).toBe(a.labelText);expect(b.rulesRoot).toBe(a.rulesRoot);expect(b.exceptionsRoot).toBe(a.exceptionsRoot);
        expect(Buffer.byteLength(compact)).toBeLessThan(Buffer.byteLength(legacy));
        expect(createPlugin(true, process.cwd(), false).transform(original, dataPath)!.code).toBe(legacy);
    });

    it('roundtrips every locked suffix export with isolated standalone compression', async () => {
        const compact = createPlugin(true, process.cwd(), true).transform(original, dataPath)!;
        const standalone = await createPlugin(true, process.cwd(), true, true).transform(original, dataPath)!;
        const [before] = encodedDataBytes(compact.code), [after] = encodedDataBytes(standalone.code);
        expect(after.byteLength).toBeLessThanOrEqual(before.byteLength);
        expect(gunzipSync(after)).toEqual(gunzipSync(before));
        const restored = restoreData(standalone.code);
        for (const name of arrayNames) {
            expect(restored[name].constructor).toBe(locked[name].constructor);
            expect(Array.from(restored[name])).toEqual(Array.from(locked[name]));
        }
        expect(restored.labelText).toBe(locked.labelText);
        expect(restored.rulesRoot).toBe(locked.rulesRoot);
        expect(restored.exceptionsRoot).toBe(locked.exceptionsRoot);
    });

    it.each(['failure', 'corrupt', 'larger'] as const)(
        'keeps the compact fallback and fails closed for isolated worker %s', async mode => {
            const fixture = mkdtempSync(resolve(tmpdir(), 'fluentread-tldts-worker-'));
            try {
                const packageRoot = resolve(fixture, 'node_modules/tldts');
                const fixturePath = resolve(packageRoot, 'dist/es6/src/data/trie.js');
                mkdirSync(resolve(packageRoot, 'dist/es6/src/data'), {recursive: true});
                mkdirSync(resolve(fixture, 'userscript'), {recursive: true});
                writeFileSync(resolve(fixture, 'package.json'), '{}');
                writeFileSync(resolve(packageRoot, 'package.json'), JSON.stringify({name: 'tldts', version: '7.4.10'}));
                writeFileSync(fixturePath, original);
                const worker = mode === 'failure' ? "throw new Error('controlled worker failure');" : mode === 'corrupt'
                    ? "require('node:worker_threads').parentPort.postMessage(new Uint8Array([1, 2]));"
                    : "const {parentPort,workerData}=require('node:worker_threads'); parentPort.postMessage(require('node:zlib').gzipSync(workerData,{level:0}));";
                writeFileSync(resolve(fixture, 'userscript/zopfliBuildWorker.cjs'), worker);
                const canonicalPath = realpathSync(fixturePath);
                const promise = Promise.resolve(createPlugin(true, fixture, true, true).transform(original, canonicalPath)!);
                if (mode !== 'larger') await expect(promise).rejects.toThrow();
                else {
                    const result = await promise;
                    const standard = createPlugin(true, fixture, true).transform(original, canonicalPath)!;
                    expect(encodedDataBytes(result.code)[0]).toEqual(encodedDataBytes(standard.code)[0]);
                    expect(restoreData(result.code).labelText).toBe(locked.labelText);
                }
            } finally {rmSync(fixture, {recursive: true, force: true});}
        },
    );

    it('roundtrips boundary integers and escaped label text without retaining plain numeric arrays as exports', () => {
        const data: TrieData = {
            ...locked,
            nodeFlags: locked.nodeFlags.slice(),
            edgeStart: locked.edgeStart.slice(),
            edgeLength: locked.edgeLength.slice(),
            edgeChild: locked.edgeChild.slice(),
            labelText: 'A𱊯A\0\ud800\n"\\',
            rulesRoot: 0,
            exceptionsRoot: locked.nodeFlags.length - 1,
        };
        // This is a codec-boundary fixture, not a new executable/domain-lookup fixture.
        data.nodeFlags[0] = 0; data.nodeFlags[1] = 255;
        data.edgeStart[0] = 0; data.edgeStart[1] = 65535;
        data.edgeLength[0] = 0; data.edgeLength[1] = 255;
        data.edgeChild[0] = 0; data.edgeChild[1] = 65535;
        const restored = restoreData(createPlugin().transform(fixtureSource(data), dataPath)!.code);
        for (const name of arrayNames) {
            expect(restored[name].constructor).toBe(data[name].constructor);
            expect(Array.from(restored[name])).toEqual(Array.from(data[name]));
            expect(Array.isArray(restored[name])).toBe(false);
        }
        expect(restored.labelText).toBe(data.labelText);
        expect(restored.rulesRoot).toBe(data.rulesRoot);
        expect(restored.exceptionsRoot).toBe(data.exceptionsRoot);
    });

    it('defaults to disabled without resolving a dependency or parsing unknown data', () => {
        const plugin = createUserscriptTldtsDataCompressionPlugin('/unavailable-suffix-root');
        if (typeof plugin.transform !== 'function') throw new Error('Expected the public plugin transform hook');
        expect(Reflect.apply(plugin.transform, plugin, ['export const nodeFlags = {', dataPath])).toBeNull();
        expect(createPlugin(false, '/unavailable-suffix-root').transform(original, dataPath)).toBeNull();
    });

    it.each([
        ['unknown-declaration', original + '\nexport const unknown = 1;'],
        ['side-effect', original + '\nsideEffect();'],
        ['let', original.replace('export const nodeFlags', 'export let nodeFlags')],
        ['wrong-export', original.replace('export const nodeFlags', 'export const other')],
        ['wrong-constructor', original.replace('new Uint8Array', 'new Uint32Array')],
        ['call-element', original.replace('new Uint8Array([1,', 'new Uint8Array([sideEffect(),')],
        ['spread-element', original.replace('new Uint8Array([1,', 'new Uint8Array([...other,')],
        ['negative-element', original.replace('new Uint8Array([1,', 'new Uint8Array([-1,')],
        ['fractional-element', original.replace('new Uint8Array([1,', 'new Uint8Array([1.5,')],
        ['overflow-element', original.replace('new Uint8Array([1,', 'new Uint8Array([256,')],
        ['wrong-array-length', fixtureSource({...locked, nodeFlags: new Uint8Array(1)})],
        ['root-call', fixtureSource(locked).replace('export const rulesRoot = ' + locked.rulesRoot, 'export const rulesRoot = makeRoot()')],
        ['root-outside-table', fixtureSource({...locked, exceptionsRoot: locked.nodeFlags.length})],
        ['label-expression', fixtureSource(locked).replace('export const labelText = ' + JSON.stringify(locked.labelText), 'export const labelText = makeLabels()')],
        ['wrong-export-order', fixtureSource(locked).split('\n').reverse().join('\n')],
        ['default-export', 'export default {};'],
        ['syntax', 'export const nodeFlags = ['],
    ])('rejects %s instead of evaluating or compressing unknown source', (_label, source) => {
        expect(() => createPlugin().transform(source, dataPath)).toThrow('seven locked static trie exports');
    });

    it.each([
        ['raw', dataPath + '?raw'],
        ['proxy', dataPath + '?commonjs-proxy'],
        ['virtual', '\0' + dataPath],
        ['algorithm', resolve(packageRoot, 'dist/es6/src/suffix-trie.js')],
        ['unrelated-trie', resolve(process.cwd(), 'fake-tldts/dist/es6/src/data/trie.js')],
    ])('leaves %s and disabled modules untouched without parsing them', (_label, id) => {
        expect(createPlugin().transform('throw Error("must not parse")', id)).toBeNull();
        expect(createPlugin(false).transform(original, id)).toBeNull();
    });

    it.each([
        ['ordinary', '0', '0', false],
        ['standalone', '1', '0', true],
        ['greasy-fork', '0', '1', false],
        ['standalone-and-greasy', '1', '1', false],
    ] as const)('binds the actual %s config to the suffix data plugin and existing bundled decoder only in standalone mode', async (_label, standalone, greasy, enabled) => {
        vi.stubEnv('FLUENTREAD_USERSCRIPT_STANDALONE', standalone);
        vi.stubEnv('FLUENTREAD_USERSCRIPT_GREASYFORK_SOURCE', greasy);
        vi.stubEnv('FLUENTREAD_USERSCRIPT_VENDOR_URL', 'https://fixture.invalid/vendor.js');
        vi.stubEnv('FLUENTREAD_USERSCRIPT_DATA_URL', 'https://fixture.invalid/data.js');
        try {
            vi.resetModules();
            const {default: configuration, userscriptAliases: aliases} = await import('@/userscript/vite.config');
            const config = configuration as unknown as {plugins: Array<{name?: string; transform?: unknown}>};
            const plugin = config.plugins.find(item => item.name === 'compress-standalone-tldts-data') as unknown as ReturnType<typeof createPlugin>;
            expect(plugin).toBeDefined();
            const transformed = await plugin.transform(original, dataPath);
            if (enabled) {
                const restored = restoreData(transformed!.code);
                expect(transformed!.code).toContain('decodeUserscriptData(');
                for (const name of arrayNames) expect(Array.from(restored[name])).toEqual(Array.from(locked[name]));
                expect(restored.labelText).toBe(locked.labelText);
                expect(restored.rulesRoot).toBe(locked.rulesRoot);
                expect(restored.exceptionsRoot).toBe(locked.exceptionsRoot);
            } else expect(transformed).toBeNull();
            const bundled = aliases.find(alias => alias.find === '@/userscript/pakoRuntime');
            expect(bundled?.replacement).toBe(standalone === '1' ? resolve(process.cwd(), 'userscript/pakoBundled.ts') : undefined);
        } finally {
            vi.unstubAllEnvs();
            vi.resetModules();
        }
    }, 30_000);

    it.each([
        ['new-version', {name: 'tldts', version: '7.4.11'}],
        ['wrong-package', {name: 'tldts-icann', version: '7.4.10'}],
        ['missing-version', {name: 'tldts'}],
    ])('fails closed for %s before resolving or transforming its data module', (_label, manifest) => {
        const fixture = mkdtempSync(resolve(tmpdir(), 'fluentread-suffix-data-owner-'));
        try {
            writeFileSync(resolve(fixture, 'package.json'), '{}');
            const packageRoot = resolve(fixture, 'node_modules/tldts');
            mkdirSync(packageRoot, {recursive: true});
            writeFileSync(resolve(packageRoot, 'package.json'), JSON.stringify({...manifest, main: 'index.js'}));
            expect(() => createPlugin(true, fixture)).toThrow('requires locked tldts 7.4.10');
        } finally {
            rmSync(fixture, {recursive: true, force: true});
        }
    });

    it('propagates decoder failure and keeps the original module heading, digest and dependency bytes', () => {
        const transformed = createPlugin().transform(original, dataPath)!;
        const failure = new Error('controlled suffix decoder failure');
        expect(() => restoreData(transformed.code, () => {throw failure;})).toThrow(failure);
        expect(transformed.code.startsWith(original.slice(0, original.indexOf('export const nodeFlags')))).toBe(true);
        expect(transformed.code).toContain('source sha256 ' + createHash('sha256').update(original).digest('hex'));
        expect(readFileSync(dataPath, 'utf8')).toBe(original);
        expect(readFileSync(resolve(packageRoot, 'LICENSE'), 'utf8')).toBe(originalLicense);
    });

    it('retains the actual original tldts MIT notice when the transformed module id enters the standalone entry', async () => {
        vi.stubEnv('FLUENTREAD_USERSCRIPT_STANDALONE', '1');
        vi.stubEnv('FLUENTREAD_USERSCRIPT_GREASYFORK_SOURCE', '0');
        try {
            vi.resetModules();
            const {default: configuration} = await import('@/userscript/vite.config');
            const plugins = (configuration as {plugins: Array<{name: string; generateBundle?: {handler: Function}}>}).plugins;
            const plugin = plugins.find(item => item.name === 'bundle-userscript-css')!;
            const entry = {type: 'chunk', isEntry: true, code: 'var suffixOwnerFixture = 1;', moduleIds: [dataPath]};
            await Reflect.apply(plugin.generateBundle!.handler, {}, [{}, {'entry.js': entry}]);
            expect(entry.code).toContain('tldts 7.4.10 — MIT');
            expect(entry.code).toContain(originalLicense.trim());
            expect(entry.moduleIds).toEqual([dataPath]);
            expect(readFileSync(resolve(packageRoot, 'LICENSE'), 'utf8')).toBe(originalLicense);
        } finally {
            vi.unstubAllEnvs();
            vi.resetModules();
        }
    }, 30_000);


    it('restores all seven locked exports without TextDecoder or a manager decoder global', () => {
        vi.stubGlobal('TextDecoder', undefined); vi.stubGlobal('pako', undefined);
        try {
            const restored = restoreData(createPlugin().transform(original, dataPath)!.code);
            expect(Object.keys(restored)).toEqual(exportNames);
            for (const name of arrayNames) {
                expect(restored[name].constructor).toBe(locked[name].constructor);
                expect(Array.from(restored[name])).toEqual(Array.from(locked[name]));
                expect(Buffer.from(restored[name].buffer, restored[name].byteOffset, restored[name].byteLength))
                    .toEqual(Buffer.from(locked[name].buffer, locked[name].byteOffset, locked[name].byteLength));
            }
            expect(restored.labelText).toBe(locked.labelText);
            expect(restored.rulesRoot).toBe(locked.rulesRoot); expect(restored.exceptionsRoot).toBe(locked.exceptionsRoot);
        } finally {vi.unstubAllGlobals();}
    });

    it.each(['A\0\ud800🧪汉字\n"\\', ''])('restores controlled JSON label text %j through the official UTF-8 fallback', labelText => {
        vi.stubGlobal('TextDecoder', undefined);
        try {
            const fixture = {...locked, labelText};
            const restored = restoreData(createPlugin().transform(fixtureSource(fixture), dataPath)!.code);
            for (const name of arrayNames) expect(Array.from(restored[name])).toEqual(Array.from(fixture[name]));
            // JSON.stringify preserves the isolated surrogate as an escape before UTF-8 decoding and JSON.parse restores it.
            expect(restored.labelText).toBe(labelText);
            expect(restored.rulesRoot).toBe(fixture.rulesRoot); expect(restored.exceptionsRoot).toBe(fixture.exceptionsRoot);
        } finally {vi.unstubAllGlobals();}
    });

    it('reads a nonzero-offset binary result and exports arrays independent of its backing buffer', () => {
        let supplied: Uint8Array | undefined;
        const restored = restoreData(createPlugin().transform(original, dataPath)!.code, compressed => {
            const decoded = inflateBundledTldtsData(compressed);
            const backing = Buffer.alloc(decoded.byteLength + 13, 0xa5);
            backing.set(decoded, 5); supplied = backing.subarray(5, 5 + decoded.byteLength);
            return supplied;
        });
        expect(supplied).toBeDefined(); expect(supplied!.byteOffset).toBeGreaterThan(0);
        for (const name of arrayNames) {
            expect(restored[name].constructor).toBe(locked[name].constructor);
            expect(restored[name].buffer).not.toBe(supplied!.buffer);
            expect(Array.from(restored[name])).toEqual(Array.from(locked[name]));
        }
        supplied!.fill(0);
        for (const name of arrayNames) expect(Array.from(restored[name])).toEqual(Array.from(locked[name]));
        expect(restored.labelText).toBe(locked.labelText);
        expect(restored.rulesRoot).toBe(locked.rulesRoot); expect(restored.exceptionsRoot).toBe(locked.exceptionsRoot);
    });

    it.each([
        ['truncated bytes', 'Invalid locked suffix data length'],
        ['extra bytes', 'Invalid locked suffix data length'],
        ['non-string JSON labels', 'Invalid locked suffix labels'],
    ])('fails closed for %s and can restore the next valid binary payload', (kind, expected) => {
        const transformed = createPlugin().transform(original, dataPath)!.code;
        expect(() => restoreData(transformed, compressed => {
            const decoded = inflateBundledTldtsData(compressed);
            if (kind === 'truncated bytes') return decoded.subarray(0, decoded.byteLength - 1);
            if (kind === 'extra bytes') {const longer = new Uint8Array(decoded.byteLength + 1); longer.set(decoded); return longer;}
            const invalid = Uint8Array.from(decoded);
            const tableBytes = arrayNames.reduce((total, name) => total + locked[name].byteLength, 0);
            invalid.fill(0x20, tableBytes); invalid.set(Buffer.from('null', 'utf8'), tableBytes);
            return invalid;
        })).toThrow(expected);
        const restored = restoreData(transformed);
        for (const name of arrayNames) expect(Array.from(restored[name])).toEqual(Array.from(locked[name]));
        expect(restored.labelText).toBe(locked.labelText);
        expect(restored.rulesRoot).toBe(locked.rulesRoot); expect(restored.exceptionsRoot).toBe(locked.exceptionsRoot);
    });
});

describe('standalone About images at explicit use boundaries', () => {
    const root = process.cwd();
    const helperId = realpathSync(resolve(root, 'src/app/options/aboutImages.ts'));
    const originalImage = (relative: string) => readFileSync(resolve(root, relative));
    const originals = {
        support: originalImage('public/misc/approve.jpg'),
        contact: originalImage('src/app/options/assets/wechat-contact.jpg'),
    };
    const expectedUrl = (kind: keyof typeof originals) => 'data:image/jpeg;base64,' + originals[kind].toString('base64');
    const createPlugin = (enabled = true, fixtureRoot = root) => createUserscriptAboutImagesCompressionPlugin(fixtureRoot, enabled) as unknown as {
        name: string; load(id: string): string | null;
    };
    async function loadAccessors(decoder = vi.fn(inflateBundledFrancData), standalone = false) {
        const plugin = createUserscriptAboutImagesCompressionPlugin(root, true, standalone) as unknown as {load(id: string): string | Promise<string>};
        const source = await plugin.load(helperId);
        const {transformWithEsbuild} = await import('vite');
        const compiled = await transformWithEsbuild(source, 'about-images-owner.js', {format: 'cjs', target: 'es2018'});
        const module = {exports: {} as {getSupportImageUrl(normal: string): string; getContactImageUrl(): string}};
        const decode = vi.fn(decodeUserscriptData);
        const hostImage = {controlledHostImage: true};
        const realm = {module, exports: module.exports, Uint8Array, atob,
            __FLUENTREAD_APPROVE_DATA__: hostImage,
            require: (id: string) => {
                if (id === '@/userscript/dataEncoding') return {decodeUserscriptData: decode};
                expect(id).toBe('@/userscript/pakoRuntime'); return {inflateWithPako: decoder};
            }};
        runInNewContext(compiled.code, realm, {timeout: 5_000});
        expect(decoder).not.toHaveBeenCalled();
        expect(decode).not.toHaveBeenCalled();
        expect(realm.__FLUENTREAD_APPROVE_DATA__).toBe(hostImage);
        return {api: module.exports, decoder, decode, realm, hostImage, source};
    }
    function assertImage(actual: string, kind: keyof typeof originals) {
        expect(actual).toBe(expectedUrl(kind));
        expect(Buffer.from(actual.slice('data:image/jpeg;base64,'.length), 'base64')).toEqual(originals[kind]);
    }

    it('restores both actual standalone images exactly and never enlarges the compact gzip', async () => {
        const plugin = createUserscriptAboutImagesCompressionPlugin(root, true, true) as unknown as {
            load(id: string): Promise<string>;
        };
        const source = await plugin.load(helperId);
        const bytes = encodedDataBytes(source);
        expect(bytes).toHaveLength(2);
        for (const [index, kind] of (['support', 'contact'] as const).entries()) {
            const input = Buffer.from(expectedUrl(kind));
            expect(gunzipSync(bytes[index])).toEqual(input);
            expect(bytes[index].length).toBeLessThanOrEqual(gzipUserscriptBuildData(input, 9, true).length);
        }
        const h = await loadAccessors(undefined, true);
        expect(h.decoder).not.toHaveBeenCalled(); expect(h.decode).not.toHaveBeenCalled();
        assertImage(h.api.getSupportImageUrl('normal'), 'support');
        assertImage(h.api.getContactImageUrl(), 'contact');
        h.api.getSupportImageUrl('normal'); h.api.getContactImageUrl();
        expect(h.decoder).toHaveBeenCalledTimes(2); expect(h.decode).toHaveBeenCalledTimes(2);
    });

    it('propagates an isolated standalone image compressor failure', async () => {
        const fixture = mkdtempSync(resolve(tmpdir(), 'fluentread-about-worker-failure-'));
        try {
            mkdirSync(resolve(fixture, 'src/app/options/assets'), {recursive: true});
            mkdirSync(resolve(fixture, 'public/misc'), {recursive: true});
            mkdirSync(resolve(fixture, 'userscript'), {recursive: true});
            const entry = resolve(fixture, 'src/app/options/aboutImages.ts');
            writeFileSync(entry, 'export {}');
            writeFileSync(resolve(fixture, 'public/misc/approve.jpg'), Buffer.alloc(50_000, 1));
            writeFileSync(resolve(fixture, 'src/app/options/assets/wechat-contact.jpg'), Buffer.alloc(50_000, 2));
            writeFileSync(resolve(fixture, 'userscript/zopfliBuildWorker.cjs'), "throw new Error('controlled image worker failure');");
            const plugin = createUserscriptAboutImagesCompressionPlugin(fixture, true, true) as unknown as {load(id: string): Promise<string>};
            await expect(plugin.load(realpathSync(entry))).rejects.toThrow('controlled image worker failure');
        } finally {rmSync(fixture, {recursive: true, force: true});}
    });

    it('keeps the compact image gzip when worker candidates are larger', async () => {
        vi.resetModules();
        const gzipModule = await import('@/userscript/buildGzip');
        const worker = vi.spyOn(gzipModule, 'gzipLargeStandaloneUserscriptData')
            .mockImplementation(async data => Buffer.alloc(data.byteLength + 1));
        try {
            const {createUserscriptAboutImagesCompressionPlugin: createImages} = await import('@/userscript/aboutImagesPlugin');
            const plugin = createImages(root, true, true) as unknown as {load(id: string): Promise<string>};
            const bytes = encodedDataBytes(await plugin.load(helperId));
            for (const [index, kind] of (['support', 'contact'] as const).entries()) {
                const input = Buffer.from(expectedUrl(kind));
                expect(Buffer.from(bytes[index])).toEqual(gzipUserscriptBuildData(input, 9, true));
                expect(gunzipSync(bytes[index])).toEqual(input);
            }
            expect(worker).toHaveBeenCalledTimes(2);
        } finally {worker.mockRestore(); vi.resetModules();}
    });

    it('does not emit an image module if the second isolated compressor fails', async () => {
        vi.resetModules();
        const gzipModule = await import('@/userscript/buildGzip');
        const worker = vi.spyOn(gzipModule, 'gzipLargeStandaloneUserscriptData')
            .mockImplementationOnce(async data => Buffer.alloc(data.byteLength + 1))
            .mockRejectedValueOnce(new Error('controlled second image failure'));
        try {
            const {createUserscriptAboutImagesCompressionPlugin: createImages} = await import('@/userscript/aboutImagesPlugin');
            const plugin = createImages(root, true, true) as unknown as {load(id: string): Promise<string>};
            await expect(plugin.load(helperId)).rejects.toThrow('controlled second image failure');
            expect(worker).toHaveBeenCalledTimes(2);
        } finally {worker.mockRestore(); vi.resetModules();}
    });

    it('keeps the ordinary caller snapshot and existing contact asset route', () => {
        for (const normal of ['/misc/approve.jpg', 'controlled-captured-data-url', '']) {
            expect(getNormalSupportImageUrl(normal)).toBe(normal);
        }
        expect(getNormalContactImageUrl()).toBe(ordinaryContactAsset);
    });

    it.each(['support-first', 'contact-first'] as const)('keeps import lazy and restores complete original JPEGs independently with %s', async order => {
        const h = await loadAccessors();
        const support = () => h.api.getSupportImageUrl('controlled-normal-url');
        const contact = () => h.api.getContactImageUrl();
        const first = order === 'support-first' ? support : contact;
        const second = order === 'support-first' ? contact : support;
        assertImage(first(), order === 'support-first' ? 'support' : 'contact');
        expect(h.decoder).toHaveBeenCalledTimes(1);expect(h.decode).toHaveBeenCalledTimes(1);
        first();first();expect(h.decoder).toHaveBeenCalledTimes(1);
        assertImage(second(), order === 'support-first' ? 'contact' : 'support');
        expect(h.decoder).toHaveBeenCalledTimes(2);expect(h.decode).toHaveBeenCalledTimes(2);
        assertImage(support(), 'support');assertImage(contact(), 'contact');
        expect(h.decoder).toHaveBeenCalledTimes(2);
        expect(h.realm.__FLUENTREAD_APPROVE_DATA__).toBe(h.hostImage);
    });

    it.each(['support', 'contact'] as const)('does not publish a failed %s restoration or affect the other successful cache', async kind => {
        const decoder = vi.fn(inflateBundledFrancData).mockImplementationOnce(() => {throw new Error('controlled restore failure');});
        const h = await loadAccessors(decoder);
        const selected = () => kind === 'support' ? h.api.getSupportImageUrl('normal') : h.api.getContactImageUrl();
        const other = () => kind === 'support' ? h.api.getContactImageUrl() : h.api.getSupportImageUrl('normal');
        expect(selected).toThrow('controlled restore failure');expect(decoder).toHaveBeenCalledTimes(1);
        assertImage(other(), kind === 'support' ? 'contact' : 'support');
        other();expect(decoder).toHaveBeenCalledTimes(2);
        assertImage(selected(), kind);expect(decoder).toHaveBeenCalledTimes(3);
        selected();other();expect(decoder).toHaveBeenCalledTimes(3);
        expect(h.decode).toHaveBeenCalledTimes(3);
    });

    it('defaults to disabled without reading nonexistent helper or image files', () => {
        const plugin = createUserscriptAboutImagesCompressionPlugin('/unavailable-about-images-root');
        if (typeof plugin.load !== 'function') throw new Error('Expected image load hook');
        expect(Reflect.apply(plugin.load, plugin, [helperId])).toBeNull();
        expect(createPlugin(false, '/unavailable-about-images-root').load(helperId)).toBeNull();
    });

    it.each([
        ['raw', helperId + '?raw'], ['proxy', helperId + '?commonjs-proxy'],
        ['virtual', '\0' + helperId], ['another-module', resolve(root, 'src/app/options/other.ts')],
        ['similar-path', resolve(root, 'fake-src/app/options/aboutImages.ts')],
    ])('leaves the %s route and disabled module untouched', (_label, id) => {
        expect(createPlugin().load(id)).toBeNull();
        expect(createPlugin(false).load(id)).toBeNull();
    });

    it.each([
        ['ordinary', '0', '0', false], ['standalone', '1', '0', true],
        ['greasy-fork', '0', '1', false], ['standalone-and-greasy', '1', '1', false],
    ] as const)('uses the actual %s config plugin, Vite alias resolution and asset path', async (_label, standalone, greasy, enabled) => {
        vi.stubEnv('FLUENTREAD_USERSCRIPT_STANDALONE', standalone);
        vi.stubEnv('FLUENTREAD_USERSCRIPT_GREASYFORK_SOURCE', greasy);
        vi.stubEnv('FLUENTREAD_USERSCRIPT_VENDOR_URL', 'https://fixture.invalid/vendor.js');
        vi.stubEnv('FLUENTREAD_USERSCRIPT_DATA_URL', 'https://fixture.invalid/data.js');
        const fixture = mkdtempSync(resolve(tmpdir(), 'fluentread-about-images-owner-'));
        try {
            vi.resetModules();
            const {default: configuration} = await import('@/userscript/vite.config');
            const config = configuration as import('vite').UserConfig;
            const plugin = (config.plugins as import('vite').Plugin[]).find(item => item.name === 'compress-standalone-about-images');
            expect(plugin).toBeDefined();
            const entryPath = resolve(fixture, 'entry.mjs');
            writeFileSync(entryPath, 'import {getSupportImageUrl,getContactImageUrl} from "@/src/app/options/aboutImages"; globalThis.aboutImagesOwner={getSupportImageUrl,getContactImageUrl};');
            const {build} = await import('vite');
            const result = await build({root, configFile: false, publicDir: false, logLevel: 'silent',
                plugins: [plugin!], resolve: config.resolve,
                build: {...config.build, write: false, outDir: resolve(fixture, 'unused-output'),
                    lib: {entry: entryPath, name: 'AboutImagesOwner', formats: ['iife']},
                    rollupOptions: {output: {inlineDynamicImports: true}}}});
            const outputs = Array.isArray(result) ? result : [result];
            expect(outputs).toHaveLength(1);
            if (!('output' in outputs[0])) throw new Error('Expected actual Rollup output');
            expect(outputs[0].output).toHaveLength(1);
            const chunk = outputs[0].output[0];
            if (chunk.type !== 'chunk') throw new Error('Expected complete image owner entry');
            expect(chunk.imports).toEqual([]);expect(chunk.dynamicImports).toEqual([]);
            const decode = vi.fn(atob);
            const realm = {aboutImagesOwner: undefined as any, atob: decode, Uint8Array, ArrayBuffer};
            runInNewContext(chunk.code, realm, {timeout: 5_000});
            expect(decode).not.toHaveBeenCalled();
            const api = realm.aboutImagesOwner;
            const normalUrl = 'controlled-captured-normal-url';
            const support = api.getSupportImageUrl(normalUrl);
            assertImage(api.getContactImageUrl(), 'contact');
            if (enabled) {
                assertImage(support, 'support');expect(decode).not.toHaveBeenCalled();
                expect(chunk.code).not.toContain(expectedUrl('support'));
                expect(chunk.code).not.toContain(expectedUrl('contact'));
                expect(chunk.moduleIds).not.toContain(resolve(root, 'src/app/options/assets/wechat-contact.jpg'));
            } else {
                expect(support).toBe(normalUrl);expect(decode).not.toHaveBeenCalled();
                expect(chunk.moduleIds).toContain(resolve(root, 'src/app/options/assets/wechat-contact.jpg'));
            }
            api.getSupportImageUrl('other-normal-url');api.getContactImageUrl();
            expect(decode).not.toHaveBeenCalled();
            const bootstrapPlugin = (config.plugins as import('vite').Plugin[]).find(item => item.name === 'bundle-userscript-css') as unknown as {
                generateBundle: {handler: Function};
            };
            await Reflect.apply(bootstrapPlugin.generateBundle.handler, {emitFile: vi.fn()}, [{}, {'entry.js': chunk}]);
            expect(chunk.code).not.toMatch(/globalThis\.__FLUENTREAD_APPROVE_DATA__\s*=/u);
            if (enabled) {
                expect(chunk.code).not.toContain(expectedUrl('support'));
                expect(chunk.code).not.toContain(expectedUrl('contact'));
            }
        } finally {
            rmSync(fixture, {recursive: true, force: true});
            vi.unstubAllEnvs();vi.resetModules();
        }
    }, 30_000);
});

describe('standalone service brand paths at actual icon use', () => {
    const root = process.cwd();
    const helperId = realpathSync(resolve(root, 'src/ui/assets/serviceBrandIcons.ts'));
    const dataPath = resolve(root, 'src/ui/assets/serviceBrandPaths.json');
    type Shape = Array<Record<string, string>>;
    type BrandApi = {getServiceBrandIcon(service: string): Shape | undefined};
    const expected = originalServiceBrandPaths as unknown as Record<string, Shape>;
    const unknownServices = ['unknown', 'constructor', '__proto__', 'toString', 'custom:work', 'google'];
    type BrandPlugin = {load(id: string): string | null};
    const createPlugin = (enabled = true, fixtureRoot = root) => createUserscriptServiceBrandIconsCompressionPlugin(fixtureRoot, enabled) as unknown as BrandPlugin;
    function loadHook(plugin: BrandPlugin, id: string) {
        const addWatchFile = vi.fn();
        const source = Reflect.apply(plugin.load, {addWatchFile}, [id]) as string | null;
        return {source, addWatchFile};
    }
    function positiveSource(plugin = createPlugin(), id = helperId, watchedPath = dataPath) {
        const result = loadHook(plugin, id);
        expect(result.addWatchFile).toHaveBeenCalledTimes(1);expect(result.addWatchFile).toHaveBeenCalledWith(watchedPath);
        expect(result.source).toBeTypeOf('string');
        if (typeof result.source !== 'string') throw new Error('Expected actual brand data module');
        encodedDataBytes(result.source)[0];
        return result.source;
    }
    async function loadAccessors(decoder = vi.fn(inflateBundledFrancData), source = positiveSource()) {
        const {transformWithEsbuild} = await import('vite');
        const compiled = await transformWithEsbuild(source, 'service-brands-owner.js', {format: 'cjs', target: 'es2018'});
        const module = {exports: {} as BrandApi};
        const decode = vi.fn(decodeUserscriptData), parse = vi.fn(JSON.parse), hostData = {controlledHostData: true};
        const realm = {module, exports: module.exports, Uint8Array, JSON: {parse}, controlledHostData: hostData,
            require: (id: string) => {
                if (id === '@/userscript/pakoRuntime') return {inflateWithPako: decoder};
                if (id === '@/userscript/dataEncoding') return {decodeUserscriptData: decode};
                throw new Error(`Unexpected brand import: ${id}`);
            }};
        runInNewContext(compiled.code, realm, {timeout: 5_000});
        expect(decoder).not.toHaveBeenCalled();expect(decode).not.toHaveBeenCalled();expect(parse).not.toHaveBeenCalled();
        expect(realm.controlledHostData).toBe(hostData);
        return {api: module.exports, decoder, decode, parse, realm, hostData};
    }
    function assertAllBrands(api: BrandApi, input: Record<string, Shape> = expected) {
        for (const [service, shape] of Object.entries(input)) {
            const restored = api.getServiceBrandIcon(service);
            expect(restored, service).toEqual(shape);
            expect(restored?.map(attributes => Object.entries(attributes)), service).toEqual(shape.map(attributes => Object.entries(attributes)));
            expect(api.getServiceBrandIcon(service), service).toBe(restored);
        }
    }
    async function withDataFixture(value: unknown, use: (fixtureRoot: string, id: string, watchedPath: string) => Promise<void> | void) {
        const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'fluentread-service-brands-owner-'));
        const assets = resolve(fixtureRoot, 'src/ui/assets');
        try {
            mkdirSync(assets, {recursive: true});
            const id = resolve(assets, 'serviceBrandIcons.ts'), watchedPath = resolve(assets, 'serviceBrandPaths.json');
            writeFileSync(id, 'export {};');writeFileSync(watchedPath, JSON.stringify(value));
            await use(fixtureRoot, realpathSync(id), watchedPath);
        } finally {rmSync(fixtureRoot, {recursive: true, force: true});}
    }

    it.each(['deepL', 'openai'])('restores the entire ordered table only at the first existing %s brand and shares the successful cache', async first => {
        const source = positiveSource();
        const [bytes] = encodedDataBytes(source);
        expect(Buffer.from(bytes)).toEqual(gzipUserscriptBuildData(Buffer.from(JSON.stringify(expected)), 8));
        const h = await loadAccessors(undefined, source);
        for (const service of unknownServices) {expect(Object.hasOwn(expected, service)).toBe(false);expect(h.api.getServiceBrandIcon(service)).toBeUndefined();}
        expect(h.decoder).not.toHaveBeenCalled();expect(h.decode).not.toHaveBeenCalled();expect(h.parse).not.toHaveBeenCalled();
        expect(h.api.getServiceBrandIcon(first)).toEqual(expected[first]);
        expect(h.decoder).toHaveBeenCalledTimes(1);expect(h.decode).toHaveBeenCalledTimes(1);expect(h.parse).toHaveBeenCalledTimes(1);
        const restoredTable = h.parse.mock.results[0].value as Record<string, Shape>;
        expect(Object.keys(restoredTable)).toEqual(Object.keys(expected));
        assertAllBrands(h.api);
        for (const service of unknownServices) expect(h.api.getServiceBrandIcon(service)).toBeUndefined();
        expect(h.decoder).toHaveBeenCalledTimes(1);expect(h.decode).toHaveBeenCalledTimes(1);expect(h.parse).toHaveBeenCalledTimes(1);
        expect(h.realm.controlledHostData).toBe(h.hostData);
    });

    it.each(['crc', 'decoder', 'malformed-json', 'null-root', 'array-root', 'numeric-root', 'missing-current', 'empty-current', 'wrong-current-type'] as const)('does not cache %s failure and can restore a valid table in the same module', async failure => {
        const decoder = vi.fn(inflateBundledFrancData).mockImplementationOnce(bytes => {
            switch (failure) {
                case 'crc': {const damaged = Uint8Array.from(bytes);damaged[damaged.length - 8] ^= 0xff;return inflateBundledFrancData(damaged);}
                case 'decoder': throw new Error('controlled brand restoration failure');
                case 'malformed-json': return '{';
                case 'null-root': return 'null';
                case 'array-root': return '[]';
                case 'numeric-root': return '1';
                case 'missing-current': return '{}';
                case 'empty-current': return '{"deepL":[]}';
                case 'wrong-current-type': return '{"deepL":{}}';
            }
        });
        const h = await loadAccessors(decoder);
        expect(() => h.api.getServiceBrandIcon('deepL')).toThrow();
        expect(h.decoder).toHaveBeenCalledTimes(1);expect(h.decode).toHaveBeenCalledTimes(1);
        expect(h.api.getServiceBrandIcon('constructor')).toBeUndefined();expect(h.decoder).toHaveBeenCalledTimes(1);
        expect(h.api.getServiceBrandIcon('deepL')).toEqual(expected.deepL);
        assertAllBrands(h.api);
        expect(h.decoder).toHaveBeenCalledTimes(2);expect(h.decode).toHaveBeenCalledTimes(2);
        expect(h.parse).toHaveBeenCalledTimes(failure === 'crc' || failure === 'decoder' ? 1 : 2);
        expect(h.realm.controlledHostData).toBe(h.hostData);
    });

    it('defaults to disabled without reading or watching an unavailable helper or data file', () => {
        for (const plugin of [createUserscriptServiceBrandIconsCompressionPlugin('/unavailable-service-brands-root') as unknown as BrandPlugin, createPlugin(false, '/unavailable-service-brands-root')]) {
            const result = loadHook(plugin, helperId);
            expect(result.source).toBeNull();expect(result.addWatchFile).not.toHaveBeenCalled();
        }
    });

    it.each(['raw', 'proxy', 'virtual', 'another-module', 'similar-path'] as const)('leaves the %s route untouched without reading or watching unavailable data', async kind => {
        await withDataFixture({}, (fixtureRoot, id, watchedPath) => {
            rmSync(watchedPath);
            const ignored = {raw: id + '?raw', proxy: id + '?commonjs-proxy', virtual: '\0' + id,
                'another-module': resolve(fixtureRoot, 'src/ui/assets/other.ts'),
                'similar-path': resolve(fixtureRoot, 'fake-src/ui/assets/serviceBrandIcons.ts')}[kind];
            for (const plugin of [createPlugin(true, fixtureRoot), createPlugin(false, fixtureRoot)]) {
                const result = loadHook(plugin, ignored);
                expect(result.source).toBeNull();expect(result.addWatchFile).not.toHaveBeenCalled();
            }
        });
    });

    it.each([
        ['null-table', null], ['array-table', []], ['empty-table', {}],
        ['non-array-entry', {fixture: {d: 'M0 0'}}], ['empty-entry', {fixture: []}],
        ['missing-d', {fixture: [{'clip-rule': 'evenodd'}]}], ['non-string-d', {fixture: [{d: 1}]}],
        ['invalid-path', {fixture: [{d: '<script>'}]}], ['event-attribute', {fixture: [{d: 'M0 0', onload: 'controlled'}]}],
        ['link-attribute', {fixture: [{d: 'M0 0', href: 'https://fixture.invalid/'}]}], ['non-string-attribute', {fixture: [{d: 'M0 0', opacity: 1}]}],
    ] as const)('rejects %s schema after registering exactly its actual JSON dependency', async (_label, value) => {
        await withDataFixture(value, (fixtureRoot, id, watchedPath) => {
            const addWatchFile = vi.fn();
            expect(() => Reflect.apply(createPlugin(true, fixtureRoot).load, {addWatchFile}, [id])).toThrow();
            expect(addWatchFile).toHaveBeenCalledTimes(1);expect(addWatchFile).toHaveBeenCalledWith(watchedPath);
        });
    });

    it('preserves all allowed ordered attributes and own reserved-looking brand keys without inheriting a fallback', async () => {
        const attributes = {d: 'M0 0 L1 1 Z', 'clip-rule': 'evenodd', 'fill-rule': 'nonzero', opacity: '0.5', 'fill-opacity': '0.25'};
        const value = JSON.parse('{"__proto__":[],"constructor":[],"fixture":[]}') as Record<string, Shape>;
        for (const service of Object.keys(value)) value[service] = [attributes, {d: 'M1 1 L2 2'}];
        await withDataFixture(value, async (fixtureRoot, id, watchedPath) => {
            const h = await loadAccessors(vi.fn(inflateBundledFrancData), positiveSource(createPlugin(true, fixtureRoot), id, watchedPath));
            expect(h.api.getServiceBrandIcon('toString')).toBeUndefined();expect(h.decoder).not.toHaveBeenCalled();
            assertAllBrands(h.api, value);
            expect(Object.keys(h.parse.mock.results[0].value)).toEqual(Object.keys(value));
            expect(h.decoder).toHaveBeenCalledTimes(1);expect(h.decode).toHaveBeenCalledTimes(1);
        });
    });

    it.each([
        ['ordinary', '0', '0', false], ['standalone', '1', '0', true],
        ['greasy-fork', '0', '1', false], ['standalone-and-greasy', '1', '1', false],
    ] as const)('uses the actual %s Vite mode, alias and real complete data without eager restoration', async (_label, standalone, greasy, enabled) => {
        vi.stubEnv('FLUENTREAD_USERSCRIPT_STANDALONE', standalone);vi.stubEnv('FLUENTREAD_USERSCRIPT_GREASYFORK_SOURCE', greasy);
        vi.stubEnv('FLUENTREAD_USERSCRIPT_VENDOR_URL', 'https://fixture.invalid/vendor.js');vi.stubEnv('FLUENTREAD_USERSCRIPT_DATA_URL', 'https://fixture.invalid/data.js');
        const fixture = mkdtempSync(resolve(tmpdir(), 'fluentread-service-brands-mode-owner-'));
        try {
            vi.resetModules();
            const {default: configuration} = await import('@/userscript/vite.config');
            const config = configuration as import('vite').UserConfig;
            const plugin = (config.plugins as import('vite').Plugin[]).find(item => item.name === 'compress-standalone-service-brand-icons');
            expect(plugin).toBeDefined();
            const entryPath = resolve(fixture, 'entry.mjs');
            writeFileSync(entryPath, 'import {getServiceBrandIcon} from "@/src/ui/assets/serviceBrandIcons"; globalThis.serviceBrandOwner={getServiceBrandIcon};');
            const {build} = await import('vite');
            const result = await build({root, configFile: false, publicDir: false, logLevel: 'silent', plugins: [plugin!, observeDataDecoder()], resolve: config.resolve,
                build: {...config.build, write: false, outDir: resolve(fixture, 'unused-output'),
                    lib: {entry: entryPath, name: 'ServiceBrandOwner', formats: ['iife']}, rollupOptions: {output: {inlineDynamicImports: true}}}});
            const outputs = Array.isArray(result) ? result : [result];
            expect(outputs).toHaveLength(1);
            if (!('output' in outputs[0]) || outputs[0].output.length !== 1 || outputs[0].output[0].type !== 'chunk') throw new Error('Expected actual complete brand owner chunk');
            const chunk = outputs[0].output[0];
            expect(chunk.imports).toEqual([]);expect(chunk.dynamicImports).toEqual([]);
            expect(chunk.moduleIds).toContain(helperId);
            expect(chunk.moduleIds.includes(dataPath)).toBe(!enabled);
            const decode = vi.fn(), parse = vi.fn(JSON.parse), hostData = {controlledHostData: true};
            const realm = {serviceBrandOwner: undefined as BrandApi | undefined, atob, Uint8Array, ArrayBuffer, JSON: {parse}, controlledHostData: hostData,
                __observeUserscriptDataDecode: decode};
            runInNewContext(chunk.code, realm, {timeout: 5_000});
            const api = realm.serviceBrandOwner;
            if (!api) throw new Error('Actual brand owner API missing');
            expect(decode).not.toHaveBeenCalled();expect(parse).not.toHaveBeenCalled();
            for (const service of unknownServices) expect(api.getServiceBrandIcon(service)).toBeUndefined();
            expect(decode).not.toHaveBeenCalled();expect(parse).not.toHaveBeenCalled();
            assertAllBrands(api);
            expect(decode).toHaveBeenCalledTimes(enabled ? 1 : 0);expect(parse).toHaveBeenCalledTimes(enabled ? 1 : 0);
            expect(realm.controlledHostData).toBe(hostData);
            expect(readFileSync(resolve(root, 'public/third-party-notices/lobe-icons-MIT.txt'), 'utf8')).toContain('Copyright (c) 2023 LobeHub');
        } finally {rmSync(fixture, {recursive: true, force: true});vi.unstubAllEnvs();vi.resetModules();}
    }, 30_000);
});

// 只替换调用者和共享编排的测试端口；两个生产 wrapper、HTTP 实现及锁定 SDK 均由真实 Vite 解析、编译和执行。
describe('standalone OpenAI transport build boundary', () => {
    const root = process.cwd();
    const owner = resolve(root, 'src/providers/translation/ai-sdk/openai-compatible');
    const standaloneOwner = resolve(root, 'userscript/openaiCompatible.ts');
    const transport = resolve(root, 'src/providers/translation/ai-sdk/openai-transport.ts');
    const http = resolve(root, 'src/providers/translation/ai-sdk/openai-http.ts');
    const callers = ['registry.ts', 'doubao.ts', 'azure-openai.ts'].map(name => resolve(root, 'src/providers/translation', name));
    const resolveOwner = (source: string, importer?: string) => (createStandaloneOpenAITransportPlugin().resolveId as
        (source: string, importer?: string) => string | null)(source, importer);

    it.each(callers.flatMap(importer => [false, true].map(extension => ({importer, extension}))))(
        'resolves the exact relative owner for $importer (explicit TS: $extension)', ({importer, extension}) => {
            const original = readFileSync(importer, 'utf8');
            const match = original.match(/import\s*\{translateWithOpenAICompatibleAiSdk\}\s*from\s*['"]([^'"]+)['"]/u);
            expect(match?.[1]).toBe('./ai-sdk/openai-compatible');
            expect(resolveOwner(match![1] + (extension ? '.ts' : ''), importer)).toBe(standaloneOwner);
            expect(resolveOwner(match![1] + (extension ? '.ts' : ''), importer + '?fixture')).toBe(standaloneOwner);
        });

    it.each([owner, `${owner}.ts`, '@/src/providers/translation/ai-sdk/openai-compatible', '@/src/providers/translation/ai-sdk/openai-compatible.ts'])(
        'resolves exact absolute or alias owner %s without an importer', source => {
            expect(resolveOwner(source)).toBe(standaloneOwner);
        });

    it.each([
        '@ai-sdk/openai-compatible', '@ai-sdk/openai-compatible.ts', 'ai',
        './ai-sdk/openai-compatible.js', './ai-sdk/openai-compatible.ts?raw', './ai-sdk/openai-compatible?url',
        './ai-sdk/openai-compatible-extra', './ai-sdk/openai-compatible/index.ts',
        '@/other/openai-compatible', '@/src/providers/translation/ai-sdk/openai-compatible.tsx',
        '@/src/providers/translation/ai-sdk/openai-compatible?raw', `${owner}.ts?commonjs-proxy`,
        `${owner}-extra.ts`, `${owner}.ts.map`, `\0${owner}.ts`,
        resolve(root, 'other/src/providers/translation/ai-sdk/openai-compatible.ts'),
    ])('does not redirect vendor, other owner, suffix or virtual import %s', source => {
        expect(resolveOwner(source, callers[0])).toBeNull();
    });

    it('does not guess the owner for a relative import without an importer or from another directory', () => {
        expect(resolveOwner('./ai-sdk/openai-compatible')).toBeNull();
        expect(resolveOwner('./ai-sdk/openai-compatible', resolve(root, 'other/registry.ts'))).toBeNull();
    });

    it('builds the real vendor, same-basename file and raw owner without redirecting them', async () => {
        const fixture = mkdtempSync(resolve(tmpdir(), 'fluentread-openai-vendor-boundary-'));
        try {
            const entryPath = resolve(root, 'userscript/openai-vendor-fixture.ts');
            writeFileSync(resolve(fixture, 'openai-compatible.ts'), 'export const marker="separate-owner";');
            const entrySource = 'import {createOpenAICompatible} from "@ai-sdk/openai-compatible";'
                + `import {marker} from ${JSON.stringify(resolve(fixture, 'openai-compatible.ts'))};`
                + `import rawOwner from ${JSON.stringify(`${owner}.ts?raw`)};`
                + 'globalThis.vendorBoundaryFixture={model:createOpenAICompatible({name:"vendor-control",baseURL:"https://fixture.invalid/v1"})("vendor-control-model"),marker,rawOwner};';
            const {build} = await import('vite');
            const config = userscriptConfig as import('vite').UserConfig;
            const result = await build({root, configFile: false, publicDir: false, logLevel: 'silent',
                plugins: [createStandaloneOpenAITransportPlugin(), {name: 'controlled-vendor-consumer',
                    resolveId(id) { return id === entryPath ? id : null; }, load(id) { return id === entryPath ? entrySource : null; }}],
                resolve: config.resolve, define: config.define,
                build: {...config.build, write: false, outDir: resolve(fixture, 'unused-output'),
                    lib: {entry: entryPath, name: 'OpenAIVendorBoundary', formats: ['iife']},
                    rollupOptions: {output: {inlineDynamicImports: true}}}});
            const outputs = Array.isArray(result) ? result : [result];
            expect(outputs).toHaveLength(1);
            if (!('output' in outputs[0]) || outputs[0].output.length !== 1 || outputs[0].output[0].type !== 'chunk') throw new Error('Expected one real vendor build');
            const chunk = outputs[0].output[0];
            expect(chunk.imports).toEqual([]);expect(chunk.dynamicImports).toEqual([]);
            expect(chunk.moduleIds.some(id => /\/node_modules\/@ai-sdk\/openai-compatible\/dist\//u.test(id))).toBe(true);
            expect(chunk.moduleIds).toContain(realpathSync(resolve(fixture, 'openai-compatible.ts')));
            expect(chunk.moduleIds).toContain(`${owner}.ts?raw`);
            expect(chunk.moduleIds).not.toContain(`${owner}.ts`);
            expect(chunk.moduleIds).not.toContain(standaloneOwner);
            expect(chunk.moduleIds).not.toContain(http);
            const forbiddenFetch = vi.fn(() => { throw new Error('Unexpected global network request'); });
            const realm = {vendorBoundaryFixture: undefined as {model: {modelId: string}; marker: string; rawOwner: string} | undefined,
                URL, URLSearchParams, Headers, Request, Response, TextDecoder, TextEncoder, Uint8Array, ArrayBuffer, AbortController,
                ReadableStream, WritableStream, TransformStream, fetch: forbiddenFetch, console};
            runInNewContext(chunk.code, realm, {timeout: 5_000});
            expect(realm.vendorBoundaryFixture?.model.modelId).toBe('vendor-control-model');
            expect(realm.vendorBoundaryFixture?.marker).toBe('separate-owner');
            expect(realm.vendorBoundaryFixture?.rawOwner).toBe(readFileSync(`${owner}.ts`, 'utf8'));
            expect(forbiddenFetch).not.toHaveBeenCalled();
        } finally {rmSync(fixture, {recursive: true, force: true});}
    }, 30_000);

    it.each([
        ['ordinary', '0', '0', true], ['standalone', '1', '0', true],
        ['greasy-fork', '0', '1', false], ['standalone-and-greasy', '1', '1', false],
    ] as const)('executes real %s owner builds and preserves the expected SDK module reachability', async (_label, standalone, greasy, lightweight) => {
        vi.stubEnv('FLUENTREAD_USERSCRIPT_STANDALONE', standalone);
        vi.stubEnv('FLUENTREAD_USERSCRIPT_GREASYFORK_SOURCE', greasy);
        vi.stubEnv('FLUENTREAD_USERSCRIPT_VENDOR_URL', 'https://fixture.invalid/vendor.js');
        vi.stubEnv('FLUENTREAD_USERSCRIPT_DATA_URL', 'https://fixture.invalid/data.js');
        vi.stubGlobal('window', {});
        const forbiddenFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Unexpected global network request'); });
        const fixture = mkdtempSync(resolve(tmpdir(), 'fluentread-openai-owner-'));
        try {
            vi.resetModules();
            const {default: configuration} = await import('@/userscript/vite.config');
            const config = configuration as import('vite').UserConfig;
            const plugin = (config.plugins as import('vite').Plugin[]).find(item => item.name === 'standalone-openai-transport');
            expect(Boolean(plugin)).toBe(lightweight);
            const callerSources = new Map(callers.map(id => {
                const match = readFileSync(id, 'utf8').match(/import\s*\{translateWithOpenAICompatibleAiSdk\}\s*from\s*['"]([^'"]+)['"]/u);
                if (!match) throw new Error(`Production caller changed: ${id}`);
                return [id, `export {translateWithOpenAICompatibleAiSdk} from ${JSON.stringify(match[1])};`];
            }));
            const imports = [...callers, owner, `${owner}.ts`, '@/src/providers/translation/ai-sdk/openai-compatible', '@/src/providers/translation/ai-sdk/openai-compatible.ts'];
            const entryPath = resolve(fixture, 'entry.mjs');
            writeFileSync(entryPath, imports.map((source, i) => `import {translateWithOpenAICompatibleAiSdk as run${i}} from ${JSON.stringify(source)};`).join('\n')
                + `\nglobalThis.openAIOwnerFixture=[${imports.map((_, i) => `run${i}`).join(',')}];`);
            const loadedCallers = new Set<string>();
            const boundary: import('vite').Plugin = {name: 'controlled-openai-consumer', enforce: 'pre', load(id) {
                if (callerSources.has(id)) { loadedCallers.add(id); return callerSources.get(id); }
                // 共享编排另有独立合同测试；这里保留真实 execution.run 的可达性，且不替换任何 SDK 模块。
                if (id === transport) return 'export function translateOpenAICompatible(call, execution) { return execution.run(call); } export const AI_SDK_MAX_RETRIES=2, AI_SDK_REQUEST_TIMEOUT_MS=120000;';
                return null;
            }};
            const {build} = await import('vite');
            const result = await build({root, configFile: false, publicDir: false, logLevel: 'silent',
                plugins: [...(plugin ? [plugin] : []), boundary], resolve: config.resolve, define: config.define,
                build: {...config.build, write: false, outDir: resolve(fixture, 'unused-output'),
                    lib: {entry: entryPath, name: 'OpenAIOwnerFixture', formats: ['iife']}}});
            const outputs = Array.isArray(result) ? result : [result];
            expect(outputs).toHaveLength(1);
            if (!('output' in outputs[0]) || outputs[0].output.length !== 1 || outputs[0].output[0].type !== 'chunk') throw new Error('Expected one actual owner build');
            const chunk = outputs[0].output[0];
            expect(chunk.dynamicImports).toEqual([]);
            // 纯 re-export 的消费模块会被 Rollup 合并；load 证据仍固定三个真实 importer 的解析。
            expect([...loadedCallers].sort()).toEqual(callers.slice().sort());
            expect(chunk.moduleIds).toContain(transport);
            expect(chunk.moduleIds.includes(standaloneOwner)).toBe(lightweight);
            expect(chunk.moduleIds.includes(`${owner}.ts`)).toBe(!lightweight);
            expect(chunk.moduleIds.includes(http)).toBe(lightweight);
            const externalSDK = !lightweight && standalone === '0' && greasy === '1';
            expect(chunk.imports.slice().sort()).toEqual(externalSDK ? ['@ai-sdk/openai-compatible', 'ai'] : []);
            expect(chunk.moduleIds.some(id => /\/node_modules\/ai\/dist\//u.test(id))).toBe(!lightweight && !externalSDK);
            expect(chunk.moduleIds.some(id => /\/node_modules\/@ai-sdk\/openai-compatible\/dist\//u.test(id))).toBe(!lightweight && !externalSDK);
            if (lightweight) expect(chunk.moduleIds.filter(id => /\/node_modules\/(?:@ai-sdk\/|ai\/|zod\/)/u.test(id))).toEqual([]);
            const realm = {openAIOwnerFixture: undefined as Array<(call: unknown) => Promise<string>> | undefined,
                window: {}, URL, URLSearchParams, Headers, Request, Response, AbortController, AbortSignal, TextDecoder, TextEncoder,
                ReadableStream, WritableStream, TransformStream, fetch: forbiddenFetch,
                Uint8Array, ArrayBuffer, Error, TypeError, DOMException, structuredClone, performance,
                crypto: globalThis.crypto, setTimeout, clearTimeout, console,
                // Greasy 的外部出口也使用安装的真实 SDK，只把固定 @require 的加载位置替换为内存对象。
                FluentReadUserscriptVendor: externalSDK ? {ai: await import('ai'), openAICompatible: await import('@ai-sdk/openai-compatible')} : undefined};
            runInNewContext(chunk.code, realm, {timeout: 5_000});
            const runs = realm.openAIOwnerFixture!;
            expect(runs).toHaveLength(imports.length);
            expect(new Set(runs).size).toBe(1);
            const requests: Array<{url: string; body: string; headers: Headers}> = [];
            const controller = new AbortController();
            const requestBody = {model: 'controlled-build-model', messages: [{role: 'user', content: '构建端口 fixture'}], stream: false};
            const call = {endpoint: {endpoint: 'https://fixture.invalid/v1/chat/completions', baseURL: 'https://fixture.invalid/v1/', queryParams: {'api-version': 'fixture'}},
                apiKey: 'synthetic-build-key', headers: {'X-Owner': 'fixture'}, requestBody, maxRetries: 0, signal: controller.signal,
                fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
                    requests.push({url: String(input), body: String(init?.body), headers: new Headers(init?.headers)});
                    return new Response(JSON.stringify({choices: [{message: {role: 'assistant', content: '构建端口译文'}, finish_reason: 'stop'}]}),
                        {headers: {'content-type': 'application/json'}});
                }};
            for (const run of runs) expect(await run(call)).toBe('构建端口译文');
            expect(requests).toHaveLength(imports.length);
            for (const request of requests) {
                expect(request.url).toBe('https://fixture.invalid/v1/chat/completions?api-version=fixture');
                expect(request.body).toBe(JSON.stringify(requestBody));
                expect(request.headers.get('authorization')).toBe('Bearer synthetic-build-key');
                expect(request.headers.get('x-owner')).toBe('fixture');
            }
            expect(forbiddenFetch).not.toHaveBeenCalled();
        } finally {
            rmSync(fixture, {recursive: true, force: true});
            forbiddenFetch.mockRestore();
            vi.unstubAllEnvs();vi.unstubAllGlobals();vi.resetModules();
        }
    }, 30_000);
});

describe('userscript appearance registry data owner', () => {
    const root=process.cwd(), id=resolve(root,'src/core/config/interfaceAppearance.ts');
    const actualSource=readFileSync(id,'utf8');
    type Transform={transform(code:string,id:string):{code:string;map:null}|null};
    const plugin=(enabled=true)=>createUserscriptSettingsDataPlugin(root,enabled,true) as unknown as Transform;
    const fixture=(skin='[{value:"skin"}]',font='[{value:"font"}]')=>`export const interfaceSkinOptions=${skin};export const interfaceFontOptions=${font};`;
    function transformed(code=actualSource){const result=plugin().transform(code,id);expect(result).not.toBeNull();return result!.code;}
    async function execute(source:string){
        const {transformWithEsbuild}=await import('vite');
        const compiled=await transformWithEsbuild(source,'appearance-owner.ts',{format:'cjs',target:'es2018'});
        const module={exports:{} as typeof originalAppearance},decode=vi.fn(inflateBundledFrancData),unrelated={unchanged:true};
        const realm={module,exports:module.exports,Uint8Array,atob,unrelated,require:(name:string)=>{
            if(name==='@/userscript/dataEncoding')return {decodeUserscriptData};
            expect(name).toBe('@/userscript/pakoRuntime');return {inflateWithPako:decode};}};
        runInNewContext(compiled.code,realm,{timeout:5000});expect(realm.unrelated).toBe(unrelated);
        return {api:module.exports,decode};
    }
    function ordered(value:unknown):unknown{
        if(Array.isArray(value))return value.map(ordered);
        if(value&&typeof value==='object')return Object.entries(value).map(([key,item])=>[key,ordered(item)]);
        return value;
    }
    function complete(api:typeof originalAppearance){
        expect(ordered(api.interfaceSkinOptions)).toEqual(ordered(originalAppearance.interfaceSkinOptions));
        expect(ordered(api.interfaceFontOptions)).toEqual(ordered(originalAppearance.interfaceFontOptions));
        expect(api.interfaceSkinOptions).toHaveLength(14);expect(api.interfaceFontOptions).toHaveLength(10);
        for(const skin of api.interfaceSkinOptions){expect(api.getInterfaceSkinOption(skin.value)).toBe(skin);expect(api.normalizeInterfaceSkin(skin.value)).toBe(skin.value);expect(api.interfaceSkinUsesContentHeight(skin.value)).toBe(originalAppearance.interfaceSkinUsesContentHeight(skin.value));}
        for(const font of api.interfaceFontOptions){expect(api.getInterfaceFontOption(font.value)).toBe(font);expect(api.normalizeInterfaceFont(font.value)).toBe(font.value);}
        for(const value of ['cheese','ocean','matcha','sakura','emoji','midnight','paper','aurora','arcade','sunset','unknown',null,1]){
            const expected=originalAppearance.getInterfaceSkinOption(value);expect(api.getInterfaceSkinOption(value)).toBe(api.interfaceSkinOptions.find(item=>item.value===expected.value));
            expect(api.getInterfaceFontOption(value)).toBe(api.interfaceFontOptions[0]);
        }
        expect(api.DEFAULT_INTERFACE_FONT).toBe(originalAppearance.DEFAULT_INTERFACE_FONT);
        expect(api.normalizePopupModuleOrder(['translation','translation','unknown'])).toEqual(originalAppearance.normalizePopupModuleOrder(['translation','translation','unknown']));
    }
    it('restores the whole real module synchronously with every ordered field, value and existing Map reference',async()=>{
        const code=transformed();expect(code.startsWith(actualSource.slice(0,actualSource.indexOf('export const')))).toBe(true);
        expect(code).toContain(actualSource.slice(actualSource.indexOf('export type InterfaceFont')));
        const {api,decode}=await execute(code);complete(api);expect(decode).toHaveBeenCalledTimes(2);
        const baseline=await execute(actualSource);complete(baseline.api);expect(baseline.decode).not.toHaveBeenCalled();
    });
    it('roundtrips all accepted literal runtime types, nested arrays and object enumeration order',async()=>{
        const skin='[{value:"one",integer:42,fraction:1.25,yes:true,no:false,empty:null,text:`literal`,nested:["x",{second:2,first:1}],constructor:"own"}]';
        const {api,decode}=await execute(transformed(fixture(skin)));expect(ordered(api.interfaceSkinOptions)).toEqual(ordered([{value:'one',integer:42,fraction:1.25,yes:true,no:false,empty:null,text:'literal',nested:['x',{second:2,first:1}],constructor:'own'}]));expect(decode).toHaveBeenCalledTimes(2);
    });
    it.each([id+'?raw',id+'?vue&type=script','\0'+id,resolve(root,'src/core/config/other.ts'),resolve(root,'node_modules/interfaceAppearance.ts')])('does not transform another module or decorated id %s',other=>{
        expect(plugin().transform('arbitrary executable source',other)).toBeNull();
    });
    it('keeps disabled mode inert without reading or executing a module',()=>{
        const disabled=createUserscriptSettingsDataPlugin('/missing-appearance-root',false) as unknown as Transform;
        expect(disabled.transform('throw new Error("not reached")','/missing-appearance-root/src/core/config/interfaceAppearance.ts')).toBeNull();
    });
    it.each([
        ['missing-font','export const interfaceSkinOptions=[];'],['duplicate-skin',fixture()+'export const interfaceSkinOptions=[];'],
        ['duplicate-replacing-font','export const interfaceSkinOptions=[];export const interfaceSkinOptions=[];'],
        ['non-export','const interfaceSkinOptions=[];export const interfaceFontOptions=[];'],
        ['mutable','export let interfaceSkinOptions=[];export const interfaceFontOptions=[];'],
        ['missing-initializer','export const interfaceSkinOptions;export const interfaceFontOptions=[];'],
        ['empty-array',fixture('[]')],['non-array',fixture('{}')],['call',fixture('makeOptions()')],['identifier',fixture('options')],
        ['spread-array',fixture('[...options]')],['array-hole',fixture('[,]')],['spread-object',fixture('[{...options}]')],
        ['computed-key',fixture('[{["value"]:"one"}]')],['duplicate-key',fixture('[{value:1,value:2}]')],['proto-key',fixture('[{"__proto__":{}}]')],
        ['getter',fixture('[{get value(){return 1}}]')],['method',fixture('[{value(){return 1}}]')],['shorthand',fixture('[{value}]')],
        ['template-expression',fixture('[{value:`x${call()}`}]')],['non-finite',fixture('[{value:1e400}]')],['numeric-key',fixture('[{1:"one"}]')],
    ])('rejects %s before any executable source can be evaluated',(_name,code)=>{expect(()=>plugin().transform(code,id)).toThrow('unique exported const literal arrays');});
    it('rejects a corrupted codec roundtrip before producing transformed code',async()=>{
        const zlib=await import('node:zlib');const {syncBuiltinESMExports}=await import('node:module');
        const spy=vi.spyOn(zlib.default,'gunzipSync').mockReturnValueOnce(Buffer.from('null'));syncBuiltinESMExports();
        try{expect(()=>plugin().transform(fixture(),id)).toThrow('unique exported const literal arrays');}
        finally{spy.mockRestore();syncBuiltinESMExports();}
    });
    it.each([
        ['standard','0','0',true],['standalone','1','0',true],['greasy-fork','0','1',false],['standalone-greasy','1','1',false],
    ] as const)('uses the actual %s Vite mode and existing codec alias to preserve the complete API',async(_label,standalone,greasy,enabled)=>{
        vi.stubEnv('FLUENTREAD_USERSCRIPT_STANDALONE',standalone);vi.stubEnv('FLUENTREAD_USERSCRIPT_GREASYFORK_SOURCE',greasy);
        vi.stubEnv('FLUENTREAD_USERSCRIPT_VENDOR_URL','https://fixture.invalid/vendor.js');vi.stubEnv('FLUENTREAD_USERSCRIPT_DATA_URL','https://fixture.invalid/data.js');
        const directory=mkdtempSync(resolve(tmpdir(),'fluentread-appearance-owner-'));
        try{
            vi.resetModules();const {default:configuration}=await import('@/userscript/vite.config');const config=configuration as import('vite').UserConfig;
            const selected=(config.plugins as import('vite').Plugin[]).find(item=>item.name==='standalone-settings-data');expect(selected).toBeDefined();
            const entry=resolve(directory,'entry.ts');writeFileSync(entry,'import * as appearance from "@/src/core/config/interfaceAppearance";globalThis.appearanceOwner=appearance;');
            const {build}=await import('vite');const result=await build({root,configFile:false,publicDir:false,logLevel:'silent',plugins:[selected!,observeDataDecoder()],resolve:config.resolve,
                build:{...config.build,write:false,outDir:resolve(directory,'unused'),lib:{entry,name:'AppearanceOwner',formats:['iife']},rollupOptions:{output:{inlineDynamicImports:true}}}});
            const results=Array.isArray(result)?result:[result];if(results.length!==1||!('output' in results[0])||results[0].output.length!==1||results[0].output[0].type!=='chunk')throw Error('Expected one real appearance consumer chunk');
            const chunk=results[0].output[0];expect(chunk.imports).toEqual([]);expect(chunk.dynamicImports).toEqual([]);
            const decode=vi.fn(),realm={appearanceOwner:undefined as typeof originalAppearance|undefined,atob,Uint8Array,ArrayBuffer,pako:{ungzip},__observeUserscriptDataDecode:decode};
            runInNewContext(chunk.code,realm,{timeout:5000});expect(realm.appearanceOwner).toBeDefined();complete(realm.appearanceOwner!);expect(decode).toHaveBeenCalledTimes(enabled?2:0);
            expect(readFileSync(resolve(root,'public/third-party-notices/lobe-icons-MIT.txt'),'utf8')).toContain('Copyright (c) 2023 LobeHub');
        }finally{rmSync(directory,{recursive:true,force:true});vi.unstubAllEnvs();vi.resetModules();}
    }, 30_000);
});

describe('standalone immutable glossary and UI catalogs', () => {
    const targets = [
        ['src/core/glossary/builtins.ts', ['BUILTIN_GLOSSARIES']],
        ['src/core/config/videoSubtitleAppearance.ts', ['VIDEO_SUBTITLE_SKINS']],
        ['src/features/settings/model/chromeTranslationPreparation.ts', ['TEST_SAMPLES']],
        ['src/core/i18n/messages/aiRequestTimeout.ts', ['aiRequestTimeoutChineseMessages', 'aiRequestTimeoutMessages']],
        ['src/core/config/driveSync.ts', ['VISIBLE_FIELDS']],
        ['src/features/settings/model/navigation.ts', ['settingsPagePanels', 'settingsSearchTargets']],
        ['src/core/config/translationLoadingStyle.ts', ['translationLoadingStyleOptions']],
        ['src/core/config/freeTranslation.ts', ['FREE_TRANSLATION_PROVIDERS']],
        ['src/core/language/catalog.ts', ['translationLanguageOptions']],
        ['src/core/language/partOfSpeech.ts', ['PARTS']],
        ['src/core/config/sentenceHighlight.ts', ['SENTENCE_HIGHLIGHT_STYLES']],
        ['src/core/config/selectionTts.ts', ['SELECTION_TTS_VOICE_OPTIONS']],
    ] as const;
    it.each(targets)('restores every ordered value from %s without changing the consumer functions', async (path, names) => {
        const root = process.cwd(), id = resolve(root, path), original = readFileSync(id, 'utf8');
        const transform = (enabled: boolean, full: boolean) => {
            const plugin = createUserscriptSettingsDataPlugin(root, enabled, full);
            return Reflect.apply(plugin.transform as Function, {}, [original, id]) as {code: string} | null;
        };
        expect(transform(false, true)).toBeNull();expect(transform(true, false)).toBeNull();
        const transformed = transform(true, true)!.code;
        const {transformWithEsbuild} = await import('vite');
        async function readCatalog(source: string) {
            const ast = ts.createSourceFile(id, source, ts.ScriptTarget.Latest, true);
            const dataStatements = ast.statements.filter(statement => ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => (names as readonly string[]).includes(declaration.name.getText(ast)))).map(statement => statement.getText(ast)).join('\n');
            const decoderImport = source.includes('__fluentreadInflateSettingsData') ? "import {inflateWithPako as __fluentreadInflateSettingsData} from '@/userscript/pakoRuntime';\nimport {decodeUserscriptData as __fluentreadDecodeSettingsData} from '@/userscript/dataEncoding';\n" : '';
            const compiled = await transformWithEsbuild(`${decoderImport}${dataStatements}\nexport const auditCatalogs = {${names.join(',')}};`, 'actual-catalog.ts', {format: 'cjs', target: 'es2018'});
            const module = {exports: {} as {auditCatalogs: unknown}}, decode = vi.fn(inflateBundledFrancData);
            runInNewContext(compiled.code, {module, exports: module.exports, Uint8Array, atob,
                require: (name: string) => {
                    if (name === '@/userscript/dataEncoding') return {decodeUserscriptData};
                    expect(name).toBe('@/userscript/pakoRuntime');return {inflateWithPako: decode};
                }}, {timeout: 5000});
            return {json: JSON.stringify(module.exports.auditCatalogs), decode};
        }
        const baseline = await readCatalog(original), candidate = await readCatalog(transformed);
        expect(candidate.json).toBe(baseline.json);expect(candidate.decode).toHaveBeenCalledTimes(names.length);
        expect(baseline.decode).not.toHaveBeenCalled();
        // 所有非目标 AST 语句逐字保留，包括实际查找、注册、恢复与错误处理函数。
        const originalAst = ts.createSourceFile(id, original, ts.ScriptTarget.Latest, true);
        for (const statement of originalAst.statements) {
            const target = ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => (names as readonly string[]).includes(declaration.name.getText(originalAst)));
            if (!target) expect(transformed).toContain(statement.getText(originalAst));
        }
    });
});

describe('standalone shared AI timeout locale data', () => {
    const root = process.cwd(), id = resolve(root, 'src/core/i18n/messages/aiRequestTimeout.ts');
    const original = readFileSync(id, 'utf8');
    const transform = (code: string) => Reflect.apply(createUserscriptSettingsDataPlugin(root, true, true).transform as Function, {}, [code, id]) as {code: string};
    const fixture = (chinese = '{message:"中文"}', table = '{"zh-CN":aiRequestTimeoutChineseMessages,"en-US":{message:"English"}}') =>
        `export const aiRequestTimeoutChineseMessages=${chinese};export const aiRequestTimeoutMessages=${table};`;
    it('restores every real locale with the same shared Chinese export identity and key order', async () => {
        const {transformWithEsbuild} = await import('vite');
        const compiled = await transformWithEsbuild(transform(original).code, 'shared-timeout-catalog.ts', {format: 'cjs', target: 'es2018'});
        const module = {exports: {} as typeof import('@/src/core/i18n/messages/aiRequestTimeout')}, decode = vi.fn(inflateBundledFrancData);
        runInNewContext(compiled.code, {module, exports: module.exports, Uint8Array, atob, require: (name: string) => {
            if (name === '@/userscript/dataEncoding') return {decodeUserscriptData};
            expect(name).toBe('@/userscript/pakoRuntime');return {inflateWithPako: decode};
        }}, {timeout: 5000});
        expect(JSON.stringify(module.exports.aiRequestTimeoutMessages)).toBe(JSON.stringify(aiRequestTimeoutMessages));
        expect(JSON.stringify(module.exports.aiRequestTimeoutChineseMessages)).toBe(JSON.stringify(aiRequestTimeoutChineseMessages));
        expect(module.exports.aiRequestTimeoutMessages['zh-CN']).toBe(module.exports.aiRequestTimeoutChineseMessages);
        expect(Object.keys(module.exports.aiRequestTimeoutMessages)).toEqual(Object.keys(aiRequestTimeoutMessages));
        expect(decode).toHaveBeenCalledTimes(2);
    });
    it.each([
        ['unknown-reference', fixture(undefined, '{"zh-CN":otherMessages}')],
        ['called-reference', fixture(undefined, '{"zh-CN":aiRequestTimeoutChineseMessages()}')],
        ['computed-reference', fixture(undefined, '{["zh-CN"]:aiRequestTimeoutChineseMessages}')],
        ['duplicate-reference', fixture(undefined, '{"zh-CN":aiRequestTimeoutChineseMessages,"zh-CN":aiRequestTimeoutChineseMessages}')],
        ['missing-reference', fixture(undefined, '{"en-US":{message:"English"}}')],
        ['alias-chain', fixture('otherMessages')],
        ['called-shared-data', fixture('makeMessages()')],
        ['non-object-shared-data', fixture('[]')],
        ['duplicate-shared-data', fixture('{message:"one",message:"two"}')],
        ['prototype-shared-data', fixture('{"__proto__":{}}')],
        ['executable-other-locale', fixture(undefined, '{"zh-CN":aiRequestTimeoutChineseMessages,"en-US":makeMessages()}')],
        ['unregistered-other-reference', fixture(undefined, '{"zh-CN":aiRequestTimeoutChineseMessages,"en-US":aiRequestTimeoutChineseMessages}')],
        ['mutable-shared-data', fixture().replace('export const aiRequestTimeoutChineseMessages', 'export let aiRequestTimeoutChineseMessages')],
        ['unexported-shared-data', fixture().replace('export const aiRequestTimeoutChineseMessages', 'const aiRequestTimeoutChineseMessages')],
        ['late-shared-data', 'export const aiRequestTimeoutMessages={"zh-CN":aiRequestTimeoutChineseMessages};export const aiRequestTimeoutChineseMessages={message:"中文"};'],
    ])('rejects %s without broadening the JSON literal parser', (_label, code) => {
        expect(() => transform(code)).toThrow();
    });
});

describe('userscript bundled CSS encoding', () => {
    it.each(['0', '1'])('preserves exact gzip bytes and CSS in standalone mode %s', async standalone => {
        vi.stubEnv('FLUENTREAD_USERSCRIPT_STANDALONE', standalone);
        vi.stubEnv('FLUENTREAD_USERSCRIPT_GREASYFORK_SOURCE', '0');
        try {
            vi.resetModules();
            const {default: configuration} = await import('@/userscript/vite.config');
            const {gzipUserscriptBuildData} = await import('@/userscript/buildGzip');
            const plugin = (configuration as {plugins: Array<{name:string;generateBundle?:{handler:Function}}>}).plugins.find(item => item.name === 'bundle-userscript-css')!;
            const entry = {type:'chunk', isEntry:true, code:'var fixture = 1;', moduleIds:[]};
            const css = '/* 世界 */\n:root{--text:"quoted";color:red}';
            const bundle = {'entry.js':entry, 'fixture.css':{type:'asset', fileName:'fixture.css', source:css}};
            await Reflect.apply(plugin.generateBundle!.handler, {}, [{}, bundle]);
            const encoded = JSON.parse(entry.code.match(/globalThis\.__fluentReadUserscriptCssCompressed=("[^"\n]*")/)![1]);
            expect(encoded.startsWith('~91:')).toBe(standalone === '1');
            const bytes = standalone === '1' ? decodeUserscriptData(encoded) : Buffer.from(encoded, 'base64');
            expect(Buffer.from(bytes)).toEqual(gzipUserscriptBuildData(Buffer.from(css)));
            expect(gunzipSync(bytes).toString('utf8')).toBe(css);
            expect(bundle).not.toHaveProperty('fixture.css');
        } finally {vi.unstubAllEnvs();vi.resetModules();}
    }, 30_000);
});
