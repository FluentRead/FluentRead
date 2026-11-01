/** 验证托管 CI 类型检查的内存门禁；所有内核状态均使用替身，不启动类型检查。 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import {executeCiTypecheck,inspectCiTypeBudget} from '../scripts/testing/run-ci-typecheck.mjs';

const gib = 1024n ** 3n;
const env = {GITHUB_ACTIONS:'true', RUNNER_OS:'Linux', RUNNER_ENVIRONMENT:'github-hosted',FLUENTREAD_TEST_CONCURRENCY:'1',FLUENTREAD_TEST_MAX_WORKERS:'1'};
const root = '/sys/fs/cgroup';
const branch = `${root}/runner`;
const leaf = `${branch}/job`;
function fixture({available = 12n*gib, leafMax = 'max', leafHigh = 'max', leafUsed = 1n*gib,
    branchMax = 14n*gib, branchHigh = 'max', branchUsed = 2n*gib, rootMax, rootHigh = 'max', rootUsed = 0n} = {}) {
    const files = {
        '/etc/os-release': 'ID=ubuntu\nVERSION_ID="24.04"\n',
        '/proc/meminfo': `MemTotal: 16777216 kB\nMemAvailable: ${available/1024n} kB\n`,
        '/proc/self/cgroup': '0::/runner/job\n',
        '/proc/self/mountinfo': '29 23 0:26 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n',
        [`${leaf}/memory.current`]: String(leafUsed), [`${leaf}/memory.max`]: String(leafMax), [`${leaf}/memory.high`]: String(leafHigh),
        [`${branch}/memory.current`]: String(branchUsed), [`${branch}/memory.max`]: String(branchMax), [`${branch}/memory.high`]: String(branchHigh),
        [`${root}/cgroup.controllers`]: 'cpuset cpu io memory pids\n',
    };
    if (rootMax !== undefined) Object.assign(files, {[`${root}/memory.current`]:String(rootUsed),[`${root}/memory.max`]:String(rootMax),[`${root}/memory.high`]:String(rootHigh)});
    const readText = file => {
        if (!(file in files)) {const error = new Error(`missing ${file}`);error.code = 'ENOENT';throw error;}
        return files[file];
    };
    return {files,readText};
}
const inspect = fixture => inspectCiTypeBudget({env,platform:'linux',readText:fixture.readText});

test('hosted Ubuntu accepts sufficient host and visible ancestor budget', () => {
    const result = inspect(fixture());
    assert.equal(result.accepted,true);assert.equal(result.available,12n*gib);assert.equal(result.effective,12n*gib);
});
test('available host RAM, ancestor max and ancestor high are each real boundaries', () => {
    for (const config of [{available:8n*gib},{branchMax:10n*gib,branchUsed:2n*gib},{leafHigh:9n*gib,leafUsed:1n*gib}]) {
        assert.equal(inspect(fixture(config)).accepted,false);
    }
    assert.equal(inspect(fixture({leafMax:10n*gib,leafUsed:1n*gib})).accepted,true);
});
test('namespace root memory limits are checked instead of ignored', () => {
    const result=inspect(fixture({rootMax:9n*gib,rootUsed:1n*gib}));
    assert.equal(result.accepted,false);assert.equal(result.effective,8n*gib);
});
test('non-hosted, non-Linux and non-Ubuntu executions refuse to start', () => {
    const f=fixture();
    for (const altered of [{...env,GITHUB_ACTIONS:'false'},{...env,RUNNER_ENVIRONMENT:'self-hosted'},{...env,RUNNER_OS:'macOS'}]) {
        assert.throws(()=>inspectCiTypeBudget({env:altered,platform:'linux',readText:f.readText}),/仅允许/u);
    }
    assert.throws(()=>inspectCiTypeBudget({env,platform:'darwin',readText:f.readText}),/仅允许/u);
    assert.throws(()=>inspectCiTypeBudget({env:{...env,FLUENTREAD_TEST_CONCURRENCY:'2'},platform:'linux',readText:f.readText}),/单槽/u);
    f.files['/etc/os-release']='ID=debian\n';assert.throws(()=>inspect(f),/Ubuntu/u);
});
test('malformed, missing, unknown or traversal resource data fails closed', () => {
    for (const [file,value] of [
        ['/proc/meminfo','MemFree: 12000000 kB\n'],
        ['/proc/self/cgroup','2:memory:/runner\n'],
        ['/proc/self/cgroup','0::/runner/../job\n'],
        [`${leaf}/memory.current`,'not-a-number'],
        [`${leaf}/memory.max`,'unknown'],
    ]) {
        const f=fixture();f.files[file]=value;assert.throws(()=>inspect(f));
    }
    const missing=fixture();delete missing.files[`${leaf}/memory.high`];assert.throws(()=>inspect(missing));
});
test('a cgroup subtree mount is rejected because ancestors are invisible', () => {
    const f=fixture({rootMax:9n*gib,rootUsed:1n*gib});
    f.files['/proc/self/cgroup']='0::/tenant/runner/job\n';
    f.files['/proc/self/mountinfo']='29 23 0:26 /tenant /sys/fs/cgroup rw - cgroup2 cgroup rw\n';
    assert.throws(()=>inspect(f),/无法确定 cgroup v2/u);
});
test('workflow uses the helper for complete compile and leaves global 4 GiB settings', () => {
    const extension=readFileSync('.github/workflows/extension-quality.yml','utf8');
    const release=readFileSync('.github/workflows/release-packages.yml','utf8');
    for (const source of [extension,release]) {
        assert.match(source,/NODE_OPTIONS: --max-old-space-size=4096/u);
        assert.equal((source.match(/node scripts\/testing\/run-ci-typecheck\.mjs/gu)??[]).length,1);
        assert.doesNotMatch(source,/max-old-space-size=6144/u);
    }
    assert.match(extension,/- name: Check extension and shared Vue types\n\s+if: steps\.affected\.outputs\.extension_changed == 'true'\n\s+run: node scripts\/testing\/run-ci-typecheck\.mjs/u);
    assert.match(extension,/node --test --test-concurrency=1 tests\/\*\.test\.mjs/u);
    assert.match(release,/- name: Audit and check types\n\s+run: \|\n\s+pnpm test:audit\n\s+node --test tests\/ciTypeBudget\.test\.mjs\n\s+node scripts\/testing\/run-ci-typecheck\.mjs/u);
    const helper=readFileSync('scripts/testing/run-ci-typecheck.mjs','utf8');
    assert.match(helper,/\['-v', 'pnpm', 'compile'\]/u);
});
test('only accepted budget starts complete compile with child-only heap and preserves exact exit', async () => {
    const callerEnv={...env,NODE_OPTIONS:'--max-old-space-size=4096'};let calls=0;
    const fakeSpawn=(command,args,options)=>{
        calls++;assert.equal(command,'/usr/bin/time');assert.deepEqual(args,['-v','pnpm','compile']);
        assert.equal(options.env.NODE_OPTIONS,'--max-old-space-size=6144');assert.equal(callerEnv.NODE_OPTIONS,'--max-old-space-size=4096');
        const child=new EventEmitter();queueMicrotask(()=>child.emit('exit',42,null));return child;
    };
    await assert.rejects(executeCiTypecheck({budget:{accepted:false},env:callerEnv,spawnChild:fakeSpawn}),/内存不足/u);
    assert.equal(calls,0);assert.equal(await executeCiTypecheck({budget:{accepted:true},env:callerEnv,spawnChild:fakeSpawn}),42);
    assert.equal(calls,1);
});
test('spawn errors and terminated child do not masquerade as success', async () => {
    const failing=()=>{const child=new EventEmitter();queueMicrotask(()=>child.emit('error',new Error('missing time')));return child;};
    const killed=()=>{const child=new EventEmitter();queueMicrotask(()=>child.emit('exit',null,'SIGTERM'));return child;};
    await assert.rejects(executeCiTypecheck({budget:{accepted:true},env,spawnChild:failing}),/missing time/u);
    await assert.rejects(executeCiTypecheck({budget:{accepted:true},env,spawnChild:killed}),/SIGTERM/u);
});
test('local CLI refuses before spawning pnpm even when environment is not trusted', () => {
    const result=spawnSync(process.execPath,['scripts/testing/run-ci-typecheck.mjs'],{encoding:'utf8',env:{...process.env,GITHUB_ACTIONS:'false'}});
    assert.equal(result.status,1);assert.match(result.stderr,/仅允许/u);assert.doesNotMatch(result.stdout,/执行完整 pnpm compile/u);
});
