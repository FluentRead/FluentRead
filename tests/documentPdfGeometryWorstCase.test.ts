import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseDocumentFile, pdfTextAtoms, pdfTextBlocks, pdfTextLines, type PdfTextAtom, type PdfTextLine} from '@/src/features/document-translation/services/binary';

const pdfPort = vi.hoisted(() => ({getDocument: vi.fn()}));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({GlobalWorkerOptions: {}, getDocument: pdfPort.getDocument}));
afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals(); pdfPort.getDocument.mockReset();});

const line = (text: string, x = 20, y = 0, height = 12, width = 80): PdfTextLine => ({text, x, y, height, width, fontFamily: 'sans-serif'});
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function counted(lines: PdfTextLine[]) {
    const reads = {x: 0, y: 0, width: 0, height: 0};
    const values = lines.map(value => new Proxy(value, {get(target, key, receiver) {
        if (key === 'x' || key === 'y' || key === 'width' || key === 'height') reads[key] += 1;
        return Reflect.get(target, key, receiver);
    }}));
    return {values, reads};
}

// The child transpiles the whole actual source. These require ports only bind unrelated imports;
// no grouping implementation is copied. The marker is emitted after loading, before any measured call.
function worstCaseChild(kind: string) {
    const sourcePath = process.env.FLUENTREAD_PDF_BINARY_SOURCE ?? fileURLToPath(new URL('../src/features/document-translation/services/binary.ts', import.meta.url));
    const typescriptPath = createRequire(import.meta.url).resolve('typescript');
    const program = `
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), ts = require(${JSON.stringify(typescriptPath)});
const sourcePath = ${JSON.stringify(sourcePath)};
const source = fs.readFileSync(sourcePath, 'utf8');
const moduleCache = new Map();
function loadLocalTs(filePath) {
    const resolved = path.resolve(filePath);
    if (moduleCache.has(resolved)) return moduleCache.get(resolved);
    const modExports = {};
    moduleCache.set(resolved, modExports);
    const code = fs.readFileSync(resolved, 'utf8');
    const localRequire = (specifier) => {
        if (specifier.startsWith('.')) {
            const candidate = path.resolve(path.dirname(resolved), specifier.endsWith('.ts') ? specifier : specifier + '.ts');
            if (fs.existsSync(candidate)) return loadLocalTs(candidate);
        }
        return {};
    };
    new Function('require', 'exports', ts.transpileModule(code, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText)(localRequire, modExports);
    return modExports;
}
const exportsPort = loadLocalTs(sourcePath);
console.log('loaded-before-call:' + JSON.stringify({sha256: crypto.createHash('sha256').update(source).digest('hex'), publicFunctions: ['pdfTextBlocks','pdfTextLines','pdfTextAtoms'].map(name => [name, typeof exportsPort[name]])}));
const kind = ${JSON.stringify(kind)};
const hugeRow = kind === 'huge-row', hugeBlock = kind === 'huge-block';
const count = hugeRow || hugeBlock ? 160000 : 20000;
const sameY = kind.startsWith('same-y');
const plain = Array.from({length: count}, (_, i) => ({text: hugeRow || hugeBlock ? 'x' : '段落 ' + i, x: hugeRow ? i / 1000 : sameY ? i * 100 : 20, y: hugeRow || sameY ? 0 : hugeBlock ? i * 12 : i * 100, width: hugeRow ? .001 : 80, height: kind === 'same-y-small-font' ? 1 : 12, fontFamily: 'sans-serif'}));
const reads = {x:0,y:0,width:0,height:0};
const values = plain.map(value => new Proxy(value, {get(target,key,receiver) {if (Object.hasOwn(reads,key)) reads[key]++; return Reflect.get(target,key,receiver);}}));
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const started = performance.now();
let blocks;
try {blocks = hugeRow ? exportsPort.pdfTextLines(values,500) : exportsPort.pdfTextBlocks(values, sameY ? count * 100 : 500);}
catch(error) {console.log('call-error:' + JSON.stringify({name:error.name,message:error.message}));process.exit(1);}
const getterHostMs = performance.now() - started;
const nativeStarted = performance.now();
const native = hugeRow ? exportsPort.pdfTextLines(plain,500) : exportsPort.pdfTextBlocks(plain, sameY ? count * 100 : 500);
console.log('result:' + JSON.stringify({kind,count,inputHash:hash(plain),outputHash:hash(blocks),nativeOutputHash:hash(native),blocks:blocks.length,first:hugeRow || hugeBlock ? undefined : blocks[0].source,last:hugeRow || hugeBlock ? undefined : blocks.at(-1).source,textLength:(hugeRow?blocks[0].text:blocks[0].source).length,lineCount:hugeBlock?blocks[0].lineCount:undefined,fullText:hugeRow ? blocks[0].text === 'x'.repeat(count) : hugeBlock ? blocks[0].source === Array(count).fill('x').join(' ') : undefined,reads,limit:count*60,getterHostMs,nativeHostMs:performance.now()-nativeStarted}));
`;
    const result = spawnSync(process.execPath, ['-e', program], {encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024});
    console.info('pdfGeometry-child:' + JSON.stringify({kind, status: result.status, signal: result.signal, error: result.error?.message, stdout: result.stdout, stderr: result.stderr}));
    expect(result.stdout).toContain('loaded-before-call:');
    const marker = JSON.parse(result.stdout.split('\n').find(value => value.startsWith('loaded-before-call:'))!.slice('loaded-before-call:'.length));
    expect(marker.publicFunctions.every(([, type]: string[]) => type === 'function')).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout.split('\n').find(value => value.startsWith('result:'))!.slice('result:'.length));
    if (kind === 'huge-row' || kind === 'huge-block') {
        expect(output.blocks).toBe(1);
        expect(output.fullText).toBe(true);
        expect(output.textLength).toBe(kind === 'huge-row' ? output.count : output.count * 2 - 1);
        if (kind === 'huge-block') expect(output.lineCount).toBe(output.count);
    } else {
        expect(output.blocks).toBe(output.count);
        expect(output.first).toBe('段落 0');
        expect(output.last).toBe(`段落 ${output.count - 1}`);
    }
    expect(output.outputHash).toBe(output.nativeOutputHash);
    expect(Object.values(output.reads).reduce((sum: number, value) => sum + Number(value), 0)).toBeLessThan(output.limit);
}

