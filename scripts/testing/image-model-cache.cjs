'use strict';
/**
 * @file scripts/testing/image-model-cache.cjs
 * 文件职责：复用图片/漫画浏览器测试的公开模型文件，避免临时 profile 重复下载权重。
 * 主要内容：读取生产固定版本与校验清单，逐文件检查长度/SHA；按需导入既有文件或流式下载、原子发布；跨进程逐模型锁有界等待，持有进程退出时恢复，取消与失败清理临时文件。
 * 模块边界：只管理显式指定的测试模型目录，不访问浏览器 profile、不修改生产下载策略；返回已校验的文件路径供测试通过现有导入 UI 放入全新的隔离 profile。
 */
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const {Readable, Transform} = require('node:stream');
const {pipeline} = require('node:stream/promises');
const {setTimeout: delay} = require('node:timers/promises');
const {execFileSync} = require('node:child_process');
const {digestFile} = require('./model-cache-transfer.cjs');

/** 所有 worktree 默认共用主仓库旁的测试缓存；普通源码快照使用当前目录内专属缓存。 */
function defaultImageTranslationModelCacheDirectory({cwd, env = process.env} = {}) {
    const invocationDirectory = cwd ?? process.cwd();
    const repositoryDirectory = cwd ?? path.resolve(__dirname, '../..');
    if (env.FLUENTREAD_TEST_MODEL_CACHE_DIR) return path.resolve(invocationDirectory, env.FLUENTREAD_TEST_MODEL_CACHE_DIR);
    try {
        const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {cwd: repositoryDirectory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
        if (!path.isAbsolute(common)) throw new Error('Git common directory must be absolute');
        return path.join(path.dirname(path.dirname(common)), 'workspace-data', 'model-cache');
    } catch {return path.join(path.resolve(invocationDirectory), '.cache', 'image-translation-models');}
}

function readImageTranslationModelManifest(metadataFile = path.resolve(__dirname, '../../src/features/image-translation/services/mangaOcrAssets.ts')) {
    const source = fs.readFileSync(metadataFile, 'utf8');
    const root = /const ROOT = '([^']+)'/.exec(source)?.[1];
    const cacheName = /export const MANGA_OCR_CACHE = '([^']+)'/.exec(source)?.[1];
    const ocrSource = /export const MANGA_OCR_ASSETS = \[([\s\S]*?)\] as const;/.exec(source)?.[1];
    const inpaint = /export const MANGA_INPAINT_ASSET = \{\s*url: '([^']+)',\s*bytes: (\d+), sha256: '([a-f0-9]{64})'/.exec(source);
    const ocr = [...(ocrSource || '').matchAll(/\{key: '([^']+)', path: '([^']+)', bytes: (\d+),\s*sha256: '([a-f0-9]{64})'/g)];
    if (!root || !cacheName || ocr.length !== 3 || !inpaint
        || new Set(ocr.map(match => match[1])).size !== 3
        || !['detection', 'recognition', 'charactersDictionary'].every(key => ocr.some(match => match[1] === key))) {
        throw new Error(`Cannot parse pinned image model metadata: ${metadataFile}`);
    }
    const assets = ocr.map(match => ({key: match[1], kind: 'ocr', filename: path.basename(match[2]), url: root + match[2], bytes: Number(match[3]), sha256: match[4], cacheName}));
    assets.push({key: 'inpainting', kind: 'inpaint', filename: path.basename(new URL(inpaint[1]).pathname), url: inpaint[1], bytes: Number(inpaint[2]), sha256: inpaint[3], cacheName});
    if (assets.some(asset => new URL(asset.url).protocol !== 'https:' || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0
        || !asset.filename || asset.filename === '.' || asset.filename === '..')) throw new Error(`Invalid pinned image model metadata: ${metadataFile}`);
    return assets;
}

async function verifiedFile(file, asset, signal) {
    signal?.throwIfAborted();
    let stat;
    try {stat = await fsp.lstat(file);} catch (error) {if (error.code === 'ENOENT') return false; throw error;}
    if (!stat.isFile() || stat.size !== asset.bytes) return false;
    const actual = await digestFile(file, signal);
    return actual.bytes === asset.bytes && actual.sha256 === asset.sha256;
}
function processAlive(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return true;
    try {process.kill(pid, 0); return true;} catch (error) {return error.code !== 'ESRCH';}
}

/** 独立进程共享同一原子 lock；等待者仅在确定 owner 已退出时回收，否则超时或取消。 */
async function acquireModelLock(lock, {signal, lockTimeoutMs, pollMs}) {
    const started = Date.now(), token = randomUUID();
    while (true) {
        signal?.throwIfAborted();
        try {
            const handle = await fsp.open(lock, 'wx', 0o600);
            try {await handle.writeFile(JSON.stringify({pid: process.pid, token, createdAt: Date.now()}));}
            catch (error) {await handle.close(); await fsp.rm(lock, {force: true}); throw error;}
            await handle.close();
            return async () => {
                try {if (JSON.parse(await fsp.readFile(lock, 'utf8')).token === token) await fsp.unlink(lock);}
                catch (error) {if (error.code !== 'ENOENT') throw error;}
            };
        } catch (error) {if (error.code !== 'EEXIST') throw error;}
        try {
            const ownerText = await fsp.readFile(lock, 'utf8');
            let owner;
            try {owner = JSON.parse(ownerText);} catch {owner = null;}
            // 不回收刚创建、尚未来得及写 owner 的锁；这类中断只在有界过期后恢复。
            const orphan = !owner && Date.now() - (await fsp.stat(lock)).mtimeMs > lockTimeoutMs;
            if ((owner && !processAlive(owner.pid)) || orphan) {
                if (await fsp.readFile(lock, 'utf8') === ownerText) await fsp.unlink(lock);
                continue;
            }
        } catch (error) {if (error.code !== 'ENOENT') throw error;}
        if (Date.now() - started >= lockTimeoutMs) throw new Error(`Timed out waiting for image model cache lock: ${path.basename(lock)}`);
        await delay(Math.min(pollMs, lockTimeoutMs), undefined, {signal});
    }
}

