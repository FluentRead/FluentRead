#!/usr/bin/env node
// 同目标语言跳过的识别器对比：在同一份校准语料与留出语料上，对每个“文本 × 目录目标”计算错误跳过与同目标跳过率，
// 并记录分类别结果、初始化与单次识别耗时、堆内存和识别数据体积。
// 候选：
//   unified-franc-min   当前统一判断链（真实 franc-min）
//   unified-franc-full  同一判断链把 franc-min 替换为完整 franc（需 --franc-full 指向本地包目录）
//   naive-*             直接相信统计首位（仅作为“不加可靠性判断”的对照）
//   old-implementation  旧提交的 shouldSkipTranslationForTarget（需 --old-root 指向旧源码目录）
//   chromium-cld3       扩展 API chrome.i18n.detectLanguage（需 --browser 及隔离浏览器参数，只在临时 profile 中运行）
// 用法：node scripts/testing/evaluate-language-detectors.mjs --out <report.json> [--franc-full <dir>] [--old-root <dir>]
//   [--extra-corpus <独立语料.json>] [--browser --extension-dir .output/chrome-mv3 --playwright-root <dir> --focus-safe-helper <file>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {createServer} from 'vite';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const require = createRequire(import.meta.url);
const argument = (name, fallback) => {
    const index = process.argv.indexOf(`--${name}`);
    return index < 0 ? fallback : process.argv[index + 1];
};
const corpora = {
    calibration: JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/language-identification-corpus.json'), 'utf8')).cases,
    holdout: JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/language-identification-holdout.json'), 'utf8')).cases,
    holdout2: JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/language-identification-holdout-2.json'), 'utf8')).cases,
};

// 新失败语料可独立加入评测，沿用同一个判定器和全部目录目标，避免只对旧校准集调参。
const extraCorpusPath = argument('extra-corpus');
if (extraCorpusPath) {
    const extra = JSON.parse(fs.readFileSync(path.resolve(extraCorpusPath), 'utf8'));
    if (!Array.isArray(extra.cases)) throw new Error('--extra-corpus 必须包含 cases 数组');
    corpora.releaseHoldout = extra.cases;
}

async function loadModules(root, alias = {}) {
    const server = await createServer({
        root, configFile: false, logLevel: 'error', appType: 'custom',
        server: {middlewareMode: true, hmr: false, watch: null},
        resolve: {alias: {'@': root, ...alias}},
        optimizeDeps: {noDiscovery: true, include: []},
    });
    const started = performance.now();
    const before = process.memoryUsage().heapUsed;
    try {
    const detect = await server.ssrLoadModule('/src/core/language/detect.ts');
    const catalog = await server.ssrLoadModule('/src/core/language/catalog.ts');
    const identify = fs.existsSync(path.join(root, 'src/core/language/identify.ts'))
        ? await server.ssrLoadModule('/src/core/language/identify.ts') : undefined;
    const codes = fs.existsSync(path.join(root, 'src/core/language/codes.ts'))
        ? await server.ssrLoadModule('/src/core/language/codes.ts') : undefined;
    return {server, detect, catalog, identify, codes, importMs: performance.now() - started, importHeapBytes: process.memoryUsage().heapUsed - before};
    } catch (error) {
        // 尚未交给调用方的 server 仍由初始化入口负责释放，保留原始加载失败。
        await server.close().catch(() => undefined);
        throw error;
    }
}

function percentile(values, ratio) {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}

/** 以决策函数评估一份语料；empty 用例只检查“全部跳过”，不计入跳过率。 */
async function evaluate(targets, cases, decide) {
    const tags = {};
    const bump = (tag, key, amount = 1) => {
        tags[tag] ??= {expected: 0, skipped: 0, wrong: 0, pairs: 0};
        tags[tag][key] += amount;
    };
    const result = {pairs: 0, wrong: 0, expected: 0, skipped: 0, emptyCases: 0, emptyMisses: 0, wrongExamples: [], missedCases: []};
    for (const item of cases) {
        const decisions = await decide(item.text, targets);
        if (item.empty) {
            result.emptyCases += 1;
            if (decisions.some(skip => !skip)) result.emptyMisses += 1;
            continue;
        }
        let missed = false;
        targets.forEach((target, index) => {
            const skip = decisions[index];
            result.pairs += 1;
            for (const tag of item.tags) bump(tag, 'pairs');
            if (item.languages.includes(target)) {
                result.expected += 1;
                for (const tag of item.tags) bump(tag, 'expected');
                if (skip) {
                    result.skipped += 1;
                    for (const tag of item.tags) bump(tag, 'skipped');
                } else missed = true;
            } else if (skip) {
                result.wrong += 1;
                for (const tag of item.tags) bump(tag, 'wrong');
                if (result.wrongExamples.length < 40) result.wrongExamples.push({id: item.id, target});
            }
        });
        if (missed) result.missedCases.push(item.id);
    }
    result.sameTargetSkipRate = result.expected ? result.skipped / result.expected : 0;
    result.duplicateTranslationRate = 1 - result.sameTargetSkipRate;
    result.wrongSkipRate = result.pairs ? result.wrong / result.pairs : 0;
    result.byTag = Object.fromEntries(Object.entries(tags).sort().map(([tag, value]) => [tag, {
        ...value, sameTargetSkipRate: value.expected ? value.skipped / value.expected : null,
    }]));
    return result;
}

