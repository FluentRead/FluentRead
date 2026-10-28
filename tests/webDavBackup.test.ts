import {describe,expect,it,vi} from 'vitest';
import {Config,normalizeConfig} from '@/src/core/config/model';
import {driveSyncPayload as completePayload,toDriveSyncConfig,projectDriveSyncConfig} from '@/src/core/config/driveSync';
import {decryptDriveConfig,encryptDriveConfig} from '@/src/platform/google-drive/encryption';
import {createWebDavConnectionStore,parseWebDavConnection,WEBDAV_CONNECTION_KEY} from '@/src/platform/webdav/connection';
import {createWebDavBackup,type WebDavBackupPorts} from '@/src/services/config/webDavBackup';
import type {CloudSyncRemote} from '@/src/core/config/cloudSync';
import type {DriveSyncState} from '@/src/services/config/remoteConfigSync';
// 旧完整备份回归使用明确完整范围，默认普通范围另行覆盖。
const driveSyncPayload = (config: Record<string, unknown>) => completePayload(config, true);
const password='FluentReadEncryption';
const input={url:'https://dav.fixture.invalid/base/',username:'fixture-user',password:'fixture-app-password',revision:null};
const config=(patch:Record<string,unknown>={})=>toDriveSyncConfig(normalizeConfig({...new Config(),videoServiceDefaultMigrated:true,...patch}));
function fixture(shared={remote:null as CloudSyncRemote|null}) {
    const records=new Map<string,unknown>();
    let local=config({token:{openai:'fixture-api-key'},customHeaders:{openai:'{"Authorization":"fixture-header"}'},customBody:{openai:'{"auth":"fixture-body"}'},proxy:{openai:'https://fixture.invalid/?auth=fixture-url-token'},extra:{oauth:'fixture-oauth-token'}});
    let state:unknown=null;
    const connections=createWebDavConnectionStore({getItem:async<T>(key:string)=>(records.get(key)??null) as T|null,setItem:async(key,value)=>{records.set(key,value);},removeItem:async key=>{records.delete(key);}});
    const ports:WebDavBackupPorts={connections,api:{remove:vi.fn(async()=>{shared.remote=null;}),test:vi.fn(async()=>undefined),read:vi.fn(async()=>shared.remote),write:vi.fn(async(_session,content)=>{shared.remote={file:{id:'fixture-file',version:crypto.randomUUID(),modifiedTime:''},content};return shared.remote.file;})},snapshot:vi.fn(async()=>structuredClone(local)),apply:vi.fn(async value=>{local=structuredClone(value);}),readState:vi.fn(async()=>state),writeState:vi.fn(async value=>{state=value;}),removeState:vi.fn(async()=>{state=null;}),now:()=>1000};
    const service=createWebDavBackup(ports);
    return {service,ports,records,connections,shared,get state(){return state as DriveSyncState;},get local(){return local;},set local(value){local=value;}};
}
describe('WebDAV 配置云备份事务',()=>{
    it.each(['download', 'merge'] as const)('普通备份跨设备%s网站规则及正文标签，保留本机连接', async direction => {
        const source = fixture(); await source.service.save(input);
        source.local = config({...source.local, siteAdaptation: {enabled: true, disabledRuleIds: ['reddit'], custom: {
            version: 1, profiles: {article: {mode: 'focus', content: [{css: ['article p'], key: 'article-body'}]}},
            rules: [{id: 'mine', name: 'My rule', match: {hosts: ['example.com']}, profile: 'article'}],
        }}});
        let preview = await source.service.prepare(password);
        await createWebDavBackup(source.ports).commit(preview.id, password, 'upload', {});
        const saved = source.shared.remote!.content;
        const payload = await decryptDriveConfig(saved, password) as {config: Record<string, unknown>};
        expect(payload.config.siteAdaptation).toEqual(source.local.siteAdaptation);
        expect(payload.config).not.toHaveProperty('token');
        const target = fixture(source.shared); await target.service.save(input);
        const original = structuredClone(target.local);
        preview = await target.service.prepare(password);
        expect(preview.changes).toContainEqual(expect.objectContaining({label: '网站规则', sensitive: true}));
        await createWebDavBackup(target.ports).commit(preview.id, password, direction,
            Object.fromEntries(preview.changes.map(change => [change.id, 'remote'])));
        expect(target.local.siteAdaptation).toEqual(source.local.siteAdaptation);
        expect(target.local.token).toEqual(original.token);
        expect(target.local.proxy).toEqual(original.proxy);
        expect(target.shared.remote!.content).toBe(saved);
        expect(target.ports.api.write).not.toHaveBeenCalled();
    });
    it.each(['upload','merge'] as const)('无 ETag 兼容预览允许 %s，worker 重启后仍可提交且保护本机密钥',async direction=>{
        const f=fixture();await f.service.save(input);
        const initial=await f.service.prepare(password);await f.service.commit(initial.id,password,'upload',{});
        f.shared.remote!.file={...f.shared.remote!.file,version:'a'.repeat(64),contentGuard:true};
        f.local=config({...f.local,to:'fr',from:'en'});
        const preview=await f.service.prepare(password,7,'fixture-page');
        expect(preview).toMatchObject({hasRemote:true,requiresExclusiveAccess:true});expect(preview.canUpload).toBeUndefined();
        const choices=Object.fromEntries(preview.changes.map(change=>[change.id,'local']));
        const local=structuredClone(f.local);
        await createWebDavBackup(f.ports).commit(preview.id,password,direction,choices,7,'fixture-page');
        expect(f.ports.api.write).toHaveBeenCalledTimes(2);
        expect(f.local.token).toEqual(local.token);
        expect(await decryptDriveConfig(f.shared.remote!.content,password)).toMatchObject({config:{to:'fr',from:'en'}});
    });
    it('无 ETag 备份允许确认删除，预览后内容变更仍阻止删除',async()=>{
        const f=fixture();await f.service.save(input);
        f.shared.remote={file:{id:'fixture-file',version:'a'.repeat(64),modifiedTime:'',contentGuard:true},content:'opaque broken backup'};
        let preview=await f.service.prepareDelete(7,'fixture-page');
        expect(preview).toMatchObject({canDelete:true,requiresExclusiveAccess:true});
        f.shared.remote={...f.shared.remote,content:'other device backup',file:{...f.shared.remote.file,version:'b'.repeat(64)}};
        await expect(f.service.commitDelete(preview.id,7,'fixture-page')).rejects.toThrow('已变化');
        expect(f.ports.api.remove).not.toHaveBeenCalled();
        preview=await f.service.prepareDelete(7,'fixture-page');
        const local=structuredClone(f.local);const connection=await f.service.settings();
        await createWebDavBackup(f.ports).commitDelete(preview.id,7,'fixture-page');
        expect(f.shared.remote).toBeNull();expect(f.local).toEqual(local);expect(await f.service.settings()).toEqual(connection);
    });
    it('WebDAV 删除确认跨 worker 重启保留版本和连接，实际删除后可重新创建备份',async()=>{
        const f=fixture();await f.service.save(input);
        const initial=await f.service.prepare(password);await f.service.commit(initial.id,password,'upload',{});
        f.shared.remote={...f.shared.remote!,file:{...f.shared.remote!.file,etag:'"one"'}};
        const connection=await f.service.settings();const local=structuredClone(f.local);
        const preview=await f.service.prepareDelete(7,'delete-page');
        await createWebDavBackup(f.ports).commitDelete(preview.id,7,'delete-page');
        expect(f.shared.remote).toBeNull();expect(await f.service.settings()).toEqual(connection);expect(f.local).toEqual(local);
        expect(f.state.baseline).toBe('');expect(f.state.lastSyncedAt).toBeNull();
        const fresh=await f.service.prepare(password);expect(fresh).toMatchObject({hasRemote:false,hasBaseline:false});
        await f.service.commit(fresh.id,password,'upload',{});expect(f.shared.remote).not.toBeNull();
    });
    it('删除预览期间其他设置页不能清除连接，外部连接切换使删除确认失效',async()=>{
        const f=fixture();const saved=await f.service.save(input);
        f.shared.remote={file:{id:'fixture-file',version:'1',modifiedTime:'',etag:'"one"'},content:'invalid backup'};
        const preview=await f.service.prepareDelete(7,'delete-page');
        await expect(f.service.clear(saved.revision,8,'other-page')).rejects.toThrow('另一个设置页面');
        await f.connections.write(parseWebDavConnection({...saved,password:'fixture-changed'},await f.connections.read()));
        await expect(f.service.commitDelete(preview.id,7,'delete-page')).rejects.toThrow('目标账号');
        expect(f.ports.api.remove).not.toHaveBeenCalled();expect(f.shared.remote).not.toBeNull();
    });
    it('打开页面只读本机摘要；测试和保存连接均不创建云端文件',async()=>{
        const f=fixture();
        expect(await f.service.status()).toMatchObject({available:false,account:null});
        expect(await f.service.settings()).toBeNull();
        await expect(f.service.prepare(password, undefined, undefined, true)).rejects.toMatchObject({code:'missing'});
        expect(f.ports.api.read).not.toHaveBeenCalled();
        await f.service.test(input);expect(await f.service.settings()).toBeNull();
        const saved=await f.service.save(input,7,'fixture-page');
        expect(saved).toMatchObject({url:input.url,username:input.username,hasPassword:true});
        expect(JSON.stringify(saved)).not.toContain(input.password);
        expect(await f.service.status()).toMatchObject({available:true,account:null});
        expect(f.ports.api.write).not.toHaveBeenCalled();
        expect(f.shared.remote).toBeNull();
        await expect(f.service.save(input)).rejects.toMatchObject({code:'changed'});
        vi.mocked(f.ports.api.test).mockRejectedValueOnce(new Error('fixture test failure'));
        await expect(f.service.save({...saved,password:'changed-fixture'})).rejects.toThrow('fixture test');
        expect(await f.service.settings()).toEqual(saved);
    });
    it('后台重启后恢复一次性预览，完整凭据可在第二设备恢复；连接密码不进入备份',async()=>{
        const f=fixture();
        const appearance={backgroundColor:'#fce7f3',customCss:'color: #123456;'};
        f.local=config({...f.local,bilingualSentenceHighlightAppearance:appearance,bilingualSentenceHighlightProfiles:[{id:'fixture-highlight',name:'Fixture highlight',style:'mint',appearance}],activeSentenceHighlightProfileId:'fixture-highlight'});
        await f.service.save(input);
        const preview=await f.service.prepare(password, 7, 'fixture-page', true);
        expect(preview).toMatchObject({hasRemote:false,hasBaseline:false,changes:[]});
        expect(f.ports.api.write).not.toHaveBeenCalled();
        expect(JSON.stringify(f.state)).not.toMatch(/fixture-api-key|fixture-app-password|fixture-oauth-token/u);
        await createWebDavBackup(f.ports).commit(preview.id,password,'upload',{},7,'fixture-page');
        const cloud=f.shared.remote!;
        for(const value of ['fixture-api-key','fixture-header','fixture-body','fixture-url-token','fixture-oauth-token',input.password]) expect(cloud.content).not.toContain(value);
        const payload=await decryptDriveConfig(cloud.content,password) as {config:unknown};
        expect(payload.config).toEqual(f.local);
        expect(JSON.stringify(payload)).not.toContain(input.password);
        const last=await f.service.status();expect(last.account?.email).toContain('fixture-user');
        const second=fixture(f.shared);await second.service.save(input);second.local=config({token:{openai:'fixture-old-key'},key:'fixture-delete-key'});
        const restore=await second.service.prepare(password, 8, 'fixture-other', true);
        expect(restore.hasBaseline).toBe(false);
        await second.service.commit(restore.id,password,'download',{},8,'fixture-other');
        expect(second.local).toEqual(f.local);
        expect(second.local).toMatchObject({bilingualSentenceHighlightAppearance:appearance,bilingualSentenceHighlightProfiles:[{id:'fixture-highlight',style:'mint',appearance}],activeSentenceHighlightProfileId:'fixture-highlight'});
        expect(second.ports.api.write).not.toHaveBeenCalled();
        expect(second.shared.remote).toEqual(cloud);
        await expect(second.service.commit(restore.id,password,'download',{},8,'fixture-other')).rejects.toThrow('失效');
    });
    it('相同连接保留基线，换连接使预览失效；另一页面不能更改连接或取消事务',async()=>{
        const f=fixture();
        let saved=await f.service.save(input,7,'fixture-page');
        let preview=await f.service.prepare(password, 7, 'fixture-page', true);
        for(const action of ['save','clear'] as const) await expect(action==='save'?f.service.save({...saved,password:''},8,'fixture-other'):f.service.clear(saved.revision,8,'fixture-other')).rejects.toThrow('另一个设置页面');
        await expect(f.service.save({...saved,password:''},7,'fixture-other')).rejects.toThrow('另一个设置页面');
        await f.service.cancel(preview.id,8,'fixture-other');expect(f.state.prepared?.id).toBe(preview.id);
        await f.service.cancelTab(99);expect(f.state.prepared?.id).toBe(preview.id);
        await f.service.cancelTab(7);expect(f.state.prepared).toBeUndefined();
        preview=await f.service.prepare(password, 7, 'fixture-page', true);await f.service.commit(preview.id,password,'upload',{},7,'fixture-page');
        const same=await f.service.save({...saved,password:''},7,'fixture-page');expect(same.revision).toBe(saved.revision);
        preview=await f.service.prepare(password, 7, 'fixture-page', true);expect(preview.hasBaseline).toBe(true);await f.service.cancel(preview.id,7,'fixture-page');
        preview=await f.service.prepare(password, 7, 'fixture-page', true);
        const changed=parseWebDavConnection({...saved,password:'fixture-other-password'},await f.connections.read());
        // 模拟后台外部连接修改，旧确认不能写入任一服务器。
        await f.connections.write(changed);
        const writes=vi.mocked(f.ports.api.write).mock.calls.length;
        await expect(f.service.commit(preview.id,password,'upload',{},7,'fixture-page')).rejects.toThrow('同步连接已变化');
        expect(vi.mocked(f.ports.api.write).mock.calls.length).toBe(writes);
        const firstForNewConnection=await f.service.prepare(password, 7, 'fixture-page', true);expect(firstForNewConnection.hasBaseline).toBe(false);
        await f.service.cancel(firstForNewConnection.id,7,'fixture-page');
        saved=(await f.service.settings())!;
        const changedSummary=await f.service.save({...saved,password:'fixture-new-password'},7,'fixture-page');
        expect(changedSummary.revision).not.toBe(saved.revision);
        saved=changedSummary;
        // 已过期预览不锁住连接设置。
        vi.mocked(f.ports.readState).mockResolvedValueOnce({...f.state,prepared:{id:'expired',expiresAt:0,tabId:9,clientId:'expired'}} as unknown as DriveSyncState);
        await f.service.save({...saved,password:''},7,'fixture-page');
        await expect(f.service.clear('stale',7,'fixture-page')).rejects.toMatchObject({code:'changed'});
        const cloud=f.shared.remote;
        await f.service.clear(saved.revision,7,'fixture-page');
        expect(await f.service.settings()).toBeNull();expect(f.state).toBeNull();expect(f.shared.remote).toEqual(cloud);
        await f.service.clear(null,7,'fixture-page');expect(f.records.has(WEBDAV_CONNECTION_KEY)).toBe(false);
    });
    it('合并单边修改，云端和本机变化使预览失效；失败不更新成功记录',async()=>{
        const f=fixture();await f.service.save(input);
        let preview=await f.service.prepare(password, undefined, undefined, true);await f.service.commit(preview.id,password,'upload',{});
        const baseline=f.state;const original=f.local;
        f.local=config({...original,theme:'dark'});
        f.shared.remote={file:{...f.shared.remote!.file,version:'2'},content:await encryptDriveConfig(driveSyncPayload(config({...original,to:'fr'})),password)};
        preview=await f.service.prepare(password, undefined, undefined, true);await f.service.commit(preview.id,password,'merge',{});
        expect(f.local).toMatchObject({theme:'dark',to:'fr'});
        preview=await f.service.prepare(password, undefined, undefined, true);f.local=config({...f.local,to:'de'});
        await expect(f.service.commit(preview.id,password,'upload',{})).rejects.toThrow('本机配置已变化');
        preview=await f.service.prepare(password, undefined, undefined, true);f.shared.remote={...f.shared.remote!,file:{...f.shared.remote!.file,version:'changed'}};
        await expect(f.service.commit(preview.id,password,'upload',{})).rejects.toThrow('云端配置已变化');
        const previous=f.state;preview=await f.service.prepare(password, undefined, undefined, true);vi.mocked(f.ports.api.write).mockRejectedValueOnce(new Error('fixture upstream'));
        await expect(f.service.commit(preview.id,password,'upload',{})).rejects.toThrow('fixture upstream');expect(f.state).toEqual(previous);
        expect(baseline.lastSyncedAt).toBe(1000);
    });
});


