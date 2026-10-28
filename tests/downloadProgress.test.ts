/**
 * @file tests/downloadProgress.test.ts
 * 文件职责：验证统一下载进度模块只使用真实字节数，并在总量未知时不给出百分比。
 * 主要内容：覆盖标识与存储键、跨上下文数据归一化、百分比与体积文字、多文件汇总、多项下载合计，以及发布器的限频和结束通知。
 * 模块边界：纯函数测试，不访问网络、浏览器存储或界面。
 */
import {describe, expect, it, vi} from 'vitest';
import {
    DOWNLOAD_PROGRESS_MESSAGE,
    LOCAL_TTS_DOWNLOAD_ID,
    createCoalescedDownloadNotifier,
    createDownloadProgressPublisher,
    createDownloadCompletionSummary,
    createDownloadProgressTracker,
    downloadProgressKey,
    downloadProgressPercent,
    formatDownloadBytes,
    formatDownloadProgress,
    isDownloadProgressId,
    normalizeDownloadProgress,
    ocrLanguageDownloadId,
    videoModelDownloadId,
    type DownloadProgress,
} from '@/src/core/download/progress';

describe('download progress data', () => {
    it('whitelists model source status and strips unrelated URLs and malformed metadata', () => {
        const transfer = {source: 'hf-mirror', state: 'connecting', attempt: 2, attempts: 3};
        expect(normalizeDownloadProgress({loaded: 5, total: 10, transfer: {...transfer, url: 'https://private.invalid/?token=secret'}})).toEqual({loaded: 5, total: 10, transfer});
        for (const source of ['modelscope', 'huggingface', 'hf-mirror', 'other']) {
            expect(normalizeDownloadProgress({loaded: 0, total: 0, transfer: {...transfer, source, state: 'receiving'}})?.transfer?.source).toBe(source);
        }
        for (const invalid of [null, 'source', {...transfer, source: 'arbitrary'}, {...transfer, state: 'done'}, {...transfer, attempt: 0}, {...transfer, attempt: 1.5}, {...transfer, attempts: NaN}, {...transfer, attempts: 1}, {...transfer, attempts: 9}]) {
            expect(normalizeDownloadProgress({loaded: 5, total: 10, transfer: invalid})).toEqual({loaded: 5, total: 10});
        }
    });
    it('builds stable ids and storage keys and rejects anything that is not a plain id', () => {
        expect(videoModelDownloadId('tiny')).toBe('video-model:tiny');
        expect(ocrLanguageDownloadId('chi_sim')).toBe('ocr-language:chi_sim');
        expect(downloadProgressKey(LOCAL_TTS_DOWNLOAD_ID)).toBe('fluentReadDownloadProgress:local-tts');
        for (const id of [LOCAL_TTS_DOWNLOAD_ID, videoModelDownloadId('base'), ocrLanguageDownloadId('jpn')]) {
            expect(isDownloadProgressId(id)).toBe(true);
        }
        for (const value of ['', ':leading', 'Upper', 'has space', 'a'.repeat(65), 7, null, undefined]) {
            expect(isDownloadProgressId(value)).toBe(false);
        }
    });

    it('accepts only finite non-negative byte counts and never lets loaded exceed a known total', () => {
        expect(normalizeDownloadProgress({loaded: 5, total: 10})).toEqual({loaded: 5, total: 10});
        expect(normalizeDownloadProgress({loaded: 12, total: 10})).toEqual({loaded: 12, total: 12});
        expect(normalizeDownloadProgress({loaded: 12, total: 0})).toEqual({loaded: 12, total: 0});
        for (const value of [undefined, null, 'text', 3, {loaded: 1}, {total: 1}, {loaded: -1, total: 2}, {loaded: 1, total: Number.NaN}, {loaded: Infinity, total: 1}, {loaded: '1', total: 2}]) {
            expect(normalizeDownloadProgress(value)).toBeUndefined();
        }
    });

    it('gives a floored percentage only when the total is known', () => {
        expect(downloadProgressPercent({loaded: 0, total: 200})).toBe(0);
        expect(downloadProgressPercent({loaded: 199, total: 200})).toBe(99);
        expect(downloadProgressPercent({loaded: 200, total: 200})).toBe(100);
        expect(downloadProgressPercent({loaded: 250, total: 200})).toBe(100);
        expect(downloadProgressPercent({loaded: 250, total: 0})).toBeUndefined();
    });

    it('writes sizes in MB or GB and falls back to downloaded bytes without a total', () => {
        expect(formatDownloadBytes(700_000)).toBe('0.7 MB');
        expect(formatDownloadBytes(9_949_999)).toBe('9.9 MB');
        expect(formatDownloadBytes(10_000_000)).toBe('10 MB');
        expect(formatDownloadBytes(341_463_503)).toBe('341 MB');
        expect(formatDownloadBytes(1_133_000_000)).toBe('1.13 GB');
        expect(formatDownloadProgress({loaded: 143_000_000, total: 341_463_503})).toBe('41% · 143 MB / 341 MB');
        expect(formatDownloadProgress({loaded: 2_500_000, total: 0})).toBe('2.5 MB');
    });
});

