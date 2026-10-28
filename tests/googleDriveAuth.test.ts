import {afterEach, describe, expect, it, vi} from 'vitest';
import {createDriveAuth, DriveError, type DriveAuthPorts} from '@/src/platform/google-drive/auth';
import {GOOGLE_DRIVE_DEFAULT_CLIENT_ID, GOOGLE_DRIVE_EXTENSION_ID, GOOGLE_DRIVE_SCOPES} from '@/src/platform/google-drive/constants';

function fixture() {
    const ports: DriveAuthPorts = {
        userAgent: () => 'Chrome/142.0.0.0',
        identity: {getAuthToken: vi.fn(async () => ({token: 'fixture-access', grantedScopes: [...GOOGLE_DRIVE_SCOPES]})), removeCachedAuthToken: vi.fn(async () => undefined), clearAllCachedAuthTokens: vi.fn(async () => undefined)},
        runtime: {id: GOOGLE_DRIVE_EXTENSION_ID, getManifest: () => ({oauth2: {client_id: GOOGLE_DRIVE_DEFAULT_CLIENT_ID, scopes: [...GOOGLE_DRIVE_SCOPES]}})},
        fetch: vi.fn(async () => new Response(JSON.stringify({user: {permissionId: 'fixture-account', emailAddress: 'tester@fixture.invalid'}}))),
    };
    return {ports, auth: createDriveAuth(ports)};
}
afterEach(() => vi.useRealTimers());
describe('Chrome Google 身份边界', () => {
    it('账号响应失败时不等未读正文取消握手，并及时释放超时计时器', async () => {
        vi.useFakeTimers();
        const f = fixture(), cancel = vi.fn(() => new Promise<void>(() => {}));
        vi.mocked(f.ports.fetch).mockResolvedValueOnce(new Response(new ReadableStream({cancel}), {status: 403}));
        await expect(f.auth.open()).rejects.toMatchObject({status: 403});
        expect(cancel).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('只请求一项 Drive 权限并建立账号固定会话，令牌只出现在请求头和回调内', async () => {
        const f = fixture();
        expect(f.auth.availability()).toEqual({available: true, reason: ''});
        const session = await f.auth.open(true);
        expect(session.account).toEqual({id: 'drive:fixture-account', email: 'tester@fixture.invalid'});
        expect(f.ports.identity!.getAuthToken).toHaveBeenCalledWith({interactive: true, enableGranularPermissions: true, scopes: ['https://www.googleapis.com/auth/drive.appdata']});
        expect(f.ports.fetch).toHaveBeenCalledWith('https://www.googleapis.com/drive/v3/about?fields=user(permissionId,emailAddress)', expect.objectContaining({headers: {Authorization: 'Bearer fixture-access'}, signal: expect.any(AbortSignal)}));
        expect(await session.request(async token => token)).toBe('fixture-access');
        expect(JSON.stringify(session)).not.toContain('fixture-access');
        await f.auth.disconnect();
        expect(f.ports.identity!.clearAllCachedAuthTokens).toHaveBeenCalledOnce();
    });
    it('未配置、浏览器不支持、扩展 ID 错误和范围不全均不能发起认证', async () => {
        for (const userAgent of ['Firefox/140.0', 'Chrome/142.0 Edg/142.0', 'Chrome/142.0 OPR/142.0']) {
            const unsupported = fixture(); unsupported.ports.userAgent = () => userAgent;
            expect(unsupported.auth.availability().available).toBe(false);
        }
        const f = fixture();
        f.ports.identity = undefined;
        expect(f.auth.availability().available).toBe(false);
        await expect(f.auth.open()).rejects.toThrow('Chrome');
        await f.auth.disconnect();
        const mismatch = fixture(); mismatch.ports.runtime.id = 'fixture-wrong-id';
        expect(mismatch.auth.availability().reason).toContain('ID');
        const unconfigured = fixture(); unconfigured.ports.runtime.getManifest = () => ({});
        expect(unconfigured.auth.availability().available).toBe(false);
        const emptyClient = fixture(); emptyClient.ports.runtime.getManifest = () => ({oauth2: {client_id: ''}});
        expect(emptyClient.auth.availability().available).toBe(false);
        const missingScopes = fixture(); missingScopes.ports.runtime.getManifest = () => ({oauth2: {client_id: 'fixture-custom-client'}});
        expect(missingScopes.auth.availability().reason).toContain('范围');
        const custom = fixture(); custom.ports.runtime.id = 'fixture-custom-id'; custom.ports.runtime.getManifest = () => ({oauth2: {client_id: 'fixture-custom-client', scopes: [...GOOGLE_DRIVE_SCOPES]}});
        expect(custom.auth.availability().available).toBe(true);
    });
    it('拒绝取消、空 token 和未授予 Drive 范围；旧邮箱授权不能代替 Drive，兼容 Chrome 未返回 grantedScopes', async () => {
        const f = fixture();
        vi.mocked(f.ports.identity!.getAuthToken).mockRejectedValueOnce(new Error('fixture provider private error'));
        await expect(f.auth.open()).rejects.toThrow('授权未完成');
        vi.mocked(f.ports.identity!.getAuthToken).mockResolvedValueOnce({});
        await expect(f.auth.open()).rejects.toThrow('有效授权');
        vi.mocked(f.ports.identity!.getAuthToken).mockResolvedValueOnce({token: 'fixture-access', grantedScopes: []});
        await expect(f.auth.open()).rejects.toThrow('配置数据权限');
        expect(f.ports.fetch).not.toHaveBeenCalled();
        vi.mocked(f.ports.identity!.getAuthToken).mockResolvedValueOnce({token: 'fixture-access', grantedScopes: ['https://www.googleapis.com/auth/userinfo.email']});
        await expect(f.auth.open()).rejects.toThrow('配置数据权限');
        vi.mocked(f.ports.identity!.getAuthToken).mockResolvedValueOnce({token: 'fixture-access', grantedScopes: [GOOGLE_DRIVE_SCOPES[0]]});
        expect((await f.auth.open()).account.id).toBe('drive:fixture-account');
        vi.mocked(f.ports.identity!.getAuthToken).mockResolvedValueOnce({token: 'fixture-access', grantedScopes: [GOOGLE_DRIVE_SCOPES[0], 'email']});
        expect((await f.auth.open()).account.id).toBe('drive:fixture-account');
        vi.mocked(f.ports.identity!.getAuthToken).mockResolvedValueOnce({token: 'fixture-access', grantedScopes: ['email']});
        await expect(f.auth.open()).rejects.toThrow('配置数据权限');
        vi.mocked(f.ports.identity!.getAuthToken).mockResolvedValueOnce({token: 'fixture-access'});
        expect((await f.auth.open()).account.id).toBe('drive:fixture-account');
    });
    it('Drive 不返回邮箱时仍以 permissionId 绑定账号，不追加邮箱权限且邮箱变化不触发换账号', async () => {
        const f = fixture();
        for (const user of [{permissionId: 'fixture-account'}, {permissionId: 'fixture-account', emailAddress: 1}, {permissionId: 'fixture-account', emailAddress: ''}]) {
            vi.mocked(f.ports.fetch).mockResolvedValueOnce(new Response(JSON.stringify({user})));
            expect((await f.auth.open()).account).toEqual({id: 'drive:fixture-account', email: ''});
        }
        const session = await f.auth.open();
        vi.mocked(f.ports.fetch).mockResolvedValueOnce(new Response(JSON.stringify({user: {permissionId: 'fixture-account', emailAddress: 'changed@fixture.invalid'}})));
        const operation = vi.fn().mockRejectedValueOnce(new DriveError('expired', 401)).mockResolvedValueOnce('ok');
        expect(await session.request(operation)).toBe('ok');
        expect(f.ports.identity!.getAuthToken).toHaveBeenLastCalledWith(expect.objectContaining({scopes: ['https://www.googleapis.com/auth/drive.appdata']}));
    });
    it('401 刷新一次且不弹授权；刷新后账号变化则拒绝继续操作', async () => {
        const f = fixture();
        const session = await f.auth.open();
        const operation = vi.fn().mockRejectedValueOnce(new DriveError('expired', 401)).mockResolvedValueOnce('ok');
        expect(await session.request(operation)).toBe('ok');
        expect(operation).toHaveBeenCalledTimes(2);
        expect(f.ports.identity!.removeCachedAuthToken).toHaveBeenCalledWith({token: 'fixture-access'});
        expect(f.ports.identity!.getAuthToken).toHaveBeenLastCalledWith(expect.objectContaining({interactive: false}));
        vi.mocked(f.ports.fetch).mockResolvedValueOnce(new Response(JSON.stringify({user: {permissionId: 'fixture-other', emailAddress: 'tester@fixture.invalid'}})));
        await expect(session.request(async () => {throw new DriveError('expired', 401);})).rejects.toThrow('账号已切换');
        await expect(session.request(async () => {throw new Error('ordinary failure');})).rejects.toThrow('ordinary failure');
        await expect(session.request(async () => {throw new DriveError('forbidden', 403);})).rejects.toThrow('forbidden');
    });
    it('Drive 账号信息 401 也仅刷新一次；其他失败不触发循环并拒绝缺少账号 ID 的响应', async () => {
        const f = fixture();
        vi.mocked(f.ports.fetch).mockResolvedValueOnce(new Response('', {status: 401}));
        expect((await f.auth.open()).account.id).toBe('drive:fixture-account');
        expect(f.ports.identity!.removeCachedAuthToken).toHaveBeenCalledOnce();
        vi.mocked(f.ports.fetch).mockResolvedValueOnce(new Response('', {status: 403}));
        await expect(f.auth.open()).rejects.toThrow('403');
        vi.mocked(f.ports.fetch).mockRejectedValueOnce(new Error('fixture network private error'));
        await expect(f.auth.open()).rejects.toThrow('检查网络');
        for (const data of [null, 1, {}, {id: 'obsolete-oauth-id', email: 'tester@fixture.invalid'}, {user: null}, {user: 1}, {user: {}}, {user: {permissionId: 1}}, {user: {permissionId: ''}}]) {
            vi.mocked(f.ports.fetch).mockResolvedValueOnce(new Response(JSON.stringify(data)));
            await expect(f.auth.open()).rejects.toThrow('响应无效');
        }
        vi.mocked(f.ports.fetch).mockResolvedValueOnce(new Response('broken'));
        await expect(f.auth.open()).rejects.toThrow('检查网络');
    });
    it('账号请求超时会中止并返回固定错误', async () => {
        const f = fixture();
        vi.useFakeTimers();
        vi.mocked(f.ports.fetch).mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('timeout')))));
        const request = f.auth.open().catch(error => error);
        await vi.advanceTimersByTimeAsync(30_000);
        expect((await request).message).toContain('检查网络');
    });
});

