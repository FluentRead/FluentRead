import {describe, expect, it, vi, afterEach, afterAll} from 'vitest';
import {asArrayBufferBytes} from '@/src/shared/function/arrayBufferBytes';
import {readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync} from 'node:fs';
import {resolve, join, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createContext, runInContext, type Context} from 'node:vm';
import {spawn, spawnSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {createConnection} from 'node:net';
import {File} from 'node:buffer';

// 同一完整用例文件直接加载原生产模块；基线只切换源码根目录，不复制业务函数。
const root = process.cwd();
const sourceRoot = process.env.FLUENTREAD_AUDIT49K_SOURCE_ROOT || root;
const producer = await import(pathToFileURL(resolve(sourceRoot, 'scripts/wasm/package-diagnostics.ts')).href);
const bridge = await import(pathToFileURL(resolve(sourceRoot, 'scripts/agent-bridge/bridge.mjs')).href);
const require = createRequire(import.meta.url);
const helpers = require(resolve(sourceRoot, 'scripts/testing/local-model-browser-helpers.cjs'));
const coreSource = resolve(root, 'public/fluent-read-ocr/core/tesseract-core-simd-lstm.wasm.js');
const workerSource = resolve(root, 'public/fluent-read-ocr/worker/worker.min.js');
const temporary: string[] = [];
function fixtureRoot() {
    const directory = mkdtempSync(join(tmpdir(), 'fluentread-audit49k-'));
    temporary.push(directory);
    mkdirSync(join(directory, 'scripts/wasm'), {recursive: true});
    writeFileSync(join(directory, 'scripts/wasm/diagnostics.js'), readFileSync(resolve(root, 'scripts/wasm/diagnostics.js')));
    return directory;
}
function workerArtifact() {
    // 基线 WXT 发布原 worker；当时没有 worker producer，这个对照仍执行真实原发布入口。
    return producer.packageTesseractWorker ? producer.packageTesseractWorker(fixtureRoot(), workerSource) : workerSource;
}
async function actualCore() {
    const artifacts = producer.packageTesseractWasm(fixtureRoot(), coreSource);
    const realm = createContext({URL, self: {location: {href: 'https://fixture.invalid/fluent-read-ocr/worker/worker.min.js'}},
        WebAssembly, Uint8Array, ArrayBuffer, atob, btoa, setTimeout, clearTimeout,
        console: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}});
    runInContext(readFileSync(artifacts.glue, 'utf8'), realm, {filename: artifacts.glue, timeout: 5_000});
    const module = await realm.TesseractCore({wasmBinary: new Uint8Array(readFileSync(artifacts.wasm)), print: vi.fn(), printErr: vi.fn()});
    return {module, artifacts};
}
type Packet = {workerId: string; jobId: string; action: string; status: string; data: any};
function workerRealm(factory: (realm: Context) => unknown) {
    const packets: Packet[] = [];
    let receive!: (event: {data: unknown}) => void;
    let complete: ((packet: Packet) => void) | undefined;
    let sequence = 0;
    const realm = createContext({WebAssembly, Uint8Array, ArrayBuffer, TextEncoder, TextDecoder, atob, btoa,
        setTimeout, clearTimeout, setInterval, clearInterval,
        console: {log: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
        fetch: () => {throw new Error('Unexpected network');}, WorkerGlobalScope: function () {},
        location: {href: 'https://fixture.invalid/worker.min.js'},
        addEventListener: (type: string, listener: typeof receive) => {if (type === 'message') receive = listener;},
        importScripts: () => {realm.TesseractCore = () => factory(realm);},
        postMessage: (packet: Packet) => {packets.push(packet); if (packet.status !== 'progress') complete?.(packet);},
    });
    realm.self = realm;
    const file = workerArtifact();
    runInContext(readFileSync(file, 'utf8'), realm, {filename: file, timeout: 5_000});
    if (!receive) throw new Error('Actual worker message entry was not loaded');
    return {packets, async send(action: string, payload: unknown) {
        const jobId = `job-${++sequence}`;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const packet = await new Promise<Packet>((yes, no) => {
                timer = setTimeout(() => no(new Error(`Timed out: ${action}`)), 1_000);
                complete = packet => {if (packet.jobId === jobId) yes(packet);};
                receive({data: {workerId: 'synthetic-worker', jobId, action, payload}});
            });
            await Promise.resolve();
            return packet;
        } finally {clearTimeout(timer); complete = undefined;}
    }};
}
const load = {options: {lstmOnly: true, corePath: 'https://fixture.invalid/core.wasm.js', logging: false}};
function nativePorts() {
    const files = new Map<string, any>();
    const api = {End: vi.fn(), Init: vi.fn(() => 0), SaveParameters: vi.fn(), SetVariable: vi.fn(),
        RestoreParameters: vi.fn(), SetImageFile: vi.fn(() => 0), Recognize: vi.fn(),
        GetUTF8Text: vi.fn(() => 'synthetic result'), MeanTextConf: () => 91, GetPageSegMode: () => 11,
        oem: () => 1, Version: () => '5.5.0', GetJSONText: () => '{"blocks":[]}'};
    const module = {TessBaseAPI: function () {return api;},
        FS: {writeFile: (file: string, data: unknown) => files.set(file, data), readFile: (file: string) => files.get(file),
            unlink: (file: string) => files.delete(file), mkdir: vi.fn()}};
    return {api, module, files};
}
function bmp(bits = 24, offset = 70, compressed = false) {
    const bytes = 4;
    const buffer = Buffer.alloc(offset + bytes);
    buffer.write('BM'); buffer.writeUInt32LE(buffer.length, 2); buffer.writeUInt32LE(offset, 10);
    buffer.writeUInt32LE(compressed ? 56 : 40, 14); buffer.writeUInt32LE(1, 18); buffer.writeInt32LE(1, 22);
    buffer.writeUInt16LE(1, 26); buffer.writeUInt16LE(bits, 28); buffer.writeUInt32LE(compressed ? 3 : 0, 30);
    buffer.writeUInt32LE(bytes, 34); buffer.fill(0xee, 54, offset);
    if (compressed) {buffer.writeUInt32LE(0xff000000, 54); buffer.writeUInt32LE(0xff0000, 58); buffer.writeUInt32LE(0xff00, 62); buffer.writeUInt32LE(0xff, 66);}
    buffer.set([0x11, 0x22, 0x33, 0], offset);
    if (compressed) buffer.set([0, 0x11, 0x22, 0x33], offset);
    return new Uint8Array(buffer);
}
afterEach(() => {vi.useRealTimers(); vi.restoreAllMocks(); for (const directory of temporary.splice(0)) rmSync(directory, {recursive: true, force: true});});

