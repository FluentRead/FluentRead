import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {
    DEFAULT_USERSCRIPT_SIZE_BUDGET_PATH,
    evaluateUserscriptStandaloneSize,
    loadUserscriptSizeBudget,
    updateUserscriptSizeBudget,
} from './testing/userscript-size-budget.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const defaultArtifact = resolve(root, '.output/userscript-standalone/fluent-read.user.js');

function parseCliArgs(argv) {
    const options = {
        artifact: defaultArtifact,
        budgetPath: DEFAULT_USERSCRIPT_SIZE_BUDGET_PATH,
        updateBaseline: false,
        commit: undefined,
    };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--') continue;
        if (arg === '--update-baseline') {
            options.updateBaseline = true;
            continue;
        }
        if (arg === '--artifact' || arg === '--budget' || arg === '--commit') {
            const value = argv[++index];
            if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
            if (arg === '--artifact') options.artifact = resolve(value);
            else if (arg === '--budget') options.budgetPath = resolve(value);
            else options.commit = value;
            continue;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
    return options;
}

function resolveCurrentShortCommit() {
    try {
        return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
            cwd: root,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        return undefined;
    }
}

export function verifyUserscriptStandaloneBuild(argv = process.argv.slice(2)) {
    const options = parseCliArgs(argv);
    const artifact = options.artifact;
    const source = readFileSync(artifact, 'utf8');
    const metadataEnd = source.indexOf('// ==/UserScript==');
    if (metadataEnd < 0) throw new Error('Standalone userscript metadata is missing');
    const metadata = source.slice(0, metadataEnd);
    const {userscriptVersion} = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    const {version: vueVersion} = JSON.parse(readFileSync(resolve(root, 'node_modules/vue/package.json'), 'utf8'));
    const {version: elementPlusVersion} = JSON.parse(readFileSync(resolve(root, 'node_modules/element-plus/package.json'), 'utf8'));
    const assertions = [
        [source.startsWith('// ==UserScript==\n'), 'Metadata must be the first bytes'],
        [metadata.includes(`// @version      ${userscriptVersion}`), 'Standalone version is stale'],
        [metadata.includes('// @inject-into  content'), 'GM APIs require content-world injection'],
        [metadata.includes('// @grant        GM.xmlHttpRequest'), 'Safari request grant is missing'],
        [metadata.includes('// @grant        GM_xmlhttpRequest'), 'Classic request grant is missing'],
        [metadata.includes('// @grant        GM.openInTab') && metadata.includes('// @grant        GM_openInTab'), 'Settings tab grants are missing'],
        [!/^\/\/ @require\s/gmu.test(metadata), 'Standalone installation must not need remote JavaScript'],
        [source.includes('fluentread-userscript-settings'), 'Full Options route is missing'],
        [!source.includes('fluent-read-writing-assistant'), 'Writing assistant runtime must be excluded'],
        [!source.includes('data-fr-slot'), 'Extension-only image context protocol must be excluded'],
        [!source.includes('imageLabelContext') && !source.includes('imageLabelSlots'), 'Extension-only image label metadata must be excluded'],
        [!source.includes('fr-selection-highlight') && !source.includes('fr-selection-underline'), 'Native PDF annotation controls must be excluded'],
        [!source.includes('hypothesis/build/'), 'Packaged Hypothesis client must be excluded'],
        [source.includes('__FLUENTREAD_BROWSER_CAPABILITY_BUILD__:userscript:mv2__'), 'Userscript browser capability marker is missing'],
        [source.includes('pako 2.1.0 —'), 'Bundled gzip fallback or license notice is missing'],
        [source.includes(`@vue/runtime-dom ${vueVersion} — MIT`), 'Bundled Vue or license notice is missing'],
        [source.includes(`element-plus ${elementPlusVersion} — MIT`), 'Bundled UI or license notice is missing'],
    ];
    for (const [passed, message] of assertions) {
        if (!passed) throw new Error(message);
    }

    const bytes = Buffer.byteLength(source);
    if (options.updateBaseline) {
        const updated = updateUserscriptSizeBudget(options.budgetPath, bytes, {
            updatedFromCommit: options.commit ?? resolveCurrentShortCommit(),
        });
        console.log(`[userscript-size] Updated baseline in ${options.budgetPath} to ${updated.baselineBytes.toLocaleString('en-US')} bytes (soft +${updated.softWarnDeltaBytes.toLocaleString('en-US')}, hard +${updated.hardMaxDeltaBytes.toLocaleString('en-US')})`);
        console.log(`Verified ${artifact} (${bytes.toLocaleString()} bytes; no @require)`);
        return {bytes, status: 'ok', updated};
    }

    // Full Options standalone build is hosted outside Greasy Fork (whose separate rules cap scripts at 2 MB).
    // Budget baseline and soft/hard deltas live in scripts/testing/userscript-size-budget.json.
    const budget = loadUserscriptSizeBudget(options.budgetPath);
    const evaluation = evaluateUserscriptStandaloneSize(bytes, budget);
    if (evaluation.status === 'fail') {
        throw new Error(evaluation.message);
    }
    if (evaluation.status === 'warn') {
        console.warn(evaluation.message);
    }
    console.log(`Verified ${artifact} (${bytes.toLocaleString()} bytes; no @require)`);
    return evaluation;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    verifyUserscriptStandaloneBuild();
}
