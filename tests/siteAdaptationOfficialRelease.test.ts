import {generateKeyPairSync, sign} from 'node:crypto';
import {describe, expect, it, vi} from 'vitest';
import {
    OFFICIAL_SITE_RULE_ENVELOPE_MAX_BYTES,
    verifyOfficialSiteRuleRelease,
} from '@/src/core/site-adaptation/officialRelease';
import {SITE_RULE_LIMITS} from '@/src/core/site-adaptation/schema';
import type {SiteRulePack} from '@/src/core/site-adaptation/types';
import {createOfficialSiteRuleUpdates} from '@/src/services/site-adaptation/officialUpdates';

const {readOfficialSiteRulePack, signOfficialSiteRules} = require('../scripts/site-translation/sign-official-site-rules.mjs') as {
    readOfficialSiteRulePack(): Promise<SiteRulePack>;
    signOfficialSiteRules(pack: unknown, options: {revision: number; minimumVersion: string; pem: string; trustedPublicKey: string}): string;
};

function makeKeys() {
    const {privateKey, publicKey} = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
    return {
        pem: privateKey.export({format: 'pem', type: 'pkcs8'}).toString(),
        trustedPublicKey: publicKey.export({format: 'der', type: 'spki'}).toString('base64'),
    };
}

const keys = makeKeys();
const pack = {version: 1, rules: [{id: 'reader', name: 'Reader', match: {hosts: ['example.test']}, mode: 'augment'}]};
const makeEnvelope = (rules: unknown = pack, revision = 101, minimumVersion = '0.0.42') =>
    signOfficialSiteRules(rules, {...keys, revision, minimumVersion});
const verify = (document: string, version = '0.0.42') => verifyOfficialSiteRuleRelease(document, keys.trustedPublicKey, version);

describe('official site rule release signatures', () => {
    it('verifies the release generated from the bundled catalog with the normal rule schema', async () => {
        const catalog = await readOfficialSiteRulePack();
        const release = await verify(makeEnvelope(catalog));
        expect(release?.revision).toBe(101);
        expect(release?.pack.rules.map(rule => rule.id)).toEqual(catalog.rules.map(rule => rule.id));
        expect(release?.pack.rules.some(rule => rule.id === 'x-post-expand-control')).toBe(true);
    });

    it('rejects a modified payload and a release signed by a different key', async () => {
        const envelope = makeEnvelope();
        const fields = JSON.parse(envelope);
        fields.payload = fields.payload.replace('example.test', 'another.test');
        await expect(verify(JSON.stringify(fields))).resolves.toBeNull();
        await expect(verifyOfficialSiteRuleRelease(envelope, makeKeys().trustedPublicKey, '0.0.42')).resolves.toBeNull();
        await expect(verifyOfficialSiteRuleRelease(envelope, '', '0.0.42')).resolves.toBeNull();
        expect(() => signOfficialSiteRules(pack, {...keys, trustedPublicKey: makeKeys().trustedPublicKey, revision: 101, minimumVersion: '0.0.42'}))
            .toThrow('does not match');
    });

    it('rejects unsupported versions, unknown rule fields, malformed and excessive data', async () => {
        await expect(verify(makeEnvelope(pack, 101, '0.0.43'))).resolves.toBeNull();
        await expect(verify(makeEnvelope(), '0.0.42.0')).resolves.toMatchObject({revision: 101});
        await expect(verify(makeEnvelope(), '0.1.0')).resolves.toMatchObject({revision: 101});
        await expect(verify(makeEnvelope(), '0.0.42-dev')).resolves.toBeNull();
        await expect(verify(makeEnvelope({version: 1, rules: [{...pack.rules[0], javascript: 'native code'}]}))).resolves.toBeNull();
        await expect(verify(JSON.stringify({...JSON.parse(makeEnvelope()), format: 2}))).resolves.toBeNull();
        await expect(verify(JSON.stringify({...JSON.parse(makeEnvelope()), signature: 'not-base64'}))).resolves.toBeNull();
        await expect(verify('not-json')).resolves.toBeNull();
        await expect(verify('[]')).resolves.toBeNull();
        await expect(verify(' '.repeat(OFFICIAL_SITE_RULE_ENVELOPE_MAX_BYTES + 1))).resolves.toBeNull();
        await expect(verify('中'.repeat(Math.ceil(OFFICIAL_SITE_RULE_ENVELOPE_MAX_BYTES / 2)))).resolves.toBeNull();
        expect(() => makeEnvelope({version: 1, rules: [], oversized: '中'.repeat(SITE_RULE_LIMITS.bytes)})).toThrow('size limit');
    });

    it('rejects malformed keys, noncanonical signatures and otherwise signed unknown payload fields', async () => {
        await expect(verifyOfficialSiteRuleRelease(makeEnvelope(), 'AQ==', '0.0.42')).resolves.toBeNull();
        const envelope = JSON.parse(makeEnvelope());
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        const tail = envelope.signature.length - 3;
        envelope.signature = envelope.signature.slice(0, tail) + alphabet[alphabet.indexOf(envelope.signature[tail]) + 1] + '==';
        await expect(verify(JSON.stringify(envelope))).resolves.toBeNull();

        const payload = JSON.stringify({revision: 101, minimumVersion: '0.0.42', pack, extra: true});
        const signature = sign('sha256', Buffer.from('FluentRead official site rules v1\n' + payload),
            {key: keys.pem, dsaEncoding: 'ieee-p1363'}).toString('base64');
        await expect(verify(JSON.stringify({format: 1, payload, signature}))).resolves.toBeNull();
    });
});