describe('audit49K actual derived OCR consumer entries', () => {
    it('preserves the decoded WASM SHA and both raw vendor resources', async () => {
        const before = [coreSource, workerSource].map(file => createHash('sha256').update(readFileSync(file)).digest('hex'));
        const {module, artifacts} = await actualCore();
        const original = producer.splitTesseractWasm(readFileSync(coreSource, 'utf8')).wasm;
        expect(createHash('sha256').update(readFileSync(artifacts.wasm)).digest('hex')).toBe(createHash('sha256').update(original).digest('hex'));
        expect(WebAssembly.validate(original)).toBe(true);
        workerArtifact();
        expect([coreSource, workerSource].map(file => createHash('sha256').update(readFileSync(file)).digest('hex'))).toEqual(before);
        module.FS.writeFile('/utf8', '中文🙂'); expect(module.FS.readFile('/utf8', {encoding: 'utf8'})).toBe('中文🙂');
        module.FS.unlink('/utf8');
    });
    it('does not accumulate acquired streams over 32 rejected actual FS writes', async () => {
        const {module} = await actualCore();
        const original = new Set(module.FS.streams.filter(Boolean));
        try {
            for (let index = 0; index < 32; index++) expect(() => module.FS.writeFile('/invalid', {})).toThrow('Unsupported data type');
            expect(module.FS.streams.filter(Boolean)).toHaveLength(original.size);
        } finally {for (const stream of module.FS.streams.filter(Boolean)) if (!original.has(stream)) module.FS.close(stream); module.FS.unlink('/invalid');}
    });
    it('closes an acquired native stream on write-port failure and preserves the thrown error', async () => {
        const {module} = await actualCore();
        const original = new Set(module.FS.streams.filter(Boolean));
        const failure = new Error('synthetic FS write failure');
        const write = vi.spyOn(module.FS, 'write').mockImplementation(() => {throw failure;});
        try {
            let observed; try {module.FS.writeFile('/port-error', new Uint8Array([1, 2, 3]));} catch (error) {observed = error;}
            expect(observed).toBe(failure);
            expect(module.FS.streams.filter(Boolean)).toHaveLength(original.size);
        } finally {write.mockRestore(); for (const stream of module.FS.streams.filter(Boolean)) if (!original.has(stream)) module.FS.close(stream); module.FS.unlink('/port-error');}
        module.FS.writeFile('/binary', new Uint8Array([0, 255, 3]));
        expect(Array.from(module.FS.readFile('/binary'))).toEqual([0, 255, 3]); module.FS.unlink('/binary');
    });
    it('fails unknown core source before creating derived output', () => {
        const directory = fixtureRoot(), input = join(directory, 'unknown-core.js');
        writeFileSync(input, readFileSync(coreSource, 'utf8') + '\n// unexpected upgrade');
        expect(() => producer.packageTesseractWasm(directory, input)).toThrow('Unsupported');
        expect(existsSync(join(directory, '.wxt/packaged-wasm'))).toBe(false);
    });
    it('fails unknown worker source before creating derived output', () => {
        const directory = fixtureRoot(), input = join(directory, 'unknown-worker.js');
        writeFileSync(input, readFileSync(workerSource, 'utf8') + '\n// unexpected upgrade');
        expect(typeof producer.packageTesseractWorker).toBe('function');
        expect(() => producer.packageTesseractWorker(directory, input)).toThrow('Unsupported');
        expect(existsSync(join(directory, '.wxt/packaged-wasm'))).toBe(false);
    });
    it('emits one identity-preserving terminal packet on async Core factory rejection and allows retry', () => {
        const file = workerArtifact();
        const script = `const {readFileSync}=require('node:fs'),{createContext,runInContext}=require('node:vm');
const packets=[],unhandled=[];let message,attempt=0;process.on('unhandledRejection',error=>unhandled.push(String(error)));
const realm=createContext({console,setTimeout,clearTimeout,WebAssembly,WorkerGlobalScope:function(){},
addEventListener:(type,fn)=>{if(type==='message')message=fn},postMessage:p=>packets.push(p),
importScripts:()=>{realm.TesseractCore=()=>++attempt===1?Promise.reject(new Error('synthetic async factory failure')):Promise.resolve({})}});
realm.self=realm;runInContext(readFileSync(process.argv[1],'utf8'),realm,{filename:process.argv[1],timeout:5000});
if(!message)throw Error('WORKER_NOT_LOADED');console.log('WORKER_ENTRY_LOADED');
const send=id=>message({data:{workerId:'worker',jobId:id,action:'load',payload:${JSON.stringify(load)}}});
send('failure');setTimeout(()=>{send('retry');setTimeout(()=>console.log(JSON.stringify({packets:packets.filter(p=>p.status!=='progress'),unhandled})),30)},30);`;
        const result = spawnSync(process.execPath, ['-e', script, file], {encoding: 'utf8', timeout: 6_000, killSignal: 'SIGKILL'});
        expect(result.error).toBeUndefined(); expect(result.status).toBe(0); expect(result.stdout).toContain('WORKER_ENTRY_LOADED');
        const report = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
        expect(report.unhandled).toEqual([]);
        expect(report.packets).toEqual([{workerId: 'worker', jobId: 'failure', action: 'load', status: 'reject', data: 'Error: synthetic async factory failure'},
            {workerId: 'worker', jobId: 'retry', action: 'load', status: 'resolve', data: {loaded: true}}]);
    });
    it('rejects actual native Init failure once per job without subsequent success/progress', async () => {
        const {module} = await actualCore();
        const realm = workerRealm(async () => module);
        await realm.send('load', load);
        await realm.send('loadLanguage', {langs: [{code: 'eng', data: new Uint8Array([1, 2, 3, 4])}], options: {cacheMethod: 'none', gzip: false, lstmOnly: true}});
        try {
            for (let index = 0; index < 2; index++) {
                const packet = await realm.send('initialize', {langs: 'eng', oem: 1, config: {}});
                expect(packet).toMatchObject({status: 'reject', data: 'initialization failed'});
                expect(realm.packets.filter(item => item.jobId === packet.jobId && item.status !== 'progress')).toEqual([packet]);
                expect(realm.packets.filter(item => item.jobId === packet.jobId && item.status === 'progress').map(item => item.data.progress)).not.toContain(1);
            }
        } finally {await realm.send('terminate', {});}
    });
    it.each(['SetVariable', 'SetImageFile', 'Recognize', 'GetUTF8Text'] as const)('restores saved parameters when actual recognize reaches a failing %s port', async method => {
        const ports = nativePorts(), realm = workerRealm(async () => ports.module);
        await realm.send('load', load); await realm.send('initialize', {langs: 'eng', oem: 1, config: {}});
        ports.api[method].mockImplementation(() => {throw new Error(`synthetic ${method} failure`);});
        const packet = await realm.send('recognize', {image: new Uint8Array([1, 2]), options: {tessedit_char_whitelist: 'ABC'}, output: {text: true, blocks: false}});
        expect(packet).toMatchObject({status: 'reject', data: `Error: synthetic ${method} failure`});
        expect(ports.api.SaveParameters).toHaveBeenCalledTimes(1); expect(ports.api.RestoreParameters).toHaveBeenCalledTimes(1);
        expect(realm.packets.filter(item => item.jobId === packet.jobId && item.status !== 'progress')).toEqual([packet]);
        await realm.send('terminate', {});
    });
    it('restores parameters before success and leaves a following parameter-free recognition independent', async () => {
        const ports = nativePorts(), realm = workerRealm(async () => ports.module);
        await realm.send('load', load); await realm.send('load', load);
        await realm.send('initialize', {langs: 'eng', oem: 1, config: {}});
        for (const options of [{tessedit_char_whitelist: 'ABC'}, {}]) {
            expect(await realm.send('recognize', {image: new Uint8Array([1, 2]), options, output: {text: true, blocks: false}})).toMatchObject({status: 'resolve', data: {text: 'synthetic result'}});
        }
        expect(ports.api.SaveParameters).toHaveBeenCalledTimes(1); expect(ports.api.RestoreParameters).toHaveBeenCalledTimes(1);
        await realm.send('terminate', {});
    });
    it('does not acquire restore responsibility when SaveParameters fails', async () => {
        const ports = nativePorts(), realm = workerRealm(async () => ports.module);
        await realm.send('load', load); await realm.send('initialize', {langs: 'eng', oem: 1, config: {}});
        ports.api.SaveParameters.mockImplementation(() => {throw new Error('synthetic save failure');});
        expect(await realm.send('recognize', {image: new Uint8Array([1]), options: {tessedit_char_whitelist: 'ABC'}, output: {text: true, blocks: false}}))
            .toMatchObject({status: 'reject', data: 'Error: synthetic save failure'});
        expect(ports.api.RestoreParameters).not.toHaveBeenCalled();
        await realm.send('terminate', {});
    });
    it('keeps the original image failure when owned restoration also fails, then permits the next job', async () => {
        const ports = nativePorts(), realm = workerRealm(async () => ports.module);
        await realm.send('load', load); await realm.send('initialize', {langs: 'eng', oem: 1, config: {}});
        ports.api.SetImageFile.mockImplementationOnce(() => {throw new Error('synthetic image failure');});
        ports.api.RestoreParameters.mockImplementationOnce(() => {throw new Error('synthetic restore failure');});
        const packet = await realm.send('recognize', {image: new Uint8Array([1]), options: {tessedit_char_whitelist: 'ABC'}, output: {text: true, blocks: false}});
        expect(packet).toMatchObject({status: 'reject', data: 'Error: synthetic image failure'});
        expect(ports.api.RestoreParameters).toHaveBeenCalledTimes(1);
        expect(realm.packets.filter(item => item.jobId === packet.jobId && item.status !== 'progress')).toEqual([packet]);
        expect(await realm.send('recognize', {image: new Uint8Array([1]), options: {tessedit_char_whitelist: 'DEF'}, output: {text: true, blocks: false}}))
            .toMatchObject({status: 'resolve', data: {text: 'synthetic result'}});
        expect(ports.api.RestoreParameters).toHaveBeenCalledTimes(2);
        await realm.send('terminate', {});
    });
    it('reports restoration failure after otherwise successful recognition', async () => {
        const ports = nativePorts(), realm = workerRealm(async () => ports.module);
        await realm.send('load', load); await realm.send('initialize', {langs: 'eng', oem: 1, config: {}});
        ports.api.RestoreParameters.mockImplementation(() => {throw new Error('synthetic restore failure');});
        expect(await realm.send('recognize', {image: new Uint8Array([1]), options: {tessedit_char_whitelist: 'ABC'}, output: {text: true, blocks: false}}))
            .toMatchObject({status: 'reject', data: 'Error: synthetic restore failure'});
        expect(ports.api.RestoreParameters).toHaveBeenCalledTimes(1);
        await realm.send('terminate', {});
    });
    it.each([[24, 54, false], [24, 70, false], [32, 54, false], [32, 86, true]] as const)('decodes real BMP %ibit pixels from offset %i (bitfields %s)', async (bits, offset, compressed) => {
        const ports = nativePorts(), realm = workerRealm(async () => ports.module);
        await realm.send('load', load); await realm.send('initialize', {langs: 'eng', oem: 1, config: {}});
        ports.api.SetImageFile.mockReturnValue(1);
        expect(await realm.send('recognize', {image: bmp(bits, offset, compressed), options: {}, output: {blocks: true}})).toMatchObject({status: 'reject', data: 'Error: Error attempting to read image.'});
        expect(Array.from(ports.files.get('/input').slice(54, 57))).toEqual([0x11, 0x22, 0x33]);
        await realm.send('terminate', {});
    });
});

