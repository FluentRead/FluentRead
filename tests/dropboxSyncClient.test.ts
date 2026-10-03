import {describe, expect, it, vi} from 'vitest';
const mocks = vi.hoisted(() => ({sendMessage: vi.fn()}));
vi.mock('webextension-polyfill', () => ({default: {runtime: {sendMessage: mocks.sendMessage}}}));
import {dropboxSyncClient as client} from '@/src/services/config/dropboxSyncClient';
import {googleDriveSyncClient} from '@/src/services/config/googleDriveSyncClient';
describe('Dropbox 设置请求', () => {
    it('构建标识只接受公开输入并去除空格，未配置时为空', async () => {
        for (const [input, expected] of [[undefined, ''], ['', ''], [' fixtureKey ', 'fixtureKey']] as const) {
            vi.stubEnv('WXT_DROPBOX_APP_KEY', input); vi.resetModules();
            expect((await import('@/src/platform/dropbox/constants')).DROPBOX_APP_KEY).toBe(expected);
        }
        vi.unstubAllEnvs();
    });
    it('独立协议与客户端归属；换号请求不传递令牌或口令', async () => {
        mocks.sendMessage.mockResolvedValue({success: true, data: {fixture: true}});
        await client.status(); await client.prepare(); await client.prepare(true); await client.commit('fixture', 'upload', {}); await client.cancel(); await googleDriveSyncClient.status();
        expect(mocks.sendMessage.mock.calls.slice(0, 5).every(([message]) => message.type === 'dropboxEncryptedSync' && !('passphrase' in message))).toBe(true);
        expect(mocks.sendMessage.mock.calls[2][0].switchAccount).toBe(true);
        expect(mocks.sendMessage.mock.calls[0][0].clientId).not.toBe(mocks.sendMessage.mock.calls[5][0].clientId);
    });
});