describe('cancellable identity ownership', () => {
    it('returns on cancellation, blocks new authorization until late token cleanup, then opens a fresh session', async () => {
        const f=fixture(); let release!: (value:{token:string})=>void;
        vi.mocked(f.ports.identity!.getAuthToken).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
        const controller=new AbortController();
        const first=f.auth.open(true, controller.signal).catch(error=>error);
        await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
        controller.abort();
        const settled=await Promise.race([first.then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),100))]);
        expect(settled).toBe(true);
        await expect(f.auth.open(true)).rejects.toThrow('授权');
        expect(f.ports.identity!.getAuthToken).toHaveBeenCalledOnce();
        expect(f.ports.fetch).not.toHaveBeenCalled();
        release({token:'late-old-token'});
        await vi.waitFor(()=>expect(f.ports.identity!.removeCachedAuthToken).toHaveBeenCalledWith({token:'late-old-token'}));
        const fresh=await f.auth.open(true);
        expect(fresh.account.id).toBe('drive:fixture-account');
        expect(await fresh.request(async token=>token)).toBe('fixture-access');
    });
});

it('quarantines a cancelled identity synchronously, even before the cancelled caller resumes', async () => {
    const f=fixture();let release!: (value:{token:string})=>void;
    vi.mocked(f.ports.identity!.getAuthToken).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    const controller=new AbortController();const first=f.auth.open(true,controller.signal).catch(error=>error);
    await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
    controller.abort();const second=f.auth.open(true).catch(error=>error);
    expect((await second).message).toContain('上次 Google 授权');
    expect(f.ports.identity!.getAuthToken).toHaveBeenCalledOnce();
    release({token:'late-same-turn'});await first;
    await vi.waitFor(()=>expect(f.ports.identity!.removeCachedAuthToken).toHaveBeenCalledWith({token:'late-same-turn'}));
});

