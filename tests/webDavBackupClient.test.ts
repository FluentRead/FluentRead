import {describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({send:vi.fn()}));
vi.mock('webextension-polyfill',()=>({default:{runtime:{sendMessage:mocks.send}}}));
import {webDavBackupClient as client} from '@/src/services/config/webDavBackupClient';
import {CloudBackupRequestError} from '@/src/services/config/cloudBackupClient';
describe('WebDAV 设置客户端',()=>{
    it('连接和同步动作共用客户端身份，读取不会返回密码',async()=>{
        mocks.send.mockResolvedValue({success:true,data:{fixture:true}});
        await client.settings();await client.test({});await client.save({});await client.clear(null);await client.status();await client.prepare();await client.cancel();await client.commit('id','upload',{});
        expect(mocks.send.mock.calls.map(([m])=>m.action)).toEqual(['settings','test','save','clear','status','prepare','cancel','commit']);
        expect(new Set(mocks.send.mock.calls.map(([m])=>m.clientId)).size).toBe(1);
        expect(mocks.send.mock.calls.every(([m])=>m.type==='webDavConfigBackup'&&!('passphrase' in m))).toBe(true);
        mocks.send.mockResolvedValueOnce({success:false,errorKey:'settings.webdav.error.http',errorParams:{status:500}});
        await expect(client.status()).rejects.toMatchObject({errorKey:'settings.webdav.error.http',params:{status:500}});
        expect(new CloudBackupRequestError('fixture') instanceof Error).toBe(true);
    });
});


it('WebDAV 客户端 prepare 默认排除且明确传递单次同意，拒绝非 boolean', async () => {
    mocks.send.mockClear();
    mocks.send.mockResolvedValue({success: true, data: {}});
    await client.prepare();
    expect(mocks.send).toHaveBeenLastCalledWith(expect.objectContaining({action: 'prepare', includeSensitive: false}));
    await client.prepare(true);
    expect(mocks.send).toHaveBeenLastCalledWith(expect.objectContaining({includeSensitive: true}));
    await client.prepare();
    expect(mocks.send).toHaveBeenLastCalledWith(expect.objectContaining({includeSensitive: false}));
    for (const consent of [null, 1, 'true', {}, []]) expect(() => client.prepare(consent as boolean)).toThrow('布尔值');
    expect(mocks.send).toHaveBeenCalledTimes(3);
});
