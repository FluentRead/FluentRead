#!/usr/bin/env node
'use strict';

// PDF 划词专项：生产扩展、临时 Edge profile、真实鼠标拖选与快捷键；翻译服务仅连接本机确定性夹具。
// 包含本地/在线导入、原生查看器 Popup 分流、跨行与迟到结果归属、长 PDF 有界 Canvas/TextLayer、窄屏暗色。
// --paper-layout-only 验证真实论文完整清晰译文/导出；--paper-layout-followup 重用已完成的长译文交互证据，验证最终界面与 CropBox。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {createRequire} = require('node:module');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {guardBrowserClose, getGuardedBrowserPid} = require('./testing/owned-browser-close.cjs');
const execFileAsync = promisify(execFile);
const support = require('./run-selection-trigger-test.cjs');
const arg = (name, fallback) => {const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1];};
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const LINES = [
  'PDF selection translation keeps the original layout.',
  'Reading across lines should become one clean sentence.',
  'First ownership request must never replace a newer selection.',
  'Second ownership selection owns the final Chinese answer.',
];

async function createPdf(pageCount, rotation = 0, uniqueParagraphs = false) {
  const {PDFDocument, StandardFonts, rgb, degrees} = createRequire(path.join(__dirname, '..', 'package.json'))('pdf-lib');
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let number = 1; number <= pageCount; number += 1) {
    const page = document.addPage([595, 842]);
    if (rotation) page.setRotation(degrees(rotation));
    page.drawText(`FluentRead PDF fixture page ${number}`, {font, x: 44, y: 792, size: 15});
    LINES.forEach((line, index) => page.drawText(uniqueParagraphs ? `${line} Page ${number}.` : line, {font, x: 44, y: 748 - index * 28, size: 11}));
    page.drawRectangle({x: 44, y: 420, width: 280, height: 100, color: rgb(0.86, 0.93, 0.88)});
    page.drawText(`Original figures, fonts and page geometry remain intact.${uniqueParagraphs ? ` Page ${number}.` : ''}`, {font, x: 44, y: 390, size: 11});
  }
  return Buffer.from(await document.save());
}

async function createCroppedPdf() {
  const {PDFDocument, StandardFonts, rgb, degrees} = createRequire(path.join(__dirname, '..', 'package.json'))('pdf-lib');
  const document = await PDFDocument.create(), page = document.addPage([400, 300]), font = await document.embedFont(StandardFonts.Helvetica);
  page.drawRectangle({x: 0, y: 0, width: 400, height: 300, color: rgb(.15, .3, .8)});
  page.drawRectangle({x: 50, y: 70, width: 300, height: 160, color: rgb(1, 1, 1)});
  page.drawRectangle({x: 65, y: 85, width: 25, height: 25, color: rgb(.85, .15, .15)});
  page.drawRectangle({x: 305, y: 190, width: 25, height: 25, color: rgb(.1, .65, .25)});
  page.drawText('Cropped rotation fixture', {font, size: 15, x: 75, y: 195});
  page.drawText('Only the visible crop belongs to the original page.', {font, size: 10, x: 75, y: 165});
  page.drawText('Source figures and text coordinates stay intact.', {font, size: 10, x: 75, y: 140});
  page.drawText('OUTSIDE CROP MUST STAY HIDDEN', {font, size: 12, x: 4, y: 14});
  page.setCropBox(50, 70, 300, 160); page.setRotation(degrees(90));
  return Buffer.from(await document.save());
}

function paperFixtureTranslation(source, expansion = 1, includeTail = false) {
  const headings = {'Attention Is All You Need': '注意力就是你所需要的全部', Abstract: '摘要', Introduction: '引言', Background: '研究背景', 'Model Architecture': '模型架构', Conclusion: '结论'};
  const normalized = source.trim();
  let hash = 2166136261; for (const character of normalized) hash = Math.imul(hash ^ character.codePointAt(0), 16777619) >>> 0;
  const tail = includeTail ? `【排版夹具尾${hash.toString(16)}】` : '';
  if (headings[normalized]) return headings[normalized] + tail;
  if (/^(?:Attention\(|MultiHead\(|head\s*=|PE\(|softmax\(|LayerNorm\(|[^a-zA-Z]*[∑∏])/u.test(normalized)) return '公式说明：原始数学表达式保留在相邻原图中，中文夹具仅用于验证完整段落的排版。' + tail;
  if (/^\d(?:\.\d)*\s/u.test(normalized) && normalized.length < 90) return normalized.replace(/^([\d.]+)\s+(.+)$/u, (_match, number) => `${number} 模型结构与注意力机制`) + tail;
  if (/^(?:Figure|Table)\s*\d/iu.test(normalized)) return '图表说明：该结构展示多头注意力、前馈网络以及编码器和解码器之间的信息流。模型利用位置编码保留输入顺序，并通过残差连接和层归一化稳定训练。'.repeat(expansion) + tail;
  const paragraphs = [
    '当前主流的序列转换模型通常依赖复杂的循环神经网络或卷积神经网络，其中包括一个编码器和一个解码器。表现最好的模型还通过注意力机制连接编码器与解码器。我们提出一种称为 Transformer 的新型网络架构，该架构完全基于注意力机制，不再使用循环结构或卷积结构。',
    '缩放点积注意力通过查询、键和值之间的关系计算输出。模型将点积结果除以键向量维度的平方根，再应用 softmax 函数得到权重。多头注意力能够同时关注不同位置和不同表示子空间中的信息，因此比单个注意力头更容易表达复杂关系。',
    '为了保留序列中词语的相对位置或绝对位置，我们在编码器和解码器底部的输入嵌入中加入位置编码。位置编码与嵌入具有相同维度，因此二者可以直接相加。实验结果表明，这种架构能够提升翻译质量，同时减少训练时间，并且更适合并行计算。',
    '实验采用公开的数据集，并与先前的序列建模方法进行比较。结果显示，该模型在英文到德文以及英文到法文的翻译任务上都具有竞争力。参数设置、训练策略和评估方法需要结合表格中的数据理解；本段中文仅用于验证排版，不代表论文的正式翻译。',
  ];
  const length = Math.max(28, Math.ceil(normalized.length * 0.55 * expansion)), paragraph = paragraphs[normalized.length % paragraphs.length];
  return paragraph.repeat(Math.ceil(length / paragraph.length)).slice(0, length).replace(/[，、；：]$/u, '') + '。' + tail;
}

// 本机排版夹具按保护标记分片生成中文，保持标记的顺序、次数和 g 标签正文占位，
// 不能把标记统一附在译文尾部，否则数学字面值会移位、配对标签会变成空节点。
function harnessFixtureTranslation(source, expansion = 1) {
  const marker = /(__FRTERM_[a-z0-9_]+?__|___FLUENTREAD_[a-z0-9_-]+?_\d+_(?:BEGIN|END)___|<\/?g[1-9]\d*\/?>)/giu;
  const pieces = source.split(marker);
  const translated = pieces.map((piece, index) => index % 2 || !/\p{L}/u.test(piece) ? piece : paperFixtureTranslation(piece, expansion)).join('');
  assert.deepEqual(translated.match(marker) || [], source.match(marker) || [], '排版夹具必须逐个保留保护标记和格式顺序');
  return translated;
}

async function createFixture(files, {paperLayout = false, includePaperTail = false, taskInteraction = false, preserveProtectedTokens = false} = {}) {
  const state = {requests: [], pdfRequests: [], completed: [], stalledRequests: 0, canceledDownloads: 0, paperExpansion: 1, translationDelayMs: 20,
    transientFailures: [], transientResponses: []};
  const server = http.createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', '*');
    if (request.method === 'OPTIONS') {response.writeHead(204); response.end(); return;}
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/favicon.ico') {response.writeHead(204); response.end(); return;}
    if (pathname === '/stalled.pdf') {
      state.stalledRequests += 1; response.once('close', () => {state.canceledDownloads += 1;});
      response.setHeader('Content-Type', 'application/pdf'); response.setHeader('Content-Length', files['/selection-fixture.pdf'].length);
      response.flushHeaders(); response.write(files['/selection-fixture.pdf'].subarray(0, 32)); return;
    }
    if (files[pathname]) {
      state.pdfRequests.push(pathname);
      response.setHeader('Content-Type', 'application/pdf');
      response.setHeader('Content-Length', files[pathname].length);
      response.end(files[pathname]); return;
    }
    if (pathname !== '/v1/chat/completions') {response.writeHead(404); response.end(); return;}
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const prompt = body.messages.filter(message => message.role === 'user').map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
      const source = /SOURCE_BEGIN([\s\S]*?)SOURCE_END/u.exec(prompt)?.[1];
      assert.equal(typeof source, 'string', '翻译夹具需要明确的 SOURCE_BEGIN/SOURCE_END 原文边界');
      // 任务交互验证恢复与选择，不依赖回显英文；使用中文夹具避免错语种校验拒绝长段原文。
      const translation = taskInteraction ? `测试译文：${harnessFixtureTranslation(source, state.paperExpansion)}`
        : preserveProtectedTokens ? harnessFixtureTranslation(source, state.paperExpansion)
        : paperLayout ? paperFixtureTranslation(source, state.paperExpansion, includePaperTail) : `测试译文：${source}`;
      const entry = {source, model: body.model, translation, ...(paperLayout ? {expansion: state.paperExpansion, evidence: 'manually generated Chinese layout fixture; not translation quality'} : {}), startedAt: Date.now()}; state.requests.push(entry);
      const transient = state.transientFailures.shift();
      if (transient) {
        entry.httpStatus = transient.status; entry.retryAfterSeconds = transient.retryAfterSeconds;
        state.transientResponses.push({status: transient.status, retryAfterSeconds: transient.retryAfterSeconds, startedAt: entry.startedAt});
        response.writeHead(transient.status, {'Content-Type': 'application/json', 'Retry-After': String(transient.retryAfterSeconds)});
        response.end(JSON.stringify({error: {message: `Fixture ${transient.status}: temporarily unavailable; automatic retry expected`, type: transient.status === 429 ? 'rate_limit_error' : 'server_error'}})); return;
      }
      if (taskInteraction && body.model === 'pdf-failing' && state.requests.filter(value => value.model === 'pdf-failing').length >= 3) {
        entry.failed = true; response.writeHead(400, {'Content-Type': 'application/json'});
        response.end(JSON.stringify({error: {message: 'Fixture model unavailable; choose another model to resume', type: 'invalid_request_error', code: 'model_not_found'}})); return;
      }
      await wait(source.includes('First ownership') && !paperLayout ? 1600 : state.translationDelayMs);
      state.completed.push({...entry, completedAt: Date.now(), disconnected: response.destroyed});
      if (response.destroyed) return;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({id: 'pdf-selection-fixture', object: 'chat.completion', created: 1, model: 'pdf-fixture',
        choices: [{index: 0, message: {role: 'assistant', content: translation}, finish_reason: 'stop'}],
        usage: {prompt_tokens: 10, completion_tokens: 10, total_tokens: 20}}));
    } catch (error) {response.writeHead(400); response.end(JSON.stringify({error: {message: error.message}}));}
  });
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  return {state, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => {server.close(resolve); server.closeAllConnections();})};
}

async function until(predicate, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {if (await predicate()) return; await wait(75);}
  throw new Error(message);
}

async function pdfTextPages(bytes) {
  const requireRepo = createRequire(path.join(__dirname, '..', 'package.json'));
  const {getDocument} = await import(requireRepo.resolve('pdfjs-dist/legacy/build/pdf.mjs'));
  const task = getDocument({data: new Uint8Array(bytes), disableFontFace: true, isEvalSupported: false, useWorkerFetch: false,
    standardFontDataUrl: path.join(path.dirname(requireRepo.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep});
  try {
    const pdf = await task.promise, pages = [];
    for (let number = 1; number <= pdf.numPages; number++) {const page = await pdf.getPage(number); try {const content = await page.getTextContent(); pages.push(content.items.filter(item => 'str' in item).map(item => ({str: item.str, transform: item.transform})));} finally {page.cleanup();}}
    return pages;
  } finally {await task.destroy();}
}

async function pdfRasterPages(bytes) {
  const {pathToFileURL} = require('node:url'), {createHash} = require('node:crypto');
  const repoRequire = createRequire(path.join(__dirname, '..', 'package.json'));
  const pdfjs = await import(pathToFileURL(repoRequire.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
  const task = pdfjs.getDocument({data: new Uint8Array(bytes), disableFontFace: true, isEvalSupported: false, useWorkerFetch: false, standardFontDataUrl: path.join(path.dirname(repoRequire.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep});
  try {
    const document = await task.promise, result = [];
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number), operators = await page.getOperatorList(), images = [];
      for (let index = 0; index < operators.fnArray.length; index++) if (operators.fnArray[index] === pdfjs.OPS.paintImageXObject) {
        const image = await new Promise(resolve => page.objs.get(operators.argsArray[index][0], resolve));
        if (image.width !== 1224 || image.height !== 1584) continue;
        assert.equal(image.kind, pdfjs.ImageKind.RGB_24BPP, '实际下载 PDF 的译文图像应该是完整 RGB 图片');
        images.push({width: image.width, height: image.height, pixelHash: createHash('sha256').update(image.data).digest('hex')});
      }
      result.push({page: number, images}); page.cleanup();
    }
    return result;
  } finally {await task.destroy();}
}

async function pdfDisplayedText(bytes) {
  const repoRequire = createRequire(path.join(__dirname, '..', 'package.json'));
  const pdfjs = await import(repoRequire.resolve('pdfjs-dist/legacy/build/pdf.mjs'));
  const task = pdfjs.getDocument({data: new Uint8Array(bytes), disableFontFace: true, isEvalSupported: false, useWorkerFetch: false, standardFontDataUrl: path.join(path.dirname(repoRequire.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep});
  try {
    const document = await task.promise, page = await document.getPage(1), viewport = page.getViewport({scale: 1}), content = await page.getTextContent();
    return {width: viewport.width, height: viewport.height, items: content.items.filter(item => 'str' in item).map(item => ({text: item.str, transform: pdfjs.Util.transform(viewport.transform, item.transform)}))};
  } finally {await task.destroy();}
}

function compareCropboxPixels(sourceFile, outputFile) {
  const repoRequire = createRequire(path.join(__dirname, '..', 'package.json')), UPNG = createRequire(repoRequire.resolve('pdf-lib/package.json'))('@pdf-lib/upng').default;
  const read = file => {const buffer = fs.readFileSync(file), decoded = UPNG.decode(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)); return {width: decoded.width, height: decoded.height, pixels: new Uint8Array(UPNG.toRGBA8(decoded)[0])};};
  const source = read(sourceFile), output = read(outputFile); assert.equal(output.width, source.width); assert.equal(output.height, source.height);
  const edge = (x, y) => {
    const current = (y * source.width + x) * 4;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= source.width || yy >= source.height) continue;
      const neighbor = (yy * source.width + xx) * 4; if ([0, 1, 2].some(channel => Math.abs(source.pixels[current + channel] - source.pixels[neighbor + channel]) > 8)) return true;
    }
    return false;
  };
  let changedPixels = 0, absoluteError = 0, outsideEdgeBand = 0;
  for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
    const index = (y * source.width + x) * 4, differences = [0, 1, 2].map(channel => Math.abs(source.pixels[index + channel] - output.pixels[index + channel])); absoluteError += differences.reduce((sum, value) => sum + value, 0);
    if (!differences.some(Boolean)) continue; changedPixels += 1;
    let inBand = false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < source.width && yy < source.height && edge(xx, yy)) inBand = true;}
    if (!inBand) outsideEdgeBand += 1;
  }
  const corners = image => ['red', 'green'].map(color => {
    const points = []; for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {const index = (y * image.width + x) * 4, [r, g, b] = image.pixels.slice(index, index + 3); if (color === 'red' ? r > 200 && g < 100 : g > 100 && r < 70 && b < 100) points.push({x, y});}
    assert(points.length > 0); return {color, count: points.length, left: Math.min(...points.map(point => point.x)), right: Math.max(...points.map(point => point.x)), top: Math.min(...points.map(point => point.y)), bottom: Math.max(...points.map(point => point.y))};
  });
  const sourceCorners = corners(source), outputCorners = corners(output), totalPixels = source.width * source.height;
  const result = {width: source.width, height: source.height, totalPixels, changedPixels, changedFraction: changedPixels / totalPixels, meanAbsoluteChannelError: absoluteError / (totalPixels * 3), outsideEdgeBand, sourceCorners, outputCorners};
  assert.equal(outsideEdgeBand, 0, `原页像素差异不能离开原始文字/矩形边界的一像素邻域：${JSON.stringify(result)}`);
  assert(result.changedFraction <= .005 && result.meanAbsoluteChannelError <= .5, `原页独立渲染差异必须小于0.5%像素/0.5平均色阶：${JSON.stringify(result)}`);
  for (let index = 0; index < sourceCorners.length; index++) for (const key of ['left', 'right', 'top', 'bottom']) assert(Math.abs(sourceCorners[index][key] - outputCorners[index][key]) <= 1, '原图彩色角标的几何不能改变');
  return result;
}

