/** Run every diagnostic partition sequentially with unchanged Program roots, resolution and compiler options. */
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export function verifyTypecheckReceipts(manifests, results) {
    if (manifests.length !== 4 || results.length !== 4) throw new Error('Missing typecheck partitions');
    for (const item of manifests) {
        if (createHash('sha256').update(JSON.stringify(item.manifest)).digest('hex') !== item.fingerprint) throw new Error('Invalid Program fingerprint');
    }
    const fingerprint = manifests[0].fingerprint;
    const count = manifests[0].manifest.files.length;
    const visited = new Set();
    results.forEach((result, part) => {
        if (manifests[part].fingerprint !== fingerprint || result.fingerprint !== fingerprint || result.complete !== true) {
            throw new Error('Typecheck Program changed or partition did not complete');
        }
        for (const index of result.selected) {
            if (!Number.isInteger(index) || index < 0 || index >= count || index % 4 !== part || visited.has(index)) {
                throw new Error('Invalid or duplicate diagnostic assignment');
            }
            visited.add(index);
        }
    });
    if (visited.size !== count) throw new Error('Some source files were not checked');
    return {fingerprint, sourceFiles: count, roots: manifests[0].manifest.roots.length, partitions: 4};
}

function runPart(worker, project, directory, part, signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {reject(new Error('Typecheck interrupted')); return;}
        const child = spawn(process.execPath, [worker, '--noEmit', '--pretty', 'false', '--project', project], {
            cwd: process.cwd(), stdio: 'inherit', shell: false,
            env: {...process.env, FLUENTREAD_TYPECHECK_PART: String(part), FLUENTREAD_TYPECHECK_RECEIPTS: directory},
        });
        let interrupted = false, timer;
        const stop = () => {interrupted = true; child.kill('SIGTERM'); timer ??= setTimeout(() => child.kill('SIGKILL'), 3000);};
        signal.addEventListener('abort', stop, {once: true});
        if (signal.aborted) stop();
        const cleanup = () => {clearTimeout(timer); signal.removeEventListener('abort', stop);};
        child.once('error', error => {cleanup(); reject(error);});
        child.once('close', (code, signal) => {
            cleanup();
            if (interrupted || signal || code !== 0) reject(new Error(`Typecheck partition ${part + 1}/4 failed: exit=${code}, signal=${signal}`));
            else resolve();
        });
    });
}

export async function runTypecheck(project = path.resolve('tsconfig.json')) {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    let directory;
    const worker = fileURLToPath(new URL('./typecheck-part-worker.cjs', import.meta.url));
    const manifests = [], results = [];
    let verified;
    try {
        directory = await mkdtemp(path.join(os.tmpdir(), 'fluentread-typecheck-'));
        for (let part = 0; part < 4; part++) {
            console.log(`[typecheck] partition ${part + 1}/4, original Program retained`);
            await runPart(worker, project, directory, part, controller.signal);
            const manifest = JSON.parse(await readFile(path.join(directory, `${part}.manifest.json`), 'utf8'));
            const result = JSON.parse(await readFile(path.join(directory, `${part}.result.json`), 'utf8'));
            if (part && manifests[0].fingerprint !== manifest.fingerprint) throw new Error('Typecheck Program changed between partitions');
            manifests.push(manifest); results.push(result);
        }
        if (controller.signal.aborted) throw new Error('Typecheck interrupted');
        verified = verifyTypecheckReceipts(manifests, results);
    } finally {
        try {if (directory) await rm(directory, {recursive: true, force: true});}
        finally {process.off('SIGINT', stop); process.off('SIGTERM', stop);}
    }
    if (controller.signal.aborted) throw new Error('Typecheck interrupted during cleanup');
    console.log(`[typecheck] complete: ${JSON.stringify(verified)}`);
    return verified;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    if (process.argv.length !== 2) throw new Error('run-typecheck accepts no CLI overrides');
    runTypecheck().catch(error => {console.error(error.message); process.exitCode = 1;});
}
