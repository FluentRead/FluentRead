#!/usr/bin/env node
// 隔离评测 ELD XS/Small：真实算法、所有目录目标、独立语料；不向检测器传入目标或标注。
// 仅使用显式提供的已解包 ELD 与同包 tgz，不安装依赖；报告和浏览器体积样本写入 --out 的父目录。
// 用法：node scripts/testing/benchmark-eld.mjs --eld-dir <package目录> --eld-tar <eld.tgz> --out <report.json> [--root <项目目录>]
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {createServer} from 'vite';

const {values} = parseArgs({options: {
    root: {type: 'string', default: process.cwd()},
    'eld-dir': {type: 'string'}, 'eld-tar': {type: 'string'}, out: {type: 'string'},
    help: {type: 'boolean', short: 'h'},
}});
if (values.help) {
    console.log('Usage: node scripts/testing/benchmark-eld.mjs --eld-dir <unpacked package> --eld-tar <same package.tgz> --out <report.json> [--root <project directory>]');
    process.exit(0);
}
for (const name of ['eld-dir', 'eld-tar', 'out']) {
    if (!values[name]?.trim()) throw new Error(`Missing required option --${name}; see --help`);
}
const ROOT = path.resolve(values.root);
const outputFile = path.resolve(values.out);
const outputDirectory = path.dirname(outputFile);
const packageRoot = path.resolve(values['eld-dir']);
const packageTar = path.resolve(values['eld-tar']);
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hashFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const packageMetadata = readJson(path.join(packageRoot, 'package.json'));
if (packageMetadata.name !== 'eld') throw new Error('--eld-dir must point to an unpacked eld package');
const fixtures = path.join(ROOT, 'tests/fixtures');
const suiteFiles = {
    releaseCorpus: 'target-language-release-corpus.json',
    calibration217: 'language-identification-corpus.json',
    holdout94: 'language-identification-holdout.json',
    holdout2_61: 'language-identification-holdout-2.json',
};
const suites = Object.fromEntries(Object.entries(suiteFiles).map(([name, file]) => [name, readJson(path.join(fixtures, file)).cases]));
const nativeBodies = suites.releaseCorpus.filter(item => item.tags.includes('native-body'));
const relatedPairs = [
    ['en', 'fr'], ['en', 'de'], ['fr', 'es'], ['es', 'pt'], ['it', 'fr'],
    ['id', 'ms'], ['cs', 'sk'], ['da', 'sv'], ['nb', 'da'], ['hr', 'sl'],
    ['sr', 'ru'], ['ru', 'uk'], ['uk', 'bg'], ['ar', 'fa'], ['fa', 'ur'],
    ['hi', 'mr'], ['mr', 'ne'], ['zh-Hans', 'ja'], ['zh-Hant', 'ko'], ['ja', 'ko'],
];
suites.composedMixed40 = relatedPairs.flatMap(([left, right]) => {
    const first = nativeBodies.find(item => item.languages.includes(left)).text;
    const second = nativeBodies.find(item => item.languages.includes(right)).text;
    return [
        {id: `${left}-${right}`, text: `${first}\n${second}`, languages: [], tags: ['mixed', 'composed-native']},
        {id: `${right}-${left}`, text: `${second}\n${first}`, languages: [], tags: ['mixed', 'composed-native']},
    ];
});
const adversarialFile = path.join(ROOT, 'tests/targetLanguageAdversarial.test.ts');
const adversarialText = fs.readFileSync(adversarialFile, 'utf8');
const foreignCasesText = adversarialText.match(/const foreignCases:[^=]+=(\s*\[[\s\S]*?\]);/u)?.[1];
if (!foreignCasesText) throw new Error('Cannot locate the foreignCases array in tests/targetLanguageAdversarial.test.ts');
suites.adversarialForeign30 = Function(`return (${foreignCasesText})`)().map(([text, target], index) => ({
    id: `adversarial-${index}-${target}`, text, languages: [], tags: ['mixed', 'adversarial', 'foreign-ui'],
}));

const server = await createServer({root: ROOT, configFile: false, logLevel: 'error', appType: 'custom',
    server: {middlewareMode: true, hmr: false, watch: null}, resolve: {alias: {'@': ROOT}},
    optimizeDeps: {noDiscovery: true, include: []}});

function percentile(values, ratio) {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}

