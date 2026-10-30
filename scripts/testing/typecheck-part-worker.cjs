/** Keep the original Vue/TS Program intact; partition only raw semantic diagnostics before Volar maps them. */
const {createRequire} = require('node:module');
const {createHash} = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const req = createRequire(path.join(process.cwd(), 'package.json'));
const vr = createRequire(req.resolve('vue-tsc'));
for (const [name, expected] of [['typescript', '5.7.3'], ['vue-tsc', '2.2.0'], ['@volar/typescript', '2.4.11']]) {
    if (vr(`${name}/package.json`).version !== expected) throw new Error(`Revalidate diagnostic partitioning for ${name}`);
}
const index = Number(process.env.FLUENTREAD_TYPECHECK_PART);
const count = 4;
const directory = process.env.FLUENTREAD_TYPECHECK_RECEIPTS;
if (!Number.isInteger(index) || index < 0 || index >= count || !directory) throw new Error('Invalid typecheck partition');
for (let at = 2; at < process.argv.length; at++) {
    const flag = process.argv[at];
    if (flag === '--noEmit') continue;
    if ((flag === '--pretty' && process.argv[at + 1] === 'false') || ((flag === '--project' || flag === '-p') && process.argv[at + 1])) {at++; continue;}
    throw new Error(`Unsupported typecheck argument: ${flag}`);
}
const api = vr('@volar/typescript/lib/node/proxyCreateProgram');
const factory = api.proxyCreateProgram;
let created = false, completed = false;
api.proxyCreateProgram = (ts, original, ...rest) => factory(ts, new Proxy(original, {
    apply(target, thisArg, args) {
        if (created) throw new Error('Multiple Programs require a separate partitioning contract');
        created = true;
        const program = Reflect.apply(target, thisArg, args);
        const options = {...program.getCompilerOptions()};
        if (!options.noEmit || options.incremental || options.composite || program.getProjectReferences()?.length) {
            throw new Error('Only non-incremental noEmit Programs without references are supported');
        }
        const configPaths = [options.configFilePath, ...(options.configFile?.extendedSourceFiles || [])];
        const configuration = configPaths.map(name => ({name, hash: createHash('sha256').update(fs.readFileSync(name)).digest('hex')}));
        const vueOptions = vr('@vue/language-core').createParsedCommandLine(ts, ts.sys, options.configFilePath).vueOptions;
        delete options.configFile;
        const files = program.getSourceFiles();
        const manifest = {configuration, vueOptions, roots: program.getRootFileNames(), options, files: files.map(file => ({
            name: file.fileName, declaration: file.isDeclarationFile, format: file.impliedNodeFormat,
            hash: createHash('sha256').update(file.text).digest('hex'),
        }))};
        const fingerprint = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
        fs.writeFileSync(path.join(directory, `${index}.manifest.json`), JSON.stringify({fingerprint, manifest}));
        const originalDiagnostics = program.getSemanticDiagnostics.bind(program);
        // This hook is on the raw TS Program. Volar subsequently keeps its normal ALL-file mapping/filtering.
        program.getSemanticDiagnostics = (sourceFile, cancellationToken, nodesToCheck) => {
            if (sourceFile) return originalDiagnostics(sourceFile, cancellationToken, nodesToCheck);
            if (completed) throw new Error('Unexpected repeated all-file semantic pass');
            const selected = files.map((_, at) => at).filter(at => at % count === index);
            const diagnostics = ts.sortAndDeduplicateDiagnostics(selected.flatMap(at => {
                cancellationToken?.throwIfCancellationRequested();
                return originalDiagnostics(files[at], cancellationToken, nodesToCheck);
            }));
            completed = true;
            fs.writeFileSync(path.join(directory, `${index}.result.json`), JSON.stringify({fingerprint, selected, complete: true}));
            return diagnostics;
        };
        return program;
    },
}), ...rest);
process.once('exit', code => {
    if (code === 0 && (!created || !completed)) {
        console.error('Typecheck did not complete the expected semantic pass');
        process.exitCode = 1;
    }
});
vr('vue-tsc').run();
