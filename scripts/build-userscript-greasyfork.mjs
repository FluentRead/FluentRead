import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prepareResources = process.argv.slice(2).join(' ') === '--prepare-resources';
if (process.argv.length > 3 || (process.argv.length === 3 && !prepareResources)) {
    throw new Error('Usage: node scripts/build-userscript-greasyfork.mjs [--prepare-resources]');
}

const resourceDir = 'userscript/resources';
const resources = [
    ['.output/userscript-vendor/fluentread-vendor.v1.js', `${resourceDir}/fluentread-vendor.v1.js`],
    ['.output/userscript-greasyfork/fluentread-data.v1.js', `${resourceDir}/fluentread-data.v1.js`],
];
// 所有会改变 vendor 输出的本地源都必须存在于资源提交且保持一致。
const vendorSources = ['userscript/vendorEntry.ts', 'userscript/vendor.vite.config.ts',
    'scripts/testing/franc-runtime-build.ts', 'public/third-party-notices/franc-min-MIT.txt', 'pnpm-lock.yaml'];

function run(command, args, extraEnv = {}) {
    const result = spawnSync(command, args, {
        cwd: root,
        env: {...process.env, ...extraEnv},
        encoding: 'utf8',
        stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status})`);
}

function gitOutput(args) {
    const result = spawnSync('git', args, {cwd: root, encoding: 'utf8', maxBuffer: 10_000_000});
    if (result.error || result.status !== 0) {
        throw result.error || new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
    }
    return result.stdout.trim();
}

const commit = prepareResources ? '' : gitOutput(['log', '-1', '--format=%H', '--', ...resources.map(([, tracked]) => tracked)]);
if (!prepareResources && !/^[a-f0-9]{40}$/u.test(commit)) {
    throw new Error('Commit both Greasy Fork resources before building the pinned source');
}
const baseUrl = prepareResources
    ? 'http://127.0.0.1:57511'
    : `https://cdn.jsdelivr.net/gh/FluentRead/FluentRead@${commit}/${resourceDir}`;
const buildEnv = {
    FLUENTREAD_USERSCRIPT_GREASYFORK_SOURCE: '1',
    FLUENTREAD_USERSCRIPT_PREPARE_RESOURCES: prepareResources ? '1' : '0',
    FLUENTREAD_USERSCRIPT_VENDOR_URL: `${baseUrl}/fluentread-vendor.v1.js`,
    FLUENTREAD_USERSCRIPT_DATA_URL: `${baseUrl}/fluentread-data.v1.js`,
};

if (prepareResources) {
    run('pnpm', ['exec', 'vite', 'build', '--config', 'userscript/vendor.vite.config.ts']);
} else {
    for (const source of vendorSources) {
        gitOutput(['cat-file', '-e', `${commit}:${source}`]);
    }
    run('git', ['diff', '--exit-code', commit, '--', ...vendorSources]);
    fs.mkdirSync(path.resolve(root, '.output/userscript-vendor'), {recursive: true});
    fs.copyFileSync(path.resolve(root, resources[0][1]), path.resolve(root, resources[0][0]));
}
run('pnpm', ['exec', 'vite', 'build', '--config', 'userscript/vite.config.ts'], buildEnv);

for (const [built, tracked] of resources) {
    const builtBytes = fs.readFileSync(path.resolve(root, built));
    const trackedPath = path.resolve(root, tracked);
    if (prepareResources) {
        fs.mkdirSync(path.dirname(trackedPath), {recursive: true});
        fs.writeFileSync(trackedPath, builtBytes);
        continue;
    }
    const committed = spawnSync('git', ['show', `${commit}:${tracked}`], {
        cwd: root,
        maxBuffer: 10_000_000,
    });
    const trackedBytes = fs.readFileSync(trackedPath);
    if (committed.error || committed.status !== 0
        || !trackedBytes.equals(committed.stdout)
        || !builtBytes.equals(trackedBytes)) {
        throw new Error(`Greasy Fork resource changed since ${commit}: ${tracked}; run --prepare-resources and commit it`);
    }
}

if (prepareResources) {
    console.log('Prepared userscript/resources; commit both files, then rebuild without --prepare-resources.');
} else {
    run('node', ['scripts/verify-userscript-greasyfork-build.mjs']);
    console.log(`Greasy Fork source pins resources at ${commit}`);
}