it('keeps late-token cleanup failure closed until a successful cache cleanup', async () => {
    const f=fixture();let release!: (value:{token:string})=>void;
    vi.mocked(f.ports.identity!.getAuthToken).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    vi.mocked(f.ports.identity!.removeCachedAuthToken).mockRejectedValueOnce(new Error('private failure'));
    const controller=new AbortController();const old=f.auth.open(true,controller.signal).catch(error=>error);
    await vi.waitFor(()=>expect(release).toBeTypeOf('function'));controller.abort();await old;release({token:'late-sensitive-token'});
    await vi.waitFor(()=>expect(f.ports.identity!.removeCachedAuthToken).toHaveBeenCalledOnce());
    await expect(f.auth.open(true)).rejects.toThrow('上次 Google 授权');
    vi.mocked(f.ports.identity!.clearAllCachedAuthTokens).mockRejectedValueOnce(new Error('cleanup failed'));
    await expect(f.auth.disconnect()).rejects.toThrow();
    await expect(f.auth.open(true)).rejects.toThrow('上次 Google 授权');
    await f.auth.disconnect();
    expect((await f.auth.open(true)).account.id).toBe('drive:fixture-account');
});

it('releases a rejected late identity without attempting token cleanup', async () => {
    const f=fixture();let reject!: (error:Error)=>void;
    vi.mocked(f.ports.identity!.getAuthToken).mockImplementationOnce(()=>new Promise((_resolve,fail)=>{reject=fail;}));
    const controller=new AbortController();const old=f.auth.open(true,controller.signal).catch(error=>error);
    await vi.waitFor(()=>expect(reject).toBeTypeOf('function'));controller.abort();await old;reject(new Error('fixture identity cancelled'));
    await vi.waitFor(async()=>expect((await f.auth.open(true)).account.id).toBe('drive:fixture-account'));
    expect(f.ports.identity!.removeCachedAuthToken).not.toHaveBeenCalled();
});