try {
    const currentModules = await Promise.all([
        server.ssrLoadModule('/src/core/language/identify.ts'),
        server.ssrLoadModule('/src/core/language/catalog.ts'),
        server.ssrLoadModule('/src/core/language/chinese.ts'),
        server.ssrLoadModule('/src/core/language/codes.ts'),
    ]);
    const [identify, catalog, chinese, codes] = currentModules;
    const targets = catalog.translationLanguageOptions.map(option => option.value);
    const texts = Object.values(suites).flat().map(item => item.text);
    const report = {
        generatedAt: new Date().toISOString(), nodeVersion: process.version,
        method: 'No detector receives selected target, allowed languages, corpus labels, or language subset. ELD uses shipped isReliable() with its default threshold; input is raw text. Only ELD zh is mapped by existing classifyChineseHan(source), independently of target. All 52 catalog targets are checked; mixed/ambiguous negative cases remain negative. Current pipeline is measured uncached. Timing covers detection + reliability + Chinese/code normalization, not target-loop comparisons. Node measurements are local relative evidence, not browser/device claims.',
        package: {name: 'eld', version: packageMetadata.version, license: packageMetadata.license,
            tarBytes: fs.statSync(packageTar).size,
            tarSha256: hashFile(packageTar),
            source: 'https://github.com/nitotm/efficient-language-detector-js',
            npmSource: `https://registry.npmjs.org/eld/-/eld-${encodeURIComponent(packageMetadata.version)}.tgz`,
            implementationNotes: ['Default text cleanup is false; no cleanup preset or language subset is enabled.',
                'detect() truncates input to 1000 UTF-16 code units; strToUtf8Bytes() cuts after whitespace beyond 350 bytes or after a UTF-8 character beyond 380 bytes.',
                'LanguageResult.isReliable() in npm 2.1.0 sets nextScore to orderedResults[1][0] (language ID), while score is [1][1]; recorded shipped behavior is used unchanged.'],
        },
        corpusFiles: Object.fromEntries(Object.entries(suiteFiles).map(([name, file]) => [name, {file, sha256: hashFile(path.join(fixtures, file)), cases: suites[name].length}])),
        adversarialSource: {file: 'tests/targetLanguageAdversarial.test.ts', sha256: hashFile(adversarialFile)},
        projectSourceHashes: Object.fromEntries(['identify.ts', 'technicalTokens.ts', 'statistical.ts', 'chinese.ts', 'codes.ts', 'lexicon.ts', 'functionWordData.ts'].map(file => [file, hashFile(path.join(ROOT, 'src/core/language', file))])),
        targets, candidates: [],
    };

    function mapEldResult(result, text) {
        const reliable = result.isReliable();
        if (!reliable || !result.language) return {languages: [], language: result.language, reliable, status: 'unknown'};
        const language = codes.normalizeDetectedLanguageCode(result.language);
        if (language === 'zh') {
            const variant = chinese.classifyChineseHan(text);
            const languages = variant === 'shared' ? ['zh-Hans', 'zh-Hant'] : variant ? [`zh-${variant}`] : [];
            return {languages, language: result.language, reliable, status: languages.length ? 'identified' : 'unknown'};
        }
        return {languages: language ? [language] : [], language: result.language, reliable, status: language ? 'identified' : 'unknown'};
    }

    function evaluateSuite(cases, detect) {
        const stats = {cases: cases.length, expectedPairs: 0, correctlySkippedPairs: 0, wrongSkippedPairs: 0,
            correctlyCoveredCases: 0, positiveCases: 0, negativeCases: 0, negativeCasesWronglySkipped: 0,
            emptyCases: 0, emptyMisses: 0, byTag: {}, wrongExamples: [], missedPositiveCases: []};
        const tagStats = tag => stats.byTag[tag] ??= {cases: 0, positiveCases: 0, coveredCases: 0, expectedPairs: 0, correctlySkippedPairs: 0, wrongSkippedPairs: 0};
        for (const item of cases) {
            const prediction = detect(item.text);
            const predictedTargets = /\p{L}/u.test(item.text)
                ? targets.filter(target => prediction.languages.some(language => codes.isLanguageCodeMatch(language, target))) : targets;
            if (item.empty) {
                stats.emptyCases += 1;
                if (predictedTargets.length !== targets.length) stats.emptyMisses += 1;
                continue;
            }
            const correct = predictedTargets.filter(target => item.languages.includes(target));
            const wrong = predictedTargets.filter(target => !item.languages.includes(target));
            stats.expectedPairs += item.languages.length;
            stats.correctlySkippedPairs += correct.length;
            stats.wrongSkippedPairs += wrong.length;
            if (item.languages.length) {
                stats.positiveCases += 1;
                if (correct.length) stats.correctlyCoveredCases += 1;
                else stats.missedPositiveCases.push(item.id);
            } else {
                stats.negativeCases += 1;
                if (wrong.length) stats.negativeCasesWronglySkipped += 1;
            }
            for (const tag of item.tags) {
                const category = tagStats(tag);
                category.cases += 1;
                category.expectedPairs += item.languages.length;
                category.correctlySkippedPairs += correct.length;
                category.wrongSkippedPairs += wrong.length;
                if (item.languages.length) category.positiveCases += 1;
                if (correct.length) category.coveredCases += 1;
            }
            if (wrong.length) stats.wrongExamples.push({id: item.id, source: item.text,
                allowedTargets: item.languages, predictedTargets, wrongTargets: wrong, prediction});
        }
        stats.sameTargetSkipRate = stats.expectedPairs ? stats.correctlySkippedPairs / stats.expectedPairs : null;
        stats.positiveCaseCoverage = stats.positiveCases ? stats.correctlyCoveredCases / stats.positiveCases : null;
        for (const category of Object.values(stats.byTag)) category.sameTargetSkipRate = category.expectedPairs ? category.correctlySkippedPairs / category.expectedPairs : null;
        return stats;
    }

    async function evaluateCandidate(name, detect, metadata = {}) {
        for (const text of texts) detect(text);
        const times = [];
        for (let round = 0; round < 5; round += 1) {
            for (const text of texts) {
                const started = performance.now();
                detect(text);
                times.push(performance.now() - started);
            }
        }
        const candidate = {name, ...metadata, timings: {calls: times.length, rounds: 5,
            medianMs: percentile(times, 0.5), p95Ms: percentile(times, 0.95), maxMs: Math.max(...times)},
            suites: Object.fromEntries(Object.entries(suites).map(([name, cases]) => [name, evaluateSuite(cases, detect)]))};
        report.candidates.push(candidate);
    }

    await evaluateCandidate('current-unified-franc-min', text => {
        identify.clearLanguageIdentificationCache();
        return identify.identifyTextLanguage(text);
    }, {note: 'Current project pipeline; cache cleared before each call to measure actual detection work.'});

    const require = createRequire(import.meta.url);
    const viteRequire = createRequire(fs.realpathSync(require.resolve('vite/package.json')));
    const {build} = await import(pathToFileURL(viteRequire.resolve('esbuild')).href);
    fs.mkdirSync(outputDirectory, {recursive: true});
    for (const [name, entry] of [['eld-xs', 'static.extrasmall.js'], ['eld-small', 'static.small.js']]) {
        const input = path.join(packageRoot, 'src/entries', entry);
        const bundle = await build({entryPoints: [input], bundle: true, write: false, minify: true,
            platform: 'browser', format: 'esm', target: 'es2020', legalComments: 'none'});
        const buffer = Buffer.from(bundle.outputFiles[0].contents);
        fs.writeFileSync(path.join(outputDirectory, `${name}.browser.min.js`), buffer);
        const dataFile = path.join(packageRoot, 'src/ngrams', entry.replace('static.', ''));
        const heapBefore = process.memoryUsage().heapUsed;
        const started = performance.now();
        const {eld} = await import(pathToFileURL(input).href);
        const initialization = {importMs: performance.now() - started, heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore};
        const info = eld.info();
        const supportedCodes = Object.values(info.Languages).map(language => codes.normalizeDetectedLanguageCode(language));
        await evaluateCandidate(name, text => mapEldResult(eld.detect(text), text), {
            modelDataBytes: fs.statSync(dataFile).size, browserBundleBytes: buffer.length,
            browserBundleGzipBytes: zlib.gzipSync(buffer, {level: 9}).length,
            initialization, languageCount: supportedCodes.length,
            unsupportedTargets: targets.filter(target => !supportedCodes.some(language => codes.isLanguageCodeMatch(language, target))), info,
        });
    }
    fs.writeFileSync(outputFile, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({report: outputFile, version: report.package.version,
        candidates: report.candidates.map(candidate => ({name: candidate.name, timings: candidate.timings,
            browserBundleBytes: candidate.browserBundleBytes, browserBundleGzipBytes: candidate.browserBundleGzipBytes,
            suites: Object.fromEntries(Object.entries(candidate.suites).map(([name, suite]) => [name, {
                cases: suite.cases, correct: suite.correctlySkippedPairs, expected: suite.expectedPairs,
                wrong: suite.wrongSkippedPairs, negativeWrong: suite.negativeCasesWronglySkipped,
                byTag: Object.fromEntries(['native-body', 'native-title', 'release'].filter(tag => suite.byTag[tag]).map(tag => [tag, {correct: suite.byTag[tag].correctlySkippedPairs, expected: suite.byTag[tag].expectedPairs, wrong: suite.byTag[tag].wrongSkippedPairs}]))}]))}))}));
} finally { await server.close(); }
