import {describe, expect, it, vi} from 'vitest';
import {installDocumentHypothesisRuntime} from '@/src/app/document-translation/hypothesisRuntime';
const flush = async () => {for (let i = 0; i < 5; i++) await Promise.resolve();};
function setup(currentTab = async (): Promise<{id?: number} | undefined> => ({id: 7})) {
    const ports = {currentTab, runtimeId: 'owned', popupUrl: 'chrome-extension://owned/popup.html', add: vi.fn(), remove: vi.fn(), toggle: vi.fn(async () => ({status: 'success', active: true}))};
    return {ports, dispose: installDocumentHypothesisRuntime(ports)};
}
describe('PDF reader popup routing', () => {
    it('accepts only its own popup and exact browser-provided target tab', async () => {
        const {ports, dispose} = setup(); await flush(); const listener = ports.add.mock.calls[0][0];
        const request = {type: 'toggleDocumentHypothesis', tabId: 7}, sender = {id: 'owned', url: ports.popupUrl + '?embedded=1#content'};
        for (const message of [null, {}, {type: 'other', tabId: 7}, {...request, tabId: 8}]) expect(listener(message, sender)).toBeUndefined();
        for (const value of [{}, {id: 'foreign', url: ports.popupUrl}, {id: 'owned', url: 'https://attacker.invalid/popup.html'}, {id: 'owned'}]) expect(listener(request, value)).toBeUndefined();
        expect(await listener(request, sender)).toEqual({status: 'success', active: true}); expect(ports.toggle).toHaveBeenCalledOnce();
        dispose(); expect(ports.remove).toHaveBeenCalledWith(listener); expect(listener(request, sender)).toBeUndefined(); dispose(); expect(ports.remove).toHaveBeenCalledOnce();
    });
    it.each([undefined, {}, {id: -1}, {id: .5}])('does not register without a live tab %j', async tab => {
        const {ports, dispose} = setup(async () => tab); await flush(); expect(ports.add).not.toHaveBeenCalled(); dispose(); expect(ports.remove).not.toHaveBeenCalled();
    });
    it('ignores late initialization after unmount and safely handles a closed tab', async () => {
        let finish!: (value: {id: number}) => void; const first = setup(() => new Promise(resolve => {finish = resolve;})); first.dispose(); finish({id: 7}); await flush(); expect(first.ports.add).not.toHaveBeenCalled();
        const second = setup(async () => {throw Error('closed');}); await flush(); second.dispose(); expect(second.ports.add).not.toHaveBeenCalled();
    });
});