it('WebDAV 默认普通范围经 worker 休眠仍去密，单次同意完整备份可明确删除凭据', async () => {
    const f = fixture(); await f.service.save(input);
    const original = structuredClone(f.local);
    let preview = await f.service.prepare(password);
    expect(preview).toMatchObject({includeSensitive: false, remoteIncludesSensitive: false});
    await createWebDavBackup(f.ports).commit(preview.id, password, 'upload', {});
    expect(await decryptDriveConfig(f.shared.remote!.content, password)).toEqual({format: 'fluentread-complete-config', version: 2, scope: 'settings', config: projectDriveSyncConfig(original)});
    expect(f.local).toEqual(original);
    f.local = config({...f.local, token: {}, apiKeys: {}, customHeaders: {}});
    preview = await f.service.prepare(password, undefined, undefined, true);
    await createWebDavBackup(f.ports).commit(preview.id, password, 'upload', {});
    expect(await decryptDriveConfig(f.shared.remote!.content, password)).toMatchObject({version: 1, config: {token: {}, apiKeys: {}, customHeaders: {}}});
    const restore = fixture(f.shared); await restore.service.save(input);
    preview = await restore.service.prepare(password);
    await createWebDavBackup(restore.ports).commit(preview.id, password, 'download', {});
    expect(restore.local.token).toEqual(original.token);
    preview = await restore.service.prepare(password, undefined, undefined, true);
    await createWebDavBackup(restore.ports).commit(preview.id, password, 'download', {});
    expect(restore.local.token).toEqual({});
    expect(restore.local.apiKeys).toEqual({});
    expect(restore.ports.api.write).not.toHaveBeenCalled();
});

