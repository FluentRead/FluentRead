import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {asArrayBufferBytes} from '@/src/shared/function/arrayBufferBytes';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createContext, runInContext, type Context} from 'node:vm';
import {createHash, createHmac, createCipheriv} from 'node:crypto';
import {createRequire} from 'node:module';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import {IDBFactory, IDBKeyRange} from 'fake-indexeddb';
import {parseHTML} from 'linkedom';
import {TranslationCandidateCore} from '@/src/core/translation/engine';
import {compileSiteRulePack} from '@/src/core/site-adaptation/compiler';
import {builtinSiteRulePack} from '@/src/core/site-adaptation/catalog';
import type {SiteRulePack} from '@/src/core/site-adaptation/types';

// 直接求值被审查的发布资源；基线也执行原 catalog producer，依赖与构建输入使用当前版本。
const resourceRoot = process.env.FLUENTREAD_AUDIT49G_SOURCE_ROOT || process.cwd();
const shippedAssets = new Map<string, string>();
const asset = (file: string) => readFileSync(shippedAssets.get(file) || resolve(resourceRoot, file), 'utf8');
const workerFile = 'public/fluent-read-ocr/worker/worker.min.js';
const coreFile = 'public/fluent-read-ocr/core/tesseract-core-simd-lstm.wasm.js';
const vendorFile = 'userscript/resources/fluentread-vendor.v1.js';
const {window: eventWindow} = parseHTML('<html><body></body></html>');
let packagedWasm: Buffer;
let ownedOutputRoot: string;

beforeAll(async () => {
    ownedOutputRoot = mkdtempSync(join(tmpdir(), 'fluentread-audit49g-ocr-'));
    mkdirSync(resolve(ownedOutputRoot, 'scripts/wasm'), {recursive: true});
    copyFileSync(resolve(process.cwd(), 'scripts/wasm/diagnostics.js'), resolve(ownedOutputRoot, 'scripts/wasm/diagnostics.js'));
    let producer: typeof import('@/scripts/wasm/package-diagnostics');
    if (resourceRoot === process.cwd()) {
        producer = await import('@/scripts/wasm/package-diagnostics');
    } else {
        const file = process.env.FLUENTREAD_AUDIT49G_OCR_BASELINE_PRODUCER;
        if (!file) throw new Error('Original OCR producer fixture is required for baseline comparison');
        const vite = await import('vite');
        const compiled = await vite.transformWithEsbuild(readFileSync(file, 'utf8'), file, {format: 'cjs', target: 'es2018'});
        const module = {exports: {}};
        const realm = createContext({module, exports: module.exports, Buffer, require: createRequire(resolve(process.cwd(), 'package.json'))});
        runInContext(compiled.code, realm, {filename: file, timeout: 5_000});
        producer = module.exports as typeof producer;
    }
    const sources = typeof producer.resolveTesseractSources === 'function'
        ? producer.resolveTesseractSources(resourceRoot)
        : {glue: resolve(resourceRoot, coreFile), worker: resolve(resourceRoot, workerFile)};
    const core = producer.packageTesseractWasm(ownedOutputRoot, sources.glue);
    shippedAssets.set(coreFile, core.glue);
    packagedWasm = readFileSync(core.wasm);
    // 原 WXT hook 直接拷贝锁定 worker；新 hook 使用真实公开 producer，原文件保持不变。
    if (producer.packageTesseractWorker) shippedAssets.set(workerFile, producer.packageTesseractWorker(ownedOutputRoot, sources.worker));
});

afterAll(() => {if (ownedOutputRoot) rmSync(ownedOutputRoot, {recursive: true, force: true});});

function wasmFetch(input: string | URL | Request) {
    if (String(input) !== 'https://fixture.invalid/core/tesseract-core-simd-lstm.wasm') throw new Error(`Unexpected fixture network: ${input}`);
    return Promise.resolve(new Response(asArrayBufferBytes(packagedWasm), {headers: {'Content-Type': 'application/wasm'}}));
}

function nativeCoreRealm() {
    const realm = createContext({WebAssembly, Uint8Array, ArrayBuffer, atob, btoa, URL,
        WorkerGlobalScope: function () {}, location: {href: 'https://fixture.invalid/worker/worker.min.js'}, fetch: wasmFetch,
        console: {log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn()}, setTimeout, clearTimeout, setInterval, clearInterval});
    realm.self = realm;
    runInContext(asset(coreFile), realm, {filename: shippedAssets.get(coreFile), timeout: 5_000});
    return realm;
}

type Vendor = {
    sha256: typeof import('crypto-js/sha256');
    md5: typeof import('crypto-js/md5');
    hmacSha256: typeof import('crypto-js/hmac-sha256');
    aes: typeof import('crypto-js/aes');
    encUtf8: typeof import('crypto-js/enc-utf8');
    encBase64: typeof import('crypto-js/enc-base64');
    modeEcb: typeof import('crypto-js/mode-ecb');
    padPkcs7: typeof import('crypto-js/pad-pkcs7');
    ai: Pick<typeof import('ai'), 'generateText' | 'APICallError' | 'RetryError'>;
    openAICompatible: Pick<typeof import('@ai-sdk/openai-compatible'), 'createOpenAICompatible'>;
    francMin: typeof import('franc-min');
    Dexie: typeof import('dexie')['default'];
};

