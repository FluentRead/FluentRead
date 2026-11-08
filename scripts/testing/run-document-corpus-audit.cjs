#!/usr/bin/env node
'use strict';

/**
 * @file scripts/testing/run-document-corpus-audit.cjs
 * 文件职责：对显式列出的公开 PDF 页运行生产解析算法并记录内容保全、栏顺序和原图覆盖证据。
 * 主要内容：校验文件 SHA256；按 manifest 的实际源页号依次通过 PDF.js、pdfTextAtoms、analyzePdfPageLayout、pdfPageSegments 与 buildPdfReadingPlan；逐字形核对解析保全、逐块核对阅读计划保全，并保存每页几何快照、跨页尾首样本、内存和耗时。失败写入报告并以非零码退出，不能因局部失败丢失其他页证据。
 * 模块边界：只读公开来源 PDF，不联网、不翻译、不生成 PDF、不启动浏览器；原图覆盖只证明几何，视觉、语义、复制与导出仍需独立验收。必须由 resource-safe runner 调用且明确传入 manifest、input-dir、output；无全库默认范围。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {pathToFileURL} = require('node:url');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const right = rect => rect.x + rect.width;
const bottom = rect => rect.y + rect.height;
const contains = (outer, inner, slack = 1) => inner.x >= outer.x - slack && inner.y >= outer.y - slack
  && right(inner) <= right(outer) + slack && bottom(inner) <= bottom(outer) + slack;
const sameRun = (a, b) => a.text === b.text && Math.abs(a.x - b.x) < .1 && Math.abs(a.y - b.y) < .1;
const arg = name => {const at = process.argv.indexOf(`--${name}`); if (at < 0 || !process.argv[at + 1] || process.argv[at + 1].startsWith('--')) throw new Error(`Missing --${name}`); return path.resolve(process.argv[at + 1]);};
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

async function main() {
  const manifestPath = arg('manifest'), inputDir = arg('input-dir'), output = arg('output');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.documents) || !manifest.documents.length) throw new Error('Manifest needs explicit documents');
  fs.mkdirSync(output, {recursive: true});
  const repository = path.resolve(__dirname, '../..');
  const {createServer} = await import('vite');
  const hmrServer = require('node:http').createServer();
  const server = await createServer({root: repository, configFile: path.join(__dirname, 'pdfjs-reader-audit.config.ts'), server: {middlewareMode: true, hmr: {server: hmrServer}},
    resolve: {alias: {'@': repository}}, optimizeDeps: {noDiscovery: true}});
  const report = {schema: 1, generatedAt: new Date().toISOString(), node: process.version,
    manifestSha256: sha(fs.readFileSync(manifestPath)), pipeline: ['PDF.js', 'pdfTextAtoms', 'analyzePdfPageLayout', 'pdfPageSegments', 'buildPdfReadingPlan'],
    sourceHashes: Object.fromEntries(['services/binary.ts', 'core/pdfLayoutAnalysis.ts', 'core/pdfReadingPlan.ts', 'core/pdfReadingRegions.ts', 'core/pdfContinuations.ts']
      .map(file => [file, sha(fs.readFileSync(path.join(repository, 'src/features/document-translation', file)))])),
    limits: ['Selected source pages only; unselected pages are explicitly listed as untested', 'Geometry coverage is not visual or semantic acceptance',
      'Source reading plus explicitly configured placeholder-translation placement checks; no supplier, semantic translation, export, clipboard, browser or cancellation acceptance'], documents: [], failures: []};
  try {
    const binary = await server.ssrLoadModule('/src/features/document-translation/services/binary.ts');
    const layout = await server.ssrLoadModule('/src/features/document-translation/core/pdfLayoutAnalysis.ts');
    const reading = await server.ssrLoadModule('/src/features/document-translation/core/pdfReadingPlan.ts');
    const continuations = await server.ssrLoadModule('/src/features/document-translation/core/pdfContinuations.ts');
    const pdfjs = await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
    const pdfRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
    for (const source of manifest.documents) {
      if (!/^[\w.-]+$/u.test(source.id) || path.basename(source.file) !== source.file || !Array.isArray(source.pages) || !source.pages.length
          || source.pages.some(page => !Number.isSafeInteger(page) || page < 1) || new Set(source.pages).size !== source.pages.length) throw new Error(`Invalid source selection: ${source.id}`);
      const bytes = fs.readFileSync(path.join(inputDir, source.file));
      if (sha(bytes) !== source.sha256) throw new Error(`Source SHA mismatch: ${source.id}`);
      const task = pdfjs.getDocument({data: new Uint8Array(bytes), disableFontFace: true, isEvalSupported: false, useWorkerFetch: false,
        cMapUrl: `${pdfRoot}/cmaps/`, cMapPacked: true, standardFontDataUrl: `${pdfRoot}/standard_fonts/`});
      const sourceDir = path.join(output, source.id); fs.mkdirSync(sourceDir, {recursive: true});
      const result = {id: source.id, category: source.category, file: source.file, sourceUrl: source.sourceUrl, sha256: source.sha256,
        bytes: bytes.length, totalPages: 0, testedPages: [...source.pages].sort((a, b) => a - b), untestedPageCount: 0, pages: [], boundaries: [], failures: []};
      report.documents.push(result);
      const started = performance.now(), segments = [], parsedPages = [];
      try {
        const pdf = await task.promise; result.totalPages = pdf.numPages; result.untestedPageCount = pdf.numPages - source.pages.length;
        if (source.pages.some(page => page > pdf.numPages)) throw new Error('Source page is out of range');
        for (const pageNumber of result.testedPages) {
          const pageStarted = performance.now(), page = await pdf.getPage(pageNumber);
          try {
            const display = page.getViewport({scale: 1}), content = await page.getTextContent(), operators = await page.getOperatorList();
            const items = content.items.filter(item => 'str' in item);
            const {viewport, atoms, ...orientation} = binary.pdfPageTextGeometry(items, content.styles, display, display.rotation ? page.getViewport({scale: 1, rotation: 0}) : display);
            const graphics = layout.extractPdfGraphicsShapes(operators, pdfjs.OPS, viewport);
            const analyzed = layout.analyzePdfPageLayout({atoms, graphics, width: viewport.width, height: viewport.height});
            const {blocks, segmentIndexes} = binary.pdfPageSegments(analyzed.blocks, pageNumber, segments);
            const parsedPage = {pageNumber, width: display.width, height: display.height, ...orientation, blocks, segmentIndexes, preservedRegions: analyzed.preservedRegions,
              layoutBoundaries: graphics.filter(shape => shape.kind === 'path' && (shape.width >= 12 && shape.height <= 5 || shape.height >= 12 && shape.width <= 5))};
            parsedPages.push(parsedPage);
            const document = {fileName: source.file, format: 'pdf', label: 'PDF', parts: [], segments};
            const plan = reading.buildPdfReadingPlan(document, parsedPage, []), regions = plan.entries.filter(entry => entry.kind === 'region');
            const runs = blocks.flatMap(block => (block.lines ?? []).flatMap(line => line.runs ?? []));
            const markerAtoms = atoms.filter(atom => /^[•◦▪■□◆◇●○▶►➢➤❖·§Ø\uE000-\uF8FFnlupqvw]$/u.test(atom.text) && blocks.some(block => block.listMarker && atom.x < block.x && block.x - right(atom) <= atom.fontSize * 2
              && atom.y < block.y + block.height && bottom(atom) > block.y && plan.entries.some(entry => entry.kind === 'text'
                && entry.segmentIndex === block.segmentIndex && entry.text.startsWith(`${block.listMarker} `))));
            const missingAtoms = atoms.filter(atom => !runs.some(run => sameRun(atom, run)) && !regions.some(region => contains(region.sourceRect, atom)) && !markerAtoms.includes(atom));
            const missingBlocks = blocks.filter(block => {
              const text = plan.entries.find(entry => entry.kind === 'text' && (block.segmentIndex >= 0 ? entry.segmentIndex === block.segmentIndex
                : entry.sourceRect.x === block.x && entry.sourceRect.y === block.y && entry.sourceRect.width === block.width && entry.sourceRect.height === block.height));
              return !text && !regions.some(region => contains(region.sourceRect, block));
            });
            const sourceTextMismatches = blocks.flatMap(block => {
              const entry = plan.entries.find(entry => entry.kind === 'text' && (block.segmentIndex >= 0 ? entry.segmentIndex === block.segmentIndex
                : entry.sourceRect.x === block.x && entry.sourceRect.y === block.y && entry.sourceRect.width === block.width && entry.sourceRect.height === block.height));
              const sourceText = document.segments[block.segmentIndex]?.source ?? block.source ?? '';
              return entry && (entry.source !== sourceText || entry.text !== `${block.listMarker ? `${block.listMarker} ` : ''}${sourceText}`.replace(/\u00AD/gu, ''))
                ? [{segmentIndex: block.segmentIndex, id: entry.id}] : [];
            });
            const orderChecks = (source.orderChecks ?? []).filter(check => check.pageNumber === pageNumber).map(check => {
              const positions = check.prefixes.map(prefix => blocks.findIndex(block => block.source.startsWith(prefix)));
              return {name: check.name, positions, passed: positions.every((value, index) => value >= 0 && (!index || value > positions[index - 1]))};
            });
            const contentChecks = (source.contentChecks ?? []).filter(check => check.pageNumber === pageNumber).map(check => {
              const block = blocks.find(block => block.source.startsWith(check.prefix));
              return {prefix: check.prefix, passed: !!block && block.kind === check.kind && (block.segmentIndex >= 0) === check.translatable};
            });
            const listChecks = (source.listChecks ?? []).filter(check => check.pageNumber === pageNumber).map(check => ({name: check.name,
              passed: check.prefixes.every(prefix => blocks.some(block => block.source.startsWith(prefix) && block.listMarker === check.marker))}));
            // 固定占位译文只检查原表图与其译文的插入关系，不能作为供应商或翻译语义验收。
            const configuredPlacement = (source.controlledPlacementChecks ?? []).filter(check => check.pageNumber === pageNumber);
            const controlledPlan = configuredPlacement.length ? reading.buildPdfReadingPlan(document, parsedPage,
              segments.map((_, index) => `受控占位译文 ${index}`)) : undefined;
            const controlledPlacementChecks = configuredPlacement.map(check => {
              const matching = controlledPlan.entries.filter(entry => entry.kind === 'region' && entry.role === check.regionKind);
              const regions = matching.map(region => {
                const at = controlledPlan.entries.indexOf(region);
                const linkedPositions = region.segmentIndexes.map(index => controlledPlan.entries.findIndex(entry => entry.kind === 'text' && entry.translated && entry.segmentIndex === index));
                return {id: region.id, position: at, linkedPositions, passed: linkedPositions.length > 0 && linkedPositions.every(position => position > at)};
              });
              return {name: check.name, regions, passed: regions.length > 0 && regions.every(region => region.passed)};
            });
            const textEntries = plan.entries.filter(entry => entry.kind === 'text');
            const blockOrder = new Map(blocks.filter(block => block.segmentIndex >= 0).map(block => [block.segmentIndex, block.readingOrder]));
            const orders = textEntries.filter(entry => entry.segmentIndex >= 0).map(entry => blockOrder.get(entry.segmentIndex));
            const textOrderStable = orders.every((order, index) => index === 0 || order >= orders[index - 1]);
            const uniqueEntryIds = new Set(plan.entries.map(entry => entry.id)).size === plan.entries.length;
            const invalidLinkedIndexes = regions.flatMap(region => region.segmentIndexes.filter(index => index < 0));
            const orientationDroppedAllText = items.some(item => item.str.trim()) && atoms.length === 0;
            const row = {pageNumber, ...orientation, rawTextItems: items.filter(item => item.str.trim()).length, atoms: atoms.length, retainedListMarkers: markerAtoms.length,
              rawTextCharacters: items.reduce((sum, item) => sum + item.str.length, 0), atomCharacters: atoms.reduce((sum, atom) => sum + atom.text.length, 0),
              blocks: blocks.length, translatable: segmentIndexes.length, textEntries: textEntries.length, preservedRegions: regions.length,
              columns: [...new Set(blocks.map(block => block.column))], kinds: blocks.reduce((counts, block) => ({...counts, [block.kind]: (counts[block.kind] ?? 0) + 1}), {}),
              missingAtoms: missingAtoms.map(atom => ({text: atom.text.slice(0, 80), x: atom.x, y: atom.y})),
              missingBlocks: missingBlocks.map(block => ({source: block.source?.slice(0, 80), kind: block.kind, segmentIndex: block.segmentIndex, x: block.x, y: block.y})),
              sourceTextMismatches, orderChecks, contentChecks, listChecks, controlledPlacementChecks, textOrderStable, uniqueEntryIds, invalidLinkedIndexes, orientationDroppedAllText, durationMs: Math.round(performance.now() - pageStarted), rssBytes: process.memoryUsage().rss};
            result.pages.push(row);
            if (missingAtoms.length || missingBlocks.length || sourceTextMismatches.length || orderChecks.some(check => !check.passed) || contentChecks.some(check => !check.passed) || listChecks.some(check => !check.passed)
              || controlledPlacementChecks.some(check => !check.passed) || !textOrderStable || !uniqueEntryIds || invalidLinkedIndexes.length || orientationDroppedAllText) result.failures.push({pageNumber, missingAtoms: missingAtoms.length, missingBlocks: missingBlocks.length, sourceTextMismatches, orderChecks, contentChecks, listChecks, controlledPlacementChecks, textOrderStable, uniqueEntryIds, invalidLinkedIndexes, orientationDroppedAllText});
            save(path.join(sourceDir, `page-${pageNumber}.json`), {pageNumber, width: display.width, height: display.height, ...orientation, sourceItems: items, atoms, graphics, blocks, segmentIndexes, preservedRegions: analyzed.preservedRegions, plan, controlledPlan});
            const previous = result.pages.at(-2);
            if (previous && previous.pageNumber + 1 === pageNumber) {
              const previousSnapshot = JSON.parse(fs.readFileSync(path.join(sourceDir, `page-${previous.pageNumber}.json`), 'utf8'));
              const prose = entries => entries.filter(entry => entry.kind === 'text' && !['metadata', 'footer', 'heading', 'caption'].includes(entry.role));
              const before = prose(previousSnapshot.plan.entries).at(-1)?.text ?? '', after = prose(plan.entries)[0]?.text ?? '';
              result.boundaries.push({from: previous.pageNumber, to: pageNumber, previousTail: before.slice(-100), nextHead: after.slice(0, 100),
                continuationCandidate: !/[.!?。！？]["')\]]?$/u.test(before) && /^\p{Ll}/u.test(after),
                sourcePagesRetained: !missingAtoms.length && !missingBlocks.length && !previous.missingAtoms.length && !previous.missingBlocks.length && !orientationDroppedAllText && !previous.orientationDroppedAllText,
                semanticJoinTested: false});
            }
            console.log(`${source.id} page ${pageNumber}: ${atoms.length} atoms, ${missingAtoms.length} missing atoms, ${missingBlocks.length} missing blocks`);
          } catch (error) {result.failures.push({pageNumber, error: String(error)});} finally {page.cleanup();}
          save(path.join(output, 'report.json'), report);
        }
      } catch (error) {result.failures.push({error: String(error)});} finally {await task.destroy();}
      result.durationMs = Math.round(performance.now() - started);
      result.continuations = continuations.findPdfContinuations({fileName: source.file, format: 'pdf', label: 'PDF', parts: [], segments,
        binary: {kind: 'pdf', bytes: new Uint8Array(), pages: parsedPages}});
      result.continuationChecks = (source.continuationChecks ?? []).map(check => ({...check, passed: result.continuations.some(entry => entry.from.pageNumber === check.from && entry.to.pageNumber === check.to && entry.kind === check.kind)}));
      result.failures.push(...result.continuationChecks.filter(check => !check.passed).map(check => ({continuationCheck: check})));
      result.peakSampledRssBytes = Math.max(0, ...result.pages.map(page => page.rssBytes));
      report.failures.push(...result.failures.map(failure => ({id: source.id, ...failure})));
      save(path.join(output, 'report.json'), report);
    }
  } finally {await server.close();}
  report.passed = report.failures.length === 0;
  save(path.join(output, 'report.json'), report);
  if (!report.passed) process.exitCode = 1;
}

main().catch(error => {console.error(error); process.exitCode = 1;});