async function timeDecisions(texts, run, rounds = 3) {
    const samples = [];
    for (let round = 0; round < rounds; round += 1) {
        for (const text of texts) {
            const started = performance.now();
            await run(text);
            samples.push(performance.now() - started);
        }
    }
    return {calls: samples.length, medianMs: percentile(samples, 0.5), p95Ms: percentile(samples, 0.95), maxMs: Math.max(...samples)};
}

function fileSizes(files) {
    const buffers = files.map(file => fs.readFileSync(file));
    const raw = buffers.reduce((total, buffer) => total + buffer.length, 0);
    const gzip = zlib.gzipSync(Buffer.concat(buffers), {level: 9}).length;
    return {raw, gzip, files: files.map(file => path.relative(ROOT, file))};
}

async function evaluatePipeline(name, modules) {
    const targets = modules.catalog.translationLanguageOptions.map(option => option.value);
    const decide = (text, list) => list.map(target => modules.detect.shouldSkipTranslationForTarget(text, target));
    const entry = {name, importMs: modules.importMs, importHeapBytes: modules.importHeapBytes, corpora: {}};
    for (const [corpus, cases] of Object.entries(corpora)) entry.corpora[corpus] = await evaluate(targets, cases, decide);
    const texts = Object.values(corpora).flat().map(item => item.text);
    entry.timing = await timeDecisions(texts, text => {
        modules.identify?.clearLanguageIdentificationCache();
        modules.detect.shouldSkipTranslationForTarget(text, 'en');
    });
    entry.cachedTiming = await timeDecisions(texts, text => modules.detect.shouldSkipTranslationForTarget(text, 'en'));
    entry.heapAfterEvaluationBytes = process.memoryUsage().heapUsed;
    return entry;
}

/** 直接相信统计首位的对照：首位规范代码等于目标即跳过，中文简繁由原有字形规则补足；不做任何可靠性判断。 */
async function evaluateNaive(name, francModule, modules) {
    const targets = modules.catalog.translationLanguageOptions.map(option => option.value);
    const {normalizeDetectedLanguageCode, isLanguageCodeMatch} = modules.codes;
    const detectTop = text => {
        const code = francModule.franc(text, {minLength: 0});
        return code === 'und' ? '' : normalizeDetectedLanguageCode(code);
    };
    const decide = (text, list) => {
        if (!/\p{L}/u.test(text)) return list.map(() => true);
        const top = detectTop(text);
        const chinese = top === 'zh' ? modules.detect.detectChineseScript(text) : undefined;
        const language = chinese ? `zh-${chinese}` : top;
        return list.map(target => isLanguageCodeMatch(language, target));
    };
    const entry = {name, corpora: {}};
    for (const [corpus, cases] of Object.entries(corpora)) entry.corpora[corpus] = await evaluate(targets, cases, decide);
    entry.timing = await timeDecisions(Object.values(corpora).flat().map(item => item.text), text => francModule.franc(text, {minLength: 0}));
    return entry;
}