function vendorRealm(extra: Record<PropertyKey, unknown> = {}) {
    const context = createContext({
        console: {log: vi.fn(), warn: vi.fn(), error: vi.fn()},
        URL, URLSearchParams, Headers, Response, Request, Blob, FormData,
        TextEncoder, TextDecoder, AbortController, AbortSignal, Uint8Array,
        setTimeout, clearTimeout, ReadableStream, TransformStream, queueMicrotask,
        structuredClone, DOMException, CustomEvent: eventWindow.CustomEvent,
        fetch: () => {throw new Error('Unexpected fixture network');},
        ...extra,
    });
    runInContext(asset(vendorFile), context, {filename: resolve(resourceRoot, vendorFile), timeout: 5_000});
    return {context, vendor: context.FluentReadUserscriptVendor as Vendor};
}

type Packet = {jobId: string; workerId: string; action: string; status: string; data: any};

// 浏览器 Worker 只由其真实 message 入口驱动；WASM、fetch、FS 是受控外部端口。
function workerRealm(options: {importCore?: (context: Context) => void; fetch?: typeof fetch} = {}) {
    const packets: Packet[] = [];
    let message: ((event: {data: unknown}) => void) | undefined;
    let complete: ((packet: Packet) => void) | undefined;
    let sequence = 0;
    const imports: string[] = [];
    const context = createContext({
        console: {log: vi.fn(), warn: vi.fn(), error: vi.fn()},
        WebAssembly, Uint8Array, ArrayBuffer, TextEncoder, TextDecoder, URL,
        setTimeout, clearTimeout, setInterval, clearInterval, atob, btoa,
        fetch: options.fetch || vi.fn(() => {throw new Error('Unexpected fixture network');}),
        location: {href: 'https://fixture.invalid/worker/worker.min.js'},
        WorkerGlobalScope: function () {},
        addEventListener(type: string, callback: (event: {data: unknown}) => void) {
            if (type === 'message') message = callback;
        },
        postMessage(packet: Packet) {
            packets.push(packet);
            if (packet.status !== 'progress') complete?.(packet);
        },
        importScripts(url: string) {imports.push(url); options.importCore?.(context);},
    });
    context.self = context;
    runInContext(asset(workerFile), context, {filename: shippedAssets.get(workerFile) || resolve(resourceRoot, workerFile), timeout: 5_000});
    if (!message) throw new Error('Worker resource did not register its public message entry');
    return {
        context, packets, imports,
        async send(action: string, payload: unknown) {
            const jobId = `fixture-${++sequence}`;
            let timer: ReturnType<typeof setTimeout>;
            try {
                return await new Promise<Packet>((resolvePacket, reject) => {
                    timer = setTimeout(() => reject(new Error(`Worker fixture timed out: ${action}`)), 3_000);
                    complete = packet => {if (packet.jobId === jobId) resolvePacket(packet);};
                    message!({data: {workerId: 'synthetic-worker', jobId, action, payload}});
                });
            } finally {
                clearTimeout(timer!);
                complete = undefined;
            }
        },
    };
}

function corePort() {
    const files = new Map<string, unknown>();
    const api = {
        End: vi.fn(), Init: vi.fn(() => 0), SetVariable: vi.fn(),
        SetImageFile: vi.fn(() => 1), SaveParameters: vi.fn(), RestoreParameters: vi.fn(),
        Recognize: vi.fn(), GetUTF8Text: vi.fn(() => 'Synthetic recognized text'),
        MeanTextConf: vi.fn(() => 99), GetJSONText: vi.fn(() => '{"blocks":[]}'),
        GetPageSegMode: vi.fn(() => 11), oem: vi.fn(() => 1), Version: vi.fn(() => 'fixture-5'),
    };
    const module = {
        FS: {
            writeFile: vi.fn((file: string, data: unknown) => {files.set(file, data);}),
            readFile: vi.fn((file: string) => files.get(file)),
            mkdir: vi.fn(), unlink: vi.fn((file: string) => {files.delete(file);}),
        },
        TessBaseAPI: function () {return api;},
    };
    const factory = vi.fn(async () => module);
    const realm = workerRealm({importCore: context => {context.TesseractCore = factory;}});
    return {...realm, factory, module, api, files};
}

const loadPayload = {options: {lstmOnly: true, corePath: 'https://fixture.invalid/core.wasm.js', logging: false}};

