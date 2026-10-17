/**
 * Compare the real baseline/worktree scheduler and document translator without a build.
 * Run from any directory: node <repo>/scripts/testing/benchmark-main-performance-20261017.cjs
 * Requires the repository's installed TypeScript and the baseline commit in local Git.
 * One warm-up and five measured runs per size; no network, generated files, or timing gates.
 * The deterministic operation-count regressions live in the normal test suite.
 */
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const fs = require('node:fs');
const {createRequire} = require('node:module');
const path = require('node:path');
const {performance} = require('node:perf_hooks');

const root = path.resolve(__dirname, '../..');
const baseline = '877ee77b5e3c905f6cc016db63633342dceb2419';
const repetitions = 5;
const repoRequire = createRequire(path.join(root, 'package.json'));
const ts = repoRequire('typescript');
const digest = value => createHash('sha256').update(value).digest('hex');

// Compile each version and its local dependencies independently, outside measured work.
// This avoids copying the algorithms, requiring a particular pnpm layout, or Node TS hooks.
function sourceLoader(version) {
    const cache = new Map();
    const hashes = new Map();
    function load(relativePath) {
        const file = path.resolve(root, relativePath);
        const relative = path.relative(root, file).split(path.sep).join('/');
        assert(!relative.startsWith('../') && !path.isAbsolute(relative), 'Source must be inside the repository');
        if (cache.has(relative)) return cache.get(relative).exports;
        const source = version === 'baseline'
            ? execFileSync('git', ['show', `${baseline}:${relative}`], {cwd: root, encoding: 'utf8'})
            : fs.readFileSync(file, 'utf8');
        hashes.set(relative, digest(source));
        const module = {exports: {}};
        cache.set(relative, module);
        const code = ts.transpileModule(source, {fileName: file, compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
        }}).outputText;
        const localRequire = specifier => {
            if (!specifier.startsWith('@/') && !specifier.startsWith('.')) return repoRequire(specifier);
            const target = specifier.startsWith('@/')
                ? path.resolve(root, specifier.slice(2))
                : path.resolve(path.dirname(file), specifier);
            return load(path.extname(target) ? target : `${target}.ts`);
        };
        new Function('require', 'module', 'exports', `${code}\n//# sourceURL=${file}`)(localRequire, module, module.exports);
        return module.exports;
    }
    return {load, hashes};
}

function timingSummary(samples) {
    const sorted = [...samples].sort((a, b) => a - b);
    return {medianMs: Number(sorted[Math.floor(sorted.length / 2)].toFixed(3)),
        samplesMs: samples.map(value => Number(value.toFixed(3)))};
}

async function schedulerRun(create, count) {
    let identityReads = 0;
    const identity = {get service() {identityReads += 1; return 'benchmark';}, model: 'model'};
    const scheduler = create(() => ({maxConcurrentTranslations: 1,
        translationRequestsPerSecond: 0, translationRequestsPerMinute: 0}));
    let release;
    const gate = new Promise(resolve => {release = resolve;});
    const starts = [];
    const active = scheduler.schedule(async () => {starts.push('active'); await gate; return 'active';}, {identity});
    const controllers = [];
    const jobs = [];
    const begin = performance.now();
    for (let index = 0; index < count; index += 1) {
        const controller = new AbortController();
        controllers.push(controller);
        jobs.push(scheduler.schedule(async () => {starts.push(index); return index;}, {
            identity, signal: controller.signal,
        }).then(value => ({value}), error => ({error: error.name})));
    }
    const queued = performance.now();
    const enqueueIdentityReads = identityReads;
    for (const controller of controllers) controller.abort();
    const cancelled = performance.now();
    const cancelIdentityReads = identityReads - enqueueIdentityReads;
    release();
    const outputs = await Promise.all([active, ...jobs]);
    assert.deepEqual(starts, ['active'], 'A cancelled queued task must never start');
    assert.deepEqual(outputs, ['active', ...Array.from({length: count}, () => ({error: 'AbortError'}))]);
    return {
        timings: {enqueue: queued - begin, cancel: cancelled - queued},
        counts: {enqueueIdentityReads, cancelIdentityReads},
        behavior: {started: starts.length, cancelled: count, outputSha256: digest(JSON.stringify(outputs))},
    };
}