describe('multi-file download tracker', () => {
    it('reports connection and source switches immediately without inventing downloaded bytes', () => {
        const reports: DownloadProgress[] = [], tracker = createDownloadProgressTracker(2, 100, progress => reports.push(progress));
        tracker.file().cached(20);
        const file = tracker.file();
        tracker.transfer({source: 'modelscope', state: 'connecting', attempt: 1, attempts: 3});
        expect(reports.at(-1)).toMatchObject({loaded: 20, total: 100, transfer: {source: 'modelscope', state: 'connecting'}});
        file.advance(10, 80);
        tracker.transfer({source: 'huggingface', state: 'connecting', attempt: 2, attempts: 3});
        file.advance(0, 80);
        expect(reports.at(-1)).toMatchObject({loaded: 20, total: 100, transfer: {source: 'huggingface', attempt: 2}});
    });
    it('uses the declared total until every file reports its size, then switches to the exact sum', () => {
        const reports: DownloadProgress[] = [];
        const tracker = createDownloadProgressTracker(3, 1000, progress => reports.push(progress));
        const config = tracker.file();
        config.advance(0, 10);
        config.advance(10, 10);
        config.complete();
        expect(reports.at(-1)).toEqual({loaded: 10, total: 1000});

        const weights = tracker.file();
        weights.advance(0, 900);
        expect(reports.at(-1)).toEqual({loaded: 10, total: 1000});
        weights.advance(450, 900);
        expect(reports.at(-1)).toEqual({loaded: 460, total: 1000});
        weights.advance(900, 900);
        weights.complete();

        const voice = tracker.file();
        voice.advance(0, 50);
        // 三个文件都已知大小：合计 960，而不是声明的 1000。
        expect(reports.at(-1)).toEqual({loaded: 910, total: 960});
        voice.advance(50, 50);
        voice.complete();
        expect(reports.at(-1)).toEqual({loaded: 960, total: 960});
    });

    it('counts cached files, grows past a too-small estimate and restarts a file after a source switch', () => {
        const reports: DownloadProgress[] = [];
        const tracker = createDownloadProgressTracker(2, 100, progress => reports.push(progress));
        tracker.file().cached(80);
        expect(reports.at(-1)).toEqual({loaded: 80, total: 100});
        const second = tracker.file();
        second.advance(30);
        // 第二个文件没有 Content-Length：已接收量超过预计时总量跟着增长，不会出现超过 100%。
        expect(reports.at(-1)).toEqual({loaded: 110, total: 110});
        second.advance(0, 40);
        expect(reports.at(-1)).toEqual({loaded: 80, total: 120});
        second.advance(40, 40);
        second.complete();
        expect(reports.at(-1)).toEqual({loaded: 120, total: 120});
    });

    it('reports an unknown total when there is no estimate and treats unreadable cache sizes as zero', () => {
        const reports: DownloadProgress[] = [];
        const tracker = createDownloadProgressTracker(2, 0, progress => reports.push(progress));
        const first = tracker.file();
        first.advance(5);
        expect(reports.at(-1)).toEqual({loaded: 5, total: 0});
        first.advance(5, 20);
        // 还有一个文件没有开始，合计仍然未知。
        expect(reports.at(-1)).toEqual({loaded: 5, total: 0});
        for (const size of [Number.NaN, 0, -3, undefined]) {
            const single: DownloadProgress[] = [];
            createDownloadProgressTracker(1, 0, progress => single.push(progress)).file().cached(size);
            expect(single).toEqual([{loaded: 0, total: 0}]);
        }
        tracker.file().cached(Number.NaN);
        expect(reports.at(-1)).toEqual({loaded: 5, total: 20});
    });
});

