import {afterEach, describe, expect, it, vi} from 'vitest';
import {createArxivPaperPdfHandler, createDocumentNavigationHandlers} from '@/src/app/background/documentNavigation';
import {isSameArxivPaper, readArxivPaperUrl} from '@/src/features/document-translation/core/arxivPaperUrl';
import {readPdfSourceFragment} from '@/src/features/document-translation/core/pdfSource';
import {createBackgroundMessageRouter} from '@/src/services/messaging/backgroundRouter';

const config = vi.hoisted(() => ({on: true, disabledExtensionDomains: [] as string[]}));
vi.mock('@/src/services/config/store', () => ({config, configReady: Promise.resolve()}));

const origin = 'https://arxiv.org';
const abs = origin + '/abs/1706.03762v7';
const pdf = origin + '/pdf/1706.03762v7';
const message = {type: 'openArxivPaperPdf', url: pdf} as const;
const sender = {id: 'fluentread', url: abs, frameId: 0, tab: {id: 0, windowId: 4}};

afterEach(() => {
    vi.unstubAllGlobals();
    config.on = true;
    config.disabledExtensionDomains = [];
});

describe('arXiv paper URL identity', () => {
    it.each([
        [abs, 'abs', '1706.03762', '7'],
        [origin + '/html/0706.0001?preview=1#S1', 'html', '0706.0001', undefined],
        ['https://www.arxiv.org/pdf/hep-th/9901001v2.pdf/', 'pdf', 'hep-th/9901001', '2'],
        [origin + '/abs/math.GT/0307245', 'abs', 'math.GT/0307245', undefined],
    ] as const)('parses %s', (href, kind, id, version) => {
        expect(readArxivPaperUrl(new URL(href))).toEqual({url: new URL(href), kind, id, version});
    });

    it.each([
        'invalid', 'http://arxiv.org/abs/1706.03762', 'https://example.com/abs/1706.03762',
        'https://arxiv.org.example.com/abs/1706.03762', 'https://arxiv.org:444/abs/1706.03762',
        'https://user@arxiv.org/abs/1706.03762', 'https://:pass@arxiv.org/abs/1706.03762',
        origin + '/list/cs/recent', origin + '/abs/1706.03762.pdf', origin + '/pdf/1706.03762v0',
        origin + '/pdf/hep-th%2F9901001', origin + '/html/1706.03762/assets',
    ])('rejects %s', href => expect(readArxivPaperUrl(href)).toBeNull());

    it('requires the selected revision and allows a latest page to use a pinned link', () => {
        const latest = readArxivPaperUrl(origin + '/abs/1706.03762')!;
        const revision = readArxivPaperUrl(abs)!;
        const selectedPdf = readArxivPaperUrl(pdf)!;
        expect(isSameArxivPaper(latest, selectedPdf)).toBe(true);
        expect(isSameArxivPaper(revision, selectedPdf)).toBe(true);
        expect(isSameArxivPaper(revision, latest)).toBe(false);
        expect(isSameArxivPaper(revision, readArxivPaperUrl(origin + '/pdf/1706.03763v7')!)).toBe(false);
    });
});

describe('Open arXiv paper PDF background message', () => {
    function setup() {
        const isDisabled = vi.fn(() => false);
        const openPdf = vi.fn(async () => undefined);
        const handler = createArxivPaperPdfHandler({ready: Promise.resolve(), extensionId: 'fluentread', isDisabled, openPdf});
        return {handler, isDisabled, openPdf};
    }

    it.each([
        undefined, {...sender, id: 'other-extension'}, {...sender, frameId: 1},
        {...sender, tab: undefined}, {...sender, tab: {id: -1}}, {...sender, url: undefined},
        {...sender, url: origin + '/html/1706.03762v7'}, {...sender, url: abs.replace('arxiv.org', 'example.com')},
    ])('rejects a sender outside the extension top-level arXiv abstract: %j', async invalidSender => {
        const {handler, isDisabled, openPdf} = setup();
        await expect(handler.handle(message, {sender: invalidSender})).resolves.toEqual({status: 'invalid-source'});
        expect(isDisabled).not.toHaveBeenCalled();
        expect(openPdf).not.toHaveBeenCalled();
    });

    it.each([
        undefined, 0, abs, pdf.replace('v7', ''), pdf.replace('v7', 'v1'),
        pdf.replace('03762', '03763'), pdf.replace('arxiv.org', 'example.com'),
    ])('rejects a target outside the selected paper PDF: %s', async url => {
        const {handler, openPdf} = setup();
        await expect(handler.handle({...message, url}, {sender})).resolves.toEqual({status: 'invalid-source'});
        expect(openPdf).not.toHaveBeenCalled();
    });

    it('returns a retryable failure without passing query or fragment into the viewer', async () => {
        const {handler, openPdf} = setup();
        openPdf.mockRejectedValueOnce(new Error('tabs.create failed'));
        const request = {...message, url: pdf + '?unused=1#page=2'};
        await expect(handler.handle(request, {sender})).resolves.toEqual({status: 'failed'});
        await expect(handler.handle(request, {sender})).resolves.toEqual({status: 'success'});
        expect(openPdf.mock.calls).toEqual([[pdf, 4], [pdf, 4]]);
    });

    it('opens the existing reader in the source window and respects global and per-site switches', async () => {
        const create = vi.fn(async (_options: {url: string; windowId?: number}) => undefined);
        vi.stubGlobal('browser', {
            runtime: {id: 'fluentread', getURL: (path: string) => `chrome-extension://fluentread${path}`},
            tabs: {create},
        });
        const router = createBackgroundMessageRouter(createDocumentNavigationHandlers());
        const check = (status: string, context = {sender}) =>
            expect(router.dispatch(message, context)).resolves.toEqual({handled: true, response: {status}});
        config.on = false;
        await check('disabled');
        config.on = true;
        config.disabledExtensionDomains = ['arxiv.org'];
        await check('disabled');
        expect(create).not.toHaveBeenCalled();
        config.disabledExtensionDomains = [];
        await check('success');
        const options = create.mock.calls[0]![0];
        expect(options.windowId).toBe(4);
        const readerUrl = new URL(options.url);
        expect(readerUrl.pathname).toBe('/document.html');
        expect(readPdfSourceFragment(readerUrl.hash)).toBe(pdf);
        await expect(router.dispatch(message, {sender: {...sender, tab: {id: 0}}}))
            .resolves.toEqual({handled: true, response: {status: 'success'}});
        expect(create).toHaveBeenLastCalledWith({url: options.url});
    });
});