async function shippedCatalogs() {
    const env = {
        FLUENTREAD_USERSCRIPT_GREASYFORK_SOURCE: '1',
        FLUENTREAD_USERSCRIPT_VENDOR_URL: 'https://fixture.invalid/vendor.js',
        FLUENTREAD_USERSCRIPT_DATA_URL: 'https://fixture.invalid/data.js',
    };
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    try {
        const vite = await import('vite');
        let createPlugin: typeof import('@/userscript/vite.config')['createUserscriptCatalogCompressionPlugin'];
        if (resourceRoot === process.cwd()) {
            ({createUserscriptCatalogCompressionPlugin: createPlugin} = await import('@/userscript/vite.config'));
        } else {
            // 原生产 plugin 在当前依赖与构建输入上执行；只绑定模块端口，不复制虚拟目录逻辑。
            const file = resolve(resourceRoot, 'userscript/vite.config.ts');
            const compiled = await vite.transformWithEsbuild(readFileSync(file, 'utf8'), file, {format: 'cjs', target: 'es2018'});
            const dependencies: Record<string, unknown> = {
                './metadata': await import('@/userscript/metadata'),
                '../src/core/i18n/bundles': await import('@/src/core/i18n/bundles'),
                '../src/core/i18n/messages/zh-CN': await import('@/src/core/i18n/messages/zh-CN'),
                '@vitejs/plugin-vue': await import('@vitejs/plugin-vue'),
                vite,
            };
            const requirePackage = createRequire(resolve(process.cwd(), 'package.json'));
            const module = {exports: {}};
            const realm = createContext({module, exports: module.exports, Buffer,
                __dirname: resolve(process.cwd(), 'userscript'), __filename: file, process: {env},
                require(name: string) {
                    if (Object.hasOwn(dependencies, name)) return {__esModule: true, ...dependencies[name] as object};
                    if (name.startsWith('node:') || name === 'typescript') return requirePackage(name);
                    throw new Error(`Uncontrolled baseline plugin dependency: ${name}`);
                },
            });
            runInContext(compiled.code, realm, {filename: file, timeout: 5_000});
            createPlugin = (module.exports as typeof import('@/userscript/vite.config')).createUserscriptCatalogCompressionPlugin;
        }
        const plugin = createPlugin();
        const realm = createContext({});
        runInContext(asset('userscript/resources/fluentread-data.v1.js'), realm, {timeout: 5_000});
        const original = realm.__FLUENTREAD_USERSCRIPT_DATA__.siteCatalogs;
        const catalogs: Record<string, any> = {};
        for (const name of ['established', 'websites', 'profiles']) {
            const resolver = typeof plugin.resolveId === 'function' ? plugin.resolveId : plugin.resolveId!.handler;
            const loader = typeof plugin.load === 'function' ? plugin.load : plugin.load!.handler;
            const id = await Reflect.apply(resolver, {}, [`./catalog/${name}.json`, resolve(process.cwd(), 'src/core/site-adaptation/pack.ts')]);
            if (typeof id !== 'string') throw new Error(`Catalog producer did not resolve ${name}`);
            const source = await Reflect.apply(loader, {}, [id]);
            if (typeof source !== 'string') throw new Error(`Catalog producer did not load ${name}`);
            const compiled = await vite.transformWithEsbuild(source, `${name}.js`, {format: 'cjs', target: 'es2018'});
            realm.module = {exports: {}};
            // CommonJS 模块各自拥有词法作用域；发布 data 仍在同一个管理器 realm 中共享。
            runInContext(`(function () {\n${compiled.code}\n})()`, realm, {timeout: 5_000});
            catalogs[name] = realm.module.exports.default;
        }
        return {catalogs, original};
    } finally {
        vi.unstubAllEnvs();
    }
}