describe('combined percentage across sequential downloads', () => {
    it('weights each task equally so the percentage never drops when the next task starts', () => {
        const reports: number[] = [];
        const update = createDownloadCompletionSummary(['ocr-language:jpn', 'ocr-language:eng'], percent => reports.push(percent));
        update('ocr-language:kor', {loaded: 1, total: 2});
        expect(reports).toEqual([]);
        update('ocr-language:jpn', {loaded: 1, total: 4});
        update('ocr-language:jpn', {loaded: 4, total: 4});
        // 结束事件把该项记为完成；下一项从 0 开始时总百分比保持在一半，不倒退。
        update('ocr-language:jpn', undefined);
        update('ocr-language:eng', {loaded: 0, total: 6});
        update('ocr-language:eng', {loaded: 3, total: 6});
        update('ocr-language:eng', {loaded: 9, total: 6});
        expect(reports).toEqual([12, 50, 50, 50, 75, 100]);
    });

    it('keeps the last known share when a task reports no total', () => {
        const reports: number[] = [];
        const update = createDownloadCompletionSummary(['a'], percent => reports.push(percent));
        update('a', {loaded: 5, total: 0});
        expect(reports).toEqual([]);
        update('a', {loaded: 1, total: 3});
        update('a', {loaded: 9, total: 0});
        update('a', undefined);
        expect(reports).toEqual([33, 100]);
    });
});

describe('download progress publisher', () => {
    it('preserves source metadata and publishes phase/source changes during the byte throttle interval', () => {
        const send = vi.fn(), publisher = createDownloadProgressPublisher(send, {now: () => 1});
        const transfer = {source: 'huggingface', state: 'connecting', attempt: 1, attempts: 3} as const;
        publisher.report('model', {loaded: 0, total: 100, transfer});
        publisher.report('model', {loaded: 0, total: 100, transfer});
        publisher.report('model', {loaded: 1, total: 100, transfer: {...transfer, state: 'receiving'}});
        publisher.report('model', {loaded: 0, total: 100, transfer: {...transfer, source: 'hf-mirror', attempt: 2}});
        publisher.report('model', {loaded: 0, total: 100});
        publisher.finish('model');
        publisher.report('model', {loaded: 0, total: 100, transfer});
        expect(send).toHaveBeenCalledTimes(6);
        expect(send.mock.calls[0][0].progress.transfer).toEqual(transfer);
        expect(send.mock.calls[2][0].progress.transfer.source).toBe('hf-mirror');
    });
    it('throttles per download, always sends the first report and the finish notice', () => {
        let now = 1000;
        const send = vi.fn();
        const publisher = createDownloadProgressPublisher(send, {now: () => now, intervalMs: 100});
        publisher.report('a', {loaded: 1, total: 10});
        publisher.report('a', {loaded: 2, total: 10});
        publisher.report('b', {loaded: 5, total: 0});
        now += 100;
        publisher.report('a', {loaded: 3, total: 10});
        publisher.finish('a');
        publisher.report('a', {loaded: 0, total: 10});
        expect(send.mock.calls.map(call => call[0])).toEqual([
            {type: DOWNLOAD_PROGRESS_MESSAGE, id: 'a', progress: {loaded: 1, total: 10}},
            {type: DOWNLOAD_PROGRESS_MESSAGE, id: 'b', progress: {loaded: 5, total: 0}},
            {type: DOWNLOAD_PROGRESS_MESSAGE, id: 'a', progress: {loaded: 3, total: 10}},
            {type: DOWNLOAD_PROGRESS_MESSAGE, id: 'a'},
            {type: DOWNLOAD_PROGRESS_MESSAGE, id: 'a', progress: {loaded: 0, total: 10}},
        ]);
    });

    it('wraps a download so success and failure both end with a finish notice', async () => {
        vi.useFakeTimers();
        try {
            const send = vi.fn();
            const publisher = createDownloadProgressPublisher(send);
            await expect(publisher.track('ok', async (report) => {
                report({loaded: 1, total: 2});
                report({loaded: 2, total: 2});
                vi.advanceTimersByTime(300);
                report({loaded: 2, total: 2});
                return 'done';
            })).resolves.toBe('done');
            await expect(publisher.track('bad', async () => { throw new Error('offline'); })).rejects.toThrow('offline');
            expect(send.mock.calls.map(call => call[0])).toEqual([
                {type: DOWNLOAD_PROGRESS_MESSAGE, id: 'ok', progress: {loaded: 1, total: 2}},
                {type: DOWNLOAD_PROGRESS_MESSAGE, id: 'ok', progress: {loaded: 2, total: 2}},
                {type: DOWNLOAD_PROGRESS_MESSAGE, id: 'ok'},
                {type: DOWNLOAD_PROGRESS_MESSAGE, id: 'bad'},
            ]);
        } finally {
            vi.useRealTimers();
        }
    });
});