describe('audit49K product OCR public entry consumes SDK job rejection', () => {
    it('rejects recognizeImage once with the original reason, avoids an escaping message error and reuses its worker for retry', async () => {
        const actualSdkProducer = await import(pathToFileURL(resolve(root, 'scripts/wasm/tesseract-sdk-build.ts')).href);
        const plugin = actualSdkProducer.tesseractSdkBuildPlugin();
        const productFile = resolve(root, 'src/features/image-translation/services/ocrRuntime.ts');
        // Explicit private baseline override only; ordinary repository runs consume the current production file.
        const productSource = process.env.FLUENTREAD_AUDIT49K_OCR_SOURCE_FILE || productFile;
        const built = await esbuild.build({absWorkingDir: root, entryPoints: [productFile], bundle: true, alias: {'@': root},
            platform: 'browser', format: 'iife', globalName: 'ActualProductOcr', write: false, logLevel: 'silent',
            plugins: [{name: 'actual-product-and-sdk-source-ports', setup(build: any) {
                build.onLoad({filter: /tesseract\.js\/src\/createWorker\.js$/}, async (args: any) => ({
                    contents: (await plugin.transform.call({}, readFileSync(args.path, 'utf8'), args.path)).code, loader: 'js',
                }));
                build.onLoad({filter: /\/services\/ocrRuntime\.ts$/}, () => ({contents: readFileSync(productSource, 'utf8'), loader: 'ts', resolveDir: dirname(productFile)}));
            }}]});
        const instances: any[] = [], escapedMessageErrors: string[] = [], sent: any[] = [];
        let failed = false;
        const reason = 'controlled product recognition failure';
        const line = {text: 'retried text', confidence: 91, bbox: {x0: 1, y0: 2, x1: 40, y1: 20}};
        class WorkerPort {
            onmessage?: (event: any) => void;
            terminated = false;
            terminateCalls = 0;
            constructor() {instances.push(this);}
            postMessage(packet: any) {
                sent.push(packet);
                queueMicrotask(() => {
                    if (this.terminated) return;
                    const reject = packet.action === 'recognize' && !failed;
                    if (reject) failed = true;
                    const data = reject ? reason : packet.action === 'recognize' ? {blocks: [{paragraphs: [{lines: [line]}]}]} : {};
                    // This is the external message-event boundary, not a replacement SDK handler.
                    // An exception here would escape the browser Worker.onmessage callback independently of its rejected job Promise.
                    try {
                        if (packet.action === 'recognize') this.onmessage?.({data: {...packet, status: 'progress', data: {status: 'recognizing text', progress: 0.5}}});
                        this.onmessage?.({data: {...packet, status: reject ? 'reject' : 'resolve', data}});
                    } catch (error) {escapedMessageErrors.push(String(error));}
                });
            }
            terminate() {this.terminateCalls++; this.terminated = true;}
        }
        const canvases: any[] = [];
        const createElement = vi.fn((tag: string) => {
            expect(tag).toBe('canvas');
            const canvas: any = {width: 0, height: 0};
            const pixels = {
                drawImage: vi.fn(),
                getImageData: vi.fn((x: number, y: number, width: number, height: number) => {
                    expect([x, y, width, height]).toEqual([0, 0, 80, 40]);
                    // 本夹具是独占、不透明的完整 RGBA 图；实际生产 alpha 检查继续执行。
                    return {data: new Uint8ClampedArray(width * height * 4).fill(255), width, height};
                }),
                putImageData: vi.fn(() => {throw new Error('Opaque fixture must not rewrite pixels');}),
            };
            canvas.getContext = vi.fn(() => pixels);
            canvas.toBlob = vi.fn(() => {throw new Error('Original opaque PNG must not be re-encoded');});
            canvas.pixels = pixels;
            canvases.push(canvas);
            return canvas;
        });
        const context = createContext({Worker: WorkerPort, Blob, File, URL, Uint8Array, ArrayBuffer, AbortController, TextEncoder, TextDecoder, atob, btoa,
            console: {log: vi.fn(), warn: vi.fn(), error: vi.fn()}, setTimeout, clearTimeout,
            chrome: {runtime: {getURL: (path: string) => `chrome-extension://controlled${path}`}},
            document: {createElement}, window: {location: {href: 'chrome-extension://controlled/offscreen.html'}}});
        context.self = context;
        runInContext(built.outputFiles[0].text, context, {filename: 'actual-product-ocr-and-browser-sdk.js', timeout: 5000});
        const product = context.ActualProductOcr;
        if (typeof product?.recognizeImage !== 'function') throw new Error('ACTUAL_PRODUCT_OCR_PUBLIC_ENTRY_NOT_LOADED');
        const borrowedImage = {naturalWidth: 80, naturalHeight: 40, src: 'borrowed-image'};
        const image = 'data:image/png;base64,AQID', progress: number[] = [];
        try {
            await product.downloadImageOcrLanguages(['eng']);
            expect(sent.map(packet => packet.action)).toEqual(['load', 'loadLanguage', 'initialize']);
            let rejectionCount = 0, caughtReason: unknown;
            const first = product.recognizeImage(image, 'en', undefined, {decodedImage: borrowedImage, onProgress: (value: number) => progress.push(value)});
            void first.then(undefined, (error: unknown) => {rejectionCount++; caughtReason = error;});
            await expect(first).rejects.toBe(reason);
            const retry = await product.recognizeImage(image, 'en', undefined, {decodedImage: borrowedImage, onProgress: (value: number) => progress.push(value)});
            expect(retry).toEqual([{text: 'retried text', bbox: line.bbox}]);
            expect(instances).toHaveLength(1); expect(instances[0].terminateCalls).toBe(0);
            expect(sent.filter(packet => packet.action === 'recognize')).toHaveLength(2);
            expect(sent.filter(packet => packet.action === 'setParameters')).toHaveLength(1);
            expect(progress).toEqual([50, 50]); expect(borrowedImage.src).toBe('borrowed-image');
            expect(canvases).toHaveLength(2);
            for (const canvas of canvases) {
                expect(canvas.getContext).toHaveBeenCalledWith('2d', {willReadFrequently: true});
                expect(canvas.pixels.drawImage).toHaveBeenCalledWith(borrowedImage, 0, 0, 80, 40);
                expect(canvas.pixels.getImageData).toHaveBeenCalledOnce();
                expect(canvas.pixels.putImageData).not.toHaveBeenCalled();
                expect(canvas.toBlob).not.toHaveBeenCalled();
                expect([canvas.width, canvas.height]).toEqual([0, 0]);
            }
            expect(rejectionCount).toBe(1); expect(caughtReason).toBe(reason);
            const observationDirectory = process.env.FLUENTREAD_AUDIT49K_OBSERVATION_DIR;
            if (observationDirectory) {
                if (!existsSync(observationDirectory) || !require('node:fs').statSync(observationDirectory).isDirectory()) throw new Error('OCR observation directory must already exist');
                const sourceSha = createHash('sha256').update(readFileSync(productSource)).digest('hex');
                writeFileSync(join(observationDirectory, `sdk-post-startup-product-observation-${sourceSha}-${process.pid}.json`), JSON.stringify({
                    publicEntry: 'actual recognizeImage/downloadImageOcrLanguages with actual ocrWorkerRuntime/sharedOcrTasks/browser SDK',
                    productSource, productSourceSha256: sourceSha, sdkProducerSha256: createHash('sha256').update(readFileSync(resolve(root, 'scripts/wasm/tesseract-sdk-build.ts'))).digest('hex'),
                    rawSdkSourceSha256: createHash('sha256').update(readFileSync(sdkSourceFile)).digest('hex'),
                    rejectionCount, caughtReason, escapedMessageErrors, retry, progress,
                    workerInstances: instances.length, terminateCallsBeforeFixtureCleanup: instances[0].terminateCalls,
                    sent: sent.map(packet => ({action: packet.action, jobId: packet.jobId})),
                    boundary: 'Actual product/SDK code, controlled external Worker message dispatch; escaping callback exceptions are captured at that external port. No native browser or OCR text quality claim.',
                }, null, 2) + '\n');
            }
            expect(escapedMessageErrors).toEqual([]);
        } finally {for (const worker of instances) if (!worker.terminated) worker.terminate();}
    });
});

