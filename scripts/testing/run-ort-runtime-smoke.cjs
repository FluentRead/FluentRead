'use strict';
const {guardBrowserClose} = require('./owned-browser-close.cjs');

// 在独立产物副本中验证生产 Worker 的模块加载/消息，再用真实 ORT 执行微型 ONNX 图。
// 只附加测试页/Worker，保留被测扩展的 CSP；不下载模型、不修改生产产物。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {createRequire} = require('node:module');
const {createHash} = require('node:crypto');
const assert = require('node:assert/strict');
function arg(name, fallback) { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; }
const source = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const artifacts = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-ort-smoke'));
const prototype = process.argv.includes('--prototype');
const diagnostics = process.argv.includes('--diagnostics');
const {chromium} = require(path.join(arg('playwright-root', '/Users/thinkstu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'), 'playwright'));
const {launchFocusSafePersistentContext, newPageWithoutForeground} = require(arg('focus-safe-helper', path.join(__dirname, 'focus-safe-browser.cjs')));
let profile, fixture;
fs.mkdirSync(artifacts, {recursive: true});
const report = {source, prototype, diagnostics, workerEntries: [], cases: [], errors: [], evidence: 'Production Worker entry/chunk loading and no-model message handling, plus real ONNX Identity sessions in owned probe Workers; this does not claim full translation, speech synthesis or transcription quality.'};
const expectedDigests = {};