async function evaluateChromiumCld3(modules) {
    const {chromium} = require(path.join(argument('playwright-root'), 'playwright'));
    const {launchFocusSafePersistentContext, newPageWithoutForeground} = require(argument('focus-safe-helper'));
    const extensionDir = path.resolve(argument('extension-dir', '.output/chrome-mv3'));
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-detector-eval-'));
    const launched = await launchFocusSafePersistentContext({chromium, profileDir,
        browserPath: argument('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
        background: true, headless: false, viewport: {width: 1280, height: 900}, timeout: 30000,
        browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check']});
    try {
        const worker = launched.context.serviceWorkers()[0] || await launched.context.waitForEvent('serviceworker', {timeout: 30000});
        const origin = /^chrome-extension:\/\/[^/]+/u.exec(worker.url())[0];
        const page = await newPageWithoutForeground(launched.context, 30000);
        await page.goto(`${origin}/popup.html`, {waitUntil: 'domcontentloaded'});
        const texts = [...new Set(Object.values(corpora).flat().map(item => item.text))];
        const started = Date.now();
        const results = await page.evaluate(async texts => {
            const detect = text => new Promise(resolve => chrome.i18n.detectLanguage(text, resolve));
            const output = {};
            for (const text of texts) {
                const begin = performance.now();
                const value = await detect(text);
                output[text] = {value, ms: performance.now() - begin};
            }
            return {output, languageDetectorApi: typeof self.LanguageDetector, userAgent: navigator.userAgent};
        }, texts);
        const targets = modules.catalog.translationLanguageOptions.map(option => option.value);
        const {normalizeDetectedLanguageCode, isLanguageCodeMatch} = modules.codes;
        const decide = (text, list) => {
            if (!/\p{L}/u.test(text)) return list.map(() => true);
            const detected = results.output[text].value;
            const top = detected?.languages?.[0];
            const language = detected?.isReliable && top ? normalizeDetectedLanguageCode(top.language) : '';
            return list.map(target => isLanguageCodeMatch(language, target));
        };
        const entry = {name: 'chromium-cld3', rule: 'isReliable && top language equals target', userAgent: results.userAgent,
            languageDetectorApi: results.languageDetectorApi, wallMs: Date.now() - started, corpora: {},
            launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement};
        for (const [corpus, cases] of Object.entries(corpora)) entry.corpora[corpus] = await evaluate(targets, cases, decide);
        const samples = Object.values(results.output).map(item => item.ms);
        entry.timing = {calls: samples.length, medianMs: percentile(samples, 0.5), p95Ms: percentile(samples, 0.95), maxMs: Math.max(...samples)};
        entry.rawSamples = Object.fromEntries(Object.entries(results.output).slice(0, 12).map(([text, item]) => [text.slice(0, 60), item.value]));
        return entry;
    } finally {
        await launched.close();
        fs.rmSync(profileDir, {recursive: true, force: true});
    }
}

async function main() {
    const out = path.resolve(argument('out', '/private/tmp/fluentread-language-detectors/report.json'));
    fs.mkdirSync(path.dirname(out), {recursive: true});
    const report = {generatedAt: new Date().toISOString(), node: process.version, platform: `${os.type()} ${os.arch()}`,
        corpora: Object.fromEntries(Object.entries(corpora).map(([name, cases]) => [name, cases.length])),
        evidenceBoundary: 'All candidates run on the same FluentRead-authored corpora. Numbers compare decisions on these texts only and are not general accuracy claims.',
        candidates: [], sizes: {}};
    const current = await loadModules(ROOT);
    try {
        report.candidates.push(await evaluatePipeline('unified-franc-min', current));
        const francMin = await import('franc-min');
        report.candidates.push(await evaluateNaive('naive-franc-min-top1', francMin, current));
        const francMinDir = path.dirname(require.resolve('franc-min/package.json'));
        report.sizes['franc-min'] = fileSizes(['index.js', 'data.js', 'expressions.js'].map(file => path.join(francMinDir, file)));
        report.sizes['unified-language-core'] = fileSizes(['codes.ts', 'identify.ts', 'lexicon.ts', 'scripts.ts', 'statistical.ts', 'technicalTokens.ts', 'detect.ts', 'chinese.ts']
            .map(file => path.join(ROOT, 'src/core/language', file)));
        report.sizes['chinese-variant-data'] = fileSizes([path.join(ROOT, 'src/core/language/chineseVariants.ts')]);

        const francFull = argument('franc-full');
        if (francFull) {
            const full = await loadModules(ROOT, {'franc-min': path.join(francFull, 'index.js')});
            try {
                report.candidates.push(await evaluatePipeline('unified-franc-full', full));
                report.candidates.push(await evaluateNaive('naive-franc-full-top1', await import(path.join(francFull, 'index.js')), current));
                report.sizes.franc = fileSizes(['index.js', 'data.js', 'expressions.js'].map(file => path.join(francFull, file)));
            } finally {
                await full.server.close();
            }
        }
        const oldRoot = argument('old-root');
        if (oldRoot) {
            const old = await loadModules(path.resolve(oldRoot));
            try {
                report.candidates.push({...(await evaluatePipeline('old-implementation', {...old, catalog: current.catalog})), root: oldRoot});
            } finally {
                await old.server.close();
            }
        }
        if (process.argv.includes('--browser')) report.candidates.push(await evaluateChromiumCld3(current));
    } finally {
        await current.server.close();
    }
    fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    const summary = report.candidates.map(candidate => ({
        name: candidate.name,
        ...Object.fromEntries(Object.entries(candidate.corpora).map(([corpus, value]) => [corpus, {
            skipRate: Number(value.sameTargetSkipRate.toFixed(4)), wrong: value.wrong, pairs: value.pairs, emptyMisses: value.emptyMisses,
        }])),
        medianMs: Number(candidate.timing.medianMs.toFixed(4)), p95Ms: Number(candidate.timing.p95Ms.toFixed(4)),
    }));
    process.stdout.write(`${JSON.stringify({out, summary, sizes: report.sizes}, null, 2)}\n`);
}

main().catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
});
