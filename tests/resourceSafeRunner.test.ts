import {afterEach, describe, expect, it} from 'vitest';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from '../scripts/testing/run-resource-safe.mjs';

const runner = resolve('scripts/testing/run-resource-safe.mjs');
const setupUrl = pathToFileURL(resolve('scripts/testing/vitest-resource-lock.mjs')).href;
const temporary: string[] = [];
const children = new Set<ReturnType<typeof spawn>>();

function parseCommand(argv: string[]) {
    const options = parseArgs(argv);
    if ('help' in options) throw new Error('Expected command options');
    return options;
}

async function workspace() {
    const directory = await mkdtemp(join(tmpdir(), 'fluentread-resource-test-'));
    temporary.push(directory);
    return directory;
}

function launch(directory: string, args: string[], extraEnv: Record<string, string> = {}) {
    const child = spawn(process.execPath, args, {env: {
        ...process.env,
        FLUENTREAD_RESOURCE_LOCK_DIR: directory,
        FLUENTREAD_RESOURCE_LOCK_HELD: '',
        FLUENTREAD_RESOURCE_LOCK_TOKEN: '',
        ...extraEnv,
    }, stdio: ['ignore', 'pipe', 'pipe']});
    children.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', chunk => { stdout += chunk; });
    child.stderr!.on('data', chunk => { stderr += chunk; });
    const done = new Promise<{code: number | null; stdout: string; stderr: string}>((resolveResult, reject) => {
        child.once('error', reject);
        child.once('close', code => {
            children.delete(child);
            resolveResult({code, stdout, stderr});
        });
    });
    return {child, done, output: () => stdout};
}

async function until(predicate: () => boolean | Promise<boolean>) {
    const deadline = Date.now() + 5_000;
    while (!await predicate()) {
        if (Date.now() > deadline) throw new Error('子进程未进入预期状态');
        await new Promise(resolveWait => setTimeout(resolveWait, 10));
    }
}

afterEach(async () => {
    for (const child of children) child.kill('SIGTERM');
    await Promise.all(temporary.splice(0).map(directory => rm(directory, {recursive: true, force: true})));
});