async function documentRun(create, count) {
    let prioritizations = 0;
    let visited = 0;
    const requests = [];
    const commits = [];
    const translate = create({
        waitUntilReady() {},
        getDefaultService() {return 'benchmark';},
        supportsBatch() {return true;},
        async translateText(source) {throw new Error(`Unexpected single request: ${source}`);},
        async translateTextBatch(sources) {requests.push([...sources]); return sources.map(source => `T ${source}`);},
    });
    const segments = Array.from({length: count}, (_,id) => ({id, source: `Unique source ${id}`}));
    const priorityKey = {};
    const begin = performance.now();
    const outputs = await translate(segments, {
        fileName: 'benchmark.txt',
        priorityKey: () => priorityKey,
        prioritize(pending) {prioritizations += 1; visited += pending.length; return [...pending];},
        onSegment(segment) {commits.push(segment);},
    });
    const elapsed = performance.now() - begin;
    assert.deepEqual(outputs, segments.map(segment => `T ${segment.source}`));
    assert.deepEqual(requests.flat(), segments.map(segment => segment.source));
    assert.equal(commits.length, count);
    assert.deepEqual([...commits].sort((a, b) => a.id - b.id),
        segments.map(segment => ({id: segment.id, translation: `T ${segment.source}`})));
    return {
        timings: {translate: elapsed},
        counts: {prioritizations, visited},
        behavior: {requests: requests.length, committed: commits.length,
            outputSha256: digest(JSON.stringify({outputs, requests, commits}))},
    };
}

async function compare(scenario, count, run, factories) {
    const measurements = {baseline: [], current: []};
    for (let repetition = 0; repetition <= repetitions; repetition += 1) {
        // Alternate execution order to reduce consistently favouring the second version.
        const versions = repetition % 2 === 0 ? ['baseline', 'current'] : ['current', 'baseline'];
        const pair = {};
        for (const version of versions) pair[version] = await run(factories[version], count);
        assert.deepEqual(pair.current.behavior, pair.baseline.behavior, `${scenario} outputs differ at count ${count}`);
        if (repetition > 0) for (const version of versions) measurements[version].push(pair[version]);
    }
    const versions = {};
    for (const [version, samples] of Object.entries(measurements)) {
        for (const sample of samples) {
            assert.deepEqual(sample.counts, samples[0].counts, `${scenario} operation counts must be deterministic`);
            assert.deepEqual(sample.behavior, samples[0].behavior, `${scenario} outputs must be deterministic`);
        }
        versions[version] = {counts: samples[0].counts,
            timings: Object.fromEntries(Object.keys(samples[0].timings).map(key =>
                [key, timingSummary(samples.map(sample => sample.timings[key]))]))};
    }
    return {scenario, count, verifiedEqual: true, behavior: measurements.current[0].behavior, ...versions};
}

async function main() {
    const loaders = {baseline: sourceLoader('baseline'), current: sourceLoader('current')};
    const schedulers = {};
    const translators = {};
    for (const [version, loader] of Object.entries(loaders)) {
        schedulers[version] = loader.load('src/services/translation/requestScheduler.ts').createTranslationRequestScheduler;
        translators[version] = loader.load('src/features/document-translation/services/translation.ts').createDocumentSegmentTranslator;
    }
    const results = [];
    for (const count of [500, 1000, 2000, 4000]) {
        results.push(await compare('blocked-scheduler-burst-with-cancellation', count, schedulerRun, schedulers));
    }
    for (const count of [1000, 5000, 10000]) {
        results.push(await compare('document-stable-reading-priority', count, documentRun, translators));
    }
    console.log(JSON.stringify({baseline, node: process.version, platform: process.platform, arch: process.arch,
        typescript: ts.version, warmups: 1, repetitions,
        scope: 'Local in-memory scheduling and document prioritization; excludes compilation, provider/network work, UI, and storage. Timings are informational, not CI thresholds.',
        sources: Object.fromEntries(Object.entries(loaders).map(([version, loader]) =>
            [version, Object.fromEntries([...loader.hashes].sort(([a], [b]) => a.localeCompare(b)))])),
        results}, null, 2));
}

main().catch(error => {console.error(error); process.exitCode = 1;});