describe('PDF paragraph geometry worst cases through actual public functions', () => {
    it.each([500, 1000, 2000])('retains every separated paragraph with bounded per-property reads at %i lines', count => {
        let treeReads = 0;
        class CountedTreeArray extends Uint32Array {
            constructor(length: number) {
                super(length);
                return new Proxy(this, {get(target, key) {
                    if (typeof key === 'string' && /^\d+$/u.test(key)) treeReads += 1;
                    return Reflect.get(target, key, target);
                }});
            }
        }
        vi.stubGlobal('Uint32Array', CountedTreeArray);
        const plain = Array.from({length: count}, (_, index) => line(`独立段 ${index}`, 20, index * 100));
        const {values, reads} = counted(plain);
        const blocks = pdfTextBlocks(values, 500);
        const indexReads = treeReads;
        const indexReadLimit = count * (4 * Math.ceil(Math.log2(count)) + 4);
        expect(blocks.map(block => block.source)).toEqual(plain.map(value => value.text));
        expect(blocks.every(block => block.lineCount === 1)).toBe(true);
        console.info('pdfGeometry-separated:' + JSON.stringify({count, inputHash: digest(plain), outputHash: digest(blocks), reads, indexReads, indexReadLimit, limit: count * 60}));
        expect(indexReads).toBeLessThan(indexReadLimit);
        expect(Object.values(reads).reduce((sum, value) => sum + value, 0)).toBeLessThan(count * 60);
        expect(reads.height).toBeLessThan(count * 12);
    });

    it.each(['separated', 'same-y', 'same-y-small-font'])('finishes large %s layouts in a loaded-before-call, timeout-bounded isolated process', kind => worstCaseChild(kind), 20_000);

    it.each(['huge-row', 'huge-block'])('retains all 160000 fragments in %s without exceeding function arity', kind => worstCaseChild(kind), 20_000);

    it.each([
        {label: 'signed zeros', coordinates: [{x: 0, y: 0, width: 0, height: 0}, {x: -0, y: -0, width: -0, height: -0}]},
        {label: 'NaN coordinates', coordinates: [{x: NaN, y: 0, width: 5, height: 12}, {x: 1, y: NaN, width: 5, height: 12}]},
        {label: 'infinite horizontal bounds', coordinates: [{x: -Infinity, y: 0, width: 5, height: 12}, {x: Infinity, y: 0, width: 5, height: 12}]},
        {label: 'infinite height bounds', coordinates: [{x: 0, y: 0, width: 5, height: -Infinity}, {x: 5, y: 0, width: 5, height: Infinity}]},
    ])('retains Math min/max semantics for $label in public line bounds', ({coordinates}) => {
        const atoms: PdfTextAtom[] = coordinates.map((geometry, index) => ({...geometry, text: index === 0 ? 'A' : 'B', fontFamily: 'sans-serif'}));
        const rows = pdfTextLines(atoms, Infinity);
        expect(rows).toHaveLength(1);
        expect(rows[0].text.replace(/\s/gu, '')).toBe('AB');
        const x = Math.min(...coordinates.map(value => value.x));
        const y = Math.min(...coordinates.map(value => value.y));
        const right = Math.max(...coordinates.map(value => value.x + value.width));
        const bottom = Math.max(...coordinates.map(value => value.y + value.height));
        expect(Object.is(rows[0].x, x)).toBe(true);
        expect(Object.is(rows[0].y, y)).toBe(true);
        expect(Object.is(rows[0].width, Math.max(1, right - x))).toBe(true);
        expect(Object.is(rows[0].height, Math.max(1, bottom - y))).toBe(true);
    });

    it('retains NaN, negative zero and Infinity in paragraph font maximum reduction', () => {
        for (const height of [NaN, -0, Infinity]) {
            const blocks = pdfTextBlocks([line('value', 0, 0, height)], 500);
            expect(blocks).toHaveLength(1);
            expect(Object.is(blocks[0].fontSize, Math.max(height))).toBe(true);
        }
    });

    it('revisits an old paragraph after distant rows without sorting the supplied array', () => {
        const input = [line('old'), line('far', 20, 1000), line('return', 20, 14), line('next', 20, 28)];
        const before = digest(input);
        const blocks = pdfTextBlocks(input, 500);
        expect(blocks.map(block => block.source)).toEqual(['old return next', 'far']);
        expect(blocks[0]).toMatchObject({lineCount: 3, y: 0, height: 40});
        expect(digest(input)).toBe(before);
    });

    it('keeps creation-order ties after a paragraph changes its bottom', () => {
        const blocks = pdfTextBlocks([line('A', 0, 0, 12, 100), line('B', 110, 10, 12, 100), line('C', 0, 10, 12, 100), line('D', 40, 24, 12, 120)], 500);
        expect(blocks.map(block => block.source)).toEqual(['A C D', 'B']);
        expect(blocks[0]).toMatchObject({lineCount: 3, width: 160, height: 36});
    });

    it('chooses the first-created equal-gap paragraph even when the spatial tree visits it second', () => {
        const blocks = pdfTextBlocks([line('A', 0, 12, 12, 100), line('B', 110, 0, 12, 100), line('C', 110, 12, 12, 100), line('D', 40, 26, 12, 120)], 500);
        expect(blocks.map(block => block.source)).toEqual(['B C', 'A D']);
        expect(blocks[1]).toMatchObject({lineCount: 2, width: 160, height: 26});
    });

    it('retains multiple columns, changing heights, headings, centering and Unicode hyphen joining', () => {
        const input = [line('标题 中文', 190, 0, 24, 120), line('multi-', 20, 50), line('右栏', 300, 50), line('lingual 中文', 20, 65, 13), line('续文', 300, 65, 13), line('结束。', 20, 81), line('新段', 36, 96), line('row', 300, 81)];
        const blocks = pdfTextBlocks(input, 500);
        expect(blocks.map(block => block.source)).toEqual(['标题 中文', 'multilingual 中文 结束。', '右栏 续文 row', '新段']);
        expect(blocks[0]).toMatchObject({fontWeight: 700, textAlign: 'center', lineCount: 1});
        expect(blocks[1]).toMatchObject({fontFamily: 'sans-serif', fontSize: 13, lineHeight: 12, lineCount: 3});
    });

    it.each([
        {label: 'ASCII hyphen', fragments: ['multi-', 'lingual'], source: 'multilingual'},
        {label: 'Unicode hyphen', fragments: ['multi‐', 'lingual'], source: 'multilingual'},
        {label: 'nonbreaking hyphen', fragments: ['multi‑', 'lingual'], source: 'multilingual'},
        {label: 'initial empty fragments', fragments: ['', '', 'multi-', 'lingual'], source: 'multilingual'},
        {label: 'intervening empty fragment', fragments: ['multi-', '', 'lingual'], source: 'multi- lingual'},
        {label: 'trailing empty fragments', fragments: ['multi-', 'lingual', '', ''], source: 'multilingual'},
        {label: 'uppercase continuation', fragments: ['multi-', 'Lingual'], source: 'multi- Lingual'},
        {label: 'Unicode continuation', fragments: ['multi-', '中文'], source: 'multi- 中文'},
        {label: 'newline following hyphen', fragments: ['multi-\n', 'lingual'], source: 'multi- lingual'},
        {label: 'newline preceding continuation', fragments: ['multi-', '\nlingual'], source: 'multi- lingual'},
        {label: 'Unicode line separator following hyphen', fragments: ['multi-\u2028', 'lingual'], source: 'multi- lingual'},
        {label: 'empty paragraph', fragments: ['', '', ''], source: undefined},
    ])('preserves $label when assembling a paragraph from fragments', ({fragments, source}) => {
        const blocks = pdfTextBlocks(fragments.map((text, index) => line(text, 20, index * 12)), 500);
        expect(blocks.map(block => block.source)).toEqual(source === undefined ? [] : [source]);
        if (source !== undefined) expect(blocks[0].lineCount).toBe(fragments.length);
    });

    it.each([
        {label: 'exact negative gap', x: 0, y: 8, height: 10, width: 100, merged: true},
        {label: 'below negative gap', x: 0, y: 8 - Number.EPSILON * 8, height: 10, width: 100, merged: false},
        {label: 'exact positive gap', x: 0, y: 19.5, height: 10, width: 100, merged: true},
        {label: 'above positive gap', x: 0, y: 19.5 + Number.EPSILON * 32, height: 10, width: 100, merged: false},
        {label: 'exact overlap ratio', x: 52, y: 12, height: 10, width: 100, merged: true},
        {label: 'below overlap ratio', x: 52.01, y: 12, height: 10, width: 100, merged: false},
        {label: 'font ratio mismatch', x: 0, y: 12, height: 7, width: 100, merged: false},
    ])('preserves $label boundary decisions', ({x, y, height, width, merged}) => {
        const blocks = pdfTextBlocks([line('first', 0, 0, 10, 100), line('second', x, y, height, width)], 500);
        expect(blocks.map(block => block.source)).toEqual(merged ? ['first second'] : ['first', 'second']);
    });

    it('retains accumulated bottom and bounds when an overlapping shorter line does not extend them', () => {
        const blocks = pdfTextBlocks([line('first', 20, 0, 12), line('overlap', 20, 10, 10), line('continued', 20, 22, 12)], 500);
        expect(blocks).toHaveLength(1);
        expect(blocks[0]).toMatchObject({source: 'first overlap continued', height: 34, lineCount: 3});
    });

    it('preserves sentence-gap and indent paragraph starts while allowing aligned ordinary continuation', () => {
        expect(pdfTextBlocks([line('Done.'), line('new', 20, 22)], 500).map(block => block.source)).toEqual(['Done.', 'new']);
        expect(pdfTextBlocks([line('Done.'), line('new', 32, 14)], 500).map(block => block.source)).toEqual(['Done.', 'new']);
        expect(pdfTextBlocks([line('ordinary'), line('continuation', 32, 14)], 500).map(block => block.source)).toEqual(['ordinary continuation']);
    });

    it('keeps nonfinite public geometry compatible through the complete fallback traversal', () => {
        expect(pdfTextBlocks([line('NaN', 20, NaN), line('finite', 20, 14)], 500).map(block => block.source)).toEqual(['NaN', 'finite']);
        expect(pdfTextBlocks([line('huge', 20, 0, 1e308), line('huge2', 20, 1e308, 1e308)], 500).map(block => block.source)).toEqual(['huge huge2']);
        expect(pdfTextBlocks([line('title', 20, 0, 24), line('NaN', 20, NaN), line('one', 20, 100), line('two', 20, 200), line('three', 20, 300)], 500).map(block => block.source)).toEqual(['title', 'NaN', 'one', 'two', 'three']);
    });

    it('carries real atom normalization and line ordering into paragraph grouping', () => {
        const atoms = pdfTextAtoms([
            {str: '中\u0000文', dir: 'ltr', transform: [1, 0, 0, 12, 20, 59.6], width: 50, height: 12, fontName: 'body', hasEOL: false},
            {str: '，测试', dir: 'ltr', transform: [1, 0, 0, 12, 71, 59.6], width: 50, height: 12, fontName: 'body', hasEOL: true},
            {str: '续文', dir: 'ltr', transform: [1, 0, 0, 12, 20, 73.6], width: 80, height: 12, fontName: 'body', hasEOL: true},
        ], {body: {ascent: 0.8, fontFamily: 'serif'}}, {width: 500, height: 1000, transform: [1, 0, 0, 1, 0, 0]});
        const rows = pdfTextLines(atoms.reverse(), 500);
        expect(rows.map(value => value.text)).toEqual(['中文，测试', '续文']);
        expect(pdfTextBlocks(rows, 500)[0]).toMatchObject({source: '中文，测试 续文', fontFamily: 'serif', lineCount: 2});
    });

    it('matches the frozen bc and initial C outputs on 690 mixed, unsorted and floating-boundary inputs', () => {
        // Expected output hashes were verified against both immutable whole binary modules.
        // This is input generation, not a second implementation of paragraph aggregation.
        let seed = 0x47abcd12;
        const random = () => {seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32;};
        const corpus: Array<{lines: PdfTextLine[]; pageWidth: number}> = [];
        for (let sample = 0; sample < 600; sample += 1) {
            const count = 10 + Math.floor(random() * 100), lines: PdfTextLine[] = [];
            for (let index = 0; index < count; index += 1) {
                const height = [1, 3, 6, 10, 12, 13, 15, 24, 48][Math.floor(random() * 9)];
                const y = sample % 5 === 0 ? 0 : sample % 5 === 1 ? index * 14 : Math.floor(random() * 60) * 4 + random() * 0.5;
                const text = ['正文', 'multi-', 'lingual', 'sentence.', 'small', '空 白', '', '—'][Math.floor(random() * 8)] + (random() > 0.8 ? '.' : '');
                const x = Math.floor(random() * 8) * 60 - 30;
                const width = [0, 10, 50, 80, 100, 130, 300][Math.floor(random() * 7)];
                lines.push({...line(text, x, y, height, width), fontFamily: 'sans'});
            }
            if (sample % 3 === 0) lines.reverse();
            corpus.push({lines, pageWidth: 500});
        }
        for (const scale of [1, 1e-4, 1e5, 1e12, 1e15]) {
            for (const offset of [0, scale * 1000, -scale * 1000]) {
                for (const delta of [-Number.EPSILON * scale * 100, 0, Number.EPSILON * scale * 100]) {
                    const height = 12 * scale, bottom = offset + height;
                    for (const gap of [-Math.max(2, height * 0.2), height * 0.95]) {
                        corpus.push({pageWidth: 500 * scale, lines: [
                            {...line('A', 20 * scale, offset, height, 100 * scale), fontFamily: 'sans'},
                            {...line('B', 72 * scale, bottom + gap + delta, height, 100 * scale), fontFamily: 'sans'},
                        ]});
                    }
                }
            }
        }
        expect(corpus).toHaveLength(690);
        expect(digest(corpus.map(sample => digest(pdfTextBlocks(sample.lines, sample.pageWidth))))).toBe('af47578a13c85b1ddd6e42e44eabcec6f9c47ab0568bf09970fd8a076c727b00');
    });

    it('feeds paragraph/heading identity and exact layout into the actual PDF file parser consumer and releases pages/tasks', async () => {
        const input = [line('Heading', 190, 0, 24, 120), line('Left', 20, 50), line('Right', 300, 50), line('Next', 20, 64), line('续文', 300, 64), line('Distant', 20, 300)];
        const items = input.map(value => ({str: value.text, dir: 'ltr', transform: [1, 0, 0, value.height, value.x, value.y + value.height * 0.8], width: value.width, height: value.height, fontName: 'body', hasEOL: true}));
        const viewport = {width: 500, height: 1000, transform: [1, 0, 0, 1, 0, 0]};
        const cleanup = vi.fn(), destroy = vi.fn(async () => {});
        const getPage = vi.fn(async () => ({getViewport: () => viewport, getTextContent: async () => ({items, styles: {body: {ascent: 0.8, fontFamily: 'sans-serif'}}}), cleanup}));
        pdfPort.getDocument.mockReturnValue({promise: Promise.resolve({numPages: 1, getPage}), destroy});
        const bytes = new TextEncoder().encode('%PDF-controlled-text-layer');
        const signal = new AbortController().signal;
        const document = await parseDocumentFile({name: 'layout.pdf', size: bytes.length, arrayBuffer: async () => bytes.slice().buffer, text: vi.fn()}, {signal});
        expect(document.segments.map(segment => segment.source)).toEqual(['Heading', 'Left Next', 'Distant', 'Right 续文']);
        expect(document.segments.map(segment => segment.role)).toEqual(['heading', 'paragraph', 'paragraph', 'paragraph']);
        expect(document.binary?.kind).toBe('pdf');
        if (document.binary?.kind !== 'pdf') throw new Error('Expected PDF');
        expect(document.binary.pages[0].blocks).toMatchObject([
            {segmentIndex: 0, source: 'Heading', kind: 'heading', x: 190, y: 0, width: 120, height: 24, fontSize: 24, lineCount: 1, textAlign: 'center', readingOrder: 0, column: 0},
            {segmentIndex: 1, source: 'Left Next', kind: 'text', x: 20, y: 50, width: 80, height: 26, fontSize: 12, lineCount: 2, textAlign: 'left', readingOrder: 1, column: 0},
            {segmentIndex: 2, source: 'Distant', kind: 'text', x: 20, y: 300, width: 80, height: 12, fontSize: 12, lineCount: 1, textAlign: 'left', readingOrder: 2, column: 0},
            {segmentIndex: 3, source: 'Right 续文', kind: 'text', x: 300, y: 50, width: 80, height: 26, fontSize: 12, lineCount: 2, textAlign: 'left', readingOrder: 3, column: 1},
        ]);
        expect(document.binary.pages[0].blocks[1].lineHeight).toBeCloseTo(14);
        expect(document.binary.pages[0].segmentIndexes).toEqual([0, 1, 2, 3]);
        expect(document.segments[0].contextLabel).toBe('第 1 页');
        expect(cleanup).toHaveBeenCalledOnce();
        expect(destroy).toHaveBeenCalledOnce();
    });

    it('retains the ordinary text file consumer alongside indexed PDF extraction', async () => {
        const document = await parseDocumentFile({name: 'note.txt', text: async () => 'Ordinary text', arrayBuffer: vi.fn()}, {signal: new AbortController().signal});
        expect(document.segments.map(segment => segment.source)).toEqual(['Ordinary text']);
        expect(document.format).toBe('txt');
    });
});
