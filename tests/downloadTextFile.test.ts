import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {downloadTextFile} from '@/src/shared/dom/downloadTextFile';

const click = vi.fn();
let anchor: {href: string; download: string; click: typeof click};
beforeEach(() => {
    vi.useFakeTimers();click.mockReset();anchor = {href:'', download:'', click};
    vi.stubGlobal('document', {createElement:vi.fn(() => anchor)});
    vi.stubGlobal('window', {setTimeout:globalThis.setTimeout});
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:owned-export');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});
afterEach(() => {vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});

describe('用户主动文本导出的 URL 所有权', () => {
    it('保留完整文本与类型，下载后延迟一秒释放', async () => {
        const bytes = downloadTextFile('backup.json', 'secret\n例句', 'application/json');
        const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
        expect(await blob.text()).toBe('secret\n例句');expect(blob.type).toBe('application/json');expect(bytes).toBe(13);
        expect(anchor.href).toBe('blob:owned-export');expect(anchor.download).toBe('backup.json');expect(click).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(999);expect(URL.revokeObjectURL).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:owned-export');
    });
    it.each(['element', 'click', 'timer'] as const)('%s 同步失败时撤销地址并保留原错误', failure => {
        const error = new Error(failure);
        if (failure === 'element') vi.mocked(document.createElement).mockImplementationOnce(() => {throw error;});
        if (failure === 'click') click.mockImplementationOnce(() => {throw error;});
        if (failure === 'timer') vi.spyOn(window, 'setTimeout').mockImplementationOnce(() => {throw error;});
        expect(() => downloadTextFile('backup', 'private', 'text/plain')).toThrow(error);
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:owned-export');expect(vi.getTimerCount()).toBe(0);
    });
    it('清理接口也失败时保留原始启动错误，定时清理失败不产生未处理异常', async () => {
        const error = new Error('download failed');click.mockImplementationOnce(() => {throw error;});
        vi.mocked(URL.revokeObjectURL).mockImplementationOnce(() => {throw new Error('cleanup');});
        expect(() => downloadTextFile('backup', 'private', 'text/plain')).toThrow(error);
        vi.mocked(URL.revokeObjectURL).mockImplementationOnce(() => {throw new Error('cleanup');});
        downloadTextFile('backup', 'private', 'text/plain');
        await vi.advanceTimersByTimeAsync(1000);expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    });
});
