import {describe, expect, it, vi} from 'vitest';
import {markRaw, nextTick, toRaw, watch} from 'vue';
import {parseDocument} from '@/src/features/document-translation/core/document';
import {applyDocumentTranslations, countCompletedTranslations, createDocumentTaskState, useDocumentTasks, type DocumentQueueItem} from '@/src/features/document-translation/ui/useDocumentTasks';

const task = (id: number): DocumentQueueItem => ({
    ...createDocumentTaskState(), id, name: `${id}.txt`, document: markRaw(parseDocument(`${id}.txt`, 'Source')),
});

describe('document task state ownership', () => {
    it('commits edits, provider results and export revisions directly to the task used by the queue', () => {
        const tasks = useDocumentTasks();
        tasks.documentQueue.value.push(task(1));
        tasks.activeDocumentId.value = 1;
        tasks.translatedSegments.value[0] = 'Reader correction';
        tasks.confirmedTranslationIds.value.push(0);
        tasks.taskFingerprint.value = 'settings';
        tasks.runState.value = 'paused';
        tasks.editRevision.value = 2;
        tasks.downloadedRevision.value = 1;
        tasks.errorMessage.value = 'retry';
        tasks.documentBatchTranslation.value = false;
        tasks.bypassCache.value = true;
        const current = tasks.documentQueue.value[0];
        expect(current).toMatchObject({translations: ['Reader correction'], confirmedTranslationIds: [0],
            fingerprint: 'settings', state: 'paused', revision: 2, downloaded: 1, error: 'retry', batchTranslation: false, bypassCache: true});
        current.translations = ['Provider result'];
        expect(tasks.translatedSegments.value).toBe(current.translations);
        expect(tasks.parsedDocument.value).toBe(current.document);
    });

    it('switches the cursor without copying or overwriting the other document', () => {
        const tasks = useDocumentTasks();
        tasks.documentQueue.value.push(task(1), task(2));
        tasks.activeDocumentId.value = 1;
        tasks.translatedSegments.value = ['First'];
        tasks.confirmedTranslationIds.value = [0];
        tasks.editRevision.value = 3;
        tasks.bypassCache.value = true;
        const firstTranslations = tasks.translatedSegments.value;
        tasks.activeDocumentId.value = 2;
        expect(tasks.translatedSegments.value).toEqual([]);
        expect(tasks.confirmedTranslationIds.value).toEqual([]);
        expect(tasks.editRevision.value).toBe(0);
        expect(tasks.bypassCache.value).toBe(false);
        tasks.translatedSegments.value = ['Second'];
        tasks.activeDocumentId.value = 1;
        expect(tasks.translatedSegments.value).toBe(firstTranslations);
        expect(tasks.editRevision.value).toBe(3);
        expect(tasks.bypassCache.value).toBe(true);
        expect(tasks.documentQueue.value[1].translations).toEqual(['Second']);
    });

    it('keeps empty-page failures separate from tasks and resets every field on clear', () => {
        const tasks = useDocumentTasks();
        tasks.errorMessage.value = 'Import failed';
        tasks.translatedSegments.value.push('empty draft');
        tasks.documentQueue.value.push(task(1));
        tasks.activeDocumentId.value = 1;
        expect(tasks.errorMessage.value).toBe('');
        tasks.parsedDocument.value = null;
        tasks.translatedSegments.value = ['Kept'];
        tasks.bypassCache.value = true;
        const previous = tasks.documentQueue.value[0];
        tasks.clear();
        expect(tasks.documentQueue.value).toEqual([]);
        expect(tasks.activeTask.value).toBeNull();
        expect(tasks.activeDocumentId.value).toBeNull();
        expect(tasks.parsedDocument.value).toBeNull();
        expect(tasks.translatedSegments.value).toEqual([]);
        expect(tasks.errorMessage.value).toBe('');
        expect(tasks.confirmedTranslationIds.value).toEqual([]);
        expect(tasks.taskFingerprint.value).toBe('');
        expect(tasks.runState.value).toBe('ready');
        expect(tasks.editRevision.value).toBe(0);
        expect(tasks.downloadedRevision.value).toBe(0);
        expect(tasks.documentBatchTranslation.value).toBe(true);
        expect(tasks.bypassCache.value).toBe(false);
        tasks.translatedSegments.value.push('new draft');
        expect(toRaw(previous).translations).toEqual(['Kept']);
    });

    it('resets idle selection without destroying other tasks and owns independent default arrays', () => {
        const tasks = useDocumentTasks();
        const first = task(1), second = task(2);
        first.translations.push('First');
        first.confirmedTranslationIds.push(0);
        first.bypassCache = true;
        expect(second.translations).toEqual([]);
        expect(second.confirmedTranslationIds).toEqual([]);
        expect(second.bypassCache).toBe(false);
        tasks.documentQueue.value.push(first, second);
        tasks.activeDocumentId.value = 1;
        tasks.clearSelection();
        expect(tasks.documentQueue.value).toHaveLength(2);
        expect(tasks.translatedSegments.value).toEqual([]);
        expect(tasks.bypassCache.value).toBe(false);
        tasks.activeDocumentId.value = 1;
        expect(tasks.translatedSegments.value).toEqual(['First']);
        expect(tasks.confirmedTranslationIds.value).toEqual([0]);
        expect(tasks.bypassCache.value).toBe(true);
    });

    it('counts completed translations without intermediate allocations across whole arrays and segment subsets', () => {
        const sparse: string[] = [];
        sparse[0] = 'First';
        sparse[2] = '   ';
        sparse[3] = 'Third';
        expect(countCompletedTranslations(sparse)).toBe(2);
        expect(countCompletedTranslations(sparse, [{id: 0}, {id: 1}, {id: 2}, {id: 3}])).toBe(2);
        expect(countCompletedTranslations(sparse, [{id: 1}, {id: 2}])).toBe(0);
    });

    it('commits translation batches in a single reactive update and keeps completedCount and hasTranslation accurate', async () => {
        const tasks = useDocumentTasks();
        // Works on empty state before any active document is selected.
        expect(tasks.completedCount.value).toBe(0);
        expect(tasks.hasTranslation.value).toBe(false);
        expect(tasks.setDocumentTranslationBatch([])).toBe(0);
        expect(tasks.setDocumentTranslationBatch([{id: 0, translation: 'Draft'}])).toBe(1);
        expect(tasks.completedCount.value).toBe(1);
        expect(tasks.hasTranslation.value).toBe(true);

        const multi = {
            ...createDocumentTaskState(),
            id: 1,
            name: 'multi.txt',
            document: markRaw(parseDocument('multi.txt', 'A\n\nB\n\nC\n\nD')),
        };
        tasks.documentQueue.value.push(multi);
        tasks.activeDocumentId.value = 1;
        expect(tasks.completedCount.value).toBe(0);
        expect(tasks.hasTranslation.value).toBe(false);

        const notifications = vi.fn();
        const stop = watch(tasks.translatedSegments, notifications);
        const beforeRef = tasks.translatedSegments.value;
        // No-op batch does not replace the array or trigger notifications.
        expect(applyDocumentTranslations(multi, [{id: 0, translation: ''}])).toBe(0);
        expect(tasks.translatedSegments.value).toBe(beforeRef);

        // Batch of multiple updates commits in a single reactive replacement.
        const delta = tasks.setDocumentTranslationBatch([
            {id: 0, translation: '甲'},
            {id: 1, translation: '乙'},
            {id: 2, translation: '丙'},
            {id: 1, translation: '乙改'},
            {id: 2, translation: '  '},
            {id: 3, translation: '丁'},
        ]);
        await nextTick();
        expect(delta).toBe(3);
        expect(notifications).toHaveBeenCalledOnce();
        expect(tasks.translatedSegments.value).toEqual(['甲', '乙改', '  ', '丁']);
        expect(tasks.completedCount.value).toBe(3);
        expect(tasks.hasTranslation.value).toBe(true);

        // Clearing translations returns negative delta and flips hasTranslation back to false.
        expect(tasks.setDocumentTranslationBatch([
            {id: 0, translation: ''},
            {id: 1, translation: ''},
            {id: 3, translation: ''},
        ])).toBe(-3);
        expect(tasks.completedCount.value).toBe(0);
        expect(tasks.hasTranslation.value).toBe(false);
        stop();
    });
});