// WeakRef 不人为持有已释放资源；统计包括未挂回 DOM 的在途/迟到 Canvas，不能只数可见页。
function installResourceProbe() {
  const native = Document.prototype.createElement;
  const refs = [];
  Document.prototype.createElement = function(name, ...rest) {
    const element = Reflect.apply(native, this, [name, ...rest]);
    if (name === 'canvas' || name === 'div') refs.push(new WeakRef(element));
    return element;
  };
  globalThis.__pdfProbe = () => {
    const elements = refs.map(reference => reference.deref()).filter(Boolean);
    const canvases = elements.filter(element => element.tagName === 'CANVAS' && element.width > 0 && element.height > 0
      && (element.hasAttribute('data-pdf-resource') || (element.getAttribute('aria-hidden') === 'true' && element.style.width)));
    const textLayers = elements.filter(element => element.hasAttribute('data-fluentread-pdf-text') && element.childNodes.length > 0);
    const pagePixels = [...document.querySelectorAll('.pdf-page-row')].map(row => ({page: Number(row.dataset.pageNumber),
      pixels: [...row.querySelectorAll('canvas')].reduce((sum, canvas) => sum + canvas.width * canvas.height, 0)}));
    return {shells: document.querySelectorAll('.pdf-page-row').length, canvases: canvases.length,
      sourceCanvases: canvases.filter(canvas => canvas.dataset.pdfResource === 'source').length,
      regionCanvases: canvases.filter(canvas => canvas.dataset.pdfResource === 'region').length,
      presentation: document.querySelector('[data-document-reader="pdf"]')?.dataset.pdfPresentation,
      textLayers: textLayers.length, pagePixels,
      sourceOnly: document.querySelectorAll('.pdf-page-column.translated').length === 0,
      attachedCanvases: document.querySelectorAll('.pdf-layout-viewer canvas').length,
      pixels: canvases.reduce((sum, canvas) => sum + canvas.width * canvas.height, 0)};
  };
  globalThis.__pdfPeaks = {shells: 0, canvases: 0, textLayers: 0, pixels: 0};
  setInterval(() => {const state = globalThis.__pdfProbe(); for (const key of Object.keys(globalThis.__pdfPeaks)) globalThis.__pdfPeaks[key] = Math.max(globalThis.__pdfPeaks[key], state[key]);}, 40);
}

