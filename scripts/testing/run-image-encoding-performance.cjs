/**
 * 隔离可见 Edge 的 PNG 性能对照：相同像素分别同步、异步编码，记录阻塞、总耗时及定时器延迟。
 * 运行一轮预热和七轮样本，解码校验像素并验证取消；不连接用户 profile，不启动 OCR 或翻译请求。
 * 使用 --playwright-root、--focus-safe-helper 指定已有测试依赖，用 --output 保存报告。
 */
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index < 0 ? fallback : process.argv[index + 1]; };
const root = path.resolve(arg('project-root', path.join(__dirname, '../..')));
const ts = require('typescript');
const playwrightRoot = arg('playwright-root'), focusHelper = arg('focus-safe-helper');
assert.ok(playwrightRoot && focusHelper, '请指定 --playwright-root 和 --focus-safe-helper');
const { chromium } = require(path.join(playwrightRoot, 'playwright'));
const { launchFocusSafePersistentContext, newPageWithoutForeground } = require(focusHelper);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-encoding-'));
(async () => {
    let launched;
    try {
        launched = await launchFocusSafePersistentContext({ chromium, profileDir, browserPath: arg('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'), headless: false, background: true, viewport: { width: 1280, height: 900 } });
        assert.equal(launched.windowPlacement.browserFrontmost, false);
        const page = await newPageWithoutForeground(launched.context);
        await page.setContent('<title>FluentRead isolated PNG benchmark</title><p>无损 PNG 编码与取消响应测试</p>');
        const { outputText } = ts.transpileModule(fs.readFileSync(root + '/src/features/image-translation/services/mangaEncoding.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
        const results = await page.evaluate(async (code) => {
            const encode = new Function(code.replace(/^export /gm, '') + ';return encodeMangaCanvas;')();
            const canvas = document.createElement('canvas');
            canvas.width = 2048;
            canvas.height = 2048;
            const context = canvas.getContext('2d', { willReadFrequently: true });
            const pixels = context.createImageData(canvas.width, canvas.height);
            let seed = 20261005;
            for (let p = 0; p < pixels.data.length; p += 4) {
                seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
                pixels.data[p] = seed & 255;
                pixels.data[p + 1] = (seed >>> 8) & 255;
                pixels.data[p + 2] = (seed >>> 16) & 255;
                pixels.data[p + 3] = 255;
            }
            context.putImageData(pixels, 0, 0);
            const digest = data => { let hash = 2166136261; for (const byte of data)
                hash = Math.imul(hash ^ byte, 16777619); return (hash >>> 0).toString(16); };
            const expected = digest(pixels.data), cases = [];
            for (const asyncEncoding of [false, true]) {
                const samples = [];
                let output;
                for (let i = 0; i < 8; i++) {
                    const start = performance.now();
                    const tick = new Promise(resolve => setTimeout(() => resolve(performance.now() - start), 0));
                    const pending = asyncEncoding ? encode(canvas) : canvas.toDataURL('image/png');
                    const blockingMs = performance.now() - start;
                    output = await pending;
                    const totalMs = performance.now() - start;
                    const timerLatencyMs = await tick;
                    if (i > 0)
                        samples.push({ blockingMs, totalMs, timerLatencyMs });
                }
                const image = await createImageBitmap(await (await fetch(output)).blob());
                const check = document.createElement('canvas');
                check.width = image.width;
                check.height = image.height;
                const checkContext = check.getContext('2d');
                checkContext.drawImage(image, 0, 0);
                const actual = digest(checkContext.getImageData(0, 0, check.width, check.height).data);
                image.close();
                check.width = check.height = 0;
                const median = key => samples.map(s => s[key]).sort((a, b) => a - b)[3];
                cases.push({ asyncEncoding, blockingMs: median('blockingMs'), totalMs: median('totalMs'), timerLatencyMs: median('timerLatencyMs'), digest: actual, expected, outputBytes: output.length, samples });
            }
            const controller = new AbortController();
            const start = performance.now(), pending = encode(canvas, controller.signal);
            setTimeout(() => controller.abort(), 0);
            let cancellation;
            try {
                await pending;
                cancellation = { error: 'unexpected success' };
            }
            catch (error) {
                cancellation = { error: error.name, elapsedMs: performance.now() - start };
            }
            canvas.width = canvas.height = 0;
            return { scope: 'isolated visible Edge, 2048x2048 deterministic opaque noise, PNG only; one warmup + seven samples', cases, cancellation };
        }, outputText);
        for (const sample of results.cases)
            assert.equal(sample.digest, sample.expected);
        assert.equal(results.cancellation.error, 'AbortError');
        Object.assign(results, { launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement });
        const output = path.resolve(arg('output', path.join(os.tmpdir(), 'fluentread-image-encoding-performance.json')));
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, JSON.stringify(results, null, 2) + '\n');
        console.log(JSON.stringify(results, null, 2));
    }
    finally {
        if (launched) {
            await launched.close();
            fs.rmSync(profileDir, { recursive: true, force: true });
        }
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