// ONNX ModelProto: Identity(float32[1]) with opset 13, generated without a model download.
const varint = value => { const bytes = []; do { let byte = value & 127; value >>>= 7; if (value) byte |= 128; bytes.push(byte); } while (value); return Buffer.from(bytes); };
const scalar = (field, value) => Buffer.concat([varint(field * 8), varint(value)]);
const message = (field, data) => { const bytes = typeof data === 'string' ? Buffer.from(data) : data; return Buffer.concat([varint(field * 8 + 2), varint(bytes.length), bytes]); };
const valueInfo = name => message(name === 'input' ? 11 : 12, Buffer.concat([
  message(1, name), message(2, message(1, Buffer.concat([scalar(1, 1), message(2, message(1, scalar(1, 1)))]))),
]));
// 未使用的 initializer 会让真实 ORT 在建会话时发出 WARNING，验证打包 glue 的实际分级。
const unused = diagnostics ? message(5, Buffer.concat([scalar(1, 1), scalar(2, 1), message(8, 'unused_diagnostic_probe'), message(9, Buffer.from([0, 0, 128, 63]))])) : Buffer.alloc(0);
const graph = Buffer.concat([message(1, Buffer.concat([message(1, 'input'), message(2, 'output'), message(4, 'Identity')])), message(2, 'identity'), valueInfo('input'), valueInfo('output'), unused]);
const model = Buffer.concat([scalar(1, 8), message(7, graph), message(8, scalar(2, 13))]);
(async () => {
  let session, primaryError, launchAttempted = false;
  try {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-ort-smoke-profile-'));
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-ort-smoke-extension-'));
    fs.cpSync(source, fixture, {recursive: true});
fs.writeFileSync(path.join(fixture, 'probe-model.onnx'), model);
fs.writeFileSync(path.join(fixture, 'probe.html'), '<!doctype html><title>ORT packaged runtime verification</title><h1>ORT packaged runtime verification</h1>');

const detectedRuntimeName = fs.existsSync(path.join(source, 'fluent-read-ai/ort-wasm-simd-threaded.jspi.wasm'))
  ? 'ort-wasm-simd-threaded.jspi'
  : 'ort-wasm-simd-threaded.asyncify';
for (const label of ['opus-whisper', 'kokoro', 'paddle']) {
  const prefix = '';
  const runtimeName = detectedRuntimeName;
  const packageRoot = fs.realpathSync(path.resolve('node_modules/@huggingface/transformers-kokoro'));
  const req = createRequire(path.join(packageRoot, 'package.json'));
  const dist = path.dirname(req.resolve('onnxruntime-web/webgpu'));
  expectedDigests[label] = createHash('sha256').update(fs.readFileSync(path.join(dist, `${runtimeName}.wasm`))).digest('hex');
  fs.copyFileSync(path.join(dist, 'ort.webgpu.min.mjs'), path.join(fixture, `probe-${label}-ort.mjs`));
  if (prototype) {
    fs.copyFileSync(path.join(dist, `${runtimeName}.mjs`), path.join(fixture, `fluent-read-ai/${runtimeName}.mjs`));
    fs.copyFileSync(path.join(dist, `${runtimeName}.wasm`), path.join(fixture, `fluent-read-ai/${runtimeName}.wasm`));
  }
  fs.writeFileSync(path.join(fixture, `probe-${label}.mjs`), `
import {env, InferenceSession, Tensor} from './probe-${label}-ort.mjs';
self.onmessage = async ({data: {backend}}) => {
  try {
    const started = performance.now();
    const response = await fetch(new URL('./fluent-read-ai/${prefix}${runtimeName}.wasm', self.location.href));
    if (!response.ok || !response.body) throw new Error('Packaged WASM missing');
    const binary = new Uint8Array(await response.arrayBuffer());
    const loadedMs = performance.now() - started;
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', binary))].map(x => x.toString(16).padStart(2, '0')).join('');
    env.wasm.numThreads = 1;
    env.wasm.proxy = false;
    env.wasm.wasmPaths = {mjs: new URL('./fluent-read-ai/${prefix}${runtimeName}.mjs', self.location.href).href};
    env.wasm.wasmBinary = binary;
    const session = await InferenceSession.create(new Uint8Array(await (await fetch('./probe-model.onnx')).arrayBuffer()), {executionProviders: [backend]});
    delete env.wasm.wasmBinary;
    const result = await session.run({input: new Tensor('float32', new Float32Array([42]), [1])});
    const output = [...result.output.data];
    await session.release();
    const nextSession = await InferenceSession.create(new Uint8Array(await (await fetch('./probe-model.onnx')).arrayBuffer()), {executionProviders: [backend]});
    const nextResult = await nextSession.run({input: new Tensor('float32', new Float32Array([-7]), [1])});
    const reusedOutput = [...nextResult.output.data];
    await nextSession.release();
    self.postMessage({ok: true, output, reusedOutput, binaryBytes: binary.byteLength, digest, loadedMs, totalMs: performance.now() - started});
  } catch (error) { self.postMessage({ok: false, error: String(error), stack: error.stack}); }
};`);
}



    launchAttempted = true;
    session = await launchFocusSafePersistentContext({chromium, profileDir: profile,
      browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', headless: false, background: true,
      viewport: {width: 1100, height: 800}, browserArgs: ['--no-first-run', '--no-default-browser-check', `--disable-extensions-except=${fixture}`, `--load-extension=${fixture}`]});
    guardBrowserClose(session, profile);
    Object.assign(report, {launchMode: session.launchMode, focusPolicy: session.focusPolicy, windowPlacement: session.windowPlacement});
    const {context} = session;
    const background = context.serviceWorkers().find(worker => worker.url().startsWith('chrome-extension://')) || await context.waitForEvent('serviceworker', {timeout: 30000});
    const origin = background.url().match(/^chrome-extension:\/\/[^/]+/)[0];
    const page = await newPageWithoutForeground(context);
    const consoleLogs = [];
    page.on('console', message => consoleLogs.push({type: message.type(), text: message.text()}));
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(`${origin}/probe.html`);
    const workerCases = [
      {entry: 'localTranslationWorker', requests: [
        {requestId: 1, type: 'dispose'}, {requestId: 2, type: 'translate', text: ''}, {requestId: 3, type: 'dispose'},
      ], expected: [
        {requestId: 1, success: true}, {requestId: 2, success: false, error: 'LOCAL_TRANSLATION_INVALID_REQUEST'}, {requestId: 3, success: true},
      ]},
      {entry: 'localTtsWorker', requests: [
        {requestId: 1, type: 'dispose'}, {requestId: 2, type: 'synthesize', text: ''}, {requestId: 3, type: 'dispose'},
      ], expected: [
        {requestId: 1, success: true}, {requestId: 2, success: false, error: '本地 TTS 文本为空'}, {requestId: 3, success: true},
      ]},
      {entry: 'videoTranscriptionWorker', requests: [
        {requestId: 1, type: 'transcribe'}, {type: 'dispose'}, {requestId: 2, type: 'transcribe'},
      ], expected: [
        {requestId: 1, success: true, text: '', segments: []}, {requestId: 2, success: true, text: '', segments: []},
      ]},
    ];
    for (const {entry, requests, expected} of workerCases) {
      // 两个独立 Worker 使用相同请求号，覆盖共享 chunk 后的上下文隔离；加载前立即排队消息。
      const instances = await page.evaluate(({entry, requests, count}) => Promise.all([0, 1].map(() => new Promise((resolve, reject) => {
        const worker = new Worker(new URL(`${entry}.js`, location.href), {type: 'module'});
        const responses = [];
        const timer = setTimeout(() => {worker.terminate(); reject(new Error(`${entry} initialization timed out`));}, 15000);
        worker.onerror = event => {clearTimeout(timer); worker.terminate(); reject(new Error(`${entry}: ${event.message}`));};
        worker.onmessage = event => {
          responses.push(event.data);
          if (responses.length === count) {clearTimeout(timer); worker.terminate(); resolve(responses);}
        };
        requests.forEach(request => worker.postMessage(request));
      }))), {entry, requests, count: expected.length});
      report.workerEntries.push({entry, instances});
      for (const responses of instances) {
        assert.equal(responses.length, expected.length);
        expected.forEach((response, index) => {
          for (const [key, value] of Object.entries(response)) assert.deepEqual(responses[index][key], value, `${entry} response ${index}: ${key}`);
        });
      }
    }
    for (const label of ['opus-whisper', 'kokoro', 'paddle']) {
      for (const backend of ['wasm', 'webgpu']) {
      const logStart = consoleLogs.length;
      const result = await page.evaluate(({label, backend}) => new Promise((resolve, reject) => {
        const worker = new Worker(new URL(`probe-${label}.mjs`, location.href), {type: 'module'});
        const timer = setTimeout(() => {worker.terminate(); reject(new Error('ORT initialization timed out'));}, 45000);
        worker.onerror = event => {clearTimeout(timer); worker.terminate(); reject(new Error(event.message));};
        worker.onmessage = event => {clearTimeout(timer); worker.terminate(); resolve(event.data);};
        worker.postMessage({backend});
      }), {label, backend});
      report.cases.push({label, backend, ...result});
      assert.equal(result.ok, true, result.error);
      assert.deepEqual(result.output, [42]);
      assert.deepEqual(result.reusedOutput, [-7]);
      assert.equal(result.digest, expectedDigests[label], '解压结果必须逐字节等于锁定依赖中的 WASM');
      if (diagnostics) {
        const logs = consoleLogs.slice(logStart);
        report.cases.at(-1).logs = logs;
        assert.ok(logs.some(entry => entry.type === 'warning' && entry.text.includes('unused_diagnostic_probe')), '真实 ORT 警告必须以 warning 输出');
        assert.ok(!logs.some(entry => entry.type === 'error'), '正常推理不能把警告记录为 error');
      }
      }
    }
    assert.deepEqual(report.errors, []);
    report.ok = true;
  } catch (error) {primaryError = error; report.ok = false; report.failure = error.stack; console.error(error); process.exitCode = 1;}
  finally {
    const cleanupErrors = [];
    const cleanup = async (resource, release) => {
      try { await release(); } catch (error) {
        cleanupErrors.push(error);
        (report.cleanupErrors ||= []).push({resource, error: String(error.stack || error)});
        report.ok = false;
        process.exitCode = 1;
        console.error(`Cleanup failed (${resource}):`, error);
      }
    };
    let browserClosed = false;
    await cleanup('browser', async () => { if (session) { await session.close(); browserClosed = true; } });
    await cleanup('extension fixture', () => {
      // 启动尝试后，活浏览器可能仍从副本加载 Worker/WASM。
      if (fixture && (!launchAttempted || browserClosed)) fs.rmSync(fixture, {recursive: true, force: true});
    });
    await cleanup('profile', () => {
      if (!profile) return;
      if (browserClosed) fs.rmSync(profile, {recursive: true, force: true});
      else if (!launchAttempted) {
        try { fs.rmdirSync(profile); } catch (error) {
          // 未尝试启动浏览器时，仅移除初始空目录。
          if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
        }
      }
    });
    report.cleaned = (!profile || !fs.existsSync(profile)) && (!fixture || !fs.existsSync(fixture));
    await cleanup('report', () => { fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2)); });
    if (cleanupErrors.length && !primaryError) throw cleanupErrors[0];
  }
  if (report.ok) console.log(JSON.stringify(report, null, 2));
})().catch(error => {console.error(error); process.exitCode = 1;});