describe('audit 49G shipped userscript resources', () => {
    it('publishes data into its manager realm and leaves the supplied host object untouched', () => {
        const host = {existing: 'host'};
        const realm = createContext({window: host});
        runInContext(asset('userscript/resources/fluentread-data.v1.js'), realm, {filename: resolve(resourceRoot, 'userscript/resources/fluentread-data.v1.js'), timeout: 5_000});
        const data = realm.__FLUENTREAD_USERSCRIPT_DATA__;
        expect(Object.keys(data).sort()).toEqual(['css', 'english', 'siteCatalogs', 'zhCNMessages']);
        expect(data.english.messages['settings.excludedLanguages.title']).toBe('Languages to skip');
        expect(data.zhCNMessages['settings.excludedLanguages.title']).toBe('不翻译的语言');
        expect(Object.keys(data.siteCatalogs).sort()).toEqual(['established', 'profiles', 'websites']);
        expect(host).toEqual({existing: 'host'});
    });

    it('delivers the actual site catalogs without introducing executable functions', async () => {
        const realm = createContext({});
        runInContext(asset('userscript/resources/fluentread-data.v1.js'), realm, {filename: resolve(resourceRoot, 'userscript/resources/fluentread-data.v1.js'), timeout: 5_000});
        const {catalogs, original} = await shippedCatalogs();
        expect(original.established.length).toBeGreaterThan(0);
        expect(realm.__FLUENTREAD_USERSCRIPT_DATA__.siteCatalogs.established).toEqual(original.established);
        for (const name of ['established', 'profiles', 'websites']) {
            const expected = JSON.parse(readFileSync(resolve(process.cwd(), `src/core/site-adaptation/catalog/${name}.json`), 'utf8'));
            expect(catalogs[name]).toEqual(expected);
            // 三个目录都可能有固定资源发布后的数据补丁；未更新的对象必须复用，更新对象必须替换。
            if (JSON.stringify(expected) === JSON.stringify(original[name])) expect(catalogs[name]).toBe(original[name]);
            else expect(catalogs[name]).not.toBe(original[name]);
            for (const [key, rule] of Object.entries(original[name]) as Array<[string, any]>) {
                const current = Array.isArray(expected) ? catalogs[name].find((candidate: any) => candidate.id === rule.id) : catalogs[name][key];
                const wanted = Array.isArray(expected) ? expected.find((candidate: any) => candidate.id === rule.id) : expected[key];
                if (!wanted) expect(current).toBeUndefined();
                else if (JSON.stringify(wanted) === JSON.stringify(rule)) expect(current).toBe(rule);
                else expect(current).not.toBe(rule);
            }
        }
        const pending = [realm.__FLUENTREAD_USERSCRIPT_DATA__, catalogs];
        while (pending.length) {
            const current = pending.pop();
            expect(typeof current).not.toBe('function');
            if (current && typeof current === 'object') pending.push(...Object.values(current));
        }
    });

    it('preserves native player captions when the shipped data feeds the real candidate engine', async () => {
        const {catalogs} = await shippedCatalogs();
        const shippedPack: SiteRulePack = {version: 1, profiles: catalogs.profiles, rules: [...catalogs.established, ...catalogs.websites]};
        const {document} = parseHTML('<html><body><p id="caption" data-caption-text>Native player subtitle text.</p><p id="prose">An ordinary article paragraph.</p></body></html>');
        const control = new TranslationCandidateCore({url: new URL('https://meet.google.com/fixture'), adapters: compileSiteRulePack(builtinSiteRulePack)});
        expect(control.discover(document).map(candidate => candidate.element.id)).toEqual(['prose']);
        const shipped = new TranslationCandidateCore({url: new URL('https://meet.google.com/fixture'), adapters: compileSiteRulePack(shippedPack)});
        expect(shipped.discover(document).map(candidate => candidate.element.id)).toEqual(['prose']);
    });

    it('preserves GitHub code and discovers ordinary prose through the shipped virtual catalog', async () => {
        const {catalogs} = await shippedCatalogs();
        const shippedPack: SiteRulePack = {version: 1, profiles: catalogs.profiles, rules: [...catalogs.established, ...catalogs.websites]};
        const {document} = parseHTML('<html><body><div class="markdown-body"><p id="code" class="blob-code">const nativeCode = 42;</p><p id="prose">An ordinary article paragraph.</p></div></body></html>');
        const control = new TranslationCandidateCore({url: new URL('https://github.com/fixture'), adapters: compileSiteRulePack(builtinSiteRulePack)});
        expect(control.discover(document).map(candidate => candidate.element.id)).toEqual(['prose']);
        const shipped = new TranslationCandidateCore({url: new URL('https://github.com/fixture'), adapters: compileSiteRulePack(shippedPack)});
        expect(shipped.discover(document).map(candidate => candidate.element.id)).toEqual(['prose']);
    });

    it('hashes UTF-8, empty and bounded large inputs through the shipped crypto exports', () => {
        const {vendor} = vendorRealm();
        for (const input of ['', 'FluentRead 中文🙂', 'bounded-input\0'.repeat(8_192)]) {
            expect(vendor.sha256(input).toString()).toBe(createHash('sha256').update(input).digest('hex'));
            expect(vendor.md5(input).toString()).toBe(createHash('md5').update(input).digest('hex'));
            expect(vendor.hmacSha256(input, 'synthetic-key').toString()).toBe(createHmac('sha256', 'synthetic-key').update(input).digest('hex'));
        }
    });

    it('encrypts with the shipped AES/ECB/PKCS7 exports and round-trips UTF-8', () => {
        const {vendor} = vendorRealm();
        const input = 'FluentRead 密文🙂';
        const key = '0123456789abcdef';
        const encrypted = vendor.aes.encrypt(input, vendor.encUtf8.parse(key), {mode: vendor.modeEcb, padding: vendor.padPkcs7});
        const cipher = createCipheriv('aes-128-ecb', Buffer.from(key), null);
        expect(encrypted.ciphertext.toString(vendor.encBase64)).toBe(Buffer.concat([cipher.update(input), cipher.final()]).toString('base64'));
        expect(vendor.aes.decrypt(encrypted, vendor.encUtf8.parse(key), {mode: vendor.modeEcb, padding: vendor.padPkcs7}).toString(vendor.encUtf8)).toBe(input);
    });

    it('returns undefined-language for empty input and respects franc candidate restrictions', () => {
        const {vendor} = vendorRealm();
        expect(vendor.francMin.franc('')).toBe('und');
        expect(vendor.francMin.francAll('abc')).toEqual([['und', 1]]);
        const input = 'This is an English paragraph about reading and translating a complete page.';
        expect(vendor.francMin.franc(input, {only: ['eng']})).toBe('eng');
        expect(vendor.francMin.francAll(input, {only: ['eng', 'fra'], ignore: ['eng']}).map(item => item[0])).toEqual(['fra']);
        expect(vendor.francMin.francAll(input, {only: ['missing-language']})).toEqual([['und', 1]]);
    });

    it('keeps Dexie storage and its singleton marker inside the synthetic realm', async () => {
        const hostDexie = {version: 'fixture-host'};
        const {context, vendor} = vendorRealm({indexedDB: new IDBFactory(), IDBKeyRange, [Symbol.for('Dexie')]: hostDexie});
        const database = new vendor.Dexie('audit49g-memory-only');
        database.version(1).stores({words: '++id,text'});
        try {
            await database.open();
            await database.table('words').add({text: 'synthetic-word'});
            expect(await database.table('words').toArray()).toEqual([{id: 1, text: 'synthetic-word'}]);
            expect(context[Symbol.for('Dexie') as any]).toBe(hostDexie);
        } finally {
            database.close();
            await database.delete();
        }
    });

    it('uses the shipped AI SDK public entry and sends only the explicit synthetic credentials', async () => {
        const requests: {url: string; body: any; headers: Headers}[] = [];
        const {vendor} = vendorRealm();
        const provider = vendor.openAICompatible.createOpenAICompatible({
            name: 'fixture', baseURL: 'https://fixture.invalid/v1/', apiKey: 'synthetic-key',
            fetch: async (input, init) => {
                requests.push({url: String(input), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers)});
                return Response.json({id: 'fixture-id', model: 'fixture-model', choices: [{index: 0, message: {role: 'assistant', content: 'Fixture translation'}, finish_reason: 'stop'}], usage: {prompt_tokens: 3, completion_tokens: 2, total_tokens: 5}});
            },
        });
        const result = await vendor.ai.generateText({model: provider.chatModel('fixture-model'), prompt: 'Synthetic source', maxRetries: 0});
        expect(result.text).toBe('Fixture translation');
        expect(result.usage.inputTokens).toBe(3);
        expect(result.usage.outputTokens).toBe(2);
        expect(requests).toHaveLength(1);
        expect(requests[0].url).toBe('https://fixture.invalid/v1/chat/completions');
        expect(requests[0].headers.get('authorization')).toBe('Bearer synthetic-key');
        expect(requests[0].body.messages).toEqual([{role: 'user', content: 'Synthetic source'}]);
    });

    it('reports a provider failure through the shipped APICallError without retrying', async () => {
        const {vendor} = vendorRealm();
        const fetchPort = vi.fn(async () => Response.json({error: {message: 'fixture rate limit', type: 'fixture', code: 'fixture-limit'}}, {status: 429}));
        const provider = vendor.openAICompatible.createOpenAICompatible({name: 'fixture', baseURL: 'https://fixture.invalid/v1', apiKey: 'synthetic-key', fetch: fetchPort});
        let failure: unknown;
        try {await vendor.ai.generateText({model: provider.chatModel('fixture-model'), prompt: 'Synthetic source', maxRetries: 0});} catch (error) {failure = error;}
        expect(vendor.ai.APICallError.isInstance(failure)).toBe(true);
        expect(failure).toMatchObject({statusCode: 429, message: 'fixture rate limit', isRetryable: true});
        expect(fetchPort).toHaveBeenCalledTimes(1);
    });

    it('aborts an in-flight AI request and permits a separate request to complete', async () => {
        const {vendor} = vendorRealm();
        const controller = new AbortController();
        let reached!: () => void;
        const started = new Promise<void>(resolveStarted => {reached = resolveStarted;});
        const fetchPort: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
            const signal = init!.signal!;
            const abort = () => {signal.removeEventListener('abort', abort); reject(new DOMException('Fixture cancellation', 'AbortError'));};
            signal.addEventListener('abort', abort, {once: true});
            reached();
        });
        const provider = vendor.openAICompatible.createOpenAICompatible({name: 'fixture', baseURL: 'https://fixture.invalid/v1', apiKey: 'synthetic-key', fetch: fetchPort});
        const result = vendor.ai.generateText({model: provider.chatModel('fixture-model'), prompt: 'Synthetic source', abortSignal: controller.signal, maxRetries: 0});
        const rejection = expect(result).rejects.toMatchObject({name: 'AbortError'});
        await started;
        controller.abort();
        await rejection;
        const second = vendor.openAICompatible.createOpenAICompatible({name: 'fixture', baseURL: 'https://fixture.invalid/v1', fetch: async () => Response.json({choices: [{message: {role: 'assistant', content: 'Next request'}, finish_reason: 'stop'}]})});
        expect((await vendor.ai.generateText({model: second.chatModel('fixture-model'), prompt: 'Synthetic next source', maxRetries: 0})).text).toBe('Next request');
    });

    it('bridges manager-lexical Vue to an actual mounted Element Plus client template', async () => {
        const {document, window} = parseHTML('<html><body><div id="app"></div><p id="host">Host text</p></body></html>');
        const context = createContext({document, window, Element: window.Element, HTMLElement: window.HTMLElement,
            SVGElement: window.SVGElement, Node: window.Node, Event: window.Event, navigator: {userAgent: 'fixture'},
            console: {log: vi.fn(), warn: vi.fn(), error: vi.fn()}, setTimeout, clearTimeout,
            requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout});
        const vue = readFileSync(resolve(process.cwd(), 'node_modules/vue/dist/vue.global.prod.js'), 'utf8');
        const elementPlus = readFileSync(resolve(process.cwd(), 'node_modules/element-plus/dist/index.full.min.js'), 'utf8');
        runInContext(`let Vue = (function () {${vue}\nreturn Vue;})()`, context, {timeout: 5_000});
        expect(context.Vue).toBeUndefined();
        runInContext(asset('userscript/vueElementPlusBridge.v1.js'), context, {filename: resolve(resourceRoot, 'userscript/vueElementPlusBridge.v1.js'), timeout: 5_000});
        runInContext(elementPlus, context, {timeout: 5_000});
        runInContext('globalThis.fixtureApp = Vue.createApp({template: `<el-button @click="count++">{{count}}</el-button>`, setup() {return {count: Vue.ref(0)}}});' +
            'globalThis.fixtureVue = Vue; fixtureApp.use(ElementPlus); fixtureApp.mount("#app");', context, {filename: 'audit49g-client-template.js', timeout: 5_000});
        try {
            expect(context.Vue).toBe(context.fixtureVue);
            expect(document.querySelector('button')!.textContent).toBe('0');
            document.querySelector('button')!.dispatchEvent(new window.Event('click', {bubbles: true}));
            await context.Vue.nextTick();
            expect(document.querySelector('button')!.textContent).toBe('1');
            expect(document.querySelector('#host')!.textContent).toBe('Host text');
        } finally {
            context.fixtureApp.unmount();
        }
        expect(document.querySelector('#app')!.childNodes).toHaveLength(0);
    });
});

