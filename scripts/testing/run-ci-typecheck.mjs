#!/usr/bin/env node
/**
 * @file scripts/testing/run-ci-typecheck.mjs
 * 文件职责：为 GitHub 托管 Ubuntu 上的完整类型检查申请有界内存预算。
 * 主要内容：检查 MemAvailable 和可见 cgroup v2 层级的内存上限；资源不足或环境未知时失败，充分时仅为 pnpm compile 子进程设置 6 GiB V8 旧生代上限，并输出 GNU time 的最大单进程 RSS、耗时和退出状态。
 * 模块边界：只供 GitHub 托管 Ubuntu CI 使用；runner 环境变量只是声明，内存检查是启动时快照，cgroup 命名空间可能隐藏更高层限制，不能认证环境或保证进程树内存硬上限。不运行模型、不修改本机环境、不开启其他命令，也不以分片替代全量类型检查。
 */
import {readFileSync} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {spawn} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';

const MIN_AVAILABLE_BYTES = 9n * 1024n ** 3n;
const HEAP_LIMIT_MIB = 6144;

function decodeMountField(value) {
    return value.replace(/\\([0-7]{3})/gu, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}

function parseCgroup2(cgroup, mountinfo) {
    const entry = cgroup.split('\n').find(line => line.startsWith('0::'));
    if (!entry) throw new Error('无法确定 cgroup v2 的进程路径');
    const group = entry.slice(3);
    if (!path.posix.isAbsolute(group) || path.posix.normalize(group) !== group) throw new Error('cgroup 进程路径无效');
    for (const line of mountinfo.split('\n')) {
        const [before, after] = line.split(' - ');
        if (!after || after.split(' ')[0] !== 'cgroup2') continue;
        const fields = before.split(' ');
        const root = decodeMountField(fields[3] ?? ''), mount = decodeMountField(fields[4] ?? '');
        // 子树挂载会隐藏更高层祖先的内存上限，不能据此证明总预算。
        if (root !== '/' || !path.posix.isAbsolute(mount)) continue;
        const relative = path.posix.relative(root, group);
        if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) continue;
        return {mount, leaf: path.posix.join(mount, relative)};
    }
    throw new Error('无法确定 cgroup v2 的挂载位置');
}

function parseBytes(value, name, allowMax = false) {
    const text = value.trim();
    if (allowMax && text === 'max') return undefined;
    if (!/^\d+$/u.test(text)) throw new Error(`${name} 不是有效的内存字节数`);
    return BigInt(text);
}

/** readText 可注入只读夹具；生产使用真实内核信息，不从环境变量接收预算。 */
export function inspectCiTypeBudget({env, platform, readText}) {
    if (platform !== 'linux' || env.GITHUB_ACTIONS !== 'true' || env.RUNNER_OS !== 'Linux' || env.RUNNER_ENVIRONMENT !== 'github-hosted') {
        throw new Error('扩展类型检查内存预算仅允许 GitHub 托管 Linux runner');
    }
    if (env.FLUENTREAD_TEST_CONCURRENCY !== '1' || env.FLUENTREAD_TEST_MAX_WORKERS !== '1') {
        throw new Error('扩展类型检查内存预算要求单槽与单 worker');
    }
    const osRelease = readText('/etc/os-release');
    if (!/^ID=(?:ubuntu|"ubuntu")$/mu.test(osRelease)) throw new Error('扩展类型检查内存预算仅允许 Ubuntu');
    const match = readText('/proc/meminfo').match(/^MemAvailable:\s*(\d+)\s+kB\s*$/mu);
    if (!match) throw new Error('无法读取 MemAvailable');
    const available = BigInt(match[1]) * 1024n;
    const {mount, leaf} = parseCgroup2(readText('/proc/self/cgroup'), readText('/proc/self/mountinfo'));
    const limits = [];
    let current = leaf;
    while (true) {
        let currentText;
        try {currentText = readText(path.posix.join(current, 'memory.current'));}
        catch (error) {
            // 真正的 cgroup v2 根不提供 memory 控制文件；命名空间映射的根若有控制文件则必须读取。
            if (current === mount && error?.code === 'ENOENT' && readText(path.posix.join(current, 'cgroup.controllers')).split(/\s+/u).includes('memory')) break;
            throw error;
        }
        const used = parseBytes(currentText, `${current}/memory.current`);
        for (const key of ['memory.max', 'memory.high']) {
            const limit = parseBytes(readText(path.posix.join(current, key)), `${current}/${key}`, true);
            if (limit !== undefined) limits.push({path: current, kind: key, limit, used, remaining: limit > used ? limit - used : 0n});
        }
        if (current === mount) break;
        const parent = path.posix.dirname(current);
        if (parent === current || !parent.startsWith(`${mount}/`) && parent !== mount) throw new Error('cgroup 层级超出挂载范围');
        current = parent;
    }
    const effective = limits.reduce((value, item) => item.remaining < value ? item.remaining : value, available);
    return {available, effective, limits, accepted: effective >= MIN_AVAILABLE_BYTES};
}

function formatBytes(value) {return `${(Number(value) / 1024 ** 3).toFixed(2)} GiB`;}

/** 执行前必须由调用方传入已接受的真实内存预算；可注入 spawn 以测试命令和退出传播。 */
export async function executeCiTypecheck({budget, env, spawnChild}) {
    if (!budget.accepted) throw new Error('类型检查剩余内存不足，保留完整检查门禁并停止');
    const child = spawnChild('/usr/bin/time', ['-v', 'pnpm', 'compile'], {
        stdio: 'inherit', env: {...env, NODE_OPTIONS: `--max-old-space-size=${HEAP_LIMIT_MIB}`},
    });
    const result = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({code, signal}));
    });
    if (result.signal) throw new Error(`类型检查被信号终止：${result.signal}`);
    return result.code ?? 1;
}

async function run() {
    const start = performance.now();
    const budget = inspectCiTypeBudget({env: process.env, platform: process.platform, readText: file => readFileSync(file, 'utf8')});
    console.log(`[ci-typecheck] 启动时快照: MemAvailable ${formatBytes(budget.available)}, visible effective ${formatBytes(budget.effective)}, minimum ${formatBytes(MIN_AVAILABLE_BYTES)}; 命名空间可能隐藏上层限制，不是进程树内存硬上限`);
    for (const item of budget.limits) console.log(`[ci-typecheck] ${item.path}/${item.kind}: limit ${formatBytes(item.limit)}, current ${formatBytes(item.used)}, remaining ${formatBytes(item.remaining)}`);
    if (!budget.accepted) throw new Error('类型检查剩余内存不足，保留完整检查门禁并停止');
    console.log(`[ci-typecheck] 执行完整 pnpm compile；仅子进程 Node 旧生代上限 ${HEAP_LIMIT_MIB} MiB。GNU time maximum RSS 是单进程峰值，不是进程树总峰值。`);
    try {
        const code = await executeCiTypecheck({budget,env:process.env,spawnChild:spawn});
        console.log(`[ci-typecheck] exit ${code}`);process.exitCode = code;
    } finally {console.log(`[ci-typecheck] elapsed ${(performance.now() - start).toFixed(0)} ms`);}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    run().catch(error => {console.error(`[ci-typecheck] ${error instanceof Error ? error.message : String(error)}`);process.exitCode = 1;});
}