it.each(['account', 'request'] as const)('quarantines a cancelled %s 401 token eviction until it settles', async stage => {
    const f=fixture();const controller=new AbortController();let release!:()=>void;
    if(stage==='account') vi.mocked(f.ports.fetch).mockResolvedValueOnce(new Response('',{status:401}));
    const session=stage==='request'?await f.auth.open():undefined;
    vi.mocked(f.ports.identity!.removeCachedAuthToken).mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;}));
    const old=(session ? session.request(async()=>{throw new DriveError('expired',401);},controller.signal) : f.auth.open(true,controller.signal)).catch(error=>error);
    await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
    controller.abort();
    const second=f.auth.open(true).catch(error=>error);
    expect((await second).message).toContain('上次 Google 授权');
    release();expect(await old).toMatchObject({name:'AbortError'});
    await vi.waitFor(async()=>expect((await f.auth.open()).account.id).toBe('drive:fixture-account'));
});

it('cancels a suspended account lookup without allowing its late 401 to refresh the token', async () => {
    const f=fixture();const controller=new AbortController();let release!: (response:Response)=>void;
    vi.mocked(f.ports.fetch).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    const old=f.auth.open(true,controller.signal).catch(error=>error);
    await vi.waitFor(()=>expect(release).toBeTypeOf('function'));controller.abort();
    expect(await old).toMatchObject({name:'AbortError'});
    const fresh=await f.auth.open(true);
    release(new Response('',{status:401}));await new Promise(resolve=>setTimeout(resolve,0));
    expect(f.ports.identity!.getAuthToken).toHaveBeenCalledTimes(2);
    expect(f.ports.identity!.removeCachedAuthToken).not.toHaveBeenCalled();
    expect(await fresh.request(async token=>token)).toBe('fixture-access');
});