describe('cancel pending WebDAV preview', () => {
    it('releases cancellation and ignores late read before accepting a new preview', async () => {
        const f=fixture(); await f.service.save(input);
        let release!: (value: CloudSyncRemote | null) => void;
        vi.mocked(f.ports.api.read).mockImplementationOnce(() => new Promise(resolve=>{release=resolve;}));
        const old=f.service.prepare(password, 7, 'old-page').catch(error=>error);
        await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
        const closed=f.service.cancelTab(7);
        const result=await Promise.race([closed.then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),100))]);
        expect(result).toBe(true);
        const fresh=await f.service.prepare(password,8,'new-page');
        release(null);await old;
        expect(f.state.prepared?.id).toBe(fresh.id);
        expect(f.state.prepared?.tabId).toBe(8);
    });
});

it('does not cancel another tab preview and ignores a late rejected network response after owner closes', async () => {
    const f=fixture();await f.service.save(input);
    let reject!: (error:Error)=>void;
    vi.mocked(f.ports.api.read).mockImplementationOnce(()=>new Promise((_resolve,fail)=>{reject=fail;}));
    const old=f.service.prepareDelete(7,'owner').catch(error=>error);
    await vi.waitFor(()=>expect(reject).toBeTypeOf('function'));
    const unrelated=f.service.cancelTab(8);
    const owner=f.service.cancelTab(7);
    await Promise.all([unrelated,owner]);
    const fresh=await f.service.prepare(password,8,'next');
    reject(new Error('late fixture error'));await old;
    expect(f.state.prepared?.id).toBe(fresh.id);
    expect(f.state.prepared?.tabId).toBe(8);
});