async function downloadVerified(asset, file, {signal, fetchImpl, downloadTimeoutMs}) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, {once: true});
    const timeout = setTimeout(() => controller.abort(new Error(`Image model download timed out: ${asset.filename}`)), downloadTimeoutMs);
    try {
        signal?.throwIfAborted();
        const response = await fetchImpl(asset.url, {signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer'});
        if (!response.ok || !response.body) {
            await response.body?.cancel(); throw new Error(`Image model download failed (${response.status}): ${asset.filename}`);
        }
        const hash = createHash('sha256'); let bytes = 0;
        const inspect = new Transform({transform(chunk, _encoding, callback) {
            bytes += chunk.length;
            if (bytes > asset.bytes) {callback(new Error(`Image model length mismatch: ${asset.filename}`)); return;}
            hash.update(chunk); callback(null, chunk);
        }});
        await pipeline(Readable.fromWeb(response.body), inspect, fs.createWriteStream(file, {flags: 'wx', mode: 0o600}), {signal: controller.signal});
        if (bytes !== asset.bytes || hash.digest('hex') !== asset.sha256) throw new Error(`Image model size/SHA-256 mismatch: ${asset.filename}`);
    } finally {clearTimeout(timeout); signal?.removeEventListener('abort', abort);}
}

/** kinds 仅列实际测试所需的 ocr/inpaint；sourceDirectories 是已下载公开模型的显式候选目录。 */
async function ensureImageTranslationModelFiles({directory = defaultImageTranslationModelCacheDirectory(), kinds = ['ocr'], sourceDirectories = [], signal,
    metadataFile, fetchImpl = globalThis.fetch, allowNetworkDownload = true, lockTimeoutMs = 300_000, downloadTimeoutMs = 300_000, pollMs = 100} = {}) {
    if (!directory || !Array.isArray(kinds) || !kinds.length || kinds.some(kind => !['ocr', 'inpaint'].includes(kind))) throw new Error('Provide a model cache directory and required ocr/inpaint kinds');
    if (typeof allowNetworkDownload !== 'boolean') throw new Error('allowNetworkDownload must be a boolean');
    if (![lockTimeoutMs, downloadTimeoutMs, pollMs].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Model cache timeouts must be positive integers');
    const assets = readImageTranslationModelManifest(metadataFile).filter(asset => kinds.includes(asset.kind));
    signal?.throwIfAborted(); await fsp.mkdir(directory, {recursive: true});
    const root = await fsp.realpath(directory), files = []; let networkDownloads = 0;
    // 固定根本身可保留之前导出的平面模型；全部来源复制后保留，不能删除已有文件。
    const sources = [...new Set([root, ...sourceDirectories.map(source => path.resolve(source))])];
    for (const asset of assets) {
        signal?.throwIfAborted();
        const folder = path.join(root, asset.sha256); await fsp.mkdir(folder, {recursive: true});
        if (!(await fsp.realpath(folder)).startsWith(root + path.sep)) throw new Error('Image model cache folder escaped its directory');
        const file = path.join(folder, asset.filename), lock = path.join(root, `${asset.sha256}.lock`);
        const release = await acquireModelLock(lock, {signal, lockTimeoutMs, pollMs});
        const partial = file + `.partial-${randomUUID()}`;
        try {
            // 旧临时字节不属于已验证缓存；禁下载模式保留已有文件以便检查。
            if (allowNetworkDownload) for (const entry of await fsp.readdir(folder)) if (entry.startsWith(asset.filename + '.partial-')) await fsp.rm(path.join(folder, entry), {force: true});
            let cache = 'hit';
            if (!await verifiedFile(file, asset, signal)) {
                // 离线模式不覆盖现有损坏文件；调用者可先检查或手动处理。
                if (!allowNetworkDownload) {
                    try {await fsp.lstat(file); throw new Error(`Invalid existing image model cache file: ${asset.filename}`);}
                    catch (error) {if (error.code !== 'ENOENT') throw error;}
                }
                let imported = false;
                for (const source of sources) {
                    const candidate = path.join(source, asset.filename);
                    if (!await verifiedFile(candidate, asset, signal)) continue;
                    await fsp.copyFile(candidate, partial, fs.constants.COPYFILE_EXCL);
                    if (!await verifiedFile(partial, asset, signal)) throw new Error(`Imported image model changed during copying: ${asset.filename}`);
                    imported = true; break;
                }
                if (!imported) {
                    if (!allowNetworkDownload) throw new Error(`Image model unavailable in offline cache: ${asset.filename}`);
                    await downloadVerified(asset, partial, {signal, fetchImpl, downloadTimeoutMs}); networkDownloads++;
                }
                signal?.throwIfAborted();
                // 不下载时不能覆盖检查后被其他进程创建的目标；同目录硬链接原子拒绝已有路径。
                if (!allowNetworkDownload) {await fsp.link(partial, file); await fsp.unlink(partial);}
                else await fsp.rename(partial, file);
                cache = imported ? 'imported' : 'downloaded';
            }
            files.push({...asset, path: file, cache});
        } finally {try {await fsp.rm(partial, {force: true});} finally {await release();}}
    }
    return {directory: root, files, networkDownloads};
}

module.exports = {defaultImageTranslationModelCacheDirectory, readImageTranslationModelManifest, ensureImageTranslationModelFiles, digestFile};
