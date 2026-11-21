import {createPrivateKey, createPublicKey, sign} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const signingContext = 'FluentRead official site rules v1\n';
const catalogDirectory = new URL('../../src/core/site-adaptation/catalog/', import.meta.url);

export async function readOfficialSiteRulePack() {
    const readCatalog = async name => JSON.parse(await readFile(new URL(name, catalogDirectory), 'utf8'));
    const [profiles, established, websites] = await Promise.all([
        readCatalog('profiles.json'), readCatalog('established.json'), readCatalog('websites.json'),
    ]);
    return {version: 1, profiles, rules: [...established, ...websites]};
}

// Production signing receives a PEM through the runner's secret environment.
// Only the public SPKI is compared, and only the signed envelope is written.
export function signOfficialSiteRules(pack, {revision, minimumVersion, pem, trustedPublicKey}) {
    if (!Number.isSafeInteger(revision) || revision < 1
        || typeof minimumVersion !== 'string' || !/^\d{1,5}(?:\.\d{1,5}){1,3}$/u.test(minimumVersion)) {
        throw new Error('Official site rule revision or minimum version is invalid');
    }
    const privateKey = createPrivateKey(pem);
    if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
        throw new Error('Official site rules require a P-256 private key');
    }
    if (createPublicKey(privateKey).export({type: 'spki', format: 'der'}).toString('base64') !== trustedPublicKey) {
        throw new Error('Official site rule signing key does not match the configured public key');
    }
    const payload = JSON.stringify({revision, minimumVersion, pack});
    if (Buffer.byteLength(payload) > 2 * 1024 * 1024) throw new Error('Official site rule payload exceeds its size limit');
    const signature = sign('sha256', Buffer.from(signingContext + payload), {key: privateKey, dsaEncoding: 'ieee-p1363'}).toString('base64');
    return JSON.stringify({format: 1, payload, signature}) + '\n';
}

async function main() {
    const [output, revision, minimumVersion] = process.argv.slice(2);
    if (!output || !revision || !minimumVersion) {
        throw new Error('Usage: node scripts/site-translation/sign-official-site-rules.mjs OUTPUT REVISION MINIMUM_VERSION');
    }
    const pem = process.env.FLUENTREAD_SITE_RULES_PRIVATE_KEY;
    const trustedPublicKey = process.env.WXT_SITE_RULES_PUBLIC_KEY?.trim();
    if (!pem || !trustedPublicKey) throw new Error('Official site rule keys are missing');
    const envelope = signOfficialSiteRules(await readOfficialSiteRulePack(), {revision: Number(revision), minimumVersion, pem, trustedPublicKey});
    await mkdir(dirname(output), {recursive: true});
    await writeFile(output, envelope, 'utf8');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