describe('audit 49G shipped OCR worker message entry', () => {
    it('initializes the actual packaged WASM and exercises its public memory filesystem', async () => {
        const realm = nativeCoreRealm();
        const module = await realm.TesseractCore({print: vi.fn(), printErr: vi.fn()});
        module.FS.writeFile('/synthetic.txt', 'Synthetic 中文🙂');
        expect(module.FS.readFile('/synthetic.txt', {encoding: 'utf8'})).toBe('Synthetic 中文🙂');
        const api = new module.TessBaseAPI();
        try {
            expect(api.Version()).toMatch(/^5\./u);
            api.SetPageSegMode(11);
            expect(api.GetPageSegMode()).toBe(11);
        } finally {
            api.End();
            module.destroy(api);
            module.FS.unlink('/synthetic.txt');
        }
        expect(() => module.FS.readFile('/synthetic.txt')).toThrow();
    });

    it('releases public filesystem streams when rejecting unsupported write data', async () => {
        const realm = nativeCoreRealm();
        const module = await realm.TesseractCore({print: vi.fn(), printErr: vi.fn()});
        const originalStreams = new Set(module.FS.streams.filter(Boolean));
        try {
            for (let index = 0; index < 32; index++) {
                expect(() => module.FS.writeFile('/unsupported.txt', {})).toThrow('Unsupported data type');
            }
            expect(module.FS.streams.filter(Boolean)).toHaveLength(originalStreams.size);
        } finally {
            for (const stream of module.FS.streams.filter(Boolean)) {
                if (!originalStreams.has(stream)) module.FS.close(stream);
            }
            module.FS.unlink('/unsupported.txt');
        }
    });

    it('loads only the explicit local-core port and reuses a loaded module', async () => {
        const realm = corePort();
        expect(await realm.send('load', loadPayload)).toMatchObject({status: 'resolve', data: {loaded: true}});
        expect(await realm.send('load', loadPayload)).toMatchObject({status: 'resolve', data: {loaded: true}});
        expect(realm.imports).toEqual(['https://fixture.invalid/core.wasm.js']);
        expect(realm.factory).toHaveBeenCalledTimes(1);
    });

    it('reports a synchronous core-import failure with the original job identity', async () => {
        const realm = workerRealm({importCore: () => {throw new Error('Fixture core missing');}});
        expect(await realm.send('load', loadPayload)).toEqual({workerId: 'synthetic-worker', jobId: 'fixture-1', action: 'load', status: 'reject', data: 'Error: Fixture core missing'});
    });

    it('awaits an asynchronous core failure and emits one rejection for its original job', async () => {
        const realm = workerRealm({importCore: context => {context.TesseractCore = async () => {throw new Error('Fixture core initialization rejected');};}});
        const terminal = await realm.send('load', loadPayload);
        expect(terminal).toEqual({workerId: 'synthetic-worker', jobId: 'fixture-1', action: 'load', status: 'reject', data: 'Error: Fixture core initialization rejected'});
        expect(realm.packets.filter(packet => packet.jobId === terminal.jobId && packet.status !== 'progress')).toEqual([terminal]);
    });

    it('emits one terminal rejection when actual native initialization rejects invalid model bytes', async () => {
        let nativeModule: any;
        const realm = workerRealm({fetch: wasmFetch as typeof fetch, importCore: context => {
            runInContext(asset(coreFile), context, {filename: shippedAssets.get(coreFile), timeout: 5_000});
            const factory = context.TesseractCore;
            context.TesseractCore = async (options: object) => {
                nativeModule = await factory({...options, print: vi.fn(), printErr: vi.fn()});
                return nativeModule;
            };
        }});
        try {
            expect(await realm.send('load', loadPayload)).toMatchObject({status: 'resolve'});
            await realm.send('loadLanguage', {langs: [{code: 'eng', data: new Uint8Array([0, 1, 2, 3])}], options: {cacheMethod: 'none', gzip: false, lstmOnly: true}});
            const terminal = await realm.send('initialize', {langs: 'eng', oem: 1, config: {tessedit_load_sublangs: ''}});
            await new Promise(resolveTurn => setTimeout(resolveTurn, 0));
            expect(realm.packets.filter(packet => packet.jobId === terminal.jobId && packet.status !== 'progress')).toEqual([
                {workerId: 'synthetic-worker', jobId: 'fixture-3', action: 'initialize', status: 'reject', data: 'initialization failed'},
            ]);
        } finally {
            if (nativeModule) await realm.send('terminate', {});
        }
    });

    it('routes FS operations to the actual loaded module and surfaces invalid methods', async () => {
        const realm = corePort();
        await realm.send('load', loadPayload);
        expect(await realm.send('FS', {method: 'writeFile', args: ['/synthetic', 'Synthetic file']})).toMatchObject({status: 'resolve'});
        expect(await realm.send('FS', {method: 'readFile', args: ['/synthetic']})).toMatchObject({status: 'resolve', data: 'Synthetic file'});
        expect(await realm.send('FS', {method: 'missingMethod', args: []})).toMatchObject({status: 'reject'});
        expect(await realm.send('FS', {method: 'unlink', args: ['/synthetic']})).toMatchObject({status: 'resolve'});
        expect(realm.files.has('/synthetic')).toBe(false);
    });

    it('loads explicit synthetic language bytes and forwards only native parameters', async () => {
        const realm = corePort();
        await realm.send('load', loadPayload);
        const langs = [{code: 'eng', data: new Uint8Array([1, 2, 3])}];
        expect(await realm.send('loadLanguage', {langs, options: {cacheMethod: 'none', gzip: false, lstmOnly: true}})).toMatchObject({status: 'resolve', data: langs});
        expect(realm.files.get('./eng.traineddata')).toEqual(new Uint8Array([1, 2, 3]));
        expect(await realm.send('initialize', {langs: 'eng', oem: 1, config: {tessedit_load_sublangs: ''}})).toMatchObject({status: 'resolve'});
        expect(realm.files.get('/config')).toBe('tessedit_load_sublangs ');
        expect(await realm.send('setParameters', {params: {tessedit_pageseg_mode: 11, tessjs_fixture: true}})).toMatchObject({status: 'resolve', data: {tessedit_pageseg_mode: 11, tessjs_fixture: true}});
        expect(realm.api.SetVariable.mock.calls).toEqual([['tessedit_pageseg_mode', 11]]);
        expect(await realm.send('terminate', {})).toMatchObject({status: 'resolve', data: {terminated: true}});
        expect(realm.api.End).toHaveBeenCalledTimes(1);
    });

    it('rejects language-download HTTP errors without writing a model', async () => {
        const fetchPort = vi.fn(async () => new Response('Synthetic missing model', {status: 404}));
        const realm = workerRealm({fetch: fetchPort});
        expect(await realm.send('loadLanguage', {langs: 'eng', options: {cacheMethod: 'none', langPath: 'https://fixture.invalid/models/', gzip: true}})).toMatchObject({status: 'reject', data: 'Error: Network error while fetching https://fixture.invalid/models/eng.traineddata.gz. Response code: 404'});
        expect(fetchPort).toHaveBeenCalledTimes(1);
        expect(fetchPort).toHaveBeenCalledWith('https://fixture.invalid/models/eng.traineddata.gz');
    });

    it('rejects an invalid image through the real recognize action', async () => {
        const realm = corePort();
        await realm.send('load', loadPayload);
        await realm.send('initialize', {langs: 'eng', oem: 1, config: {}});
        expect(await realm.send('recognize', {image: new Uint8Array([1, 2]), options: {}, output: {blocks: true}})).toMatchObject({status: 'reject', data: 'Error: Error attempting to read image.'});
        expect(realm.api.SetImageFile).toHaveBeenCalledTimes(1);
        expect(realm.api.SetImageFile).toHaveBeenCalledWith(1, 0);
        expect(realm.files.get('/input')).toEqual(new Uint8Array([1, 2]));
    });

    it('restores per-recognition native parameters when the image port fails', async () => {
        const realm = corePort();
        await realm.send('load', loadPayload);
        await realm.send('initialize', {langs: 'eng', oem: 1, config: {}});
        expect(await realm.send('recognize', {image: new Uint8Array([1, 2]),
            options: {tessedit_char_whitelist: 'ABC'}, output: {blocks: true}})).toMatchObject({status: 'reject'});
        expect(realm.api.SaveParameters).toHaveBeenCalledTimes(1);
        expect(realm.api.SetVariable).toHaveBeenCalledWith('tessedit_char_whitelist', 'ABC');
        expect(realm.api.RestoreParameters).toHaveBeenCalledTimes(1);
    });

    it('restores temporary parameters before a successful terminal and reuses the loaded worker', async () => {
        const realm = corePort();
        realm.api.SetImageFile.mockReturnValue(0);
        await realm.send('load', loadPayload);
        await realm.send('initialize', {langs: 'eng', oem: 1, config: {}});
        const first = await realm.send('recognize', {image: new Uint8Array([1, 2]), options: {tessedit_char_whitelist: 'ABC'}, output: {text: true, blocks: true}});
        expect(first).toMatchObject({status: 'resolve', data: {text: 'Synthetic recognized text', confidence: 99, blocks: []}});
        expect(realm.api.SaveParameters).toHaveBeenCalledTimes(1);
        expect(realm.api.RestoreParameters).toHaveBeenCalledTimes(1);
        expect(realm.api.RestoreParameters.mock.invocationCallOrder[0]).toBeGreaterThan(realm.api.GetUTF8Text.mock.invocationCallOrder[0]);
        expect(await realm.send('recognize', {image: new Uint8Array([3, 4]), options: {}, output: {text: true}})).toMatchObject({status: 'resolve', data: {text: 'Synthetic recognized text'}});
        expect(realm.api.SaveParameters).toHaveBeenCalledTimes(1);
        expect(realm.api.RestoreParameters).toHaveBeenCalledTimes(1);
        expect(realm.factory).toHaveBeenCalledTimes(1);
        expect(realm.files.get('/input')).toEqual(new Uint8Array([3, 4]));
    });

    it.each(['SaveParameters', 'SetVariable'] as const)('keeps native %s failures and restores only an acquired snapshot', async method => {
        const realm = corePort();
        await realm.send('load', loadPayload);
        await realm.send('initialize', {langs: 'eng', oem: 1, config: {}});
        realm.api[method].mockImplementation(() => {throw new Error(`Fixture ${method} failed`);});
        expect(await realm.send('recognize', {image: new Uint8Array([1, 2]), options: {tessedit_char_whitelist: 'ABC'}, output: {text: true}})).toMatchObject({status: 'reject', data: `Error: Fixture ${method} failed`});
        expect(realm.api.RestoreParameters).toHaveBeenCalledTimes(method === 'SaveParameters' ? 0 : 1);
        expect(realm.api.SetImageFile).not.toHaveBeenCalled();
    });

    it('reports a restoration failure instead of publishing a successful recognition', async () => {
        const realm = corePort();
        realm.api.SetImageFile.mockReturnValue(0);
        await realm.send('load', loadPayload);
        await realm.send('initialize', {langs: 'eng', oem: 1, config: {}});
        realm.api.RestoreParameters.mockImplementation(() => {throw new Error('Fixture restoration failed');});
        const terminal = await realm.send('recognize', {image: new Uint8Array([1, 2]), options: {tessedit_char_whitelist: 'ABC'}, output: {text: true}});
        expect(terminal).toMatchObject({status: 'reject', data: 'Error: Fixture restoration failed'});
        expect(realm.packets.filter(packet => packet.jobId === terminal.jobId && packet.status !== 'progress')).toEqual([terminal]);
        expect(realm.api.GetUTF8Text).toHaveBeenCalledTimes(1);
        expect(realm.api.RestoreParameters).toHaveBeenCalledTimes(1);
    });

    it('preserves the recognition failure when restoring its saved parameters also fails', async () => {
        const realm = corePort();
        await realm.send('load', loadPayload);
        await realm.send('initialize', {langs: 'eng', oem: 1, config: {}});
        realm.api.RestoreParameters.mockImplementation(() => {throw new Error('Fixture restoration failed');});
        const terminal = await realm.send('recognize', {image: new Uint8Array([1, 2]), options: {tessedit_char_whitelist: 'ABC'}, output: {text: true}});
        expect(terminal).toMatchObject({status: 'reject', data: 'Error: Error attempting to read image.'});
        expect(realm.packets.filter(packet => packet.jobId === terminal.jobId && packet.status !== 'progress')).toEqual([terminal]);
        expect(realm.api.SaveParameters).toHaveBeenCalledTimes(1);
        expect(realm.api.RestoreParameters).toHaveBeenCalledTimes(1);
    });

    it('reads BMP pixels from the declared file offset before the native image port', async () => {
        const realm = corePort();
        await realm.send('load', loadPayload);
        await realm.send('initialize', {langs: 'eng', oem: 1, config: {}});
        const bmp = Buffer.alloc(74);
        bmp.write('BM');
        bmp.writeUInt32LE(bmp.length, 2);
        bmp.writeUInt32LE(70, 10);
        bmp.writeUInt32LE(40, 14);
        bmp.writeInt32LE(1, 18);
        bmp.writeInt32LE(1, 22);
        bmp.writeUInt16LE(1, 26);
        bmp.writeUInt16LE(24, 28);
        bmp.writeUInt32LE(4, 34);
        bmp.fill(0xee, 54, 70);
        bmp.set([0x11, 0x22, 0x33, 0], 70);
        expect(await realm.send('recognize', {image: new Uint8Array(bmp), options: {},
            output: {blocks: true}})).toMatchObject({status: 'reject', data: 'Error: Error attempting to read image.'});
        const converted = realm.files.get('/input') as Uint8Array;
        expect(Array.from(converted.slice(54, 57))).toEqual([0x11, 0x22, 0x33]);
    });

    it.each([
        {name: '24-bit ordinary header', bits: 24, header: 40, offset: 54, compression: 0, pixel: [0x11, 0x22, 0x33, 0], expected: [0x11, 0x22, 0x33]},
        {name: '24-bit extended top-down header', bits: 24, header: 108, offset: 130, compression: 0, pixel: [0x11, 0x22, 0x33, 0], expected: [0x11, 0x22, 0x33]},
        {name: '8-bit palette followed by gap', bits: 8, header: 40, offset: 80, compression: 0, pixel: [0, 0, 0, 0], expected: [0x11, 0x22, 0x33]},
        {name: '16-bit bitfields followed by gap', bits: 16, header: 40, offset: 86, compression: 3, pixel: [0xff, 0xff, 0, 0], expected: [0xf8, 0xfc, 0xf8]},
        {name: '32-bit bitfields followed by gap', bits: 32, header: 40, offset: 86, compression: 3, pixel: [0xff, 0x11, 0x22, 0x33], expected: [0x11, 0x22, 0x33]},
    ])('decodes $name through the actual worker before forwarding image bytes', async fixture => {
        const realm = corePort();
        await realm.send('load', loadPayload);
        await realm.send('initialize', {langs: 'eng', oem: 1, config: {}});
        const bmp = Buffer.alloc(fixture.offset + 4);
        bmp.write('BM'); bmp.writeUInt32LE(bmp.length, 2); bmp.writeUInt32LE(fixture.offset, 10);
        bmp.writeUInt32LE(fixture.header, 14); bmp.writeInt32LE(1, 18); bmp.writeInt32LE(fixture.header === 108 ? -1 : 1, 22);
        bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(fixture.bits, 28); bmp.writeUInt32LE(fixture.compression, 30); bmp.writeUInt32LE(4, 34);
        if (fixture.bits === 8) {bmp.writeUInt32LE(1, 46); bmp.set([0x11, 0x22, 0x33, 0], 54);}
        if (fixture.compression === 3) {
            const masks = fixture.bits === 16 ? [0xf800, 0x07e0, 0x001f, 0] : [0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000];
            masks.forEach((mask, index) => bmp.writeUInt32LE(mask, 54 + index * 4));
        }
        const dataEnd = fixture.compression === 3 ? 70 : fixture.bits === 8 ? 58 : 14 + fixture.header;
        bmp.fill(0xee, dataEnd, fixture.offset); bmp.set(fixture.pixel, fixture.offset);
        expect(await realm.send('recognize', {image: new Uint8Array(bmp), options: {}, output: {blocks: true}})).toMatchObject({status: 'reject', data: 'Error: Error attempting to read image.'});
        const converted = realm.files.get('/input') as Uint8Array;
        expect(Array.from(converted.slice(54, 57))).toEqual(fixture.expected);
        expect(realm.api.SetImageFile).toHaveBeenCalledTimes(1);
    });
});