it('does not start a queued preview after its tab closes', async () => {
    const f=fixture();await f.service.save(input);
    let release!:()=>void;
    vi.mocked(f.ports.readState).mockImplementationOnce(async()=>{await new Promise<void>(resolve=>{release=resolve;});return f.state;});
    const status=f.service.status();await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
    const old=f.service.prepare(password,7,'closed').catch(error=>error);
    const close=f.service.cancelTab(7);
    release();await Promise.all([status,close]);
    expect(await old).toMatchObject({name:'AbortError'});
    expect(f.ports.api.read).not.toHaveBeenCalled();
});

it('closes promptly during a pending connection test and ignores the late result', async () => {
    const f=fixture();await f.service.save(input);
    let release!:()=>void;
    vi.mocked(f.ports.api.test).mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;}));
    const old=f.service.prepare(password,7,'old-page').catch(error=>error);
    await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
    const closed=f.service.cancelTab(7);
    expect(await Promise.race([closed.then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),100))])).toBe(true);
    const fresh=await f.service.prepare(password,8,'new-page');
    release();await old;
    expect(f.state.prepared?.id).toBe(fresh.id);
    expect(f.ports.api.read).toHaveBeenCalledTimes(1);
});

it('cancels the matching page client when a read synchronously requests cancellation', async () => {
    const f=fixture();await f.service.save(input);
    let closed!:Promise<void>;
    vi.mocked(f.ports.api.read).mockImplementationOnce(async (_session,signal)=>{
        closed=f.service.cancel(undefined,7,'owner');
        expect(signal?.aborted).toBe(true);
        return null;
    });
    const old=await f.service.prepare(password,7,'owner').catch(error=>error);
    await closed;
    expect(old).toMatchObject({name:'AbortError'});
    expect(f.state?.prepared).toBeUndefined();
    const fresh=await f.service.prepare(password,8,'new-page');
    expect(f.state.prepared?.id).toBe(fresh.id);
});

