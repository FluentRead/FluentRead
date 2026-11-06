import {describe, expect, it, vi} from 'vitest';
import {createPdfSourceRecoveryWorkflow, type PdfSourceImage} from '../src/features/document-translation/services/pdfSourceRecoveryWorkflow';

const deferred = <T>() => {let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
function setup() {
    const renders: ReturnType<typeof deferred<PdfSourceImage>>[] = [], recognitions: ReturnType<typeof deferred<readonly {text: string}[]>>[] = [];
    const ports = {
        render: vi.fn((_target: {source: string; sourceLanguage: string; isCurrent(): boolean}, _signal: AbortSignal) => {const value = deferred<PdfSourceImage>(); renders.push(value); return value.promise;}),
        recognize: vi.fn((_image: string, _language: string, _signal: AbortSignal) => {const value = deferred<readonly {text: string}[]>(); recognitions.push(value); return value.promise;}),
        onImage: vi.fn(), onRecognition: vi.fn(), onPhase: vi.fn(), onError: vi.fn(),
    };
    const target = {source: 'Before \u0003 after.', sourceLanguage: 'en', isCurrent: () => true};
    return {ports, target, renders, recognitions, workflow: createPdfSourceRecoveryWorkflow(ports)};
}
const image = {image: 'data:image/png;base64,source', width: 30, height: 20};

describe('PDF source recovery operation ownership', () => {
    it('renders first and starts OCR only on explicit demand; returns raw text separately from a source-faithful suggestion', async () => {
        const {ports, target, renders, recognitions, workflow} = setup();
        await workflow.recognize();
        expect(ports.recognize).not.toHaveBeenCalled();
        const opening = workflow.open(target);
        expect(ports.onPhase).toHaveBeenLastCalledWith('rendering');
        renders[0].resolve(image); await opening;
        expect(ports.onImage).toHaveBeenCalledWith(image);
        expect(ports.recognize).not.toHaveBeenCalled();
        const recognizing = workflow.recognize();
        expect(ports.recognize).toHaveBeenCalledWith(image.image, 'en', expect.any(AbortSignal));
        await workflow.recognize();
        expect(ports.recognize).toHaveBeenCalledTimes(1);
        recognitions[0].resolve([{text: 'Before −'}, {text: 'after.'}]); await recognizing;
        expect(ports.onRecognition).toHaveBeenCalledWith({recognizedText: 'Before −\nafter.', suggestion: {source: 'Before − after.', replacements: [{offset: 7, original: '\u0003', text: '−'}]}});
        expect(target.source).toBe('Before \u0003 after.');
        expect(ports.onPhase).toHaveBeenLastCalledWith('ready');
    });
    it.each(['cancel', 'dispose'] as const)('aborts %s and ignores a late render or OCR response', async action => {
        const {ports, target, renders, recognitions, workflow} = setup();
        const first = workflow.open(target);
        const renderSignal = ports.render.mock.calls[0][1];
        workflow[action](); expect(renderSignal.aborted).toBe(true);
        renders[0].resolve(image); await first;
        expect(ports.onImage).not.toHaveBeenCalled();
        await workflow.recognize(); expect(ports.recognize).not.toHaveBeenCalled();
        if (action === 'dispose') {await workflow.open(target); expect(ports.render).toHaveBeenCalledTimes(1); return;}
        const second = workflow.open(target); renders[1].resolve(image); await second;
        const recognition = workflow.recognize(), signal = ports.recognize.mock.calls[0][2];
        workflow.cancel(); expect(signal.aborted).toBe(true);
        recognitions[0].resolve([{text: 'Before − after.'}]); await recognition;
        expect(ports.onRecognition).not.toHaveBeenCalled();
    });
    it('supersedes an opening generation without letting its error change the new phase', async () => {
        const {ports, target, renders, workflow} = setup();
        const old = workflow.open(target), current = workflow.open({...target, source: 'Other'});
        expect(ports.render.mock.calls[0][1].aborted).toBe(true);
        renders[0].reject(new Error('old render')); await old;
        expect(ports.onError).not.toHaveBeenCalled(); expect(ports.onPhase).toHaveBeenLastCalledWith('rendering');
        renders[1].resolve(image); await current;
        expect(ports.onImage).toHaveBeenCalledTimes(1);
    });
    it('rejects stale task/document/revision qualification before and after awaited work', async () => {
        const {ports, target, renders, recognitions, workflow} = setup();
        let valid = false; target.isCurrent = () => valid;
        await workflow.open(target); expect(ports.render).not.toHaveBeenCalled();
        valid = true; const opening = workflow.open(target); valid = false;
        renders[0].resolve(image); await opening;
        expect(ports.onImage).not.toHaveBeenCalled();
        valid = true; const again = workflow.open(target); renders[1].resolve(image); await again;
        const recognition = workflow.recognize(); valid = false;
        recognitions[0].reject(new Error('stale OCR')); await recognition;
        expect(ports.onRecognition).not.toHaveBeenCalled(); expect(ports.onError).not.toHaveBeenCalled();
    });
    it('reports current failures and permits OCR retry without overwriting a manual draft', async () => {
        const {ports, target, renders, recognitions, workflow} = setup();
        const failed = workflow.open(target); renders[0].reject(new Error('render failure')); await failed;
        expect(ports.onError).toHaveBeenCalledWith('render', expect.any(Error));
        expect(ports.onPhase).toHaveBeenLastCalledWith('ready');
        const opening = workflow.open(target); renders[1].resolve(image); await opening;
        const failedOcr = workflow.recognize(); recognitions[0].reject(new Error('OCR failure')); await failedOcr;
        expect(ports.onError).toHaveBeenLastCalledWith('recognize', expect.any(Error));
        const retry = workflow.recognize(); recognitions[1].resolve([{text: 'OCR changed known words'}]); await retry;
        expect(ports.onRecognition).toHaveBeenCalledWith({recognizedText: 'OCR changed known words', suggestion: undefined});
        expect(target.source).toBe('Before \u0003 after.');
    });
});