function cdpFixture(send: (method: string, params?: any) => unknown) {
    const cdp = Object.assign(new EventEmitter(), {send: vi.fn(async (method: string, params?: any) => send(method, params)), detach: vi.fn(async () => {})});
    const context = {browser: () => ({newBrowserCDPSession: async () => cdp}), newCDPSession: async () => cdp};
    return {cdp, context};
}
describe('audit49K actual browser helper ownership', () => {
    it('detaches the acquired browser CDP connection when offscreen discovery fails', async () => {
        const {cdp, context} = cdpFixture(() => ({targetInfos: []}));
        await expect(helpers.attachOffscreen(context)).rejects.toThrow('No offscreen document');
        expect(cdp.detach).toHaveBeenCalledTimes(1);
    });
    it('clears pending RPC timers and detaches on offscreen enable failure', async () => {
        vi.useFakeTimers();
        const failure = new Error('synthetic transport failure');
        const {cdp, context} = cdpFixture(method => {
            if (method === 'Target.getTargets') return {targetInfos: [{targetId: 'owned', url: 'chrome-extension://fixture/offscreen.html'}]};
            if (method === 'Target.attachToTarget') return {sessionId: 'owned-session'};
            if (method === 'Target.sendMessageToTarget') throw failure;
        });
        try {
            await expect(helpers.attachOffscreen(context)).rejects.toBe(failure);
            expect(vi.getTimerCount()).toBe(0); expect(cdp.listenerCount('Target.receivedMessageFromTarget')).toBe(0);
            expect(cdp.detach).toHaveBeenCalledTimes(1);
        } finally {vi.clearAllTimers(); cdp.removeAllListeners();}
    });
    it('detaches when the first real measurement request fails before starting an action', async () => {
        const failure = new Error('synthetic telemetry failure');
        const {cdp, context} = cdpFixture(() => {throw failure;});
        const action = vi.fn();
        await expect(helpers.measureBrowser(context, 'failed', fixtureRoot(), action)).rejects.toBe(failure);
        expect(action).not.toHaveBeenCalled(); expect(cdp.detach).toHaveBeenCalledTimes(1);
    });
    it('retains an action failure report and detaches even when the final measurement fails', async () => {
        vi.spyOn(require('node:child_process'), 'execFileSync').mockReturnValue(`${process.pid} 100\n`);
        delete require.cache[require.resolve(resolve(sourceRoot, 'scripts/testing/local-model-browser-helpers.cjs'))];
        const measuredHelpers = require(resolve(sourceRoot, 'scripts/testing/local-model-browser-helpers.cjs'));
        let calls = 0;
        const {cdp, context} = cdpFixture(() => {if (++calls > 1) throw new Error('synthetic final sample failure'); return {processInfo: [{id: process.pid, type: 'fixture'}]};});
        const directory = fixtureRoot();
        const result = await measuredHelpers.measureBrowser(context, 'action-failure', directory, async () => {throw new Error('synthetic action failure');});
        expect(result.error).toBe('Error: synthetic action failure'); expect(cdp.detach).toHaveBeenCalledTimes(1);
        expect(JSON.parse(readFileSync(join(directory, 'action-failure.json'), 'utf8')).measurementErrors).toEqual(['Error: synthetic final sample failure']);
    });
    it('waits for the in-flight periodic sample before final sampling and detach', async () => {
        vi.useFakeTimers();
        vi.spyOn(require('node:child_process'), 'execFileSync').mockReturnValue(`${process.pid} 100\n`);
        delete require.cache[require.resolve(resolve(sourceRoot, 'scripts/testing/local-model-browser-helpers.cjs'))];
        const measuredHelpers = require(resolve(sourceRoot, 'scripts/testing/local-model-browser-helpers.cjs'));
        const info = {processInfo: [{id: process.pid, type: 'fixture'}]};
        let releaseSample!: (value: typeof info) => void, finishAction!: () => void, calls = 0;
        const delayed = new Promise<typeof info>(yes => {releaseSample = yes;});
        const action = new Promise<void>(yes => {finishAction = yes;});
        const {cdp, context} = cdpFixture(() => ++calls === 2 ? delayed : info);
        const directory = fixtureRoot();
        const measured = measuredHelpers.measureBrowser(context, 'delayed-sample', directory, () => action);
        try {
            await vi.advanceTimersByTimeAsync(251); expect(calls).toBe(2);
            finishAction(); await vi.advanceTimersByTimeAsync(1);
            expect(cdp.detach).not.toHaveBeenCalled();
            releaseSample(info); await measured;
            expect(calls).toBe(3); expect(cdp.detach).toHaveBeenCalledTimes(1);
            expect(JSON.parse(readFileSync(join(directory, 'delayed-sample.json'), 'utf8')).samples).toHaveLength(3);
        } finally {finishAction(); releaseSample(info); await measured; vi.clearAllTimers();}
    });
    it('disposes an initialized offscreen session and rejects its pending RPC without a timer or listener', async () => {
        vi.useFakeTimers();
        const {cdp, context} = cdpFixture((method, params) => {
            if (method === 'Target.getTargets') return {targetInfos: [{targetId: 'owned', url: 'chrome-extension://fixture/offscreen.html'}]};
            if (method === 'Target.attachToTarget') return {sessionId: 'owned-session'};
            if (method === 'Target.sendMessageToTarget') {
                const message = JSON.parse(params.message);
                if (message.method.endsWith('.enable')) Promise.resolve().then(() => cdp.emit('Target.receivedMessageFromTarget', {sessionId: 'owned-session', message: JSON.stringify({id: message.id, result: {}})}));
            }
        });
        try {
            const session = await helpers.attachOffscreen(context);
            expect(typeof session.dispose).toBe('function');
            const pending = session.rpc('Runtime.evaluate');
            const rejected = expect(pending).rejects.toThrow('disposed');
            await session.dispose(); await rejected; await session.dispose();
            await expect(session.rpc('Runtime.evaluate')).rejects.toThrow('disposed');
            expect(vi.getTimerCount()).toBe(0); expect(cdp.detach).toHaveBeenCalledTimes(1);
            expect(cdp.listenerCount('Target.receivedMessageFromTarget')).toBe(0);
            cdp.emit('Target.receivedMessageFromTarget', {sessionId: 'owned-session', message: JSON.stringify({method: 'synthetic-late-event'})});
            expect(session.events).toEqual([]);
        } finally {vi.clearAllTimers(); cdp.removeAllListeners();}
    });
    it('releases breakpoint timers/listeners and retains the original click failure', async () => {
        vi.useFakeTimers();
        const failure = new Error('synthetic click failure');
        const click = Promise.reject(failure); void click.catch(() => undefined);
        const {cdp, context} = cdpFixture(method => {
            if (method === 'Runtime.evaluate') return {result: {objectId: 'owned-object'}};
            if (method === 'DOMDebugger.getEventListeners') return {listeners: [{type: 'click', scriptId: 'owned-script', lineNumber: 1, columnNumber: 0}]};
            if (method === 'Debugger.setBreakpoint') return {breakpointId: 'owned-breakpoint'};
            return {};
        });
        const page = {locator: () => ({first: () => ({click: () => click})})};
        const rejected = expect(helpers.capturedTranslationError(context, page)).rejects.toBe(failure);
        void rejected.catch(() => undefined);
        try {
            await vi.advanceTimersByTimeAsync(10_001); await rejected;
            expect(vi.getTimerCount()).toBe(0); expect(cdp.listenerCount('Debugger.paused')).toBe(0);
            expect(cdp.detach).toHaveBeenCalledTimes(1);
        } finally {vi.clearAllTimers(); cdp.removeAllListeners();}
    });
});

