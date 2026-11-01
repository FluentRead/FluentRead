import {createHash} from 'node:crypto';
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {gzipSync, gunzipSync} from 'node:zlib';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {cacheUserscriptBuildGzip} from '../userscript/buildCompressionCache';

const roots: string[] = [];
function fixture(): string {
    const root = mkdtempSync(resolve(tmpdir(), 'fluentread-build-cache-'));
    roots.push(root);
    mkdirSync(resolve(root, 'userscript'));
    writeFileSync(resolve(root, 'userscript/zopfliBuildWorker.cjs'), '// compressor version 1\n');
    writeFileSync(resolve(root, 'pnpm-lock.yaml'), 'locked-version: 1\n');
    return root;
}
const input = Buffer.from('静态界面与目录🙂\n'.repeat(50));
const directory = (root: string) => resolve(root, '.wxt/cache/userscript-gzip');
const compress = (data: Buffer) => Promise.resolve(gzipSync(data));

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});
});

describe('userscript build compression cache', () => {
    it('reuses complete verified bytes and gives each caller an independent result', async () => {
        const root = fixture(), encode = vi.fn(compress);
        const first = await cacheUserscriptBuildGzip(input, root, encode);
        const expected = Buffer.from(first);
        first.fill(0);
        const second = await cacheUserscriptBuildGzip(new Uint8Array(input), root, encode);
        expect(second).toEqual(expected);
        expect(gunzipSync(second)).toEqual(input);
        expect(encode).toHaveBeenCalledOnce();
        expect(readdirSync(directory(root))).toHaveLength(1);
    });

    it('invalidates changed inputs, worker bytes, implementation and dependency locks', async () => {
        const root = fixture(), encode = vi.fn(compress);
        await cacheUserscriptBuildGzip(input, root, encode);
        await cacheUserscriptBuildGzip(Buffer.from('other data'), root, encode);
        writeFileSync(resolve(root, 'userscript/zopfliBuildWorker.cjs'), '// compressor version 2\n');
        await cacheUserscriptBuildGzip(input, root, encode);
        writeFileSync(resolve(root, 'userscript/buildGzip.ts'), '// updated selection policy\n');
        await cacheUserscriptBuildGzip(input, root, encode);
        writeFileSync(resolve(root, 'pnpm-lock.yaml'), 'locked-version: 2\n');
        await cacheUserscriptBuildGzip(input, root, encode);
        expect(encode).toHaveBeenCalledTimes(5);
    });

    it('coalesces concurrent compression and snapshots offset views before awaiting', async () => {
        const root = fixture();
        const bytes = Buffer.concat([Buffer.from('prefix'), input, Buffer.from('suffix')]);
        const view = bytes.subarray(6, 6 + input.length);
        let finish!: () => void;
        const ready = new Promise<void>(resolveReady => {finish = resolveReady;});
        const encode = vi.fn(async (value: Buffer) => {await ready; return gzipSync(value);});
        const a = cacheUserscriptBuildGzip(view, root, encode);
        const b = cacheUserscriptBuildGzip(input, root, encode);
        view.fill(0);
        finish();
        const [first, second] = await Promise.all([a, b]);
        expect(first).toEqual(second);
        first.fill(0);
        expect(gunzipSync(second)).toEqual(input);
        expect(encode).toHaveBeenCalledOnce();
    });

    it.each(['digest', 'different source', 'excessive size'] as const)('rebuilds a corrupt cache: %s', async kind => {
        const root = fixture(), encode = vi.fn(compress);
        const expected = await cacheUserscriptBuildGzip(input, root, encode);
        const file = resolve(directory(root), readdirSync(directory(root))[0]);
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        if (kind === 'digest') {
            const cached = readFileSync(file);
            cached[cached.length - 1] ^= 1;
            writeFileSync(file, cached);
        } else if (kind === 'different source') {
            const gzip = gzipSync(Buffer.from('different source'));
            writeFileSync(file, Buffer.concat([Buffer.from(`${createHash('sha256').update(gzip).digest('hex')}\n`), gzip]));
        } else writeFileSync(file, Buffer.alloc(input.length + 4_097));
        expect(await cacheUserscriptBuildGzip(input, root, encode)).toEqual(expected);
        expect(await cacheUserscriptBuildGzip(input, root, encode)).toEqual(expected);
        expect(encode).toHaveBeenCalledTimes(2);
        expect(warning).toHaveBeenCalledOnce();
        expect(warning).toHaveBeenCalledWith('[userscript-build-cache] 压缩缓存损坏，重新生成');
        expect(readdirSync(directory(root))).toHaveLength(1);
    });

    it('does not cache compressor failures or invalid output and can retry', async () => {
        const root = fixture(), failure = new Error('controlled compressor failure');
        const encode = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(gzipSync(Buffer.from('wrong')))
            .mockImplementation(compress);
        await expect(cacheUserscriptBuildGzip(input, root, encode)).rejects.toBe(failure);
        await expect(cacheUserscriptBuildGzip(input, root, encode)).rejects.toThrow('输入校验失败');
        expect(gunzipSync(await cacheUserscriptBuildGzip(input, root, encode))).toEqual(input);
        expect(encode).toHaveBeenCalledTimes(3);
    });

    it('supports empty input and a cache-disabled build without accessing cache files', async () => {
        const root = fixture();
        expect(gunzipSync(await cacheUserscriptBuildGzip(Buffer.alloc(0), root, compress))).toHaveLength(0);
        vi.stubEnv('FLUENTREAD_BUILD_CACHE', '0');
        const missing = resolve(root, 'does-not-exist');
        expect(gunzipSync(await cacheUserscriptBuildGzip(input, missing, compress))).toEqual(input);
        expect(readdirSync(root)).not.toContain('does-not-exist');
    });

    it('propagates filesystem failures instead of accepting an unreadable cache', async () => {
        const root = fixture();
        writeFileSync(resolve(root, '.wxt'), 'not a directory');
        await expect(cacheUserscriptBuildGzip(input, root, compress)).rejects.toMatchObject({code: 'ENOTDIR'});
    });
});