describe('official site rule updates', () => {
    const makePorts = (revision = 101) => ({
        trustedPublicKey: keys.trustedPublicKey,
        extensionVersion: '0.0.42',
        readCachedEnvelope: vi.fn(async () => makeEnvelope(pack, revision)),
        writeCachedEnvelope: vi.fn<(value: string) => Promise<void>>().mockResolvedValue(undefined),
        fetch: vi.fn<typeof fetch>(),
    });

    it('shares concurrent refreshes and remembers a newer verified release', async () => {
        const ports = makePorts();
        const next = makeEnvelope(pack, 102);
        ports.fetch.mockResolvedValue(new Response(next));
        const updater = createOfficialSiteRuleUpdates(ports);
        const pending = updater.refresh();
        expect(updater.refresh()).toBe(pending);
        await expect(pending).resolves.toMatchObject({revision: 102});
        await expect(updater.readCurrent()).resolves.toMatchObject({revision: 102});
        expect(ports.readCachedEnvelope).toHaveBeenCalledTimes(1);
        expect(ports.fetch).toHaveBeenCalledExactlyOnceWith('https://read.thinkstu.com/site-rules/v1/official.json',
            expect.objectContaining({method: 'GET', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer'}));
        expect(ports.writeCachedEnvelope).toHaveBeenCalledExactlyOnceWith(next);
    });

    it('keeps the verified cache on rollback, tampering, invalid data, transport or storage failure', async () => {
        const ports = makePorts();
        const updater = createOfficialSiteRuleUpdates(ports);
        const responses = [
            new Response(makeEnvelope(pack, 100)),
            new Response(makeEnvelope(pack, 102).replace('example.test', 'evil.test')),
            new Response(makeEnvelope(pack, 102, '0.0.43')),
            new Response('error', {status: 503}),
            new Response('too-large', {headers: {'content-length': String(OFFICIAL_SITE_RULE_ENVELOPE_MAX_BYTES + 1)}}),
            new Response(new Uint8Array(OFFICIAL_SITE_RULE_ENVELOPE_MAX_BYTES + 1)),
            new Response(new Uint8Array([255])),
            new Response(new ReadableStream({
                start(controller) { controller.enqueue(Uint8Array.of(255)); },
                cancel() { throw new Error('fixture stream already lost its transport'); },
            })),
        ];
        for (const response of responses) {
            ports.fetch.mockResolvedValueOnce(response);
            await expect(updater.refresh()).resolves.toMatchObject({revision: 101});
        }
        ports.fetch.mockRejectedValueOnce(new Error('offline'));
        await expect(updater.refresh()).resolves.toMatchObject({revision: 101});
        expect(ports.writeCachedEnvelope).not.toHaveBeenCalled();
        ports.fetch.mockResolvedValueOnce(new Response(makeEnvelope(pack, 103)));
        ports.writeCachedEnvelope.mockRejectedValueOnce(new Error('disk unavailable'));
        await expect(updater.refresh()).resolves.toMatchObject({revision: 101});
        await expect(updater.readCurrent()).resolves.toMatchObject({revision: 101});
    });

    it('leaves the bundled fallback in use with no trust configuration or no usable copy', async () => {
        const ports = makePorts();
        const disabled = createOfficialSiteRuleUpdates({...ports, trustedPublicKey: ''});
        await expect(disabled.refresh()).resolves.toBeNull();
        expect(ports.fetch).not.toHaveBeenCalled();
        expect(ports.readCachedEnvelope).not.toHaveBeenCalled();
        ports.readCachedEnvelope.mockRejectedValueOnce(new Error('storage unavailable'));
        ports.fetch.mockResolvedValueOnce(new Response(null));
        const updater = createOfficialSiteRuleUpdates(ports);
        await expect(updater.refresh()).resolves.toBeNull();
        expect(ports.writeCachedEnvelope).not.toHaveBeenCalled();
    });
});