function agentProcess(onRequest: (request: any, reply: (message: any) => void) => void) {
    const stdout = Object.assign(new EventEmitter(), {setEncoding: vi.fn()});
    const child = Object.assign(new EventEmitter(), {stdout, killed: false, kill: vi.fn(() => {child.killed = true; queueMicrotask(() => child.emit('close', null, 'SIGTERM')); return true;}),
        stdin: Object.assign(new EventEmitter(), {writable: true, write: (line: string) => {
            const request = JSON.parse(line);
            Promise.resolve().then(() => onRequest(request, message => stdout.emit('data', JSON.stringify(message) + '\n')));
            return true;
        }})});
    return child;
}
describe('audit49K actual ACP protocol entry', () => {
    it('closes an authenticated partial-body loopback connection during bridge shutdown', async () => {
        const token = 'owned-fixture-token-with-at-least-32-characters';
        const server = await bridge.createBridge({port: 0, token, environment: {}, spawnProcess: () => {throw new Error('Partial body must not spawn an agent');}});
        const socket = createConnection({host: '127.0.0.1', port: server.port});
        const socketClosed = new Promise<void>(yes => socket.once('close', () => yes()));
        let closing: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await new Promise<void>((yes, no) => {socket.once('connect', yes); socket.once('error', no);});
            socket.write(`POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
            await new Promise(yes => setTimeout(yes, 20));
            closing = server.close();
            await Promise.race([closing, new Promise((_yes, no) => {timer = setTimeout(() => no(new Error('Bridge shutdown left owned active connection')), 300);})]);
            await socketClosed; expect(socket.destroyed).toBe(true);
        } finally {clearTimeout(timer); socket.destroy(); await socketClosed; await (closing || server.close());}
    });
    it('waits for an owned process that ignores SIGTERM, using a bounded forced stop', async () => {
        const agent = `process.on('SIGTERM',()=>{});process.stdin.setEncoding('utf8');process.stdin.on('data',line=>{const p=JSON.parse(line);process.stdout.write(JSON.stringify({id:p.id,result:{protocolVersion:1}})+'\\n')});setInterval(()=>{},1000);`;
        let child: ReturnType<typeof spawn> | undefined, closed = false;
        const client = new bridge.AcpClient({command: process.execPath, args: ['-e', agent], env: {}}, fixtureRoot(), (...args: Parameters<typeof spawn>) => {
            child = spawn(...args); child.once('close', () => {closed = true;}); return child;
        });
        try {
            await client.start(); const started = Date.now(); await client.close();
            expect(closed).toBe(true); expect(child!.signalCode).toBe('SIGKILL');
            expect(Date.now() - started).toBeLessThan(5000);
            await client.close(); expect(closed).toBe(true);
        }
        finally {if (child && !closed) {const waited = new Promise<void>(yes => child!.once('close', () => yes())); child.kill('SIGKILL'); await waited;} await client.close();}
    });
    it.each([false, true])('bounds missing close after TERM/KILL and retains the first stop error (signal throws %s)', async signalThrows => {
        vi.useFakeTimers();
        const child = agentProcess((request, reply) => reply({id: request.id, result: {protocolVersion: 1}}));
        const signalFailure = new Error('synthetic TERM permission failure');
        child.killed = true; // A sent signal must never count as observed process exit.
        child.kill.mockImplementation((signal?: string) => {if (signalThrows && signal === 'SIGTERM') throw signalFailure; return true;});
        const stdin = Object.assign(child.stdin, {destroy: vi.fn()}), stdout = Object.assign(child.stdout, {destroy: vi.fn()});
        const client = new bridge.AcpClient({command: 'synthetic-agent', args: [], env: {}}, fixtureRoot(), () => child);
        await client.start();
        const closing = Promise.resolve().then(() => client.close());
        const rejected = signalThrows ? expect(closing).rejects.toBe(signalFailure) : expect(closing).rejects.toMatchObject({code: 'agent_stop_timeout'});
        void rejected.catch(() => {});
        let settled = false; void closing.then(() => {settled = true;}, () => {settled = true;});
        try {
            await vi.advanceTimersByTimeAsync(1999); expect(settled).toBe(false);
            await vi.advanceTimersByTimeAsync(1); expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
            expect(settled).toBe(false); await vi.advanceTimersByTimeAsync(2000); await rejected;
            expect(stdin.destroy).toHaveBeenCalledTimes(1); expect(stdout.destroy).toHaveBeenCalledTimes(1);
            expect(child.listenerCount('close')).toBe(0); expect(vi.getTimerCount()).toBe(0);
            child.emit('close', null, 'SIGKILL');
            if (signalThrows) await expect(client.close()).rejects.toBe(signalFailure);
            else await expect(client.close()).rejects.toMatchObject({code: 'agent_stop_timeout'});
            expect(child.kill).toHaveBeenCalledTimes(2);
        } finally {await rejected.catch(() => {}); vi.clearAllTimers(); child.removeAllListeners();}
    });
    it('releases the real HTTP server and owned cwd after an ACP stop failure, preserving repeat-close outcome', async () => {
        const token = 'owned-fixture-token-with-at-least-32-characters';
        const signalFailure = new Error('synthetic owned-process stop failure');
        const child = agentProcess((request, reply) => {
            const result = request.method === 'initialize' ? {protocolVersion: 1}
                : request.method === 'session/new' ? {sessionId: 'owned-session'} : {stopReason: 'end_turn'};
            if (request.method === 'session/prompt') reply({method: 'session/update', params: {sessionId: 'owned-session', update: {sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'owned output'}}}});
            reply({id: request.id, result});
        });
        child.kill.mockImplementation((signal = 'SIGTERM') => {if (signal === 'SIGTERM') throw signalFailure; return true;});
        let ownedCwd = '';
        const server = await bridge.createBridge({port: 0, token, environment: {}, spawnProcess: (_command: string, _args: string[], options: {cwd: string}) => {ownedCwd = options.cwd; return child;}});
        let closing: Promise<void> | undefined;
        try {
            const response = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
                body: JSON.stringify({model: 'default', messages: [{role: 'user', content: 'owned input'}]})});
            expect((await response.json()).choices[0].message.content).toBe('owned output');
            expect(existsSync(ownedCwd)).toBe(true);
            vi.useFakeTimers(); closing = server.close(); const rejected = expect(closing).rejects.toBe(signalFailure);
            expect(server.server.listening).toBe(false);
            await vi.advanceTimersByTimeAsync(4000); await rejected;
            expect(server.server.listening).toBe(false); expect(existsSync(ownedCwd)).toBe(false);
            expect(server.close()).toBe(closing); await expect(server.close()).rejects.toBe(signalFailure);
            expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]); expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers(); child.emit('close', null, 'SIGKILL'); await (closing || server.close()).catch(() => {});
            if (server.server.listening) {
                server.server.closeAllConnections(); await new Promise<void>(yes => server.server.close(() => yes()));
            }
            if (ownedCwd) rmSync(ownedCwd, {recursive: true, force: true});
            child.removeAllListeners();
        }
    });
    it.each([null, [], 1])('rejects malformed JSON protocol values %j without throwing out of the stdout listener', async value => {
        const child = agentProcess((request, reply) => {if (request.method === 'initialize') reply({id: request.id, result: {protocolVersion: 1}});});
        const client = new bridge.AcpClient({command: 'synthetic-agent', args: [], env: {}}, fixtureRoot(), () => child);
        await client.start();
        const pending = client.request('synthetic-pending', {});
        const rejected = expect(pending).rejects.toMatchObject({code: 'protocol_error'});
        try {
            expect(() => child.stdout.emit('data', JSON.stringify(value) + '\n')).not.toThrow();
            await rejected; expect(child.kill).toHaveBeenCalledTimes(1); expect(client.pending.size).toBe(0);
        } finally {await client.close(); await rejected.catch(() => undefined);}
    });
    it('clears a rejected initialize process so a second start performs a fresh handshake', async () => {
        const children: ReturnType<typeof agentProcess>[] = [];
        const spawnPort = vi.fn(() => {
            const failed = children.length === 0;
            const child = agentProcess((request, reply) => reply(failed ? {id: request.id, error: {code: -1}} : {id: request.id, result: {protocolVersion: 1}}));
            children.push(child); return child;
        });
        const client = new bridge.AcpClient({command: 'synthetic-agent', args: [], env: {}}, fixtureRoot(), spawnPort);
        try {
            await expect(client.start()).rejects.toMatchObject({code: 'agent_rejected'});
            expect(client.process).toBe(null); expect(children[0].kill).toHaveBeenCalledTimes(1);
            await client.start(); expect(spawnPort).toHaveBeenCalledTimes(2);
            children[0].stdout.emit('data', 'null\n'); children[0].emit('exit', 1);
            expect(client.process).toBe(children[1]);
        } finally {await client.close();}
    });
    it('handles an asynchronous stdin failure through the owned request failure path', async () => {
        const child = agentProcess((request, reply) => {if (request.method === 'initialize') reply({id: request.id, result: {protocolVersion: 1}});});
        const client = new bridge.AcpClient({command: 'synthetic-agent', args: [], env: {}}, fixtureRoot(), () => child);
        await client.start();
        const pending = client.request('synthetic-pending', {});
        const rejected = expect(pending).rejects.toMatchObject({code: 'agent_unavailable'});
        try {expect(() => child.stdin.emit('error', new Error('synthetic EPIPE'))).not.toThrow(); await rejected;}
        finally {await client.close(); await rejected.catch(() => undefined);}
    });
    it('joins a bounded 8192-chunk completed turn once while preserving exact output', async () => {
        let joins = 0, client: InstanceType<typeof bridge.AcpClient>;
        const text = '中文🙂';
        const child = agentProcess((request, reply) => {
            if (request.method === 'initialize') reply({id: request.id, result: {protocolVersion: 1}});
            if (request.method === 'session/new') reply({id: request.id, result: {sessionId: 'synthetic-session'}});
            if (request.method === 'session/prompt') {
                for (let index = 0; index < 8192; index++) reply({method: 'session/update', params: {sessionId: 'synthetic-session', update: {sessionUpdate: 'agent_message_chunk', content: {type: 'text', text}}}});
                const joinChunks = client.chunks.join.bind(client.chunks);
                client.chunks.join = (...args: any[]) => {joins++; return joinChunks(...args);};
                reply({id: request.id, result: {stopReason: 'end_turn'}});
            }
        });
        client = new bridge.AcpClient({command: 'synthetic-agent', args: [], env: {}}, fixtureRoot(), () => child);
        try {
            const output = await client.turn('default', 'synthetic prompt');
            expect(createHash('sha256').update(output).digest('hex')).toBe(createHash('sha256').update(text.repeat(8192)).digest('hex'));
            expect(joins).toBe(1); expect(client.activeSession).toBe(null); expect(client.chunks).toEqual([]);
        } finally {await client.close();}
    });
});

describe('audit49K complete product-site CLI ownership', () => {
    it.each(['launch', 'close'] as const)('closes its acquired server on browser %s failure', async stage => {
        const script = resolve(sourceRoot, 'scripts/verify-product-site.cjs');
        const failure = new Error(`synthetic browser ${stage} failure`);
        const server = Object.assign(new EventEmitter(), {
            listen: vi.fn((_port, _host, ready) => ready()), address: () => ({port: 12345}),
            closeAllConnections: vi.fn(), close: vi.fn(done => done()),
        });
        const browser = {newContext: vi.fn(async () => {throw new Error('synthetic context failure');}),
            close: vi.fn(async () => {throw failure;})};
        const chromium = {launch: vi.fn(async () => {if (stage === 'launch') throw failure; return browser;})};
        const fsPort = {
            mkdirSync: vi.fn(), readdirSync: () => [], statSync: () => ({isFile: () => true}),
            existsSync: (file: string) => !file.endsWith('maintainers') && !file.endsWith('marketing'),
            readFileSync: (file: string) => {
                if (file.endsWith('asset-manifest.json')) return '{"entries":[]}';
                if (file.endsWith('.md')) return '';
                const english = file.includes('/en/'), slogan = english ? 'Closer languages. A bigger world.' : '让语言更近，让世界更大。';
                return `<!doctype html><html><head><title>FluentRead</title></head><body><h1>${slogan}</h1><div class="product-tagline">${slogan}</div><div class="fr-control-notes"><a href="${english ? '/en' : ''}/guide/privacy"></a></div><div class="vp-doc">drive.appdata Data category Storage location 数据类别 保存位置</div></body></html>`;
            }, writeFileSync: vi.fn(),
        };
        let finished!: () => void;
        const done = new Promise<void>(yes => {finished = yes;});
        const processPort = {argv: ['node', script, '--runtime', '/controlled-runtime', '--output', '/controlled-evidence'], env: {}, exitCode: 0};
        const modulePort = {createRequire: () => (name: string) => name === 'playwright' ? {chromium} : () => ({metadata: async () => ({})})};
        const ports: Record<string, unknown> = {'node:fs': fsPort, 'node:path': require('node:path'), 'node:http': {createServer: () => server},
            'node:assert/strict': require('node:assert/strict'), 'node:module': modulePort, linkedom: require('linkedom')};
        runInContext(readFileSync(script, 'utf8'), createContext({URL, __dirname: dirname(script), process: processPort,
            require: (name: string) => {if (!(name in ports)) throw new Error(`Unexpected external port ${name}`); return ports[name];},
            console: {error: vi.fn(), log: () => finished()}}), {filename: script, timeout: 5000});
        await done;
        const report = JSON.parse(fsPort.writeFileSync.mock.calls.at(-1)![1]);
        expect(report.error).toContain(failure.message);
        expect(chromium.launch).toHaveBeenCalledTimes(1);
        expect(processPort.exitCode).toBe(1);
        expect(server.closeAllConnections).toHaveBeenCalledTimes(1); expect(server.close).toHaveBeenCalledTimes(1);
        if (stage === 'close') expect(browser.close).toHaveBeenCalledTimes(1);
    });
});

describe('audit49K complete language-detector CLI ownership', () => {
    it('closes an acquired Vite server when actual module initialization fails', () => {
        const directory = fixtureRoot();
        const vitePort = join(directory, 'controlled-vite.mjs'), fsPort = join(directory, 'controlled-fs.mjs'), loader = join(directory, 'controlled-loader.mjs');
        writeFileSync(vitePort, `export async function createServer(){console.log('VITE_EXTERNAL_PORT_ACQUIRED');return {ssrLoadModule:async()=>{throw Error('synthetic language module failure')},close:async()=>{console.log('VITE_EXTERNAL_PORT_CLOSED')}}}`);
        writeFileSync(fsPort, `import fs from 'node:fs';import path from 'node:path';export default {...fs,readFileSync:(file,...args)=>String(file).includes('/tests/fixtures/language-identification-')?fs.readFileSync(path.join(${JSON.stringify(root)},'tests/fixtures',path.basename(String(file))),...args):fs.readFileSync(file,...args)};`);
        writeFileSync(loader, `export async function resolve(name,context,next){if(name==='vite')return {url:${JSON.stringify(pathToFileURL(vitePort).href)},shortCircuit:true};if(name==='node:fs'&&context.parentURL?.endsWith('/evaluate-language-detectors.mjs'))return {url:${JSON.stringify(pathToFileURL(fsPort).href)},shortCircuit:true};return next(name,context)}`);
        const script = resolve(sourceRoot, 'scripts/testing/evaluate-language-detectors.mjs');
        const result = spawnSync(process.execPath, ['--experimental-loader', loader, script, '--out', join(directory, 'report.json')],
            {encoding: 'utf8', timeout: 6000, killSignal: 'SIGKILL'});
        expect(result.error).toBeUndefined(); expect(result.status).toBe(1);
        expect(result.stdout).toContain('VITE_EXTERNAL_PORT_ACQUIRED');
        expect(result.stderr).toContain('synthetic language module failure');
        expect(result.stdout).toContain('VITE_EXTERNAL_PORT_CLOSED');
    });
});

describe('audit49K complete interactive local-model CLI ownership', () => {
    it.each(['operation', 'report'] as const)('closes the acquired session and preserves the %s failure', async stage => {
        const script = resolve(sourceRoot, 'scripts/testing/local-model-browser-session.cjs');
        const operationFailure = new Error('synthetic service worker failure'), reportFailure = new Error('synthetic diagnostic write failure');
        const closeFailure = new Error('synthetic session close failure'), logged: unknown[][] = [];
        const context = {on: vi.fn(), serviceWorkers: () => stage === 'operation' ? [] : [{url: () => 'chrome-extension://owned/worker.js'}],
            waitForEvent: async () => {throw operationFailure;}};
        const session = {context, close: vi.fn(async () => {throw closeFailure;})};
        const page = {goto: vi.fn(async () => {}), locator: () => ({click: vi.fn(async () => {})})};
        const fsPort = {mkdirSync: vi.fn(), mkdtempSync: () => '/controlled-temp/fluentread-local-v2-owned', realpathSync: (file: string) => file,
            writeFileSync: (file: string) => {if (file.endsWith('errors.json')) throw reportFailure;}};
        let finished!: () => void, exitCode = 0;
        const done = new Promise<void>(yes => {finished = yes;});
        const processPort = {argv: ['node', script, '/controlled-extension', '/controlled-browser', '/controlled-evidence'],
            env: {PLAYWRIGHT_ROOT: '/controlled-runtime', FOCUS_SAFE_HELPER: '/controlled-launch-helper'}, stdin: {}};
        Object.defineProperty(processPort, 'exitCode', {get: () => exitCode, set: value => {exitCode = value; finished();}});
        const ports: Record<string, unknown> = {'node:fs': fsPort, 'node:path': require('node:path'), 'node:os': {tmpdir: () => '/controlled-temp'},
            'node:readline': {createInterface: () => ({async *[Symbol.asyncIterator]() {yield 'exit';}})}, '/controlled-runtime/playwright': {chromium: {}},
            '/controlled-launch-helper': {launchFocusSafePersistentContext: async () => session, newPageWithoutForeground: async () => page}};
        runInContext(readFileSync(script, 'utf8'), createContext({URL, process: processPort,
            require: (name: string) => {if (!(name in ports)) throw new Error(`Unexpected external port ${name}`); return ports[name];},
            console: {log: vi.fn(), error: (...args: unknown[]) => logged.push(args)}}), {filename: script, timeout: 5000});
        await done;
        expect(session.close).toHaveBeenCalledTimes(1); expect(exitCode).toBe(1);
        expect(logged.at(-1)![0]).toBe(stage === 'operation' ? operationFailure : reportFailure);
    });
});

const sdkProducerFile = resolve(sourceRoot, 'scripts/wasm/tesseract-sdk-build.ts');
const sdkProducer = existsSync(sdkProducerFile) ? await import(pathToFileURL(sdkProducerFile).href) : undefined;
const deliveredProducer = await import(pathToFileURL(resolve(root, 'scripts/wasm/package-diagnostics.ts')).href);
const sdkSourceFile = require.resolve('tesseract.js/src/createWorker.js');
const esbuild = createRequire(require.resolve('vite'))('esbuild');
let sdkBundle: Promise<string> | undefined;
afterAll(() => esbuild.stop());
function browserSdkBundle(): Promise<string> {
    return sdkBundle ||= (async () => {
        const actualPlugin = sdkProducer?.tesseractSdkBuildPlugin();
        const built = await esbuild.build({absWorkingDir: root, entryPoints: ['node_modules/tesseract.js/src/index.js'], bundle: true,
            platform: 'browser', format: 'iife', globalName: 'ActualTesseract', write: false, logLevel: 'silent',
            plugins: actualPlugin ? [{name: 'actual-sdk-build-transform-port', setup(build: any) {
                build.onLoad({filter: /tesseract\.js\/src\/createWorker\.js$/}, async (args: any) => ({
                    contents: (await actualPlugin.transform.call({}, readFileSync(args.path, 'utf8'), args.path)).code, loader: 'js',
                }));
            }}] : []});
        return built.outputFiles[0].text;
    })();
}
async function sdkRealm(WorkerPort: unknown) {
    const context = createContext({Worker: WorkerPort, Blob, File, URL, Uint8Array, ArrayBuffer, TextEncoder, TextDecoder, atob, btoa,
        console: {log: vi.fn(), warn: vi.fn(), error: vi.fn()}, setTimeout, clearTimeout, document: {}, window: {location: {href: 'https://controlled.invalid/'}}});
    context.self = context;
    runInContext(await browserSdkBundle(), context, {filename: 'actual-browser-tesseract-sdk.js', timeout: 5000});
    if (typeof context.ActualTesseract?.createWorker !== 'function') throw new Error('SDK_BROWSER_PUBLIC_ENTRY_NOT_LOADED');
    return context.ActualTesseract;
}
const sdkOptions = {workerPath: 'https://controlled.invalid/worker.min.js', corePath: 'https://controlled.invalid/core',
    workerBlobURL: false, langPath: 'https://controlled.invalid/lang', cacheMethod: 'none', gzip: false};
async function nativeSdkFixture(stage: 'loadLanguage' | 'initialize', cleanupThrows: boolean) {
    // SDK-only comparison: both versions consume the SAME final worker/core producers and exact native WASM.
    // Baseline has no SDK transform, so esbuild uses the original installed public SDK, with current dependencies.
    const artifacts = deliveredProducer.packageTesseractWasm(fixtureRoot(), coreSource);
    const actualWorker = deliveredProducer.packageTesseractWorker(fixtureRoot(), workerSource);
    const instances: any[] = [], errors: string[] = [];
    class WorkerPort {
        onmessage?: (event: any) => void;
        receive!: (event: any) => void;
        terminated = false;
        terminateCalls = 0;
        timers = new Set<ReturnType<typeof setTimeout>>();
        constructor() {
            instances.push(this);
            const owned = this;
            const realm = createContext({URL, WebAssembly, Uint8Array, ArrayBuffer, TextEncoder, TextDecoder, atob, btoa,
                WorkerGlobalScope: function () {}, console: {log: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
                setTimeout: (fn: () => void, ms: number) => {const timer = setTimeout(() => {owned.timers.delete(timer); if (!owned.terminated) fn();}, ms); owned.timers.add(timer); return timer;},
                clearTimeout: (timer: ReturnType<typeof setTimeout>) => {clearTimeout(timer); owned.timers.delete(timer);},
                setInterval: (fn: () => void, ms: number) => {const timer = setInterval(() => {if (!owned.terminated) fn();}, ms); owned.timers.add(timer); return timer;},
                clearInterval: (timer: ReturnType<typeof setTimeout>) => {clearInterval(timer); owned.timers.delete(timer);},
                fetch: async (url: string) => String(url).endsWith('.wasm')
                    ? new Response(asArrayBufferBytes(readFileSync(artifacts.wasm)), {headers: {'Content-Type': 'application/wasm'}})
                    : stage === 'initialize' ? new Response(new Uint8Array([1, 2, 3, 4])) : new Response('controlled missing language', {status: 404}),
                addEventListener: (type: string, fn: (event: any) => void) => {if (type === 'message') this.receive = fn;},
                postMessage: (packet: unknown) => queueMicrotask(() => {if (!owned.terminated) try {owned.onmessage?.({data: packet});} catch (error) {errors.push(String(error));}}),
                importScripts: () => runInContext(readFileSync(artifacts.glue, 'utf8'), realm, {filename: artifacts.glue, timeout: 5000}),
            });
            realm.self = realm; realm.location = {href: 'https://controlled.invalid/fluent-read-ocr/worker/worker.min.js'};
            runInContext(readFileSync(actualWorker, 'utf8'), realm, {filename: actualWorker, timeout: 5000});
            if (!this.receive) throw new Error('ACTUAL_DERIVED_WORKER_ENTRY_NOT_LOADED');
        }
        postMessage(packet: unknown) {queueMicrotask(() => {if (!this.terminated) this.receive({data: packet});});}
        terminate() {
            this.terminateCalls++; this.terminated = true;
            for (const timer of this.timers) {clearTimeout(timer); clearInterval(timer);} this.timers.clear();
            if (cleanupThrows) throw new Error('synthetic Worker terminate failure');
        }
    }
    return {sdk: await sdkRealm(WorkerPort), instances, errors, dispose() {for (const worker of instances) if (!worker.terminated) try {worker.terminate();} catch {}}};
}
function packetSdkFixture(handler?: (error: unknown) => void, workerError = false) {
    const instances: any[] = [], errors: string[] = [], sent: any[] = [];
    class WorkerPort {
        onmessage?: (event: any) => void;
        onerror?: (event: any) => void;
        terminated = false;
        terminateCalls = 0;
        constructor() {instances.push(this); if (workerError) queueMicrotask(() => this.onerror?.({message: 'controlled startup Worker error'}));}
        postMessage(packet: any) {
            sent.push(packet);
            queueMicrotask(() => {
                if (this.terminated) return;
                const failed = packet.action === 'recognize' && packet.payload.options.controlledFailure;
                const data = failed ? 'controlled job failure' : packet.action === 'recognize' ? {text: 'controlled native port result'} : {};
                try {this.onmessage?.({data: {...packet, status: failed ? 'reject' : 'resolve', data}});} catch (error) {errors.push(String(error));}
            });
        }
        terminate() {this.terminateCalls++; this.terminated = true;}
    }
    return {WorkerPort, instances, errors, sent, handler};
}
describe('audit49K actual browser SDK build producer and public createWorker', () => {
    it.each([['loadLanguage', false], ['initialize', false], ['initialize', true]] as const)
    ('rejects actual native %s startup failure and terminates its owned Worker (cleanup failure %s)', async (stage, cleanupThrows) => {
        const fixture = await nativeSdkFixture(stage, cleanupThrows);
        let outcome = 'pending', reason = '';
        const created = fixture.sdk.createWorker('eng', 1, sdkOptions);
        void created.then(() => {outcome = 'resolve';}, (error: unknown) => {outcome = 'reject'; reason = String(error);});
        try {
            const deadline = Date.now() + 2000;
            while (Date.now() < deadline && outcome === 'pending' && !fixture.errors.length) await new Promise(yes => setTimeout(yes, 10));
            expect(fixture.instances).toHaveLength(1);
            expect(outcome).toBe('reject');
            expect(reason).toContain(stage === 'initialize' ? 'initialization failed' : 'Network error while fetching');
            expect(fixture.errors).toEqual([]); expect(fixture.instances[0].terminateCalls).toBe(1);
        } finally {fixture.dispose();}
    });
    it('rejects a startup Worker error and releases that unique Worker', async () => {
        const fixture = packetSdkFixture(undefined, true), sdk = await sdkRealm(fixture.WorkerPort);
        try {
            await expect(sdk.createWorker('eng', 1, sdkOptions)).rejects.toBe('controlled startup Worker error');
            expect(fixture.instances[0].terminateCalls).toBe(1);
        } finally {for (const worker of fixture.instances) if (!worker.terminated) worker.terminate();}
    });
    it('preserves startup, parameters, recognize, reinitialize, legacy guards and idempotent terminate', async () => {
        const fixture = packetSdkFixture(), sdk = await sdkRealm(fixture.WorkerPort);
        const worker = await sdk.createWorker('eng', 1, sdkOptions);
        try {
            expect(fixture.sent.map(packet => packet.action)).toEqual(['load', 'loadLanguage', 'initialize']);
            await worker.setParameters({tessedit_char_whitelist: 'ABC'}, 'settings-job');
            expect(fixture.sent.at(-1)).toMatchObject({action: 'setParameters', jobId: 'settings-job', payload: {params: {tessedit_char_whitelist: 'ABC'}}});
            const image = new Uint8Array([1, 2, 3]);
            expect(await worker.recognize(image, {}, {text: true}, 'recognize-job')).toMatchObject({jobId: 'recognize-job', data: {text: 'controlled native port result'}});
            expect(Array.from(fixture.sent.at(-1).payload.image)).toEqual([1, 2, 3]);
            await worker.reinitialize('eng', 1, {someConfig: 1}, 'reuse-job');
            expect(fixture.sent.at(-1)).toMatchObject({action: 'initialize', jobId: 'reuse-job', payload: {langs: 'eng', oem: 1, config: {someConfig: 1}}});
            const before = fixture.sent.length;
            await worker.reinitialize('eng+fra', 1, {}, 'new-language-job');
            expect(fixture.sent.slice(before).map(packet => packet.action)).toEqual(['loadLanguage', 'initialize']);
            expect(() => worker.reinitialize('eng', 0)).toThrow('Legacy model requested');
            await expect(worker.detect(image)).rejects.toThrow('requires Legacy model');
            await worker.terminate(); await worker.terminate(); expect(fixture.instances[0].terminateCalls).toBe(1);
        } finally {await worker.terminate();}
    });
    it.each([false, true])('preserves a post-startup job rejection and following independent recognition (error handler %s)', async hasHandler => {
        const observed: unknown[] = [], fixture = packetSdkFixture(), sdk = await sdkRealm(fixture.WorkerPort);
        const worker = await sdk.createWorker('eng', 1, {...sdkOptions, ...(hasHandler ? {errorHandler: (error: unknown) => observed.push(error)} : {})});
        try {
            await expect(worker.recognize(new Uint8Array([1]), {controlledFailure: true}, {text: true})).rejects.toBe('controlled job failure');
            expect(observed).toEqual(hasHandler ? ['controlled job failure'] : []);
            expect(fixture.errors).toEqual(hasHandler ? [] : ['Error: controlled job failure']);
            expect(fixture.instances[0].terminateCalls).toBe(0);
            expect(await worker.recognize(new Uint8Array([1]), {}, {text: true})).toMatchObject({data: {text: 'controlled native port result'}});
        } finally {await worker.terminate();}
    });
    it('guards the exact source/version and leaves other modules untouched', () => {
        expect(typeof sdkProducer?.tesseractSdkBuildPlugin).toBe('function');
        const actualPlugin = sdkProducer!.tesseractSdkBuildPlugin();
        expect(actualPlugin.transform.call({}, 'unrelated authored module', resolve(root, 'src/unrelated.ts'))).toBeUndefined();
        expect(() => actualPlugin.transform.call({}, readFileSync(sdkSourceFile, 'utf8') + '\n// unexpected source', sdkSourceFile)).toThrow('Unsupported');
        const directory = fixtureRoot(), input = join(directory, 'tesseract.js/src/createWorker.js');
        mkdirSync(dirname(input), {recursive: true}); writeFileSync(join(dirname(input), '../package.json'), '{"version":"6.0.2"}');
        expect(() => actualPlugin.transform.call({}, readFileSync(sdkSourceFile, 'utf8'), input)).toThrow('Unsupported');
    });
    it.each(['?commonjs-proxy', '?commonjs-entry', ''])('leaves a virtual SDK module untouched (%s)', suffix => {
        const actualPlugin = sdkProducer!.tesseractSdkBuildPlugin();
        expect(actualPlugin.transform.call({}, 'export default controlledProxy;', `\0${sdkSourceFile}${suffix}`)).toBeUndefined();
    });
});
