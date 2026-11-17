import {describe, expect, it, vi} from 'vitest';
import {createHypothesisInjectionHandler} from '@/src/features/hypothesis/injection';
const sender = () => ({id: 'owned', frameId: 0, url: 'https://paper.example/read', documentId: 'original-document', tab: {id: 7}});
function setup() {
    const ports = {extensionId: 'owned', enabled: vi.fn(async () => true), getTab: vi.fn(async () => ({url: 'https://paper.example/read'} as {url?: string; pendingUrl?: string})), inject: vi.fn(async () => {})};
    const handler = createHypothesisInjectionHandler(ports); return {ports, run: (value: any = {sender: sender()}) => handler.handle({type: handler.type}, value)};
}
describe('Hypothesis static injection boundary', () => {
    it.each([{}, {sender: {}}, {sender: {...sender(), id: 'foreign'}}, {sender: {...sender(), frameId: 1}}, {sender: {...sender(), tab: undefined}}, {sender: {...sender(), tab: {id: -1}}}, {sender: {...sender(), url: undefined}}, {sender: {...sender(), url: 'chrome://settings'}}])('rejects invalid or non-top-level ownership %#', async value => {
        const {ports, run} = setup(); expect(await run(value)).toEqual({status: 'unavailable'}); expect(ports.inject).not.toHaveBeenCalled();
    });
    it('checks configuration and exact tab URL before injecting into the sending document', async () => {
        const {ports, run} = setup(); expect(await run()).toEqual({status: 'success'}); expect(ports.inject).toHaveBeenCalledWith(7, 'original-document');
        ports.inject.mockClear(); ports.enabled.mockResolvedValue(false); expect(await run()).toEqual({status: 'disabled'}); expect(ports.inject).not.toHaveBeenCalled();
        ports.enabled.mockResolvedValue(true); ports.getTab.mockResolvedValue({url: sender().url, pendingUrl: 'https://paper.example/next'}); expect(await run()).toEqual({status: 'unavailable'});
        ports.getTab.mockResolvedValue({}); expect(await run()).toEqual({status: 'unavailable'});
        ports.getTab.mockRejectedValue(Error('closed')); expect(await run()).toEqual({status: 'failed'});
    });
    it('uses the document guard for an MV2 sender without documentId and reports injection failure', async () => {
        const {ports, run} = setup(); const value: any = sender(); delete value.documentId;
        expect(await run({sender: value})).toEqual({status: 'success'}); expect(ports.inject).toHaveBeenCalledWith(7, undefined);
        ports.inject.mockRejectedValueOnce(Error('denied')); expect(await run()).toEqual({status: 'failed'});
    });
});
