/**
 * 图片翻译纯算法性能对照：加载指定检出的真实模块，在固定样本上测量分组、修补和排版。
 * 只记录阶段耗时、输出摘要和测宽调用数；输入准备与结果校验不计入时间，不请求 OCR 或翻译服务。
 */
import ts from 'typescript';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
const arg = (name, fallback) => {
    const index = process.argv.indexOf(`--${name}`);
    return index < 0 ? fallback : process.argv[index + 1];
};
const root = resolve(arg('project-root', process.cwd()));
const load = async (path) => {
    const source = readFileSync(resolve(root, path), 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
    return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
};
const digest = bytes => {
    let hash = 2166136261;
    for (const byte of bytes)
        hash = Math.imul(hash ^ byte, 16777619);
    return (hash >>> 0).toString(16);
};
const measure = (run, setup = () => undefined) => {
    for (let i = 0; i < 2; i++)
        run(setup());
    const times = [];
    let output;
    for (let i = 0; i < 7; i++) {
        const input = setup(), start = performance.now();
        output = run(input);
        times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    return { medianMs: times[3], samplesMs: times, output };
};
const allocations = run => {
    const constructors = { Uint8Array, Uint32Array, Uint8ClampedArray };
    const totals = { maskBytes: 0, peakMaskBytes: 0, queueBytes: 0, peakQueueBytes: 0, pixelCopyBytes: 0 };
    globalThis.Uint8Array = class extends constructors.Uint8Array {
        constructor(size) { super(size); totals.maskBytes += this.byteLength; totals.peakMaskBytes = Math.max(totals.peakMaskBytes, this.byteLength); }
    };
    globalThis.Uint32Array = class extends constructors.Uint32Array {
        constructor(size) { super(size); totals.queueBytes += this.byteLength; totals.peakQueueBytes = Math.max(totals.peakQueueBytes, this.byteLength); }
    };
    globalThis.Uint8ClampedArray = class extends constructors.Uint8ClampedArray {
        constructor(input) { super(input); totals.pixelCopyBytes += this.byteLength; }
    };
    try {
        run();
        return totals;
    }
    finally {
        Object.assign(globalThis, constructors);
    }
};
{
    const { groupImageParagraphs } = await load('src/features/image-translation/paragraphs.ts');
    const { inpaintTextRegions } = await load('src/features/image-translation/services/inpainting.ts');
    const { layoutImageTranslationText } = await load('src/features/image-translation/services/rendering.ts');
    const report = { label: arg('label', 'candidate'), scope: 'Node pure algorithm stages, no OCR/network/encoding',
        environment: {node: process.version, platform: process.platform, arch: process.arch}, warmups: 2, samples: 7, cases: [] };
    const sourceLine = (text, x, y, width = 200) => ({ text, bbox: { x0: x, y0: y, x1: x + width, y1: y + 12 } });
    const paragraphs = {
        bambu: JSON.parse(readFileSync(resolve(root, 'tests/fixtures/image-translation/bambu-ocr-lines.json'))),
        labels1000: Array.from({ length: 1000 }, (_, i) => sourceLine(`Label ${i}`, (i % 4) * 400, Math.floor(i / 4) * 30)),
        continuous500: Array.from({ length: 500 }, (_, i) => sourceLine(`Sentence ${i}`, 0, i * 14)),
    };
    for (const [name, lines] of Object.entries(paragraphs)) {
        const { output, ...timing } = measure(() => groupImageParagraphs(lines));
        report.cases.push({ stage: 'paragraphs', name, ...timing, regions: output.length, digest: digest(Buffer.from(JSON.stringify(output))) });
    }
    for (const [name, w, h, boxes] of [
        ['sparse-4mp', 2048, 2048, Array.from({ length: 32 }, (_, i) => sourceLine('Text', (i % 4) * 480 + 100, Math.floor(i / 4) * 240 + 100, 160))],
        ['large-region', 800, 800, [{ text: 'Text', bbox: { x0: 150, y0: 150, x1: 650, y1: 650 } }]],
    ]) {
        const source = new Uint8ClampedArray(w * h * 4);
        for (let p = 0; p < source.length; p += 4)
            source.set([180, 200, 220, 255], p);
        for (const { bbox: b } of boxes)
            for (let y = b.y0; y < b.y1; y++)
                for (let x = b.x0; x < b.x1; x++)
                    source.set([0, 0, 0, 255], (y * w + x) * 4);
        for (const inPlace of [false, true]) {
            const run = owned => {
                const result = inpaintTextRegions(owned, w, h, boxes, inPlace);
                if (inPlace && result !== owned)
                    owned.set(result);
                return result;
            };
            const { output, ...timing } = measure(run, () => new Uint8ClampedArray(source));
            const owned = new Uint8ClampedArray(source);
            const allocated = allocations(() => run(owned));
            report.cases.push({ stage: 'inpainting', name, inPlace, ...timing, allocated, digest: digest(output) });
        }
    }
    for (const [name, text] of [
        ['english', 'Translate each complete paragraph and keep the original reading order. '.repeat(30)],
        ['mixed', '完整译文保留全部文字 FluentRead helps you read. '.repeat(30)],
        ['long-token', 'e\u0301'.repeat(600) + '👨‍👩‍👧‍👦'.repeat(50)],
    ]) {
        let calls = 0;
        const { output, ...timing } = measure(() => {
            calls = 0;
            return layoutImageTranslationText(text, 200, 100, (value, size) => { calls++; return Array.from(value).length * size * .55; }, 16);
        });
        report.cases.push({ stage: 'layout', name, ...timing, measureCalls: calls, digest: digest(Buffer.from(JSON.stringify(output))) });
    }
    const baselineReport = arg('baseline-report', null);
    if (baselineReport) {
        const baseline = JSON.parse(readFileSync(resolve(baselineReport), 'utf8'));
        assert.equal(report.cases.length, baseline.cases.length, '基线样本数不一致');
        for (const [index, sample] of report.cases.entries()) {
            const previous = baseline.cases[index];
            assert.deepEqual([sample.stage, sample.name, sample.inPlace], [previous.stage, previous.name, previous.inPlace], '基线样本不一致');
            assert.equal(sample.digest, previous.digest, `${sample.stage}/${sample.name} 输出与基线不同`);
        }
        report.baseline = {label: baseline.label, outputsEqual: true};
    }
    const output = arg('output', null);
    if (output)
        writeFileSync(resolve(output), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
}