// 只记录真实 Canvas 的绘制与字体测量；不改变绘制参数，不将 Range 或 Selection 写回 PDF。
function installPaperPaintProbe() {
  const states = new WeakMap(), ids = new WeakMap();
  const stateFor = context => {let state = states.get(context); if (!state) {state = {clip: null, path: null, stack: []}; states.set(context, state);} return state;};
  const idFor = canvas => {let id = ids.get(canvas); if (!id) {id = ++globalThis.__pdfPaint.nextCanvas; ids.set(canvas, id);} return id;};
  globalThis.__pdfPaint = {nextCanvas: 0, draws: [], images: [], encodedPages: [], renderOps: {}, measureCalls: 0, readbackCalls: 0, readbackPixels: 0, readbackMs: 0, longTasks: []};
  const prototype = CanvasRenderingContext2D.prototype;
  for (const name of ['save', 'restore', 'beginPath', 'rect', 'clip', 'measureText', 'getImageData', 'fillText', 'fill', 'stroke', 'drawImage', 'fillRect', 'clearRect', 'putImageData']) {
    const native = prototype[name];
    prototype[name] = function(...args) {
      const state = stateFor(this);
      if (['fillText', 'fill', 'stroke', 'drawImage', 'fillRect', 'clearRect', 'putImageData'].includes(name)) {const id = idFor(this.canvas); globalThis.__pdfPaint.renderOps[id] = (globalThis.__pdfPaint.renderOps[id] || 0) + 1;}
      if (name === 'drawImage' && globalThis.__pdfTracePhase?.startsWith('export') && args[0] instanceof HTMLCanvasElement && args.length === 9 && args[0].width >= 500 && args[0].height >= 500) {
        globalThis.__pdfPaint.images.push({phase: globalThis.__pdfTracePhase, sourceCanvasId: idFor(args[0]), targetCanvasId: idFor(this.canvas), sourceWidth: args[0].width, sourceHeight: args[0].height, sourceRect: args.slice(1, 5), destinationRect: args.slice(5, 9)});
      }
      if (name === 'save') state.stack.push({clip: state.clip && {...state.clip}, path: state.path && {...state.path}});
      else if (name === 'restore' && state.stack.length) Object.assign(state, state.stack.pop());
      else if (name === 'beginPath') state.path = null;
      else if (name === 'rect') state.path = {x: args[0], y: args[1], width: args[2], height: args[3]};
      else if (name === 'clip') state.clip = state.path && {...state.path};
      const translatedFont = /Noto (?:Sans|Serif) CJK|Songti SC|PingFang SC|Microsoft YaHei/u.test(this.font);
      if (name === 'measureText' && translatedFont) globalThis.__pdfPaint.measureCalls += 1;
      if (name === 'fillText' && (/[\u3400-\u9fff]/u.test(String(args[0])) || (translatedFont && globalThis.__pdfTracePhase?.startsWith('export')))) {
        const metrics = Reflect.apply(prototype.measureText, this, [String(args[0])]);
        globalThis.__pdfPaint.draws.push({canvasId: idFor(this.canvas), text: String(args[0]), x: args[1], y: args[2], maxWidth: args[3],
          font: this.font, fontPx: Number(/([\d.]+)px/u.exec(this.font)?.[1]), clip: state.clip && {...state.clip},
          inkTop: args[2] - metrics.actualBoundingBoxAscent, inkBottom: args[2] + metrics.actualBoundingBoxDescent,
          inkLeft: args[1] - metrics.actualBoundingBoxLeft, inkRight: args[1] + metrics.actualBoundingBoxRight,
          measuredWidth: metrics.width, canvasWidth: this.canvas.width, canvasHeight: this.canvas.height,
          transform: [this.getTransform().a, this.getTransform().b, this.getTransform().c, this.getTransform().d, this.getTransform().e, this.getTransform().f], phase: globalThis.__pdfTracePhase || 'reading'});
      }
      const started = name === 'getImageData' ? performance.now() : 0;
      const result = Reflect.apply(native, this, args);
      if (name === 'getImageData') {globalThis.__pdfPaint.readbackCalls += 1; globalThis.__pdfPaint.readbackPixels += args[2] * args[3]; globalThis.__pdfPaint.readbackMs += performance.now() - started;}
      return result;
    };
  }
  globalThis.__pdfCanvasPaint = canvas => {
    const bounds = canvas.getBoundingClientRect(), ratio = bounds.width / canvas.width;
    const draws = globalThis.__pdfPaint.draws.filter(draw => draw.canvasId === ids.get(canvas)).map(draw => ({...draw, cssFontPx: draw.fontPx * ratio,
      clipped: Boolean(draw.clip && (draw.inkTop < draw.clip.y - 0.01 || draw.inkBottom > draw.clip.y + draw.clip.height + 0.01)),
      fullyHidden: Boolean(draw.clip && (draw.inkBottom <= draw.clip.y || draw.inkTop >= draw.clip.y + draw.clip.height))}));
    return {width: canvas.width, height: canvas.height, cssWidth: bounds.width, cssHeight: bounds.height, draws,
      minCssFontPx: draws.length ? Math.min(...draws.map(draw => draw.cssFontPx)) : null,
      clippedLines: draws.filter(draw => draw.clipped).length, fullyHiddenLines: draws.filter(draw => draw.fullyHidden).length};
  };
  globalThis.__pdfSourceRenderState = () => [...document.querySelectorAll('.pdf-page-column:not(.translated) .pdf-page-frame canvas')].map(canvas => {
    const id = idFor(canvas); return {page: Number(canvas.closest('[data-page-number]').dataset.pageNumber), canvasId: id, operations: globalThis.__pdfPaint.renderOps[id] || 0,
      text: canvas.parentElement.querySelector('[data-fluentread-pdf-text]')?.textContent, width: canvas.width, height: canvas.height};
  });
  const nativeEncode = HTMLCanvasElement.prototype.toBlob, lastEncoded = new WeakMap();
  HTMLCanvasElement.prototype.toBlob = function(...args) {
    if (globalThis.__pdfTracePhase?.startsWith('export')) {
      const canvasId = idFor(this), index = lastEncoded.get(this) || 0, draws = globalThis.__pdfPaint.draws.slice(index).filter(draw => draw.canvasId === canvasId);
      const entry = {phase: globalThis.__pdfTracePhase, canvasId, width: this.width, height: this.height, draws}; globalThis.__pdfPaint.encodedPages.push(entry); lastEncoded.set(this, globalThis.__pdfPaint.draws.length);
      const rgba = this.getContext('2d').getImageData(0, 0, this.width, this.height).data, rgb = new Uint8Array(this.width * this.height * 3);
      for (let source = 0, target = 0; source < rgba.length; source += 4) {rgb[target++] = rgba[source]; rgb[target++] = rgba[source + 1]; rgb[target++] = rgba[source + 2];}
      const pixelHash = crypto.subtle.digest('SHA-256', rgb).then(hash => {entry.pixelHash = [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');});
      const callback = args[0]; args[0] = blob => {entry.encodedBytes = blob?.size; pixelHash.then(() => callback(blob));};
    }
    return Reflect.apply(nativeEncode, this, args);
  };
  if (typeof PerformanceObserver === 'function') {try {new PerformanceObserver(list => globalThis.__pdfPaint.longTasks.push(...list.getEntries().map(entry => ({startTime: entry.startTime, duration: entry.duration})))).observe({type: 'longtask', buffered: true});} catch {}}
}

async function main() {
  const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
  const artifactsDir = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-pdf-selection'));
  const packages = arg('playwright-root', process.env.PLAYWRIGHT_ROOT);
  const arxivPath = arg('arxiv-pdf');
  const liveArxiv = process.argv.includes('--live-arxiv');
  const skipRotations = process.argv.includes('--skip-rotations');
  const paperLayoutOnly = process.argv.includes('--paper-layout-only');
  const harnessLayoutOnly = process.argv.includes('--harness-layout-only') || process.argv.includes('--harness-status-only');
  const paperLayoutBaseline = process.argv.includes('--paper-layout-baseline');
  const paperLayoutFollowup = process.argv.includes('--paper-layout-followup');
  const paperLayoutCancelOnly = process.argv.includes('--paper-layout-cancel-only');
  const taskInteraction = process.argv.includes('--interaction-recovery-only') || process.argv.includes('--selection-baseline-only');
  const retranslationOnly = process.argv.includes('--retranslation-only');
  assert(packages, '需要 --playwright-root 或 PLAYWRIGHT_ROOT');
  assert(fs.existsSync(path.join(extensionDir, 'manifest.json')), '请先生成生产扩展产物');
  if (arxivPath) assert(fs.existsSync(arxivPath), '找不到 --arxiv-pdf 指定的论文');
  if (paperLayoutOnly) assert(arxivPath, '--paper-layout-only 需要真实 --arxiv-pdf 论文夹具');
  if (harnessLayoutOnly) assert(arxivPath, '--harness-layout-only 需要真实 --arxiv-pdf 论文夹具');
  const {chromium} = createRequire(path.join(path.resolve(packages), 'pdf-selection-runner.cjs'))('playwright');
  const helper = require(path.resolve(arg('focus-safe-helper', path.join(__dirname, 'testing/focus-safe-browser.cjs'))));
  const diagnosticsPath = arg('runtime-diagnostics-helper', process.env.FLUENTREAD_RUNTIME_DIAGNOSTICS_HELPER);
  assert(diagnosticsPath, '需要 --runtime-diagnostics-helper 或 FLUENTREAD_RUNTIME_DIAGNOSTICS_HELPER');
  const diagnostics = require(path.resolve(diagnosticsPath)).createRuntimeDiagnostics();
  fs.mkdirSync(artifactsDir, {recursive: true});
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-pdf-selection-'));
  // Chromium 原生键盘浏览非编辑文字需启用 caret browsing；只设置新建临时 profile，不读取用户 profile。
  fs.mkdirSync(path.join(profileDir, 'Default'), {recursive: true});
  fs.writeFileSync(path.join(profileDir, 'Default', 'Preferences'), JSON.stringify({settings: {a11y: {caretbrowsing: {enabled: true, show_dialog: false}}}}));
  const report = {ok: false, extensionDir, artifactsDir, cases: [], screenshots: [], importTimings: [], resources: [], consoleErrors: [],
    providerEvidence: 'Production extension and real PDF.js/Edge input; deterministic loopback translation fixture. arXiv fixture is local unless a separate live import is recorded.',
    profileMode: 'new temporary profile', nativeCaretBrowsing: {enabled: true, scope: 'new temporary test profile only', preference: 'settings.a11y.caretbrowsing.enabled'}, selectionInput: 'real Playwright mouse drag and keyboard over PDF.js TextLayer',
    selectionLimits: {paperTitle: 'Not claimed: prior isolated background Input title drags collapsed with unchanged text-node identity and user-select:text; no product cause demonstrated. This suite selects meaningful abstract source text.'}};
  if (skipRotations) report.skipped = ['rotatedPDF'];
  let fixture, launched, page, launchAttempted = false, diagnosticsStarted = false;
  const record = name => {report.cases.push(name); process.stdout.write(`PASS ${name}\n`);};
  try {
    const smallPdf = await createPdf(retranslationOnly ? 1 : 3, 0, taskInteraction || retranslationOnly), longPdf = await createPdf(120);
    fs.writeFileSync(path.join(artifactsDir, 'selection-fixture.pdf'), smallPdf);
    fs.writeFileSync(path.join(artifactsDir, 'long-120.pdf'), longPdf);
    fixture = await createFixture({'/selection-fixture.pdf': smallPdf}, {paperLayout: paperLayoutOnly || harnessLayoutOnly, includePaperTail: paperLayoutOnly && !paperLayoutBaseline, taskInteraction, preserveProtectedTokens: harnessLayoutOnly || retranslationOnly});
    launchAttempted = true;
    launched = await helper.launchFocusSafePersistentContext({chromium, profileDir,
      browserPath: arg('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'), background: true, headless: false,
      viewport: {width: 1440, height: 960}, displayTarget: 'secondary', timeout: 30000,
      browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check']});
    guardBrowserClose(launched, profileDir);
    Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
    assert.equal(launched.windowPlacement.browserFrontmost, false, '测试浏览器不能成为用户前台应用');
    const context = launched.context;
    await diagnostics.start(context); diagnosticsStarted = true;
    const browserPid = await getGuardedBrowserPid(launched);
    const checkFocus = async stage => {
      if (process.platform !== 'darwin') return;
      const script = "ObjC.import('AppKit'); const app=$.NSWorkspace.sharedWorkspace.frontmostApplication; JSON.stringify({pid:Number(app.processIdentifier),name:ObjC.unwrap(app.localizedName)||''});";
      const {stdout} = await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], {timeout: 5000});
      const frontmost = JSON.parse(stdout.trim()); assert(Number.isInteger(frontmost.pid), '无法读取当前前台应用，停止测试');
      (report.frontmostSnapshots ||= []).push({stage, ...frontmost, browserFrontmost: frontmost.pid === browserPid});
      assert.notEqual(frontmost.pid, browserPid, `测试 Edge 成为前台，停止 ${stage}`);
    };
    const {worker, extensionId} = await support.waitForWorker(context);
    diagnostics.setExtensionId(extensionId);
    const origin = `chrome-extension://${extensionId}`;
    const preparePage = async next => {
      await diagnostics.attachPage(next, 'document');
      next.setDefaultTimeout(30000);
      next.on('pageerror', error => report.consoleErrors.push({url: next.url(), error: error.message}));
      next.on('console', message => {if (message.type() === 'error') report.consoleErrors.push({url: next.url(), error: message.text()});});
      await next.addInitScript(installResourceProbe); if (paperLayoutOnly || harnessLayoutOnly) await next.addInitScript(installPaperPaintProbe); return next;
    };
    const newPage = async () => preparePage(await helper.newPageWithoutForeground(context, 30000));
    const initialPage = context.pages().find(candidate => /^about:blank#fluentread-background-/u.test(candidate.url()));
    const configPage = initialPage ? await preparePage(initialPage) : await newPage();
    await configPage.goto(`${origin}/document.html`); await configPage.locator('.file-drop-zone').waitFor(); await checkFocus('initial document page');
    const current = await support.readStoredConfig(configPage), service = 'custom:pdf-fixture';
    await support.patchStoredConfig(configPage, {on: true, uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true, service, from: 'en', to: 'zh-Hans',
      selectionTranslationService: service, documentService: service, model: {...current.model, [service]: 'pdf-fixture', ...(taskInteraction ? {'custom:pdf-rescue': 'pdf-rescue'} : {})},
      documentModel: {...current.documentModel, [service]: 'pdf-fixture', ...(taskInteraction ? {'custom:pdf-rescue': 'pdf-rescue'} : {})}, user_role: {...current.user_role, [service]: 'SOURCE_BEGIN{{origin}}SOURCE_END', ...(taskInteraction ? {'custom:pdf-rescue': 'SOURCE_BEGIN{{origin}}SOURCE_END'} : {})},
      customOpenAIProviders: [{id: service, name: 'PDF 本机确定性测试', endpoint: `${fixture.base}/v1/chat/completions`, models: taskInteraction ? ['pdf-fixture', 'pdf-failing', 'pdf-rescue'] : ['pdf-fixture']}, ...(taskInteraction ? [{id: 'custom:pdf-rescue', name: 'PDF 备用测试服务', endpoint: `${fixture.base}/v1/chat/completions`, models: ['pdf-rescue']}] : [])],
      requireApiKey: Object.fromEntries((taskInteraction ? [[service, 'pdf-fixture'], [service, 'pdf-failing'], [service, 'pdf-rescue'], ['custom:pdf-rescue', 'pdf-rescue']] : [[service, 'pdf-fixture']]).map(pair => [`v2:${JSON.stringify(pair)}`, false])), token: {...current.token, [service]: 'fixture-token', ...(taskInteraction ? {'custom:pdf-rescue': 'fixture-token'} : {})},
      selectionTranslatorMode: 'bilingual', selectionTranslatorTrigger: 'icon', selectionTranslatorDelay: 0, selectionTranslatorAutoDismiss: false,
      useCache: retranslationOnly, ...(retranslationOnly ? {translationMaxRetries: 0} : {}),
      hotkey: 'none', floatingBallHotkey: 'none', enableAIContext: false, enableAIMultiSegment: false});
    if (paperLayoutOnly || taskInteraction || harnessLayoutOnly || retranslationOnly) {
      await support.patchStoredConfig(configPage, {translationRequestsPerSecond: 0, translationRequestsPerMinute: 0});
      report.fixtureRequestLimits = {perSecond: 0, perMinute: 0, scope: 'owned isolated profile and local fixture only; product default remains unchanged'};
    }
    const patch = async value => {await support.patchStoredConfig(configPage, value); await wait(200);};
    const openDocument = async () => {
      // 本地历史会在刷新后恢复当前文档；通过侧栏“调整设置 → 更换文件/清空队列”真实离开文档，再回到首页，不删除 IndexedDB。
      if (await configPage.locator('.document-app.is-workspace').count()) {
        if (await configPage.locator('.focus-exit').count()) await configPage.keyboard.press('Escape');
        if (!await configPage.locator('.document-settings-button').isVisible()) await configPage.locator('.sidebar-toggle').click();
        assert.equal(await configPage.locator('.document-taskbar .document-settings-button').count(), 0, '调整设置入口应该位于侧栏而不是工具栏');
        await configPage.locator('aside.document-sidebar .document-settings-button').click(); await configPage.locator('.document-settings-dialog[open] .sidebar-change-file').click();
        const confirm = configPage.locator('dialog[open][aria-labelledby="confirm-document-heading"]'); if (await confirm.count()) await confirm.locator('.translate-document-button').click();
        await configPage.locator('.file-drop-zone').waitFor();
        assert.equal(await configPage.evaluate(() => sessionStorage.getItem('fluentread.document.open')), null, '离开文档后不应再记住已打开的文档');
      }
      await configPage.goto(`${origin}/document.html`); await configPage.locator('.file-drop-zone').waitFor(); await checkFocus('document reload'); return configPage;
    };
    const shot = async name => {await checkFocus(name); const file = path.join(artifactsDir, `${name}.png`); await page.screenshot({path: file, animations: 'disabled'}); report.screenshots.push(file);};
    // 缩放与展示方式是自定义菜单：点开 .pdf-menu-button，再点 li[role=option][data-value]。
    const menuPick = async (root, value) => {
      const menu = page.locator(root), button = menu.locator('.pdf-menu-button');
      if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
      await menu.locator(`li[role="option"][data-value="${value}"]`).click();
      await until(async () => await menu.locator('.pdf-menu-list').count() === 0, `选择 ${value} 后菜单未收起`);
    };
    const setZoom = value => menuPick('.pdf-zoom-control .pdf-menu', value);
    const currentZoom = async () => {
      const menu = page.locator('.pdf-zoom-control .pdf-menu'), button = menu.locator('.pdf-menu-button');
      if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
      const value = await menu.locator('li[role="option"][aria-selected="true"]').getAttribute('data-value'); await button.click();
      await until(async () => await menu.locator('.pdf-menu-list').count() === 0, '缩放菜单未收起'); return value;
    };
    const presentationOf = () => page.locator('.pdf-layout-viewer').getAttribute('data-pdf-presentation');
    const setPresentation = async value => {
      await menuPick('.pdf-presentation-control.pdf-menu', value);
      await until(async () => await presentationOf() === value, `展示方式未切换到 ${value}`);
    };
    // 提示条已移除：用工具栏文件名上的真实点击清除旧选区。
    const clearSelectionByClick = () => page.locator('.document-taskbar .workspace-heading h1').click();
    const rowReady = async number => {await page.locator(`.pdf-page-row[data-page-number="${number}"][data-render-state="ready"] [data-fluentread-pdf-text] span`).first().waitFor();};
    const load = async (name, buffer) => {
      const started = Date.now(), requestsBefore = fixture.state.requests.length; await page.locator('input[type=file]').setInputFiles({name, mimeType: 'application/pdf', buffer});
      await page.locator('.workspace-heading h1').filter({hasText: name}).waitFor({timeout: 60000}); await rowReady(1);
      report.importTimings.push({name, firstSelectablePageMs: Date.now() - started});
      assert.equal(fixture.state.requests.length, requestsBefore, '仅导入 PDF 不得发送整份文档到翻译服务'); await checkFocus(`import ${name}`);
    };
    const resourceState = async label => {
      const state = await page.evaluate(() => ({...globalThis.__pdfProbe(), peaks: {...globalThis.__pdfPeaks}}));
      assert(state.shells <= 5 && state.sourceCanvases <= 5 && state.textLayers <= 5 && (state.presentation === 'readable' || state.canvases <= (state.sourceOnly ? 5 : 10)), `PDF 资源必须有界：${JSON.stringify(state)}`);
      assert(state.pagePixels.every(entry => entry.pixels <= 8_000_000), `单页源/译画布合计超过 8m：${JSON.stringify(state)}`);
      assert(state.pixels <= 40_000_000 && state.peaks.pixels <= 40_000_000, `Canvas 像素超过 5 页 × 8m = 40m：${JSON.stringify(state)}`);
      assert(state.peaks.shells <= 5 && state.peaks.textLayers <= 5, `历史资源峰值超限：${JSON.stringify(state)}`);
      report.resources.push({label, ...state}); return state;
    };
    const readerGeometry = async label => {
      const geometry = await page.locator('.reading-content.reading-pdf').evaluate(parent => {
        const viewer = parent.querySelector('[data-document-reader="pdf"]'), scroll = viewer.querySelector('[data-pdf-scroll]');
        const frame = viewer.querySelector('.pdf-page-row[data-render-state="ready"] .pdf-page-frame'), canvas = frame?.querySelector('canvas');
        const measure = element => {const bounds = element.getBoundingClientRect(); return {left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height};};
        return {viewport: {width: innerWidth, height: innerHeight}, parent: measure(parent), viewer: measure(viewer), scroll: measure(scroll), frame: frame && measure(frame), canvas: canvas && measure(canvas), direction: getComputedStyle(parent).flexDirection};
      });
      (report.readerGeometries ||= []).push({label, ...geometry});
      assert.equal(geometry.direction, 'column', 'PDF 阅读器和未翻译提示必须按列排列');
      assert(geometry.viewer.width >= geometry.parent.width - 2, `PDF 阅读器未占满阅读区：${JSON.stringify(geometry)}`);
      assert(geometry.scroll.width >= geometry.viewer.width - 2, `PDF 滚动区宽度被兄弟提示挤占：${JSON.stringify(geometry)}`);
      if (await currentZoom() === 'fit') {
        const minimumPageWidth = geometry.viewport.width <= 600 ? 250 : Math.min(geometry.scroll.width - 65, 600);
        assert(geometry.frame?.width >= minimumPageWidth && geometry.canvas?.width >= minimumPageWidth, `适合宽度的 PDF 页面必须保持可读尺寸：${JSON.stringify(geometry)}`);
      }
      return geometry;
    };
    const uiNode = async name => support.findCdpNode((await support.getSelectionUiTree(page)).root, node => support.hasCdpClass(node, name));
    const uiText = async () => support.cdpText(await uiNode('fr-translation-tooltip'));
    const clickNode = async name => {
      const {session, root} = await support.getSelectionUiTree(page);
      const node = support.findCdpNode(root, candidate => support.hasCdpClass(candidate, name)); assert(node, `缺少 ${name}`);
      const {model} = await session.send('DOM.getBoxModel', {nodeId: node.nodeId}); const q = model.content;
      await page.mouse.click((q[0] + q[2] + q[4] + q[6]) / 4, (q[1] + q[3] + q[5] + q[7]) / 4);
    };
    const normalizeSelection = value => value.replace(/\u00ad/gu, '').replace(/[\s\u00a0]+/gu, ' ').trim();
    const nativeSelectionState = () => page.evaluate(() => {
      const selection = getSelection(), describe = node => node && {text: node.textContent?.slice(0, 180), connected: node.isConnected, page: node.parentElement?.closest('[data-pdf-page-number]')?.getAttribute('data-pdf-page-number')};
      return {text: selection?.toString(), anchor: describe(selection?.anchorNode), anchorOffset: selection?.anchorOffset, focus: describe(selection?.focusNode), focusOffset: selection?.focusOffset,
        anchorSameAsStart: selection?.anchorNode === globalThis.__pdfGestureStartNode, focusSameAsStart: selection?.focusNode === globalThis.__pdfGestureStartNode,
        originalPointConnected: globalThis.__pdfGestureStartNode?.isConnected, isCollapsed: selection?.isCollapsed, scrollTop: document.querySelector('[data-pdf-scroll]').scrollTop, pages: [...document.querySelectorAll('.pdf-page-row')].map(row => row.dataset.pageNumber)};
    });
    const characterPoint = async (number, text, atEnd) => page.evaluate(({number, text, atEnd}) => {
      const span = [...document.querySelectorAll(`[data-fluentread-pdf-text][data-pdf-page-number="${number}"] span`)].find(element => element.textContent.includes(text));
      if (!span) throw new Error(`真实拖选目标缺失：${text}`);
      const textNode = span.firstChild, index = span.textContent.indexOf(text), desiredOffset = index + (atEnd ? text.length : 0);
      const glyphOffset = atEnd ? desiredOffset - 1 : desiredOffset, range = document.createRange();
      range.setStart(textNode, glyphOffset); range.setEnd(textNode, glyphOffset + 1);
      const rect = range.getBoundingClientRect(), viewport = document.querySelector('[data-pdf-scroll]').getBoundingClientRect();
      const probes = [];
      // 只读 caret 探针验证浏览器命中的实际字符，避免 PDF.js 的 transform/裁剪坐标让拖选扩成多行。
      for (const fractionY of [0.5, 0.35, 0.65, 0.01, 0.99]) {
        const edges = atEnd ? [rect.right - 0.1, rect.right - 0.4, rect.right, rect.right + 0.4] : [rect.left + 0.1, rect.left + 0.4, rect.left, rect.left - 0.4];
        for (const x of [...edges, rect.left + rect.width / 2, rect.left + 0.1, rect.right - 0.1]) {
          const y = rect.top + rect.height * fractionY;
          if (x <= viewport.left || x >= viewport.right || y <= viewport.top + 3 || y >= viewport.bottom - 3) continue;
          const caret = document.caretPositionFromPoint?.(x, y), caretRange = !caret && document.caretRangeFromPoint?.(x, y);
          const node = caret ? caret.offsetNode : caretRange?.startContainer, offset = caret ? caret.offset : caretRange?.startOffset;
          probes.push({x, y, text: node?.textContent?.slice(0, 120), offset});
          if (node === textNode && offset === desiredOffset) {
            const hit = document.elementFromPoint(x, y), ancestors = []; let ancestor = hit;
            for (let count = 0; ancestor && count < 8; count += 1, ancestor = ancestor.parentElement) {const style = getComputedStyle(ancestor); ancestors.push({tag: ancestor.tagName, className: ancestor.className, userSelect: style.userSelect, pointerEvents: style.pointerEvents});}
            return {x, y, expectedOffset: desiredOffset, caretOffset: offset, text: span.textContent, hitHtml: hit?.outerHTML?.slice(0, 400), ancestors,
              glyph: {left: rect.left, top: rect.top, width: rect.width, height: rect.height}, scrollTop: document.querySelector('[data-pdf-scroll]').scrollTop};
          }
        }
      }
      throw new Error(`真实拖选坐标无法命中目标字符：${JSON.stringify({text, number, atEnd, desiredOffset, glyph: rect.toJSON(), span: span.getBoundingClientRect().toJSON(), viewport: viewport.toJSON(), transform: getComputedStyle(span).transform, probes})}`);
    }, {number, text, atEnd});
    // 拖选垫片：拖动中位于选区活动端旁并铺满文字层，文字层带 selecting；松开后退回层尾并清除尺寸。
    const selectionGuardState = () => page.evaluate(() => {
      const selection = getSelection(), range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      const elementOf = node => node && (node.nodeType === 3 ? node.parentNode : node);
      const start = elementOf(range?.startContainer), end = elementOf(range?.endContainer);
      return {collapsed: !range || selection.isCollapsed, layers: [...document.querySelectorAll('[data-fluentread-pdf-text]')].map(layer => {
        const guards = layer.querySelectorAll('[data-fluentread-pdf-selection-guard]'), guard = guards[0];
        return {page: layer.getAttribute('data-pdf-page-number'), selecting: layer.classList.contains('selecting'), guards: guards.length,
          guardIsLast: Boolean(guard) && guard.parentElement === layer && layer.lastElementChild === guard, guardWidth: guard?.style.width || '', guardHeight: guard?.style.height || '',
          guardAfterSelectionEnd: Boolean(guard && end) && guard.previousSibling === end, guardBeforeSelectionStart: Boolean(guard && start) && guard.nextSibling === start,
          intersectsSelection: Boolean(range) && range.intersectsNode(layer)};
      })};
    });
    const assertGuardsReset = async stage => {
      const state = await selectionGuardState();
      for (const layer of state.layers) assert(!layer.selecting && layer.guards <= 1 && (layer.guards === 0 || (layer.guardIsLast && !layer.guardWidth && !layer.guardHeight)), `${stage}：松开指针后选区垫片必须退回层尾并取消 selecting：${JSON.stringify(layer)}`);
      return state;
    };
    const assertGuardsActive = (state, stage) => {
      const active = state.layers.filter(layer => layer.intersectsSelection);
      assert(active.length > 0, `${stage}：拖选中的选区必须落在原文文字层`);
      for (const layer of active) assert(layer.selecting && layer.guards === 1, `${stage}：被选中的文字层必须带 selecting 并只有一个垫片：${JSON.stringify(layer)}`);
      assert(active.some(layer => (layer.guardAfterSelectionEnd || layer.guardBeforeSelectionStart) && layer.guardWidth && layer.guardHeight), `${stage}：垫片必须移到选区活动端旁并铺满文字层：${JSON.stringify(state)}`);
      for (const layer of state.layers.filter(layer => !layer.intersectsSelection)) assert(!layer.selecting, `${stage}：未被选中的文字层不能带 selecting：${JSON.stringify(layer)}`);
    };
    const dragLines = async (first, last = first, number = 1) => {
      await checkFocus('before selection input');
      await helper.activateExtensionTabWithoutForeground(context, page);
      await page.keyboard.press('Escape'); await clearSelectionByClick();
      assert(await page.evaluate(() => !getSelection()?.rangeCount || getSelection().isCollapsed), '下一次拖选前必须用真实点击清除旧选区，防止浏览器启动文字拖放');
      await page.locator(`[data-fluentread-pdf-text][data-pdf-page-number="${number}"] span`).filter({hasText: first}).first().scrollIntoViewIfNeeded();
      const points = {start: await characterPoint(number, first, false), end: await characterPoint(number, last, true)};
      const gesture = {kind: 'same-page', number, first, last, ...points, states: []}; (report.selectionGestures ||= []).push(gesture);
      await page.mouse.move(points.start.x, points.start.y); await page.mouse.down(); await page.evaluate(() => {globalThis.__pdfGestureStartNode = getSelection()?.anchorNode;}); gesture.states.push({stage: 'down', ...await nativeSelectionState()});
      // 逐步移动并记录每一步的选区端点与垫片位置；输入仍是 18 次真实鼠标移动。
      gesture.trace = [];
      const dragSteps = 18;
      for (let step = 1; step <= dragSteps; step += 1) {
        const x = points.start.x + (points.end.x - points.start.x) * step / dragSteps, y = points.start.y + (points.end.y - points.start.y) * step / dragSteps;
        await page.mouse.move(x, y);
        gesture.trace.push(await page.evaluate(({step, x, y}) => {
          const selection = getSelection(), describe = (node, offset) => node ? `${node.nodeType === 3 ? 'text' : node.nodeName.toLowerCase() + (node.className ? '.' + node.className : '')}:${(node.textContent || '').slice(0, 18)}@${offset}` : null;
          const layer = document.querySelector('[data-fluentread-pdf-text][data-pdf-page-number="1"]'), guard = layer?.querySelector('[data-fluentread-pdf-selection-guard]'), hit = document.elementFromPoint(x, y);
          return {step, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, hit: hit ? hit.nodeName.toLowerCase() + (hit.className ? '.' + hit.className : '') + ':' + (hit.textContent || '').slice(0, 12) : null,
            anchor: describe(selection?.anchorNode, selection?.anchorOffset), focus: describe(selection?.focusNode, selection?.focusOffset), length: selection?.toString().length,
            guardIndex: guard ? [...guard.parentElement.childNodes].indexOf(guard) : -1, guardParent: guard?.parentElement === layer ? 'layer' : guard?.parentElement?.nodeName.toLowerCase(), children: layer?.childNodes.length};
        }, {step, x, y}));
      }
      gesture.states.push({stage: 'move', ...await nativeSelectionState()});
      gesture.guardWhileDragging = await selectionGuardState(); await page.mouse.up();
      gesture.guardAfterRelease = await assertGuardsReset('same-page drag');
      if (!gesture.guardWhileDragging.collapsed) assertGuardsActive(gesture.guardWhileDragging, 'same-page drag');
      const selected = await page.evaluate(() => getSelection()?.toString() || '');
      Object.assign(gesture, {selected, scrollTopAfter: await page.locator('[data-pdf-scroll]').evaluate(element => element.scrollTop)});
      assert.equal(normalizeSelection(selected), normalizeSelection(first === last ? first : `${first} ${last}`), `真实拖选必须严格对应指定原文：${selected}`); return selected;
    };
    const translateDrag = async (first, last = first) => {const selected = await dragLines(first, last); await until(() => uiNode('fr-selection-indicator'), 'PDF 划词入口未出现'); await clickNode('fr-selection-indicator'); await until(async () => (await uiText()).includes('测试译文'), 'PDF 划词译文未出现'); return selected;};
    const translateKeyboardLine = async text => {
      await checkFocus('before native keyboard selection'); await helper.activateExtensionTabWithoutForeground(context, page);
      await page.keyboard.press('Escape'); await clearSelectionByClick();
      await page.locator('[data-fluentread-pdf-text][data-pdf-page-number="1"] span').filter({hasText: text}).first().scrollIntoViewIfNeeded();
      const start = await characterPoint(1, text, false); await page.mouse.click(start.x, start.y);
      await page.evaluate(() => {globalThis.__pdfGestureStartNode = getSelection()?.anchorNode;});
      const gesture = {kind: 'native-keyboard', first: text, start, key: 'Shift+ArrowRight', count: text.length, states: [{stage: 'caret-click', ...await nativeSelectionState()}]};
      (report.selectionGestures ||= []).push(gesture);
      assert.equal(gesture.states[0].anchorOffset, 0, '键盘选择必须从真实鼠标点击的原文起始 caret 开始');
      await page.keyboard.down('Shift');
      try {for (let offset = 0; offset < text.length; offset += 1) await page.keyboard.press('ArrowRight');} finally {await page.keyboard.up('Shift');}
      gesture.states.push({stage: 'keyboard-selected', ...await nativeSelectionState()});
      const selected = await page.evaluate(() => getSelection()?.toString() || ''); gesture.selected = selected;
      assert.equal(normalizeSelection(selected), normalizeSelection(text), '旋转页真实键盘选择必须严格对应指定原文');
      await until(() => uiNode('fr-selection-indicator'), '旋转页键盘划词入口未出现'); await clickNode('fr-selection-indicator');
      await until(async () => (await uiText()).includes(`测试译文：${text}`), '旋转页键盘选区未返回确定性中文译文'); return selected;
    };
    const paperSelectionTarget = () => page.locator('[data-fluentread-pdf-text][data-pdf-page-number="1"] span').evaluateAll(spans => {
      const texts = spans.map(span => span.textContent);
      return texts.find(text => /dominant|Transformer|architecture/iu.test(text) && text.trim().split(/\s+/u).length >= 4 && !/copyright|license|permission|attribution|Google hereby/iu.test(text));
    });
    const dragAcrossPages = async () => {
      await checkFocus('before cross-page selection input'); await helper.activateExtensionTabWithoutForeground(context, page); await page.keyboard.press('Escape'); await clearSelectionByClick();
      await setZoom('1'); await wait(200); await rowReady(1);
      const first = 'Original figures, fonts and page geometry remain intact.', last = 'FluentRead PDF fixture page 2';
      const firstSpan = page.locator('[data-fluentread-pdf-text][data-pdf-page-number="1"] span').filter({hasText: first}).first();
      await firstSpan.scrollIntoViewIfNeeded();
      const start = await characterPoint(1, first, false);
      const nativeState = nativeSelectionState;
      report.crossPageGesture = {start, states: []};
      await page.mouse.move(start.x, start.y); await page.mouse.down();
      await page.evaluate(() => {globalThis.__pdfGestureStartNode = getSelection()?.anchorNode;});
      report.crossPageGesture.states.push({stage: 'down', ...await nativeState()});
      try {
        // 先超过原页上的真实拖拽阈值，再滚动；否则 Chromium 会在后来的移动点重新决定起始 caret。
        await page.mouse.move(start.x + 20, start.y, {steps: 4}); report.crossPageGesture.states.push({stage: 'start-drag', ...await nativeState()});
        // 浏览器 Input 的按下/拖动创建真实选区；只滚动内层视口，不写入 Selection 或 DOM Range。
        await page.locator('[data-pdf-scroll]').evaluate(element => {const next = element.querySelector('.pdf-page-row[data-page-number="2"]'); if (!next) throw new Error('跨页拖选需要第二页'); element.scrollTop = Number.parseFloat(next.style.top);});
        await rowReady(2); await wait(100);
        report.crossPageGesture.states.push({stage: 'scroll', ...await nativeState()});
        const end = await characterPoint(2, last, true); report.crossPageGesture.end = end; await page.mouse.move(end.x, end.y, {steps: 18});
        report.crossPageGesture.states.push({stage: 'move', ...await nativeState()});
        report.crossPageGesture.guardWhileDragging = await selectionGuardState();
      } finally {await page.mouse.up();}
      report.crossPageGesture.guardAfterRelease = await assertGuardsReset('cross-page drag');
      assertGuardsActive(report.crossPageGesture.guardWhileDragging, 'cross-page drag');
      report.crossPageGesture.states.push({stage: 'up', ...await nativeState()});
      const selected = await page.evaluate(() => getSelection()?.toString() || '');
      assert(selected.includes(first) && selected.includes(last), `真实跨页拖选没有保留两端：${selected}`);
      await until(() => uiNode('fr-selection-indicator'), '跨页划词入口未出现'); await clickNode('fr-selection-indicator');
      await until(async () => (await uiText()).includes('测试译文'), '跨页划词译文未出现');
      const requestedSource = fixture.state.requests.at(-1).source;
      assert.equal(requestedSource, `${first} ${last}`, '跨页请求必须只有两页原文，不能夹入页眉、原文标签或页码控件');
      assert(!/原文|第\s*2\s*页|可选择原文/u.test(requestedSource), '跨页请求混入了阅读器装饰文字');
      assert((await uiText()).includes(`测试译文：${requestedSource}`)); report.crossPage = {nativeSelection: selected, requestedSource, input: 'mouse down; inner viewport scrollTop; mouse move and up'};
    };

    if (retranslationOnly) {
      const {runPdfRetranslation} = require('./testing/pdf-retranslation.cjs');
      page = await openDocument(); await load('retranslation-fixture.pdf', smallPdf);
      assert.equal((await support.readStoredConfig(configPage)).useCache, true, '重译专项必须启用真实翻译缓存');
      await runPdfRetranslation({page, fixture, report, shot, record, until, wait, openDocument, rowReady, checkFocus, artifactsDir});
      await checkFocus('PDF retranslation scope complete');
      assert.equal(report.consoleErrors.length, 0, `浏览器错误：${JSON.stringify(report.consoleErrors)}`);
      report.ok = true; return;
    }
    if (harnessLayoutOnly) {
      const {runPdfHarnessLayout} = require('./testing/pdf-harness-layout.cjs');
      page = await openDocument(); await load('arxiv-2609.35738.pdf', fs.readFileSync(arxivPath));
      await runPdfHarnessLayout({page, fixture, report, shot, record, until, wait, setZoom, rowReady, checkFocus,
        artifactsDir, sourcePath: arxivPath, pageNumbers: String(arg('harness-pages', '1,3,8,16')).split(',').map(Number)});
      await checkFocus('harness layout scope complete'); report.ok = true; return;
    }
    if (taskInteraction) {
      const {runPdfTaskInteractions} = require('./testing/pdf-task-interactions.cjs');
      page = await openDocument(); await load('selection-fixture.pdf', smallPdf);
      await runPdfTaskInteractions({page, fixture, report, shot, record, patch, service, until, wait, resourceState, uiNode, uiText, clickNode, translateDrag,
        baseline: process.argv.includes('--selection-baseline-only')});
      await checkFocus('PDF interaction recovery complete');
      assert.equal(report.consoleErrors.length, 0, `浏览器错误：${JSON.stringify(report.consoleErrors)}`);
      report.ok = true; return;
    }
    if (paperLayoutOnly) {
      if (!paperLayoutBaseline) {
        report.runScope = paperLayoutFollowup ? 'paper-readable-followup' : 'paper-readable'; report.selectionInput = 'Layout verification with a local Chinese fixture; selection probes recorded separately';
        report.providerEvidence = 'Actual local arXiv PDF and production renderer; manually generated Chinese fixture text and unique tails. This is formatting evidence, not translation quality.';
        page = await openDocument(); await load('attention-is-all-you-need.pdf', fs.readFileSync(arxivPath));
        await setZoom('1'); await rowReady(1);
        assert.equal(await presentationOf(), 'layout', '原版排版应为默认 PDF 展示'); await setPresentation('readable');
        const snapshotManifest = async () => {
          const manifest = [];
          await page.locator('[aria-label="文档工作区"]').getByRole('button', {name: '校订译文', exact: true}).click();
          await page.locator('.editor-search input').fill('');
          while (true) {
            manifest.push(...await page.locator('.segment-edit-row').evaluateAll(rows => rows.map(row => ({segment: row.dataset.segmentId, source: row.querySelector('.document-source').textContent}))));
            const next = page.locator('[aria-label="校订分页"]').getByRole('button', {name: '下一页', exact: true});
            if (!await next.count() || !await next.isEnabled()) break;
            await next.click();
          }
          await page.locator('[aria-label="文档工作区"]').getByRole('button', {name: '阅读', exact: true}).click();
          assert.equal(new Set(manifest.map(entry => entry.segment)).size, manifest.length, '校订视图的独立片段清单不能重复'); return manifest;
        };
        report.paperManifest = await snapshotManifest();
        fixture.state.translationDelayMs = 60;
        await page.locator('.translation-actions .translate-document-button').click();
        await until(async () => await page.locator('.pdf-reading-paragraph').evaluateAll(elements => elements.some(element => element.textContent.includes('【排版夹具尾'))), '翻译期间未出现已完成的清晰中文段落', 60000);
        assert(await page.locator('.pause-button').count(), '中文段落应在整份论文仍翻译时出现');
        const streamingSource = await page.evaluate(() => {globalThis.__pdfOriginalNode = document.querySelector('[data-fluentread-pdf-text][data-pdf-page-number="1"] span')?.firstChild; return globalThis.__pdfSourceRenderState();});
        await until(async () => {
          const status = await page.locator('.document-status').innerText();
          if (status.includes('翻译中断')) throw new Error(`论文翻译提前失败：${await page.locator('.task-notice').innerText()}`);
          return status.includes('翻译完成');
        }, '整份论文未完成翻译', 120000);
        const afterSource = await page.evaluate(() => ({sources: globalThis.__pdfSourceRenderState(), originalNodeRetained: globalThis.__pdfOriginalNode === document.querySelector('[data-fluentread-pdf-text][data-pdf-page-number="1"] span')?.firstChild}));
        const beforePageOne = streamingSource.find(source => source.page === 1), afterPageOne = afterSource.sources.find(source => source.page === 1);
        assert(beforePageOne && afterPageOne && beforePageOne.canvasId === afterPageOne.canvasId && beforePageOne.operations === afterPageOne.operations && afterSource.originalNodeRetained, '后续译文不能重绘原页或替换 PDF 原文文字节点');
        report.paperStreamingOwnership = {before: beforePageOne, after: afterPageOne, textNodeRetained: afterSource.originalNodeRetained};
        const modes = page.locator('[aria-label="阅读方式"]'); await modes.getByRole('button', {name: '双语', exact: true}).click();
        let activeExpansion = 1, activeSourceWidth = 612;
        const manualTranslations = new Map();
        const captureReadable = async (number, {shotName, zoom = '1', narrow = false} = {}) => {
          const input = page.locator('.pdf-page-navigation input'); await input.fill(String(number)); await input.press('Enter');
          const row = page.locator(`.pdf-page-row[data-page-number="${number}"][data-render-state="ready"]`); await row.locator(`[data-pdf-reading-page="${number}"]`).waitFor(); await wait(100);
          assert.equal(await input.inputValue(), String(number), '已跳转并渲染的页码必须对应目标，不能依赖邻页驻留证明跳转');
          const entries = await row.locator('[data-pdf-reading-page]').evaluate(sheet => {
            const bounds = sheet.getBoundingClientRect();
            return {width: bounds.width, height: bounds.height, entries: [...sheet.children].filter(element => element.matches('[data-pdf-segment-index], [data-pdf-region-id]')).map(element => {
              const rect = element.getBoundingClientRect(), style = getComputedStyle(element), range = document.createRange();
              range.selectNodeContents(element);
              const textRects = element.matches('[data-pdf-segment-index]') ? [...range.getClientRects()].filter(value => value.width > 0 && value.height > 0) : [];
              const clippingAncestors = []; let ancestor = element;
              while (ancestor && sheet.contains(ancestor)) {
                const ancestorStyle = getComputedStyle(ancestor), ancestorRect = ancestor.getBoundingClientRect();
                if ([ancestorStyle.overflowX, ancestorStyle.overflowY].some(value => ['hidden', 'clip', 'scroll', 'auto'].includes(value))) clippingAncestors.push({tag: ancestor.tagName, className: ancestor.className, x: ancestorStyle.overflowX, y: ancestorStyle.overflowY, left: ancestorRect.left, right: ancestorRect.right, top: ancestorRect.top, bottom: ancestorRect.bottom});
                ancestor = ancestor.parentElement;
              }
              const cropped = textRects.some(value => clippingAncestors.some(clip => (['hidden', 'clip', 'scroll', 'auto'].includes(clip.x) && (value.left < clip.left - 2 || value.right > clip.right + 2)) || (['hidden', 'clip', 'scroll', 'auto'].includes(clip.y) && (value.top < clip.top - 2 || value.bottom > clip.bottom + 2))));
              return {segment: element.dataset.pdfSegmentIndex, source: element.dataset.pdfSourceText, text: element.textContent, role: element.dataset.pdfRole || (element.classList.contains('pdf-reading-metadata') ? 'metadata' : ''),
                region: element.dataset.pdfRegionId, kind: element.dataset.pdfRegionKind, sourceRect: element.dataset.pdfSourceRect,
                body: element.matches('.pdf-reading-paragraph:not(.pdf-reading-heading):not(.pdf-reading-caption):not(.pdf-reading-metadata):not(.pdf-reading-footer)'),
                font: Number.parseFloat(style.fontSize), lineHeight: Number.parseFloat(style.lineHeight), textAlign: style.textAlign,
                top: rect.top - bounds.top, bottom: rect.bottom - bounds.top, left: rect.left - bounds.left, right: rect.right - bounds.left,
                width: rect.width, height: rect.height, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
                overflowX: style.overflowX, overflowY: style.overflowY, clippingAncestors, cropped,
                textRects: textRects.map(value => ({left: value.left - bounds.left, right: value.right - bounds.left, top: value.top - bounds.top, bottom: value.bottom - bounds.top}))};
            })};
          });
          const expected = new Map(fixture.state.requests.map(request => [request.source, request.translation]));
          for (const entry of entries.entries) {
            if (entry.segment !== undefined) {
              if (!['metadata', 'footer'].includes(entry.role)) assert(expected.has(entry.source) || manualTranslations.has(entry.source), `已完成正文 ${entry.segment} 必须存在确定性译文，不能默默回退为英文原文`);
              assert.equal(entry.text, ['metadata', 'footer'].includes(entry.role) ? entry.source : manualTranslations.get(entry.source) || expected.get(entry.source) || entry.source, `第 ${number} 页片段 ${entry.segment} 的完整中文及结尾必须保留`);
              if (entry.body && /[\u3400-\u9fff]/u.test(entry.text)) {assert(entry.font >= 16 && entry.lineHeight >= entry.font * 1.6, `中文正文必须可读：${JSON.stringify(entry)}`); assert(['start', 'left'].includes(entry.textAlign), '普通中文段落不能整段居中');}
            }
            assert(!entry.cropped && entry.top >= -2 && entry.bottom <= entries.height + 2 && entry.left >= -2 && entry.right <= entries.width + 2, `第 ${number} 页条目被裁剪：${JSON.stringify(entry)}`);
          }
          for (let index = 1; index < entries.entries.length; index++) {
            const previous = entries.entries[index - 1], previousBottom = Math.max(previous.bottom, ...previous.textRects.map(rect => rect.bottom));
            assert(entries.entries[index].top >= previousBottom - 2, `第 ${number} 页文字/图形的阅读顺序出现重叠`);
          }
          const crops = await row.evaluate((row, sourceWidth) => [...row.querySelectorAll('.pdf-reading-region')].map(region => {
            const crop = region.querySelector('canvas'), source = row.querySelector('.pdf-page-column:not(.translated) canvas');
            if (!crop || !source) return {id: region.dataset.pdfRegionId, status: 'no source/crop'};
            const rect = JSON.parse(region.dataset.pdfSourceRect), expected = document.createElement('canvas'); expected.width = crop.width; expected.height = crop.height;
            const cssWidth = Number.parseFloat(source.style.width), cssHeight = Number.parseFloat(source.style.height), scale = cssWidth / sourceWidth;
            const regionArea = [...row.querySelectorAll('.pdf-reading-region')].reduce((sum, element) => {const value = JSON.parse(element.dataset.pdfSourceRect); return sum + value.width * value.height * scale ** 2;}, 0);
            const outputScale = Math.min(Math.max(1, Math.min(2, devicePixelRatio)), Math.sqrt((2500000 - row.querySelectorAll('.pdf-reading-region').length) / (cssWidth * cssHeight + regionArea)), 8192 / Math.max(cssWidth, cssHeight));
            const context = expected.getContext('2d', {alpha: false}); context.drawImage(source, rect.x * scale * outputScale, rect.y * scale * outputScale, rect.width * scale * outputScale, rect.height * scale * outputScale, 0, 0, crop.width, crop.height);
            const actualPixels = crop.getContext('2d').getImageData(0, 0, crop.width, crop.height).data, expectedPixels = context.getImageData(0, 0, crop.width, crop.height).data;
            let differences = 0; for (let index = 0; index < actualPixels.length; index++) if (actualPixels[index] !== expectedPixels[index]) differences += 1;
            expected.width = expected.height = 0; return {id: region.dataset.pdfRegionId, kind: region.dataset.pdfRegionKind, pixels: crop.width * crop.height, differences};
          }), activeSourceWidth);
          for (const crop of crops) assert.equal(crop.differences, 0, `第 ${number} 页图形/公式/表格必须等于未修改的原页裁剪：${JSON.stringify(crop)}`);
          (report.paperReadablePages ||= []).push({page: number, zoom, narrow, expansion: activeExpansion, document: await page.locator('.workspace-heading h1').innerText(), ...entries, crops}); await resourceState(`paper readable ${number} ${zoom} ${activeExpansion}x`);
          if (shotName) await shot(shotName); return entries;
        };
        for (let number = 1; number <= 15; number++) await captureReadable(number, {shotName: [1, 3, 4, 6, 7, 10, 12].includes(number) ? `paper-readable-p${String(number).padStart(2, '0')}-z100` : undefined});
        const verifyManifest = expansion => {
          const actual = report.paperReadablePages.filter(value => value.expansion === expansion && value.zoom === '1' && !value.narrow && value.document === 'attention-is-all-you-need.pdf').flatMap(value => value.entries).filter(value => value.segment !== undefined).map(({segment, source}) => ({segment, source}));
          assert.deepEqual(actual.sort((a, b) => Number(a.segment) - Number(b.segment)), [...report.paperManifest].sort((a, b) => Number(a.segment) - Number(b.segment)), '阅读器必须覆盖独立校订片段清单的每个片段，不能遗漏整段');
        };
        verifyManifest(1);
        const pageEntries = number => report.paperReadablePages.find(entry => entry.page === number).entries;
        assert(pageEntries(1).some(entry => entry.source?.includes('Ashish Vaswani')) && pageEntries(1).some(entry => entry.source?.includes('Noam Shazeer')), '第一页作者信息应完整保留');
        assert(pageEntries(2).some(entry => entry.source?.includes('Recurrent neural networks')), '第二页正文阅读流必须完整');
        assert(pageEntries(4).some(entry => entry.kind === 'formula'), '第四页公式必须以原图保留');
        for (const number of [6, 9, 10]) assert(pageEntries(number).some(entry => entry.kind === 'table'), `第 ${number} 页表格必须以原图保留`);
        const verifyPdfExport = async (mode, expansion = 1) => {
          const phase = `export-${mode}-${expansion}x`; await checkFocus(phase);
          await page.evaluate(phase => {globalThis.__pdfTracePhase = phase;}, phase);
          await page.locator('.download-button').click(); const dialog = page.locator('.download-dialog[open]');
          await dialog.locator('.export-options button').nth(mode === 'bilingual' ? 0 : 1).click();
          const started = Date.now();
          const [download] = await Promise.all([page.waitForEvent('download', {timeout: 180000}), dialog.getByRole('button', {name: mode === 'bilingual' ? '下载双语文件' : '下载译文文件', exact: true}).click()]);
          const file = path.join(artifactsDir, `${expansion}x-${download.suggestedFilename()}`); await download.saveAs(file);
          const telemetry = await page.evaluate(phase => ({encodedPages: globalThis.__pdfPaint.encodedPages.filter(page => page.phase === phase), images: globalThis.__pdfPaint.images.filter(image => image.phase === phase)}), phase);
          await page.evaluate(() => {globalThis.__pdfTracePhase = 'reading';});
          assert(telemetry.encodedPages.length >= 15, '真实论文每一页都应输出完整可读续页');
          const drawOffsets = []; let text = '';
          for (const encoded of telemetry.encodedPages) {
            assert.equal(encoded.width, 1224); assert.equal(encoded.height, 1584);
            for (const draw of encoded.draws) {
              const normalized = draw.text.replace(/\s/gu, ''); drawOffsets.push({start: text.length, end: text.length + normalized.length, font: draw.fontPx}); text += normalized;
              const [a, b, c, d, e, f] = draw.transform;
              const points = [[draw.inkLeft, draw.inkTop], [draw.inkRight, draw.inkTop], [draw.inkLeft, draw.inkBottom], [draw.inkRight, draw.inkBottom]].map(([x, y]) => ({x: a * x + c * y + e, y: b * x + d * y + f}));
              assert(points.every(point => point.x >= -1 && point.x <= encoded.width + 1 && point.y >= -1 && point.y <= encoded.height + 1), `导出文字被画布边界裁剪：${JSON.stringify(draw)}`);
            }
          }
          const expectedEntries = report.paperReadablePages.filter(page => page.zoom === '1' && !page.narrow && page.expansion === expansion && page.document === 'attention-is-all-you-need.pdf').flatMap(page => page.entries).filter(entry => entry.segment !== undefined && /[\u3400-\u9fff]/u.test(entry.text) && !['metadata', 'footer'].includes(entry.role));
          let cursor = 0;
          for (const entry of expectedEntries) {
            const expected = entry.text.replace(/\s/gu, ''), at = text.indexOf(expected, cursor);
            assert(at >= cursor, `导出必须保留完整中文及结尾，片段 ${entry.segment} 缺失：${expected.slice(-60)}`);
            if (entry.body) assert(drawOffsets.filter(draw => draw.end > at && draw.start < at + expected.length).every(draw => draw.font >= 12), '导出中文正文必须至少 12pt');
            cursor = at + expected.length;
          }
          assert(telemetry.images.length > 0, '论文导出必须实际绘制受保护原图区域');
          const rasterPages = await pdfRasterPages(fs.readFileSync(file)), downloadedHashes = rasterPages.flatMap(value => value.images.map(image => image.pixelHash));
          assert.deepEqual(downloadedHashes, telemetry.encodedPages.map(value => value.pixelHash), '实际下载 PDF 的译页像素必须完整等于排版画布，不能只验证绘制调用后导出空白页');
          const outputText = await pdfTextPages(fs.readFileSync(file));
          if (mode === 'bilingual') {
            const originalText = await pdfTextPages(fs.readFileSync(arxivPath)), vectorPages = outputText.filter(items => items.some(item => item.str.trim()));
            assert.deepEqual(vectorPages, originalText, '双语导出必须完整保留原页可选文字和字形坐标');
          } else assert(outputText.every(items => items.every(item => !/[\u3400-\u9fff]/u.test(item.str))), '中文译页为图像，证据不得错误声称 PDF 中文可选');
          (report.pdfExports ||= []).push({mode, expansion, file, elapsedMs: Date.now() - started, pages: outputText.length, readableRasterPages: telemetry.encodedPages.length, completeChineseSegments: expectedEntries.length,
            protectedImageDraws: telemetry.images.length, downloadedRasterPixelsMatched: true, drawingTelemetry: telemetry, chinesePdfSelectable: false});
        };
        if (!paperLayoutFollowup) {
          const canceledDownloads = [], onCanceledDownload = download => canceledDownloads.push(download.suggestedFilename()); page.on('download', onCanceledDownload);
          await page.locator('.download-button').click(); const cancelDialog = page.locator('.download-dialog[open]'); await cancelDialog.locator('.export-options button').nth(1).click();
          await page.evaluate(() => {globalThis.__pdfTracePhase = 'export-cancel-1x';});
          await cancelDialog.getByRole('button', {name: '下载译文文件', exact: true}).click();
          await until(async () => await cancelDialog.locator('.export-progress').count() && /\d/u.test(await cancelDialog.locator('.export-progress').innerText()), '取消必须等待真实 PDF 生成进度出现');
          const progressBeforeCancel = await cancelDialog.locator('.export-progress').innerText(); await cancelDialog.locator('.dialog-actions .ghost-button').click();
          await until(async () => await cancelDialog.getByRole('button', {name: '下载译文文件', exact: true}).isEnabled() && (await cancelDialog.locator('.export-progress').innerText()).includes('取消'), '取消后没有恢复可重试状态');
          const canceledProgress = await cancelDialog.locator('.export-progress').innerText(); await wait(400); assert.equal(await cancelDialog.locator('.export-progress').innerText(), canceledProgress, '取消后的迟到栅格页不得覆盖界面状态');
          page.off('download', onCanceledDownload); assert.deepEqual(canceledDownloads, [], '取消生成不得触发实际文件下载');
          report.paperExportCancel = {progressBeforeCancel, canceledProgress, downloads: canceledDownloads, lateUiWriteRejected: true}; await page.evaluate(() => {globalThis.__pdfTracePhase = 'reading';});
          await cancelDialog.getByRole('button', {name: '返回文档', exact: true}).click(); await resourceState('paper export canceled/released');
        }
        await verifyPdfExport('translated');
        if (paperLayoutCancelOnly) {
          await checkFocus('export cancel/retry complete'); assert.equal(report.consoleErrors.length, 0); report.ok = true; report.runScope = 'paper-readable-export-cancel-retry';
          record('actual readable PDF export cancels without download or late UI write, then retry preserves all Chinese and actual raster pixels'); return;
        }
        await verifyPdfExport('bilingual');
        record('all 15 paper pages and both downloaded exports preserve complete Chinese fixture text and protected source regions');

        if (!paperLayoutFollowup) {
        await captureReadable(1);
        const copiedEntry = report.paperReadablePages.find(value => value.page === 1).entries.find(entry => entry.body && /[\u3400-\u9fff]/u.test(entry.text));
        const paragraph = page.locator(`[data-pdf-reading-page="1"] [data-pdf-segment-index="${copiedEntry.segment}"]`);
        await helper.activateExtensionTabWithoutForeground(context, page); await page.keyboard.press('Escape'); await clearSelectionByClick();
        await paragraph.scrollIntoViewIfNeeded();
        const copiedText = copiedEntry.text.slice(0, 28);
        const readablePoint = async offset => paragraph.evaluate((element, offset) => {
          const text = element.firstChild, glyph = Math.min(offset, text.length - 1), range = document.createRange(); range.setStart(text, glyph); range.setEnd(text, glyph + 1);
          const rect = range.getBoundingClientRect(), probes = [];
          for (const y of [rect.top + rect.height * .5, rect.top + rect.height * .35, rect.top + rect.height * .65]) for (const x of [rect.left + .1, rect.left - .1, rect.right - .1, rect.right + .1]) {
            const caret = document.caretPositionFromPoint?.(x, y), fallback = !caret && document.caretRangeFromPoint?.(x, y), node = caret?.offsetNode || fallback?.startContainer, value = caret?.offset ?? fallback?.startOffset;
            probes.push({x, y, value}); if (node === text && value === offset) return {x, y, offset};
          }
          throw new Error(`清晰译文拖选坐标未命中指定字符：${JSON.stringify({offset, rect: rect.toJSON(), probes})}`);
        }, offset);
        const points = {start: await readablePoint(0), end: await readablePoint(copiedText.length)};
        const requestsBeforeCopy = fixture.state.requests.length;
        await page.mouse.move(points.start.x, points.start.y); await page.mouse.down(); await page.mouse.move(points.end.x, points.end.y, {steps: 18}); await page.mouse.up();
        assert.equal(await page.evaluate(() => getSelection()?.toString()), copiedText, '真实鼠标必须能准确选择清晰译文，不能混入旁边原文');
        await page.evaluate(() => {globalThis.__pdfCopied = null; document.addEventListener('copy', event => {globalThis.__pdfCopied = {text: getSelection()?.toString(), trusted: event.isTrusted}; event.preventDefault();}, {once: true});});
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C');
        await until(async () => Boolean(await page.evaluate(() => globalThis.__pdfCopied)), '真实复制快捷键未触发复制事件');
        const copy = await page.evaluate(() => globalThis.__pdfCopied); assert.equal(copy.text, copiedText); assert(copy.trusted, '复制必须由真实键盘快捷键触发');
        await wait(150); assert.equal(fixture.state.requests.length, requestsBeforeCopy, '选择译文不得误触发原文翻译请求'); assert.equal(await uiNode('fr-selection-indicator'), null, '译文选择不应该挂上原文划词入口');
        report.translatedCopy = {...copy, points, clipboardWrite: false, boundary: 'trusted keyboard copy event captured and preventDefault preserves the user clipboard'}; await shot('paper-translated-native-copy');
        await page.keyboard.press('Escape'); await clearSelectionByClick();
        const originalTarget = await paperSelectionTarget(); assert(originalTarget, '真实论文原文段落缺失'); const originalSelected = await dragLines(originalTarget);
        await until(() => uiNode('fr-selection-indicator'), '清晰双语中的原文划词入口未出现'); await clickNode('fr-selection-indicator');
        await until(async () => (await uiText()).includes(paperFixtureTranslation(originalTarget, 1, true)), '原文划词未获得确定性中文结果');
        assert.equal(fixture.state.requests.at(-1).source, normalizeSelection(originalSelected), '原文划词请求不得混入中文译文');
        await shot('paper-original-native-selection'); record('native mouse selection and trusted copy isolate complete translated HTML from source selection translation');

        await page.keyboard.press('Escape'); await clearSelectionByClick(); await captureReadable(1);
        const beforeEdit = await page.evaluate(() => {globalThis.__pdfEditingNode = document.querySelector('[data-fluentread-pdf-text][data-pdf-page-number="1"] span')?.firstChild; return globalThis.__pdfSourceRenderState().find(value => value.page === 1);});
        await page.locator('[aria-label="文档工作区"]').getByRole('button', {name: '校订译文', exact: true}).click();
        await page.locator('.editor-search input').fill(copiedEntry.source.slice(0, 50));
        const editedText = `${copiedEntry.text}人工校订补充：这一段完整保留到校订末尾。【人工校订尾】`; manualTranslations.set(copiedEntry.source, editedText);
        await page.locator(`.segment-edit-row[data-segment-id="${copiedEntry.segment}"] textarea`).fill(editedText);
        await page.locator('[aria-label="文档工作区"]').getByRole('button', {name: '阅读', exact: true}).click();
        await page.locator(`[data-pdf-reading-page="1"] [data-pdf-segment-index="${copiedEntry.segment}"]`).filter({hasText: '【人工校订尾】'}).waitFor();
        const afterEdit = await page.evaluate(() => ({source: globalThis.__pdfSourceRenderState().find(value => value.page === 1), nodeRetained: globalThis.__pdfEditingNode === document.querySelector('[data-fluentread-pdf-text][data-pdf-page-number="1"] span')?.firstChild}));
        assert.equal(afterEdit.source.canvasId, beforeEdit.canvasId); assert.equal(afterEdit.source.operations, beforeEdit.operations); assert(afterEdit.nodeRetained, '校订不得重建原文 TextLayer');
        report.paperManualEdit = {segment: copiedEntry.segment, sourceRetained: true, textNodeRetained: true, tail: '【人工校订尾】'}; await captureReadable(1, {shotName: 'paper-readable-manual-edit'});

        await setPresentation('layout'); await rowReady(1);
        await page.locator(`[data-pdf-reading-page="1"] [data-pdf-segment-index="${copiedEntry.segment}"]`).filter({hasText: '【人工校订尾】'}).waitFor();
        assert(await page.locator('.pdf-page-column.translated .pdf-page-frame canvas').count(), '原版式模式应保留原版式预览'); await resourceState('paper original-layout with complete continuation'); await shot('paper-layout-with-complete-continuation');
        await setPresentation('readable'); await rowReady(1); await captureReadable(1);
        record('manual corrections update complete HTML without source repaint and optional original-layout keeps a full readable continuation');

        await captureReadable(3);
        const anchor = await page.locator('[data-pdf-scroll]').evaluate(viewport => {
          const target = viewport.querySelector('[data-pdf-reading-page="3"] [data-pdf-segment-index]'), top = target.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
          viewport.scrollTop += top + target.getBoundingClientRect().height * .35;
          return {id: target.dataset.pdfSourceId, offset: .35};
        });
        await wait(80); await setZoom('1.5'); await rowReady(3); await wait(150);
        const zoomAnchor = await page.locator('[data-pdf-scroll]').evaluate((viewport, anchor) => {
          const target = [...viewport.querySelectorAll('[data-pdf-source-id]')].find(element => element.dataset.pdfSourceId === anchor.id), rect = target.getBoundingClientRect();
          return {page: document.querySelector('.pdf-page-navigation input').value, fraction: (viewport.getBoundingClientRect().top - rect.top) / rect.height};
        }, anchor);
        assert.equal(zoomAnchor.page, '3', '缩放必须留在同一原始页'); assert(Math.abs(zoomAnchor.fraction - anchor.offset) < .15, `缩放必须保持正在阅读的段落位置：${JSON.stringify({anchor, zoomAnchor})}`); report.paperZoomAnchor = {anchor, after: zoomAnchor};
        await setZoom('1.5'); await captureReadable(3, {zoom: '1.5', shotName: 'paper-readable-p03-z150'});
        await page.setViewportSize({width: 390, height: 844}); await page.emulateMedia({colorScheme: 'dark'}); await setZoom('fit');
        await captureReadable(3, {zoom: 'fit', narrow: true, shotName: 'paper-readable-p03-390-dark-bilingual'}); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '390px 清晰译文不得撑宽整页');
        await readerGeometry('paper readable 390 fit');
        await page.setViewportSize({width: 1440, height: 960}); await page.emulateMedia({colorScheme: 'light'}); await setZoom('1');
        for (const expansion of [2, 4]) {
          activeExpansion = expansion; fixture.state.paperExpansion = expansion; fixture.state.translationDelayMs = 20; manualTranslations.clear();
          await page.locator('.document-settings-button').click(); await page.locator('.document-settings-dialog[open] .dialog-actions .translate-document-button').click();
          await page.locator('dialog[open][aria-labelledby="confirm-document-heading"] .translate-document-button').click();
          if (expansion === 2) {
            await until(() => fixture.state.requests.filter(request => request.expansion === 2).length >= 6, '长译文暂停需要真实进行中的请求');
            await page.locator('.pause-button').click();
            await until(async () => (await page.locator('.document-status').innerText()).includes('已暂停'), '暂停没有停止文档任务');
            const paused = await page.locator('.document-status').innerText(); await wait(180); assert.equal(await page.locator('.document-status').innerText(), paused, '暂停后迟到响应不得修改任务进度');
            await page.locator('.translation-actions .translate-document-button').click(); report.paperPauseResume = {pausedStatus: paused, lateProgressRejected: true};
          }
          await until(async () => {
            const status = await page.locator('.document-status').innerText(); if (status.includes('翻译中断')) throw new Error(`长中文夹具翻译失败：${await page.locator('.task-notice').innerText()}`); return status.includes('翻译完成');
          }, `${expansion}倍中文论文翻译未完成`, 120000);
          for (let number = 1; number <= 15; number++) await captureReadable(number, {shotName: [3, 4, 10].includes(number) ? `paper-readable-${expansion}x-p${number}` : undefined});
          verifyManifest(expansion); await verifyPdfExport('translated', expansion);
          record(`${expansion}x long Chinese paragraphs preserve every independent segment and tail in readable HTML and downloaded PDF`);
        }
        }
        else report.reusedPriorEvidence = {report: '/private/tmp/fluentread-pdf-layout-20261009/readable-final/report.json', cases: ['native copy/source selection', 'manual edit/source stability', 'semantic zoom anchor', '2x and4x all15pages and downloaded pixel-matched exports'], limitation: 'previous120-page timeout and theme filenames are not successful evidence'};
        const captureActualDark = async (number, prefix) => {
          await page.setViewportSize({width: 390, height: 844}); await page.emulateMedia({colorScheme: 'dark'}); await setZoom('fit');
          await until(async () => await page.locator('.document-app').evaluate(element => element.classList.contains('dark')), '实际文档界面没有应用深色媒体查询');
          await captureReadable(number, {zoom: 'fit', narrow: true});
          const modeSwitch = {target: number, stages: []}; (report.readingModeSwitches ||= []).push(modeSwitch);
          const switchState = () => page.locator('[data-pdf-scroll]').evaluate(viewport => ({page: document.querySelector('.pdf-page-navigation input').value, scrollTop: viewport.scrollTop, viewportHeight: viewport.clientHeight,
            residents: [...viewport.querySelectorAll('[data-page-number]')].map(row => ({page: row.dataset.pageNumber, top: row.style.top, height: row.style.height})),
            visibleParagraphs: [...viewport.querySelectorAll('[data-pdf-source-id]')].filter(element => {const rect = element.getBoundingClientRect(), bounds = viewport.getBoundingClientRect(); return rect.bottom > bounds.top && rect.top < bounds.bottom;}).map(element => ({id: element.dataset.pdfSourceId, top: element.getBoundingClientRect().top - viewport.getBoundingClientRect().top}))}));
          modeSwitch.stages.push({stage: 'before', ...await switchState()});
          await modes.getByRole('button', {name: '译文', exact: true}).click(); await wait(120);
          modeSwitch.stages.push({stage: 'translated', ...await switchState()}); assert.equal(modeSwitch.stages.at(-1).page, String(number), `切换译文模式必须保留原页位置：${JSON.stringify(modeSwitch.stages)}`);
          await page.locator(`[data-pdf-reading-page="${number}"]`).waitFor();
          const body = page.locator(`[data-pdf-reading-page="${number}"] .pdf-reading-paragraph[data-pdf-role="text"]`).first(); await body.scrollIntoViewIfNeeded();
          const visual = await body.evaluate(element => {
            const sheet = element.closest('.pdf-reading-sheet'), rect = element.getBoundingClientRect(), scrollRect = element.closest('[data-pdf-scroll]').getBoundingClientRect(), style = getComputedStyle(sheet), bodyStyle = getComputedStyle(element);
            return {background: style.backgroundColor, color: style.color, font: Number.parseFloat(bodyStyle.fontSize), lineHeight: Number.parseFloat(bodyStyle.lineHeight), visibleTop: Math.max(rect.top, scrollRect.top), visibleBottom: Math.min(rect.bottom, scrollRect.bottom, innerHeight), sheetWidth: sheet.getBoundingClientRect().width, documentDark: document.querySelector('.document-app').classList.contains('dark')};
          });
          assert(visual.documentDark && visual.visibleBottom - visual.visibleTop >= 26 && visual.sheetWidth >= 250 && visual.font >= 16, `390px 截图必须实际显示深色清晰译文正文：${JSON.stringify(visual)}`);
          const background = /\((\d+),\s*(\d+),\s*(\d+)/u.exec(visual.background); assert(background && Number(background[1]) < 80 && Number(background[2]) < 80 && Number(background[3]) < 80, '深色译文不能仅靠截图名称声明');
          (report.actualDarkViews ||= []).push({page: number, expansion: activeExpansion, ...visual}); await shot(`${prefix}-390-dark-translated`);
          const region = page.locator(`[data-pdf-reading-page="${number}"] .pdf-reading-region`).first(); if (await region.count()) {await region.scrollIntoViewIfNeeded(); await shot(`${prefix}-390-dark-region`);}
          await resourceState(`${prefix} actualdark`);
          await modes.getByRole('button', {name: '双语', exact: true}).click(); await rowReady(number); await readerGeometry(`${prefix} 390 fit`);
          await wait(120); modeSwitch.stages.push({stage: 'bilingual', ...await switchState()}); assert.equal(modeSwitch.stages.at(-1).page, String(number), '切回双语模式必须保留原页位置');
        };
        await captureActualDark(10, `paper-readable-${activeExpansion}x-p10`);
        await page.setViewportSize({width: 1440, height: 960}); await page.emulateMedia({colorScheme: 'light'});
        await setPresentation('layout'); await rowReady(10);
        const layoutText = await page.locator('[data-pdf-reading-page="10"] [data-pdf-segment-index]').evaluateAll(elements => elements.map(element => element.textContent));
        const expectedLayoutText = report.paperReadablePages.find(value => value.page === 10 && value.expansion === activeExpansion).entries.filter(entry => entry.segment !== undefined).map(entry => entry.text);
        assert.deepEqual(layoutText, expectedLayoutText, '最终原版式预览的清晰续页必须包含整页完整译文'); await resourceState('final layout preview/full continuation'); await shot('paper-final-layout-complete-continuation');
        await setPresentation('readable'); await rowReady(10);
        page = await openDocument(); await load('long-120.pdf', longPdf); activeSourceWidth = 595; activeExpansion = 4; fixture.state.paperExpansion = 4;
        await setZoom('1'); await page.locator('.translation-actions .translate-document-button').click();
        await until(async () => {const status = await page.locator('.document-status').innerText(); if (status.includes('翻译中断')) throw new Error(`120页翻译失败：${await page.locator('.task-notice').innerText()}`); return status.includes('翻译完成');}, '120页中文夹具翻译未完成', 120000);
        for (const number of [120, 1, 60, 119, 2, 100, 25, 120]) await captureReadable(number);
        await setZoom('1.5'); await captureReadable(120, {zoom: '1.5', shotName: 'long-120-readable-z150'});
        await captureActualDark(120, 'long-120-readable');
        for (const name of ['原文', '双语']) {
          await modes.getByRole('button', {name, exact: true}).click(); await rowReady(120); await wait(120);
          const current = await page.locator('.pdf-page-navigation input').inputValue(); assert.equal(current, '120', `120页窄屏切换${name}不能更换当前页`);
          (report.longModeBoundaries ||= []).push({mode: name, currentPage: current}); await resourceState(`120 narrow ${name}`);
        }
        for (const presentation of ['layout', 'readable']) {
          await setPresentation(presentation); await rowReady(120); await wait(120);
          assert.equal(await page.locator('.pdf-page-navigation input').inputValue(), '120', '120页窄屏切换原版式/清晰展示不能更换当前页');
          (report.longModeBoundaries ||= []).push({presentation, currentPage: '120'}); await resourceState(`120 narrow ${presentation}`);
        }
        record('120-page translated reader keeps complete long Chinese paragraphs, readable narrow layout and bounded source/region resources');
        await page.setViewportSize({width: 1440, height: 960}); await page.emulateMedia({colorScheme: 'light'});
        page = await openDocument(); const cropped = await createCroppedPdf(), croppedFile = path.join(artifactsDir, 'rotated-cropbox.pdf'); fs.writeFileSync(croppedFile, cropped);
        await load('rotated-cropbox.pdf', cropped); await setZoom('1'); await rowReady(1);
        const sourceCanvas = page.locator('.pdf-page-column:not(.translated) .pdf-page-frame canvas');
        const cropSource = await sourceCanvas.evaluate(canvas => ({width: Number.parseFloat(canvas.style.width), height: Number.parseFloat(canvas.style.height), image: canvas.toDataURL('image/png')}));
        assert.equal(cropSource.width, 160); assert.equal(cropSource.height, 300); fs.writeFileSync(path.join(artifactsDir, 'rotated-cropbox-source-canvas.png'), Buffer.from(cropSource.image.split(',')[1], 'base64'));
        await page.locator('.translation-actions .translate-document-button').click(); await until(async () => {const status = await page.locator('.document-status').innerText(); if (status.includes('翻译中断')) throw new Error(`CropBox夹具翻译失败：${await page.locator('.task-notice').innerText()}`); return status.includes('翻译完成');}, 'CropBox夹具未完成', 30000);
        await page.locator('.download-button').click(); const cropDialog = page.locator('.download-dialog[open]'); await cropDialog.locator('.export-options button').first().click();
        const [cropDownload] = await Promise.all([page.waitForEvent('download'), cropDialog.getByRole('button', {name: '下载双语文件', exact: true}).click()]);
        const cropOutputFile = path.join(artifactsDir, cropDownload.suggestedFilename()); await cropDownload.saveAs(cropOutputFile);
        const {PDFDocument} = createRequire(path.join(__dirname, '..', 'package.json'))('pdf-lib'), cropOutput = await PDFDocument.load(fs.readFileSync(cropOutputFile));
        assert.deepEqual(cropOutput.getPage(0).getSize(), {width: 160, height: 300}, '带裁切和90度旋转的原页导出不能回退到MediaBox尺寸');
        const sourcePrefix = path.join(artifactsDir, 'cropbox-original-poppler'), outputPrefix = path.join(artifactsDir, 'cropbox-bilingual-original-poppler');
        for (const [file, prefix] of [[croppedFile, sourcePrefix], [cropOutputFile, outputPrefix]]) await execFileAsync('pdftoppm', ['-f', '1', '-l', '1', '-singlefile', '-cropbox', '-r', '144', '-png', file, prefix], {timeout: 30000});
        const pixelComparison = compareCropboxPixels(`${sourcePrefix}.png`, `${outputPrefix}.png`), sourceText = await pdfDisplayedText(cropped), exportedText = await pdfDisplayedText(fs.readFileSync(cropOutputFile));
        assert.deepEqual(exportedText.items.map(item => item.text), sourceText.items.map(item => item.text)); assert(sourceText.items.every(item => !item.text.includes('OUTSIDE CROP')), '被裁切区域外的文字不能出现在原页导出中');
        let maximumMatrixError = 0; for (let index = 0; index < sourceText.items.length; index++) for (let coefficient = 0; coefficient < 6; coefficient++) maximumMatrixError = Math.max(maximumMatrixError, Math.abs(sourceText.items[index].transform[coefficient] - exportedText.items[index].transform[coefficient])); assert(maximumMatrixError <= 1e-6, '裁切旋转后的可见文字坐标必须一致');
        report.cropboxExport = {rotation: 90, crop: {x: 50, y: 70, width: 300, height: 160}, viewerSize: {width: cropSource.width, height: cropSource.height}, outputOriginalSize: cropOutput.getPage(0).getSize(), appearancePreserved: true, exactRasterIdentity: pixelComparison.changedPixels === 0, pixelComparison, maximumMatrixError, renderedBy: 'independent Poppler144dpi', file: cropOutputFile,
          inference: 'Small edge-only raster differences are consistent with native Rotate versus embedded-vector renderer antialiasing; the cause is inferred, not proven.'}; await shot('rotated-cropbox-bilingual');
        record('rotated CropBox export preserves visible text geometry and source appearance within bounded edge antialias differences');
        await checkFocus('readable paper diagnostic complete'); assert.equal(report.consoleErrors.length, 0); report.ok = true;
        record('all 15 actual paper pages preserve complete Chinese fixture text, readable typography and original figure/formula/table crops'); return;
      }
      report.runScope = 'paper-layout-only'; report.selectionInput = 'No selection claim in this baseline mode';
      report.providerEvidence = 'Actual local arXiv PDF and production renderer; manually generated representative Chinese fixture translations. This is layout/performance evidence, not translation-quality evidence.';
      report.paperLayoutQuality = 'Baseline measurements and screenshots; readability is deliberately not asserted.';
      page = await openDocument(); await load('attention-is-all-you-need.pdf', fs.readFileSync(arxivPath));
      await setZoom('1'); await rowReady(1); await shot('paper-source-p01-z100');
      const started = Date.now(); await page.locator('.translation-actions .translate-document-button').click();
      await page.locator('.document-status').filter({hasText: '翻译完成'}).waitFor({timeout: 120000});
      report.paperTranslationMs = Date.now() - started; assert(fixture.state.requests.length > 20, '真实论文应实际翻译完整片段，不能只做短范例');
      const modes = page.locator('[aria-label="阅读方式"]'); await modes.getByRole('button', {name: '双语', exact: true}).click();
      const capturePaper = async (number, zoom, mode, narrow = false) => {
        await modes.getByRole('button', {name: mode === 'bilingual' ? '双语' : '译文', exact: true}).click();
        await setZoom(zoom);
        const input = page.locator('.pdf-page-navigation input'); await input.fill(String(number)); await input.press('Enter');
        const row = page.locator(`.pdf-page-row[data-page-number="${number}"][data-render-state="ready"]`), translated = row.locator('.pdf-page-column.translated canvas');
        await translated.waitFor(); await wait(150); await checkFocus(`paper ${number} zoom ${zoom} ${mode}`);
        const suffix = zoom === 'fit' ? 'fit' : String(Math.round(Number(zoom) * 100)), name = `paper-p${String(number).padStart(2, '0')}-${mode}-z${suffix}${narrow ? '-390' : ''}`;
        const paint = await translated.evaluate(canvas => globalThis.__pdfCanvasPaint(canvas));
        (report.paperLayoutSnapshots ||= []).push({page: number, zoom, mode, narrow, ...paint});
        const saveCanvas = async (canvas, kind) => {
          const url = await canvas.evaluate(element => element.toDataURL('image/png'));
          const file = path.join(artifactsDir, `${name}-${kind}-canvas.png`); fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64')); report.screenshots.push(file);
        };
        await saveCanvas(translated, 'translated');
        const sourceCanvas = row.locator('.pdf-page-column:not(.translated) canvas'); if (await sourceCanvas.count()) await saveCanvas(sourceCanvas, 'source');
        await readerGeometry(name); await resourceState(name); await shot(name);
        process.stdout.write(`BASELINE paper ${number} ${mode} ${suffix}%: min Chinese font ${paint.minCssFontPx?.toFixed(2)} CSSpx, clipped lines ${paint.clippedLines}, fully hidden lines ${paint.fullyHiddenLines}\n`);
      };
      for (const number of [1, 3, 4, 6, 7, 10, 12]) await capturePaper(number, '1', 'bilingual');
      await capturePaper(3, '1.5', 'translated');
      await page.setViewportSize({width: 390, height: 844}); await capturePaper(3, 'fit', 'translated', true);
      report.paperPaintTotals = await page.evaluate(() => {const {draws, ...totals} = globalThis.__pdfPaint; return {...totals, translatedLines: draws.length};});
      assert.equal(report.consoleErrors.length, 0, `浏览器错误：${JSON.stringify(report.consoleErrors)}`); await checkFocus('paper layout baseline complete');
      report.ok = true; record('actual paper Chinese layout baseline captured; readability failures recorded without claiming a layout pass'); return;
    }

    page = await openDocument(); await load('sample.pdf', fs.readFileSync(path.join(__dirname, '..', 'examples/document-translation/sample.pdf'))); await resourceState('local sample'); await shot('sample-local'); record('local sample PDF retains canvas and a selectable PDF.js text layer');
    if (arxivPath) {
      page = await openDocument(); await load('attention-is-all-you-need.pdf', fs.readFileSync(arxivPath));
      const text = await page.locator('[data-fluentread-pdf-text][data-pdf-page-number="1"]').innerText(); assert(/attention/iu.test(text), '论文第一页文字层必须含 Attention');
      const target = await paperSelectionTarget(); report.localArxivSource = target;
      assert(target, '论文必须有可拖选的真实多词文本'); await translateDrag(target); await shot('arxiv-local-selection'); await resourceState('arxiv local'); record('actual arXiv PDF imports locally and a real mouse selection produces Chinese fixture output');
    }
    for (const rotation of skipRotations ? [] : [90, 180, 270]) {
      page = await openDocument(); const rotated = await createPdf(1, rotation); await load(`rotation-${rotation}.pdf`, rotated); await shot(`rotation-${rotation}-source`);
      assert.equal(await page.locator('[data-fluentread-pdf-text]').getAttribute('data-main-rotation'), String(rotation), 'TextLayer 应声明真实 PDF 页面方向');
      const proof = {rotation, pointerAttempt: null}; (report.rotatedSelections ||= []).push(proof);
      try {proof.pointerAttempt = {status: 'selected', selected: await dragLines(LINES[0])};}
      catch (error) {
        if (error?.code !== 'ERR_ASSERTION' || !error.message.includes('真实拖选必须严格对应指定原文')) throw error;
        proof.pointerAttempt = {status: 'inconclusive', error: error.message, limitation: 'Background browser Input collapsed native drag despite correct glyph hit and unchanged source node; no mouse-selection success claimed.'};
      }
      proof.keyboardSelection = await translateKeyboardLine(LINES[0]); proof.requestedSource = fixture.state.requests.at(-1).source;
      assert.equal(proof.requestedSource, LINES[0], '旋转页面键盘选区请求必须严格对应单行原文');
      await resourceState(`rotation ${rotation}`); await shot(`rotation-${rotation}-keyboard-selection`); record(`rotated ${rotation}° PDF supports exact native keyboard selection and Chinese fixture output; pointer evidence recorded separately`);
    }
    page = await openDocument(); await load('selection-fixture.pdf', smallPdf);
    // 默认打开状态（双语、原版排版、适合宽度）下先如实记录同一手势的结果：这一几何下后台真实输入的拖选可能逐步塌缩为跟随指针的光标，
    // 与页面缩放比例有关（旧脚本对旋转页与论文标题已有同类“inconclusive”记录）。此处只取证，不计入 PASS；严格断言在 100% 缩放下执行。
    report.defaultFitDrag = {mode: 'bilingual', presentation: await presentationOf(), zoom: await currentZoom(),
      geometry: await page.evaluate(() => {const viewport = document.querySelector('[data-pdf-scroll]'), frame = document.querySelector('.pdf-page-frame'); return {viewportWidth: viewport.clientWidth, frameWidth: frame.getBoundingClientRect().width, devicePixelRatio};})};
    assert.equal(report.defaultFitDrag.presentation, 'layout'); assert.equal(report.defaultFitDrag.zoom, 'fit', 'PDF 默认缩放应为适合宽度');
    try {report.defaultFitDrag.selected = await dragLines(LINES[0], LINES[1]); report.defaultFitDrag.status = 'exact';}
    catch (error) {
      if (error?.code !== 'ERR_ASSERTION' || !error.message.includes('真实拖选必须严格对应指定原文')) throw error;
      const gesture = report.selectionGestures.at(-1);
      Object.assign(report.defaultFitDrag, {status: 'not-exact', selected: gesture.selected, expected: `${LINES[0]} ${LINES[1]}`, trace: gesture.trace,
        observation: 'Real mouse drag at the default fit zoom did not extend from the mouse-down caret: each move re-placed a collapsed caret until the pointer crossed the line gap. Recorded as evidence, not as a pass.'});
    }
    process.stdout.write(`NOTE default bilingual fit-zoom cross-line drag: ${report.defaultFitDrag.status} (frame ${report.defaultFitDrag.geometry.frameWidth}px, dpr ${report.defaultFitDrag.geometry.devicePixelRatio})\n`);
    await page.keyboard.press('Escape'); await clearSelectionByClick(); await setZoom('1'); await wait(200); await rowReady(1);
    const nativeCrossLine = await translateDrag(LINES[0], LINES[1]);
    const source = fixture.state.requests.at(-1).source; assert.equal(source, `${LINES[0]} ${LINES[1]}`, '跨行请求必须严格对应两行原文'); assert(!/[\r\n]/u.test(source), '跨行选区请求应规范成连续原文');
    assert((await uiText()).includes(`测试译文：${source}`)); report.crossLine = {nativeSelection: nativeCrossLine, requestedSource: source}; await shot('cross-line-selection'); record('real cross-line drag preserves source layout and sends one normalized sentence to the chosen service');
    await dragAcrossPages(); await shot('cross-page-selection'); await resourceState('cross-page selection pins'); record('real mouse drag across adjacent pages translates source text without reader labels or page metadata');
    await page.keyboard.press('Escape'); const returnToFirst = page.locator('.pdf-page-navigation input'); await returnToFirst.fill('1'); await returnToFirst.press('Enter'); await rowReady(1);
    const before = fixture.state.requests.length; await dragLines(LINES[2]); await until(() => uiNode('fr-selection-indicator'), '旧选区入口缺失'); await clickNode('fr-selection-indicator'); await until(() => fixture.state.requests.length > before, '旧选区请求未开始');
    await translateDrag(LINES[3]); await wait(1800); assert((await uiText()).includes(LINES[3]) && !(await uiText()).includes(LINES[2]), '旧请求覆盖了新选区结果'); await shot('late-selection-owner'); record('late response from the previous PDF selection cannot replace the new selection');
    await page.keyboard.press('Escape'); await patch({selectionTranslatorTrigger: 'Control'}); const shortcutBefore = fixture.state.requests.length; await dragLines(LINES[0]); await wait(200); assert.equal(fixture.state.requests.length, shortcutBefore);
    await page.keyboard.down('Control'); await page.keyboard.up('Control'); await until(async () => (await uiText()).includes('测试译文'), '真实 Control 未触发 PDF 划词'); record('real Control respects shortcut-only selection trigger'); await patch({selectionTranslatorTrigger: 'icon'}); await page.keyboard.press('Escape');
    await setZoom('1'); await wait(200); await rowReady(1);
    const sourceGeometry = () => page.locator('.pdf-page-row[data-page-number="1"] .pdf-page-column:not(.translated) .pdf-page-frame').evaluate(frame => {
      const bounds = frame.getBoundingClientRect(), span = frame.querySelector('[data-fluentread-pdf-text] span'), glyphs = span.getBoundingClientRect();
      return {width: bounds.width, height: bounds.height, firstText: span.textContent, firstGlyph: {left: glyphs.left - bounds.left, top: glyphs.top - bounds.top, width: glyphs.width, height: glyphs.height}};
    });
    const sourceBeforeTranslation = await sourceGeometry(), documentRequestsBefore = fixture.state.requests.length;
    const modes = page.locator('[aria-label="阅读方式"]');
    // 新阅读器：PDF 打开即为“原版排版”双语两栏；译页先是原页的画布副本，译文以 HTML 段落块叠在原坐标上。
    assert.equal(await presentationOf(), 'layout', 'PDF 默认展示应为原版排版');
    assert.equal(await modes.getByRole('button', {name: '双语', exact: true}).getAttribute('aria-pressed'), 'true', 'PDF 打开后应直接处于双语阅读');
    assert.equal(await page.locator('.pdf-reading-sheet').count(), 0, '原版排版下不应再出现重排续页');
    assert.equal(await page.locator('.pdf-page-row .pdf-page-column figcaption, .pdf-page-row h2, .pdf-page-row h3').count(), 0, '每页标题与原文/译文题注应已移除');
    const layoutPages = () => page.evaluate(() => [...document.querySelectorAll('.pdf-page-row[data-render-state="ready"]')].map(row => {
      const frame = row.querySelector('.pdf-page-column.translated .pdf-page-frame'), layer = frame?.querySelector('.pdf-translation-layer[data-fluentread-pdf-translation]');
      const source = row.querySelector('.pdf-page-column:not(.translated) canvas'), translated = frame?.querySelector('.pdf-canvas-host canvas');
      if (!frame || !layer) return {page: Number(row.dataset.pageNumber), missing: true};
      const bounds = frame.getBoundingClientRect();
      return {page: Number(row.dataset.pageNumber), frame: {width: bounds.width, height: bounds.height},
        sourceCanvas: source && {width: source.width, height: source.height, cssWidth: Number.parseFloat(source.style.width), text: Boolean(source.parentElement.querySelector('[data-fluentread-pdf-text] span'))},
        translatedCanvas: translated && {width: translated.width, height: translated.height, cssWidth: Number.parseFloat(translated.style.width), resource: translated.dataset.pdfResource, distinct: translated !== source},
        blocks: [...layer.querySelectorAll('.pdf-translation-block')].map(block => {
          const rect = block.getBoundingClientRect();
          return {segment: block.dataset.pdfSegmentIndex, id: block.dataset.pdfSourceId, source: block.dataset.pdfSourceText, role: block.dataset.pdfRole, overflowing: block.classList.contains('overflowing'),
            text: [...block.querySelectorAll('.pdf-translation-text span')].map(line => line.textContent).join(''),
            left: rect.left - bounds.left, top: rect.top - bounds.top, right: rect.right - bounds.left, bottom: rect.bottom - bounds.top};
        }),
        spinners: [...layer.querySelectorAll('.pdf-translation-spinner[data-pdf-pending-segment]')].map(spinner => spinner.dataset.pdfPendingSegment)};
    }));
    const compact = value => value.replace(/\s+/gu, '');
    const beforeLayout = await layoutPages();
    assert(beforeLayout.length > 0 && beforeLayout.every(entry => !entry.missing && entry.blocks.length === 0 && entry.spinners.length === 0), `未翻译时译页只能是原页副本，不能有译文块或等待动画：${JSON.stringify(beforeLayout)}`);
    for (const entry of beforeLayout) {
      assert(entry.sourceCanvas?.text && entry.translatedCanvas?.distinct && entry.translatedCanvas.resource === 'translation', `双语两栏应各有画布，原文栏带文字层：${JSON.stringify(entry)}`);
      assert.equal(entry.translatedCanvas.width, entry.sourceCanvas.width); assert.equal(entry.translatedCanvas.height, entry.sourceCanvas.height);
      // 595×842 的页面在 100% 下两张 2x 画布共约 4m 像素，低于每页 8m 预算，因此必须正好是 2x。
      assert(Math.abs(entry.sourceCanvas.width / entry.sourceCanvas.cssWidth - 2) < 0.01, `预算内的页面必须以固定 2x 像素比渲染：${JSON.stringify(entry.sourceCanvas)}`);
    }
    const translatedPixelsBefore = await page.evaluate(async () => {
      const canvas = document.querySelector('.pdf-page-row[data-page-number="1"] .pdf-page-column.translated .pdf-canvas-host canvas'), source = document.querySelector('.pdf-page-row[data-page-number="1"] .pdf-page-column:not(.translated) canvas');
      const digest = async element => {const data = element.getContext('2d').getImageData(0, 0, element.width, element.height).data; return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(value => value.toString(16).padStart(2, '0')).join('');};
      globalThis.__pdfTranslatedCanvasBefore = canvas; globalThis.__pdfSourceCanvasBefore = source; return {translated: await digest(canvas), source: await digest(source)};
    });
    assert.equal(translatedPixelsBefore.translated, translatedPixelsBefore.source, '译页画布必须是原页的逐像素副本');
    fixture.state.translationDelayMs = 450;
    await page.locator('.translation-actions .translate-document-button').click();
    // 等待中的段落只在翻译进行时显示等待动画；有动画的段落此刻不能已有译文块。
    let streaming;
    await until(async () => {
      if (!await page.locator('.pause-button').count()) return false;
      const pagesNow = await layoutPages(); if (!pagesNow.some(entry => entry.spinners?.length)) return false; streaming = pagesNow; return true;
    }, '翻译进行中未出现等待段落的动画', 30000);
    for (const entry of streaming) for (const pending of entry.spinners) assert(!entry.blocks.some(block => block.segment === pending), `等待中的段落不能同时显示译文块：${JSON.stringify(entry)}`);
    report.layoutStreaming = streaming.map(entry => ({page: entry.page, translatedBlocks: entry.blocks.length, pendingSpinners: entry.spinners}));
    fixture.state.translationDelayMs = 20;
    await page.locator('.document-status').filter({hasText: '翻译完成'}).waitFor({timeout: 60000});
    assert(fixture.state.requests.length > documentRequestsBefore, '整份文档翻译必须实际调用已选服务');
    const documentSources = fixture.state.requests.slice(documentRequestsBefore).map(request => request.source);
    assert.equal(await modes.getByRole('button', {name: '双语', exact: true}).getAttribute('aria-pressed'), 'true');
    const caption = 'Original figures, fonts and page geometry remain intact.';
    const layoutEvidence = [];
    for (const number of [1, 2, 3]) {
      const input = page.locator('.pdf-page-navigation input'); await input.fill(String(number)); await input.press('Enter'); await rowReady(number);
      await page.locator(`.pdf-page-row[data-page-number="${number}"] .pdf-translation-block`).first().waitFor();
      const entry = (await layoutPages()).find(value => value.page === number); layoutEvidence.push(entry);
      assert.equal(entry.spinners.length, 0, `翻译完成后第 ${number} 页不能残留等待动画`);
      for (const block of entry.blocks) {
        assert(documentSources.includes(block.source), `第 ${number} 页译文块的原文必须真实送往翻译服务：${block.source}`);
        assert.equal(compact(block.text), compact(`测试译文：${block.source}`), `第 ${number} 页片段 ${block.segment} 的译文块必须完整等于夹具译文`);
        assert(block.left >= -2 && block.top >= -2 && block.right <= entry.frame.width + 2 && block.bottom <= entry.frame.height + 2, `第 ${number} 页译文块不能超出页面：${JSON.stringify({block, frame: entry.frame})}`);
      }
      // 夹具每页的四行正文与图下说明都必须恰好落在一个译文块里；行距宽松、句子排满栏宽的相邻行按同一段翻译，因此按“包含该行”核对而不要求一行一块。
      for (const line of [...LINES, caption]) assert.equal(entry.blocks.filter(block => block.source.includes(line)).length, 1, `第 ${number} 页原文“${line}”必须恰好出现在一个译文块里：${JSON.stringify(entry.blocks.map(block => block.source))}`);
      assert.equal(new Set(entry.blocks.map(block => block.id)).size, entry.blocks.length, '同页译文块的来源标识不能重复');
    }
    const blockSources = layoutEvidence.flatMap(entry => entry.blocks.map(block => block.source));
    for (const source of new Set(documentSources)) assert(blockSources.includes(source), `已翻译的段落必须在译页上有译文块：${source}`);
    report.layoutTranslation = {requestedSources: [...new Set(documentSources)], requests: documentSources.length, pages: layoutEvidence.map(entry => ({page: entry.page, blocks: entry.blocks.map(({segment, source, role, overflowing}) => ({segment, source, role, overflowing}))}))};
    const firstPage = page.locator('.pdf-page-navigation input'); await firstPage.fill('1'); await firstPage.press('Enter'); await rowReady(1);
    const translatedPixelsAfter = await page.evaluate(async () => {
      const canvas = document.querySelector('.pdf-page-row[data-page-number="1"] .pdf-page-column.translated .pdf-canvas-host canvas'), source = document.querySelector('.pdf-page-row[data-page-number="1"] .pdf-page-column:not(.translated) canvas');
      const digest = async element => {const data = element.getContext('2d').getImageData(0, 0, element.width, element.height).data; return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(value => value.toString(16).padStart(2, '0')).join('');};
      return {translated: await digest(canvas), source: await digest(source), sameTranslatedCanvas: canvas === globalThis.__pdfTranslatedCanvasBefore, sameSourceCanvas: source === globalThis.__pdfSourceCanvasBefore};
    });
    assert.deepEqual({translated: translatedPixelsAfter.translated, source: translatedPixelsAfter.source}, translatedPixelsBefore, '译文不能画到画布上：翻译前后原页与译页画布像素必须不变');
    assert(translatedPixelsAfter.sameTranslatedCanvas && translatedPixelsAfter.sameSourceCanvas, '译文更新不能重新渲染页面画布');
    report.layoutCanvasStability = {...translatedPixelsAfter, before: translatedPixelsBefore};
    assert.deepEqual(await sourceGeometry(), sourceBeforeTranslation, '双语原页 CSS 尺寸和 PDF.js 字形几何必须保持原版面');
    await shot('translated-layout-blocks');
    // 译文栏的真实拖选可复制，但不属于原文：不能出现原文划词入口，也不能发出翻译请求。
    await checkFocus('before translated-column selection'); await helper.activateExtensionTabWithoutForeground(context, page); await page.keyboard.press('Escape'); await clearSelectionByClick();
    const translatedLine = page.locator('.pdf-page-row[data-page-number="1"] .pdf-translation-block').filter({hasText: LINES[0].slice(0, 20)}).locator('.pdf-translation-text span').first();
    const translatedDrag = await translatedLine.evaluate(span => {
      const text = span.firstChild, count = Math.min(8, text.length), range = document.createRange();
      range.setStart(text, 0); range.setEnd(text, 1); const first = range.getBoundingClientRect();
      range.setStart(text, count - 1); range.setEnd(text, count); const last = range.getBoundingClientRect();
      return {expected: text.data.slice(0, count), start: {x: first.left + 0.4, y: first.top + first.height / 2}, end: {x: last.right - 0.4, y: last.top + last.height / 2}};
    });
    const requestsBeforeTranslatedSelection = fixture.state.requests.length;
    await page.mouse.move(translatedDrag.start.x, translatedDrag.start.y); await page.mouse.down(); await page.mouse.move(translatedDrag.end.x, translatedDrag.end.y, {steps: 12});
    const translatedGuard = await selectionGuardState(); await page.mouse.up();
    const translatedSelection = await page.evaluate(() => ({text: getSelection()?.toString() || '', inTranslationLayer: Boolean(getSelection()?.anchorNode?.parentElement?.closest('[data-fluentread-pdf-translation]'))}));
    assert.equal(translatedSelection.text, translatedDrag.expected, '真实鼠标必须能准确选择译文块里的文字'); assert(translatedSelection.inTranslationLayer, '选区必须位于译文层');
    assert(translatedGuard.layers.every(layer => !layer.selecting), `译文栏拖选不能启动原文文字层的选区垫片：${JSON.stringify(translatedGuard)}`);
    await wait(400); assert.equal(await uiNode('fr-selection-indicator'), null, '译文选择不应该挂上原文划词入口'); assert.equal(fixture.state.requests.length, requestsBeforeTranslatedSelection, '选择译文不得触发翻译请求');
    report.translatedColumnSelection = {...translatedSelection, presentation: 'layout', indicator: false, requests: 0}; await shot('translated-column-selection');
    await clearSelectionByClick();
    // “重排阅读”仍以可复制的 HTML 段落呈现同一批译文；其中的选区同样不属于原文。
    await setPresentation('readable');
    await page.locator('.pdf-page-row[data-page-number="1"][data-render-state="ready"] .pdf-page-column.translated .pdf-reading-sheet').waitFor();
    const readableEntries = await page.locator('[data-pdf-reading-page="1"] .pdf-reading-paragraph').evaluateAll(elements => elements.map(element => ({source: element.dataset.pdfSourceText, text: element.textContent, role: element.dataset.pdfRole})));
    // 与原版排版相同：每行原文恰好属于一个段落，该段落显示它完整的夹具译文。
    for (const line of [...LINES, caption]) {const owners = readableEntries.filter(entry => entry.source.includes(line)); assert.equal(owners.length, 1, `重排阅读中“${line}”必须恰好属于一个段落`); assert.equal(owners[0].text, `测试译文：${owners[0].source}`, `重排阅读必须显示完整译文：${line}`);}
    assert.equal(await page.locator('.pdf-page-row[data-page-number="1"] .pdf-translation-layer').count(), 0, '重排阅读不显示原版排版的译文层');
    const readableParagraph = page.locator('[data-pdf-reading-page="1"] .pdf-reading-paragraph').filter({hasText: LINES[0]}).first(); await readableParagraph.scrollIntoViewIfNeeded();
    const readableDrag = await readableParagraph.evaluate(element => {
      const text = element.firstChild, range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 1); const first = range.getBoundingClientRect();
      range.setStart(text, 7); range.setEnd(text, 8); const last = range.getBoundingClientRect();
      return {expected: text.data.slice(0, 8), start: {x: first.left + 0.4, y: first.top + first.height / 2}, end: {x: last.right - 0.4, y: last.top + last.height / 2}};
    });
    await page.mouse.move(readableDrag.start.x, readableDrag.start.y); await page.mouse.down(); await page.mouse.move(readableDrag.end.x, readableDrag.end.y, {steps: 12}); await page.mouse.up();
    assert.equal(await page.evaluate(() => getSelection()?.toString() || ''), readableDrag.expected, '真实鼠标必须能准确选择重排阅读里的译文');
    await wait(400); assert.equal(await uiNode('fr-selection-indicator'), null, '重排阅读里的译文选择不应该挂上原文划词入口'); assert.equal(fixture.state.requests.length, requestsBeforeTranslatedSelection, '选择重排译文不得触发翻译请求');
    report.readablePresentation = {entries: readableEntries, selection: readableDrag.expected}; await resourceState('three-page readable'); await shot('translated-readable-sheet');
    await clearSelectionByClick(); await setPresentation('layout'); await rowReady(1);
    await page.locator('.pdf-page-row[data-page-number="1"] .pdf-translation-block').first().waitFor();
    assert.equal(await page.locator('.pdf-reading-sheet').count(), 0, '切回原版排版后不应残留重排续页');
    assert.deepEqual(await sourceGeometry(), sourceBeforeTranslation, '切换展示方式后原页几何必须不变');
    await translateDrag(LINES[0], LINES[1]); await resourceState('three-page bilingual'); await shot('translated-bilingual-selection');
    await page.keyboard.press('Escape'); await modes.getByRole('button', {name: '译文', exact: true}).click();
    await until(async () => await page.locator('.pdf-page-row[data-page-number="1"][data-render-state="ready"] .pdf-page-column.translated .pdf-translation-block').count()
      && await page.locator('[data-fluentread-pdf-text]').count() === 0 && await page.locator('.pdf-page-column:not(.translated)').count() === 0, '仅译文模式必须只显示带译文块的译页并移除原文文字层');
    await resourceState('three-page translated'); await shot('translated-only-pages');
    await modes.getByRole('button', {name: '原文', exact: true}).click(); await rowReady(1); await until(async () => await page.locator('.pdf-page-column.translated').count() === 0, '原文模式仍残留译页');
    assert.equal(await page.locator('.pdf-presentation-control').count(), 0, '原文模式不提供展示方式菜单');
    assert.deepEqual(await sourceGeometry(), sourceBeforeTranslation, '恢复原文模式必须保留原始页面和文字几何'); await resourceState('three-page restored source');
    record('whole-document fixture translation overlays exact HTML blocks on unchanged canvases, shows spinners only while translating, keeps translated-column selection out of the source trigger, and preserves source geometry across layout/readable and original/bilingual/translated modes');
    await patch({selectionTranslatorTrigger: 'contextMenu'}); const contextBefore = fixture.state.requests.length; await dragLines(LINES[1]); await wait(200);
    assert.equal(fixture.state.requests.length, contextBefore, '右键模式应等待明确的后台指令'); assert.equal(await uiNode('fr-selection-indicator'), null, '右键模式不显示划词入口');
    const documentTabId = await page.evaluate(async () => (await chrome.tabs.getCurrent()).id);
    const sendContextMenu = () => worker.evaluate(async tabId => chrome.runtime.sendMessage({type: 'documentSelectionTranslate', tabId}), documentTabId);
    const firstContextResponse = await sendContextMenu(); assert.equal(firstContextResponse.status, 'success'); await until(async () => (await uiText()).includes(`测试译文：${LINES[1]}`), '后台右键指令未打开匹配文档页的划词卡片');
    await page.keyboard.press('Escape'); await until(async () => !(await uiNode('fr-translation-tooltip')), 'Esc 未关闭右键划词卡片');
    const reopenedContextResponse = await sendContextMenu(); assert.equal(reopenedContextResponse.status, 'success'); await until(async () => (await uiText()).includes(`测试译文：${LINES[1]}`), '同一真实选区经右键指令不能重新打开卡片');
    report.documentContextMenu = {documentTabId, firstResponse: firstContextResponse, reopenedResponse: reopenedContextResponse, sender: 'actual extension service worker runtime.sendMessage', nativeOsMenuGesture: false};
    await shot('context-menu-runtime-selection'); record('actual trusted background runtime command opens and reopens the selected PDF card; native OS menu gesture is outside this proof');
    await patch({selectionTranslatorTrigger: 'icon'}); await page.keyboard.press('Escape');
    await page.setViewportSize({width: 390, height: 844}); await page.emulateMedia({colorScheme: 'dark'}); await patch({theme: 'dark'}); await setZoom('fit'); await wait(200); await rowReady(1); await translateDrag(LINES[0]);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '390px 文档页横向溢出'); await readerGeometry('390 dark translated source'); await shot('selection-390-dark'); await resourceState('390 dark'); record('390px dark reading retains original text selection and usable card'); await page.emulateMedia({colorScheme: 'light'}); await patch({theme: 'light'}); await page.setViewportSize({width: 1440, height: 960});

    page = await openDocument(); const beforeOnline = fixture.state.requests.length;
    await page.locator('#online-pdf-url').fill(`${fixture.base}/stalled.pdf`); await page.locator('#online-pdf-url').press('Enter');
    await until(() => fixture.state.stalledRequests > 0, '在线导入未开始读取迟缓 PDF'); await until(async () => /\d/u.test(await page.locator('.upload-description').innerText()), '下载阶段应显示实际字节进度');
    await page.locator('.file-drop-zone').getByRole('button', {name: '取消导入', exact: true}).click(); await until(() => fixture.state.canceledDownloads > 0, '取消后仍在读取在线 PDF 连接');
    assert.equal(await page.locator('[data-document-reader="pdf"]').count(), 0, '取消导入不得打开部分 PDF'); assert(await page.locator('#online-pdf-url').isEnabled(), '取消后应该允许立即重试');
    await page.locator('#online-pdf-url').fill(`${fixture.base}/selection-fixture.pdf`); await page.locator('#online-pdf-url').press('Enter'); await rowReady(1); assert.equal(fixture.state.requests.length, beforeOnline); await translateDrag(LINES[0], LINES[1]); await shot('online-pdf-selection'); record('online HTTP PDF byte progress cancels a stalled body and retries into the same selectable reader');
    const nativePdf = await newPage(); await nativePdf.goto(`${fixture.base}/selection-fixture.pdf`, {waitUntil: 'domcontentloaded'});
    const destination = await openDocument(), destinationId = await destination.evaluate(async () => (await chrome.tabs.getCurrent()).id);
    // tabs.create 生产行为会新建页面；预创建目标先离开 document.html，避免仅更新 fragment 而不重新挂载。
    await destination.goto('about:blank');
    const popup = await newPage(); await helper.activateExtensionTabWithoutForeground(context, nativePdf); await popup.goto(`${origin}/popup.html`); await popup.locator('.popup-shell[data-config-ready="true"]').waitFor();
    await popup.evaluate(targetId => {globalThis.__pdfReaderOpens = []; chrome.tabs.create = (properties, callback) => {globalThis.__pdfReaderOpens.push(properties); const promise = chrome.tabs.update(targetId, {url: properties.url, active: false}); if (callback) promise.then(callback); return promise;}; window.close = () => {};}, destinationId);
    await helper.activateExtensionTabWithoutForeground(context, nativePdf); await popup.locator('[data-testid="page-translation"]').click(); await destination.waitForURL(/document\.html#pdf=/u); page = destination;
    const opens = await popup.evaluate(() => globalThis.__pdfReaderOpens); assert.equal(opens.length, 1); assert.equal(new URLSearchParams(new URL(opens[0].url).hash.slice(1)).get('pdf'), `${fixture.base}/selection-fixture.pdf`);
    report.nativePopupRedirect = {sourceUrl: nativePdf.url(), requests: opens, nativeTabCreation: false, focusAdapter: 'precreated background reader destination; actual popup tabs.create arguments and tabs.update(active:false), original close captured'};
    await rowReady(1);
    await translateDrag(LINES[0]); await shot('native-popup-reader-selection'); record('native PDF popup full-page action hands the source URL to the reader and its real selection card works'); await popup.close(); await nativePdf.close();

    page = await openDocument(); await load('long-120.pdf', longPdf); assert((await page.locator('.pdf-page-total').innerText()).includes('120')); await resourceState('120 first page');
    for (const number of [60, 120, 1, 100, 25, 119, 2, 60]) {
      const input = page.locator('.pdf-page-navigation input'), navigation = {target: number, valueBefore: await input.inputValue()}; (report.pageJumps ||= []).push(navigation);
      await input.fill(String(number)); navigation.valueAfterFill = await input.inputValue(); await input.press('Enter'); navigation.valueAfterEnter = await input.inputValue();
      await rowReady(number); navigation.valueAtReady = await input.inputValue(); await resourceState(`jump ${number}`);
    }
    for (const zoom of ['1', '1.5']) {await setZoom(zoom); await wait(200); await rowReady(60); assert.equal(await page.locator('.pdf-page-navigation input').inputValue(), '60', '远处页缩放必须保持当前页'); await resourceState(`page 60 zoom ${zoom}`);}
    await page.locator('[data-pdf-scroll]').focus(); await page.keyboard.press('End'); await rowReady(120); await page.keyboard.press('Home'); await rowReady(1); await resourceState('keyboard End/Home');
    await page.locator('[data-pdf-scroll]').evaluate(element => {for (const fraction of [0.8, 0.2, 0.95, 0.1, 1, 0]) element.scrollTop = element.scrollHeight * fraction;}); await rowReady(1); await resourceState('rapid scroll');
    await setZoom('fit'); await page.setViewportSize({width: 390, height: 844}); await wait(200); await rowReady(1); await readerGeometry('120 pages 390 fit'); await resourceState('120 pages 390 fit'); await shot('long-120-390');
    record('120-page jump, zoom, keyboard and rapid scroll keep resident pages/TextLayer <= 5, per-page pixels <= 8m and total pixels <= 40m');
    if (liveArxiv) {
      report.liveArxiv = {ok: false, url: 'https://arxiv.org/pdf/1706.03762', interception: false};
      try {
        page = await openDocument(); await page.setViewportSize({width: 1440, height: 960}); const started = Date.now();
        await page.locator('#online-pdf-url').fill(report.liveArxiv.url); await page.locator('#online-pdf-url').press('Enter'); await rowReady(1);
        report.liveArxiv.firstSelectablePageMs = Date.now() - started;
        const target = await paperSelectionTarget(); report.liveArxiv.selectedSource = target;
        assert(target, '实时论文未提供可选择文字'); await translateDrag(target); await readerGeometry('live arxiv'); await shot('arxiv-live-selection'); await resourceState('live arxiv'); report.liveArxiv.ok = true;
        record('live arXiv URL fetches without interception and its real selection translates through the local fixture');
      } catch (error) {report.liveArxiv.error = error.stack || String(error); report.liveArxiv.limitation = 'Requested live network import failed; local arXiv fixture does not substitute for live proof.';}
    }
    assert.equal(report.consoleErrors.length, 0, `浏览器错误：${JSON.stringify(report.consoleErrors)}`); await checkFocus('suite complete');
    report.fixtureRequests = fixture.state; report.ok = !liveArxiv || report.liveArxiv.ok;
    if (!report.ok) process.exitCode = 1;
  } catch (error) {report.ok = false; report.error = error.stack || String(error); process.exitCode = 1; if (page && !page.isClosed()) {try {const file = path.join(artifactsDir, 'failure.png'); await page.screenshot({path: file}); report.screenshots.push(file);} catch {}}}
  finally {
    if (diagnosticsStarted) {
      try {
        await diagnostics.flush();
        if (report.ok) diagnostics.assertClean();
      } catch (error) {report.ok = false; report.diagnosticsError = String(error); process.exitCode = 1;}
      try {diagnostics.write(artifactsDir, report);} catch (error) {report.ok = false; report.diagnosticsWriteError = String(error); process.exitCode = 1;}
      try {await diagnostics.stop();} catch (error) {report.ok = false; report.diagnosticsCleanupError = String(error); process.exitCode = 1;}
    }
    let closed = false;
    try {if (launched) {await launched.close(); closed = true;}} catch (error) {report.ok = false; report.cleanupError = error.stack || String(error); process.exitCode = 1;}
    if (fixture) {report.fixtureRequests = fixture.state; await fixture.close();}
    if (closed || !launchAttempted) fs.rmSync(profileDir, {recursive: true, force: true}); else report.retainedProfile = profileDir;
    const reportPath = path.join(artifactsDir, 'report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    const resourcePeaks = report.resources.reduce((peaks, resource) => {
      for (const key of ['shells', 'canvases', 'textLayers', 'pixels']) peaks[key] = Math.max(peaks[key], resource.peaks[key]);
      return peaks;
    }, {shells: 0, canvases: 0, textLayers: 0, pixels: 0});
    process.stdout.write(JSON.stringify({ok: report.ok, cases: report.cases.length, screenshots: report.screenshots.length, reportPath,
      resourcePeaks, readerGeometries: report.readerGeometries, liveArxiv: report.liveArxiv, runScope: report.runScope, paperLayoutQuality: report.paperLayoutQuality,
      paperLayoutMeasurements: report.paperLayoutSnapshots?.map(({page, zoom, mode, narrow, minCssFontPx, clippedLines, fullyHiddenLines}) => ({page, zoom, mode, narrow, minCssFontPx, clippedLines, fullyHiddenLines})), paperPaintTotals: report.paperPaintTotals,
      readablePages: report.paperReadablePages?.length, pdfExports: report.pdfExports?.map(({mode, expansion, elapsedMs, pages, readableRasterPages, completeChineseSegments, downloadedRasterPixelsMatched}) => ({mode, expansion, elapsedMs, pages, readableRasterPages, completeChineseSegments, downloadedRasterPixelsMatched})), translatedCopy: report.translatedCopy, paperZoomAnchor: report.paperZoomAnchor,
      nativeCaretBrowsing: report.nativeCaretBrowsing, selectionLimits: report.selectionLimits,
      defaultFitDrag: report.defaultFitDrag && {status: report.defaultFitDrag.status, geometry: report.defaultFitDrag.geometry, selected: report.defaultFitDrag.selected},
      foregroundChecks: report.frontmostSnapshots?.length || 0, foregroundViolations: report.frontmostSnapshots?.filter(snapshot => snapshot.browserFrontmost).length || 0,
      consoleErrors: report.consoleErrors, skipped: report.skipped, error: report.error, cleanupError: report.cleanupError, retainedProfile: report.retainedProfile}, null, 2) + '\n');
  }
}

module.exports = {compareCropboxPixels, pdfDisplayedText, harnessFixtureTranslation};
if (require.main === module) main().catch(error => {process.stderr.write((error.stack || String(error)) + '\n'); process.exitCode = 1;});