it.each(['availability', 'snapshot'] as const)('releases cancellation while local %s is suspended and ignores its late result', async stage => {
    const f=fixture();await f.service.save(input);
    let release!:()=>void;
    if(stage==='availability') vi.mocked(f.ports.readState).mockImplementationOnce(async()=>{await new Promise<void>(resolve=>{release=resolve;});return f.state;});
    else vi.mocked(f.ports.snapshot).mockImplementationOnce(async()=>{await new Promise<void>(resolve=>{release=resolve;});return f.local;});
    const old=f.service.prepare(password,7,'old').catch(error=>error);
    await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
    const close=f.service.cancelTab(7);
    const promptly=await Promise.race([close.then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),100))]);
    if(!promptly) {release();await Promise.all([old,close]);}
    expect(promptly).toBe(true);
    const fresh=await f.service.prepare(password,8,'new');
    release();expect(await old).toMatchObject({name:'AbortError'});
    expect(f.state.prepared?.id).toBe(fresh.id);
});

it.each(['sync', 'delete'] as const)('ignores a late rejected local state read during %s preview', async kind => {
    const f=fixture();await f.service.save(input);let reject!: (error:Error)=>void;
    vi.mocked(f.ports.readState).mockResolvedValueOnce(f.state).mockImplementationOnce(()=>new Promise((_resolve,fail)=>{reject=fail;}));
    const old=(kind==='sync'?f.service.prepare(password,7,'old'):f.service.prepareDelete(7,'old')).catch(error=>error);
    await vi.waitFor(()=>expect(reject).toBeTypeOf('function'));
    const close=f.service.cancelTab(7);
    expect(await Promise.race([close.then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),100))])).toBe(true);
    const fresh=await f.service.prepare(password,8,'new');
    reject(new Error('late local read failure'));expect(await old).toMatchObject({name:'AbortError'});
    await new Promise(resolve=>setTimeout(resolve,0));
    expect(f.state.prepared?.id).toBe(fresh.id);
});