describe('resource safe runner', () => {
    it('只处理 Vitest 的首个转发分隔符，保留普通子命令参数与后续分隔符', () => {
        expect(parseCommand(['--', 'node', 'child.mjs', '--', '--literal']).args)
            .toEqual(['child.mjs', '--', '--literal']);
        expect(parseCommand(['--', 'vitest', 'run', '--config', 'coverage.ts', '--', 'one.test.ts', '--', 'literal']).args)
            .toEqual(['run', '--config', 'coverage.ts', 'one.test.ts', '--', 'literal']);
        expect(parseCommand(['--max-workers', '1', '--', 'node', 'child.mjs']).maxWorkers).toBe(1);
        expect(() => parseArgs(['--max-workers', '0', '--', 'node'])).toThrow('正整数');
        expect(() => parseArgs(['--cpu-target', '100', '--', 'node'])).toThrow('10-90');
        expect(() => parseArgs(['--wait-ms', '-1', '--', 'node'])).toThrow('正整数');
        expect(() => parseArgs(['--unknown', '1', '--', 'node'])).toThrow('无法识别');
        expect(() => parseArgs(['--max-workers'])).toThrow('缺少值');
        expect(() => parseArgs([])).toThrow('提供要运行的命令');
        expect(parseArgs(['--help'])).toEqual({help: true});
    });

    it('多个真实进程在同一资源目录串行运行，竞争回收死进程锁时不同时进入', async () => {
        const directory = await workspace();
        await mkdir(join(directory, 'lock'));
        // 用已退出的真实进程 PID，避免误判一个任意 PID 是否仍然存在。
        const dead = launch(directory, ['-e', '']);
        await dead.done;
        await writeFile(join(directory, 'lock/owner.json'), JSON.stringify({pid: dead.child.pid}));
        const critical = join(directory, 'critical');
        const code = `const fs = require('node:fs'); const p = ${JSON.stringify(critical)};
            fs.writeFileSync(p, 'held', {flag:'wx'});
            setTimeout(() => {fs.unlinkSync(p); console.log('completed');}, 100);`;
        // 5 个竞争者让“递归删除中途他人重建 reaping”的交错更容易暴露；旧实现约 7% 概率令其中一个等待者崩溃。
        const jobs = Array.from({length: 5}, () => launch(directory, [runner, '--', process.execPath, '-e', code]));
        const results = await Promise.all(jobs.map(job => job.done));
        expect(results.map(result => result.code), results.map(result => result.stderr).join('\n')).toEqual([0, 0, 0, 0, 0]);
        expect(results.every(result => result.stdout.includes('completed'))).toBe(true);
        await expect(readFile(join(directory, 'lock/owner.json'))).rejects.toMatchObject({code: 'ENOENT'});
    }, 10_000);

    it('嵌套 package runner 复用父锁并向子进程传递 worker 上限', async () => {
        const directory = await workspace();
        const code = 'console.log("WORKERS=" + process.env.FLUENTREAD_TEST_MAX_WORKERS)';
        const result = await launch(directory, [runner, '--max-workers', '1', '--', process.execPath,
            runner, '--wait-ms', '100', '--', process.execPath, '-e', code]).done;
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toContain('WORKERS=1');
        await expect(readFile(join(directory, 'lock/owner.json'))).rejects.toMatchObject({code: 'ENOENT'});
    });

    it('直接 Vitest setup 和 wrapper 竞争同一把锁，过期的继承环境不能绕过等待', async () => {
        const directory = await workspace();
        const releasePath = join(directory, 'release');
        const holder = launch(directory, ['--input-type=module', '-e',
            `import setup from ${JSON.stringify(setupUrl)}; const release = await setup();
             const fs = await import('node:fs'); console.log('LOCK_READY');
             while (!fs.existsSync(${JSON.stringify(releasePath)})) await new Promise(r => setTimeout(r, 10));
             await release();`]);
        await until(() => holder.output().includes('LOCK_READY'));
        const waiting = launch(directory, [runner, '--wait-ms', '50', '--', process.execPath, '-e', 'console.log("RAN")'], {
            FLUENTREAD_RESOURCE_LOCK_HELD: '1', FLUENTREAD_RESOURCE_LOCK_TOKEN: 'expired',
        });
        const result = await waiting.done;
        expect(result.code).toBe(1);
        expect(result.stdout).not.toContain('RAN');
        expect(result.stderr).toContain('等待全局测试锁超过');
        await writeFile(releasePath, 'release');
        expect((await holder.done).code).toBe(0);
        expect((await launch(directory, [runner, '--', process.execPath, '-e', '']).done).code).toBe(0);
    });

    it('子进程失败或无法启动后释放锁，并保留退出码', async () => {
        const directory = await workspace();
        expect((await launch(directory, [runner, '--', process.execPath, '-e', 'process.exit(7)']).done).code).toBe(7);
        expect((await launch(directory, [runner, '--', join(directory, 'missing-command')]).done).code).toBe(1);
        expect((await launch(directory, [runner, '--', process.execPath, '-e', '']).done).code).toBe(0);
    });

    it('SIGTERM 传给受控子进程，等待退出后释放锁', async () => {
        const directory = await workspace();
        const marker = join(directory, 'terminated');
        const code = `process.on('SIGTERM', () => {require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes'); process.exit(23)});
            console.log('CHILD_READY'); setInterval(() => {}, 1000);`;
        const job = launch(directory, [runner, '--', process.execPath, '-e', code]);
        // runner 会打印命令本身，所以只认子进程单独输出的整行。
        await until(() => job.output().split('\n').includes('CHILD_READY'));
        job.child.kill('SIGTERM');
        expect((await job.done).code).toBe(23);
        expect(await readFile(marker, 'utf8')).toBe('yes');
        expect((await launch(directory, [runner, '--', process.execPath, '-e', '']).done).code).toBe(0);
    });
});