it('keeps the authorization gate closed after a cancelled token eviction rejects', async () => {
    const f=fixture();const controller=new AbortController();const session=await f.auth.open();let reject!: (error:Error)=>void;
    vi.mocked(f.ports.identity!.removeCachedAuthToken).mockImplementationOnce(()=>new Promise((_resolve,fail)=>{reject=fail;}));
    const old=session.request(async()=>{throw new DriveError('expired',401);},controller.signal).catch(error=>error);
    await vi.waitFor(()=>expect(reject).toBeTypeOf('function'));controller.abort();
    expect(await old).toMatchObject({name:'AbortError'});reject(new Error('private eviction error'));
    await vi.waitFor(async()=>expect((await f.auth.open().catch(error=>error)).message).toContain('上次 Google 授权'));
    await f.auth.disconnect();expect((await f.auth.open()).account.id).toBe('drive:fixture-account');
});

it('waits for all independently abandoned identity requests before reopening', async () => {
    const f=fixture();const releases:Array<(value:{token:string})=>void>=[];
    vi.mocked(f.ports.identity!.getAuthToken).mockImplementation(()=>new Promise(resolve=>{releases.push(resolve);}));
    const a=new AbortController(),b=new AbortController();
    const oldA=f.auth.open(true,a.signal).catch(error=>error),oldB=f.auth.open(true,b.signal).catch(error=>error);
    await vi.waitFor(()=>expect(releases).toHaveLength(2));a.abort();b.abort();await Promise.all([oldA,oldB]);
    releases[0]({token:'late-a'});await vi.waitFor(()=>expect(f.ports.identity!.removeCachedAuthToken).toHaveBeenCalledWith({token:'late-a'}));
    await expect(f.auth.open()).rejects.toThrow('上次 Google 授权');
    releases[1]({token:'late-b'});await vi.waitFor(()=>expect(f.ports.identity!.removeCachedAuthToken).toHaveBeenCalledWith({token:'late-b'}));
    vi.mocked(f.ports.identity!.getAuthToken).mockResolvedValue({token:'fresh'});
    await vi.waitFor(async()=>expect((await f.auth.open()).account.id).toBe('drive:fixture-account'));
});

it('clears the token when cancellation falls between identity resolution and caller continuation', async () => {
    const f=fixture();const controller=new AbortController();let release!: (value:{token:string})=>void;
    vi.mocked(f.ports.identity!.getAuthToken).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    const old=f.auth.open(true,controller.signal).catch(error=>error);
    await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
    release({token:'late-between-microtasks'});queueMicrotask(()=>controller.abort());
    expect(await old).toMatchObject({name:'AbortError'});
    await vi.waitFor(()=>expect(f.ports.identity!.removeCachedAuthToken).toHaveBeenCalledWith({token:'late-between-microtasks'}));
    expect(f.ports.fetch).not.toHaveBeenCalled();
});

it('consumes an account fetch that synchronously cancels the caller', async () => {
    const f=fixture();const controller=new AbortController();
    vi.mocked(f.ports.fetch).mockImplementationOnce(()=>{controller.abort();return Promise.reject(new Error('late network failure'));});
    await expect(f.auth.open(true,controller.signal)).rejects.toMatchObject({name:'AbortError'});
});

it('does not refresh after cancellation around a completed 401 eviction', async () => {
    for (let turns=0;turns<7;turns++) {
        const f=fixture();const controller=new AbortController();const session=await f.auth.open();let release!:()=>void;
        vi.mocked(f.ports.identity!.removeCachedAuthToken).mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;}));
        const operation=vi.fn().mockRejectedValueOnce(new DriveError('expired',401)).mockResolvedValue('ok');
        const old=session.request(operation,controller.signal).catch(error=>error);
        await vi.waitFor(()=>expect(release).toBeTypeOf('function'));release();
        for(let i=0;i<turns;i++) await Promise.resolve();
        controller.abort();const result=await old;
        if(result==='ok') expect(operation).toHaveBeenCalledTimes(2);
        else {expect(result).toMatchObject({name:'AbortError'});expect(operation).toHaveBeenCalledOnce();}
    }
});
