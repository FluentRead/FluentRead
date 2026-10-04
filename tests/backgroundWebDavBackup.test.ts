import {describe, expect, it, vi} from 'vitest';
import {createWebDavBackupHandler, WEBDAV_BACKUP_MESSAGE_TYPE as type} from '@/src/app/background/handlers/webDavBackup';
import type {createWebDavBackup} from '@/src/services/config/webDavBackup';
import {WebDavError} from '@/src/platform/webdav/connection';
import {CloudSyncError} from '@/src/core/config/cloudSync';
import {DriveEncryptionError} from '@/src/platform/google-drive/encryption';
import {DriveConfigError} from '@/src/core/config/driveSync';
import {GOOGLE_DRIVE_APPLICATION_PASSPHRASE} from '@/src/platform/google-drive/constants';
const clientId = 'fixture-client';
function fixture(trusted = true) {
    const service = Object.fromEntries(['status','settings','save','test','clear','prepare','commit','cancel'].map(key => [key,vi.fn()])) as unknown as ReturnType<typeof createWebDavBackup>;
    return {service, handler: createWebDavBackupHandler(service, () => trusted)};
}
describe('WebDAV 可信设置消息', () => {
    it('拒绝未授权发送者和无效身份，合法动作只传递必需参数', async () => {
        const denied=fixture(false);
        expect(await denied.handler.handle({type,clientId,action:'settings'},{})).toMatchObject({success:false,errorKey:'settings.webdav.error.trusted'});
        expect(denied.service.settings).not.toHaveBeenCalled();
        const f=fixture();
        for(const id of [undefined,null,'','bad/id','x'.repeat(65)]) expect(await f.handler.handle({type,clientId:id,action:'settings'},{})).toMatchObject({success:false});
        for(const action of ['status','settings','prepare','clear','cancel']) expect(await f.handler.handle({type,clientId,action},{sender:{tab:{id:7}}})).toMatchObject({success:true});
        expect(f.service.prepare).toHaveBeenCalledWith(GOOGLE_DRIVE_APPLICATION_PASSPHRASE,7,clientId, false);
        expect(f.service.clear).toHaveBeenCalledWith(undefined,7,clientId);
        for(const action of ['save','test']) {
            await f.handler.handle({type,clientId,action,connection:{url:'fixture'}},{});
            expect(f.service[action as 'save'|'test']).toHaveBeenCalled();
            for(const connection of [undefined,null,[],1]) expect(await f.handler.handle({type,clientId,action,connection},{})).toMatchObject({success:false});
        }
        await f.handler.handle({type,clientId,action:'cancel',id:'preview'},{});
        expect(f.service.cancel).toHaveBeenLastCalledWith('preview',undefined,clientId);
        await f.handler.handle({type,clientId,action:'commit',id:'preview',direction:'merge',choices:{'0':'local'}},{});
        expect(f.service.commit).toHaveBeenCalledWith('preview',GOOGLE_DRIVE_APPLICATION_PASSPHRASE,'merge',{'0':'local'},undefined,clientId);
    });
    it('拒绝不合法动作、方向、预览和选择', async () => {
        const f=fixture();
        for(const msg of [{},{action:'unknown'},{action:'cancel',id:1},{action:'cancel',id:'x'.repeat(65)},{action:'commit'},{action:'commit',id:'x'.repeat(65)},{action:'commit',id:'preview',direction:'bad'}]) expect(await f.handler.handle({type,clientId,...msg},{})).toMatchObject({success:false});
        for(const choices of [undefined,null,[],1,{'bad':'local'},{'0':'bad'},Object.fromEntries(Array.from({length:50_001},(_,i)=>[String(i),'local']))]) expect(await f.handler.handle({type,clientId,action:'commit',id:'preview',direction:'merge',choices},{})).toMatchObject({success:false});
        expect(f.service.commit).not.toHaveBeenCalled();
    });
    it('返回可本地化的安全错误，不回显服务器正文和秘密', async () => {
        const f=fixture();
        for(const error of [new WebDavError('auth',401),new WebDavError('timeout'),new DriveEncryptionError('同步配置过大'),new DriveEncryptionError('fixture password'),new CloudSyncError('同步连接已变化，请重新生成预览。'),new DriveConfigError('fixture safe config'),new Error('fixture-private'),null]) {
            vi.mocked(f.service.status).mockRejectedValueOnce(error);
            const result=await f.handler.handle({type,clientId,action:'status'},{});
            expect(result).toMatchObject({success:false});
            expect(JSON.stringify(result)).not.toMatch(/fixture-private|fixture password/u);
            if(error instanceof WebDavError) expect(result).toMatchObject({errorKey:`settings.webdav.error.${error.code}`,errorParams:{status:error.status??0}});
        }
    });
});


it('WebDAV prepare 的敏感信息同意只能是 boolean，旧消息缺省安全关闭', async () => {
    const f = fixture();
    for (const includeSensitive of [null, 0, 1, 'false', 'true', {}, []]) {
        expect(await f.handler.handle({type, clientId: 'fixture-client', action: 'prepare', includeSensitive}, {})).toMatchObject({success: false});
    }
    expect(f.service.prepare).not.toHaveBeenCalled();
    for (const includeSensitive of [undefined, false, true]) {
        expect(await f.handler.handle({type, clientId: 'fixture-client', action: 'prepare', includeSensitive}, {sender: {tab: {id: 7}}})).toMatchObject({success: true});
        expect(f.service.prepare).toHaveBeenLastCalledWith(GOOGLE_DRIVE_APPLICATION_PASSPHRASE, 7, 'fixture-client', includeSensitive ?? false);
    }
});
