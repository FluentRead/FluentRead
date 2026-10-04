import {describe, expect, it, vi} from 'vitest';
const mocks = vi.hoisted(() => ({send: vi.fn()}));
vi.mock('webextension-polyfill', () => ({default: {runtime: {sendMessage: mocks.send}}}));
import {googleDriveSyncClient as client} from '@/src/services/config/googleDriveSyncClient';

describe('同步设置请求端口', () => {
    it('所有动作使用同一加密同步协议，不在客户端读取配置', async () => {
        mocks.send.mockResolvedValue({success: true, data: {fixture: true}});
        expect(await client.status()).toEqual({fixture: true});
        await client.cancel('fixture-id');
        await client.prepare();
        await client.commit('fixture-id', 'download', {'0': 'remote'});
        expect(mocks.send.mock.calls.map(call => call[0].action)).toEqual(['status', 'cancel', 'prepare', 'commit']);
        expect(mocks.send.mock.calls.every(([message]) => !('passphrase' in message))).toBe(true);
        expect(mocks.send.mock.calls[1][0]).toMatchObject({action: 'cancel', id: 'fixture-id'});
        expect(mocks.send.mock.calls.every(([message]) => typeof message.clientId === 'string')).toBe(true);
        expect(mocks.send).toHaveBeenLastCalledWith({clientId: expect.any(String), type: 'googleDriveEncryptedSync', action: 'commit', id: 'fixture-id', direction: 'download', choices: {'0': 'remote'}});
    });
    it('后台不可用、无响应和失败响应都有可见错误', async () => {
        mocks.send.mockRejectedValueOnce(new Error('fixture transport private error'));
        await expect(client.status()).rejects.toThrow('后台暂时不可用');
        mocks.send.mockResolvedValueOnce(undefined);
        await expect(client.status()).rejects.toThrow('同步请求未完成');
        mocks.send.mockResolvedValueOnce({success: false});
        await expect(client.status()).rejects.toThrow('同步请求未完成');
        mocks.send.mockResolvedValueOnce({success: false, error: 'fixture safe error'});
        await expect(client.status()).rejects.toThrow('fixture safe error');
    });
});


it('Google Drive 客户端 prepare 默认排除且明确传递单次同意，拒绝非 boolean', async () => {
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
