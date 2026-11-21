import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {OfficialSiteRuleRelease} from '@/src/core/site-adaptation/officialRelease';

const service = vi.hoisted(() => ({make: vi.fn(), read: vi.fn(), refresh: vi.fn()}));
vi.mock('@/src/services/site-adaptation/officialUpdates', () => ({createOfficialSiteRuleUpdates: service.make}));

const release: OfficialSiteRuleRelease = {revision: 100, minimumVersion: '0.0.42', pack: {version: 1, rules: []}};
const extensionId = 'test-extension';

function mockBrowser() {
    const ports = {
        runtime: {id: extensionId, getManifest: vi.fn(() => ({version: '0.0.42'})),
            getURL: vi.fn((path: string) => 'chrome-extension://' + extensionId + path), sendMessage: vi.fn()},
        storage: {local: {get: vi.fn(), set: vi.fn()}},
        alarms: {get: vi.fn(), create: vi.fn(), onAlarm: {addListener: vi.fn()}},
    };
    vi.stubGlobal('browser', ports);
    return ports;
}

beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.stubEnv('BROWSER', 'chrome');
    vi.stubEnv('WXT_SITE_RULES_PUBLIC_KEY', ' public-key ');
    service.read.mockResolvedValue(release);
    service.refresh.mockResolvedValue(release);
    service.make.mockReturnValue({readCurrent: service.read, refresh: service.refresh});
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('official site rule background wiring', () => {
    it('registers and uses neither messages nor alarms without configured trust', async () => {
        vi.stubEnv('WXT_SITE_RULES_PUBLIC_KEY', undefined);
        const browser = mockBrowser();
        const runtime = await import('@/src/app/background/officialSiteRuleRuntime');
        expect(runtime.createOfficialSiteRuleHandlers()).toEqual([]);
        runtime.installOfficialSiteRuleMaintenance();
        expect(browser.alarms.onAlarm.addListener).not.toHaveBeenCalled();
        expect(service.make).not.toHaveBeenCalled();
    });

    it('shares one updater, gates reads and refreshes by sender and uses extension-owned storage', async () => {
        const browser = mockBrowser();
        const fetch = vi.fn().mockResolvedValue(new Response('test rules'));
        vi.stubGlobal('fetch', fetch);
        const runtime = await import('@/src/app/background/officialSiteRuleRuntime');
        const [read, refresh] = runtime.createOfficialSiteRuleHandlers();
        const content = {id: extensionId, url: 'https://example.test/'};
        const settings = {id: extensionId, url: browser.runtime.getURL('/options.html#settings-sites')};
        expect(read.handle({type: read.type}, {sender: {id: 'external'}})).toBeNull();
        expect(refresh.handle({type: refresh.type}, {sender: content})).toBeNull();
        await expect(read.handle({type: read.type}, {sender: content})).resolves.toBe(release);
        await expect(refresh.handle({type: refresh.type}, {sender: settings})).resolves.toBe(release);
        expect(service.make).toHaveBeenCalledTimes(1);
        const [ports] = service.make.mock.calls[0];
        expect(ports).toMatchObject({trustedPublicKey: 'public-key', extensionVersion: '0.0.42'});
        const key = 'fluentread:official-site-rule-release-v1';
        browser.storage.local.get.mockResolvedValue({[key]: 'saved'});
        await expect(ports.readCachedEnvelope()).resolves.toBe('saved');
        await ports.writeCachedEnvelope('next');
        expect(browser.storage.local.set).toHaveBeenCalledWith({[key]: 'next'});
        await ports.fetch('https://read.thinkstu.com/');
        expect(fetch).toHaveBeenCalledWith('https://read.thinkstu.com/', undefined);
    });

    it('installs a missing periodic alarm and refreshes only for its own name', async () => {
        const browser = mockBrowser();
        const runtime = await import('@/src/app/background/officialSiteRuleRuntime');
        const alarmName = 'fluentread-official-site-rule-refresh';
        runtime.installOfficialSiteRuleMaintenance();
        await vi.waitFor(() => expect(browser.alarms.create).toHaveBeenCalledWith(alarmName, {delayInMinutes: 1, periodInMinutes: 360}));
        const [listener] = browser.alarms.onAlarm.addListener.mock.calls[0];
        listener({name: 'other'});
        expect(service.refresh).not.toHaveBeenCalled();
        listener({name: alarmName});
        expect(service.refresh).toHaveBeenCalledOnce();
    });

    it('retains an existing alarm and diagnoses scheduling failure', async () => {
        const browser = mockBrowser();
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const runtime = await import('@/src/app/background/officialSiteRuleRuntime');
        browser.alarms.get.mockResolvedValueOnce({name: 'fluentread-official-site-rule-refresh'});
        runtime.installOfficialSiteRuleMaintenance();
        await vi.waitFor(() => expect(browser.alarms.get).toHaveBeenCalled());
        expect(browser.alarms.create).not.toHaveBeenCalled();
        browser.alarms.get.mockRejectedValueOnce(new Error('alarm API unavailable'));
        runtime.installOfficialSiteRuleMaintenance();
        await vi.waitFor(() => expect(warning).toHaveBeenCalledExactlyOnceWith('[FluentRead] 官方网站规则更新定时任务安装失败'));
    });
});

describe('official site rule client', () => {
    it('stays on bundled rules in userscript builds', async () => {
        vi.stubEnv('BROWSER', 'userscript');
        const browser = mockBrowser();
        const client = await import('@/src/services/site-adaptation/officialClient');
        await expect(client.readOfficialSiteRuleRelease()).resolves.toBeNull();
        expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
    });

    it('reads and refreshes via the background routes and rejects unusable replies', async () => {
        const browser = mockBrowser();
        const client = await import('@/src/services/site-adaptation/officialClient');
        browser.runtime.sendMessage.mockResolvedValueOnce(release).mockResolvedValueOnce({pack: release.pack});
        await expect(client.readOfficialSiteRuleRelease()).resolves.toBe(release);
        await expect(client.refreshOfficialSiteRuleRelease()).resolves.toBeNull();
        expect(browser.runtime.sendMessage.mock.calls).toEqual([
            [{type: 'readOfficialSiteRuleRelease'}], [{type: 'refreshOfficialSiteRuleRelease'}],
        ]);
        browser.runtime.sendMessage.mockRejectedValueOnce(new Error('worker disconnected'));
        await expect(client.readOfficialSiteRuleRelease()).resolves.toBeNull();
    });

    it('does not hold page startup open when its background read never settles', async () => {
        vi.useFakeTimers();
        const browser = mockBrowser();
        browser.runtime.sendMessage.mockReturnValue(new Promise(() => undefined));
        const client = await import('@/src/services/site-adaptation/officialClient');
        const pending = client.readOfficialSiteRuleRelease();
        await vi.advanceTimersByTimeAsync(1200);
        await expect(pending).resolves.toBeNull();
        expect(vi.getTimerCount()).toBe(0);
    });
});