describe('后台进度通知的有限等待和快照合并', () => {
    it('正常回执前维持顺序，期间只发送最新快照', async () => {
        let acknowledge!: () => void;
        const send = vi.fn((value: number) => value === 1 ? new Promise<void>(resolve => {acknowledge = resolve;}) : Promise.resolve());
        const notifier = createCoalescedDownloadNotifier(send);
        const first = notifier.notify(1); await Promise.resolve();
        let returned = false; void first.then(() => {returned = true;});
        await notifier.notify(2); await notifier.notify(3); expect(send.mock.calls).toEqual([[1]]); expect(returned).toBe(false);
        acknowledge(); await first; await vi.waitFor(() => expect(send.mock.calls).toEqual([[1], [3]]));
        notifier.dispose();
    });
    it('永久不回复时只保留一个发送和最新快照，超时释放调用方，迟到回执恢复发送', async () => {
        vi.useFakeTimers();
        try {
            let acknowledge!: () => void;
            const send = vi.fn((value: number) => value === 0 ? new Promise<void>(resolve => {acknowledge = resolve;}) : Promise.resolve());
            const notifier = createCoalescedDownloadNotifier(send, 1000);
            const first = notifier.notify(0); await Promise.resolve();
            for (let value = 1; value <= 10_000; value++) await notifier.notify(value);
            expect(send.mock.calls).toEqual([[0]]);
            await vi.advanceTimersByTimeAsync(1000); await first;
            expect(send.mock.calls).toEqual([[0]]);
            acknowledge(); for (let i = 0; i < 8; i++) await Promise.resolve();
            expect(send.mock.calls).toEqual([[0], [10_000]]); notifier.dispose();
        } finally {vi.useRealTimers();}
    });
    it.each(['throw', 'reject'])('%s 不阻塞下一次新快照', async failure => {
        const send = vi.fn().mockImplementationOnce(() => {if (failure === 'throw') throw new Error('fixture'); return Promise.reject(new Error('fixture'));})
            .mockResolvedValue(undefined);
        const notifier = createCoalescedDownloadNotifier(send); await notifier.notify(1); await notifier.notify(2);
        expect(send.mock.calls).toEqual([[1], [2]]); notifier.dispose();
    });
    it('通知刚入队即同步释放时，不调用底层发送', async () => {
        const send = vi.fn(async () => undefined);
        const notifier = createCoalescedDownloadNotifier(send);
        const pending = notifier.notify(1); notifier.dispose(); await pending;
        for (let i = 0; i < 5; i++) await Promise.resolve();
        expect(send).not.toHaveBeenCalled();
    });
    it('释放立即结束调用方等待，丢弃排队快照并阻止迟到回执触发新发送', async () => {
        vi.useFakeTimers();
        try {
            let acknowledge!: () => void;
            const send = vi.fn(() => new Promise<void>(resolve => {acknowledge = resolve;}));
            const notifier = createCoalescedDownloadNotifier(send);
            const pending = notifier.notify(1); await Promise.resolve(); await notifier.notify(2);
            notifier.dispose(); await pending; await notifier.notify(3);
            acknowledge(); for (let i = 0; i < 8; i++) await Promise.resolve();
            expect(send.mock.calls).toEqual([[1]]); expect(vi.getTimerCount()).toBe(0); notifier.dispose();
        } finally {vi.useRealTimers();}
    });
});
