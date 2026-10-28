import {afterEach, expect, it, vi} from 'vitest';
import {startXVideoBridgeApp} from '@/src/app/content/xVideoBridge';
import {YOUTUBE_BRIDGE_DISPOSE_EVENT, YOUTUBE_BRIDGE_ENABLE_EVENT, YOUTUBE_BRIDGE_REPLAY_EVENT} from '@/src/features/video-subtitle/content/youtubeTimedTextBridgeCore';

const metadataUrl='https://x.com/i/api/graphql/hash/TweetDetail?cursor=private-cursor';
const subtitleUrl='https://video.twimg.com/ext_tw_video/123/pu/captions/en.vtt';
const variantUrl='https://video.twimg.com/ext_tw_video/123/pu/vid/720x720/sample.mp4';
const pageHref='https://x.com/example/status/123';
afterEach(()=>vi.unstubAllGlobals());

it('bridges only approved X resources, strips metadata secrets, and restores host methods on disable', async () => {
    const postMessage=vi.fn();const location={href:pageHref,origin:'https://x.com'};
    const metadata=new Response(JSON.stringify({secret:'private-body',video_info:{variants:[{url:variantUrl,bitrate:500,content_type:'video/mp4'}]}}));
    const ignored=new Response(JSON.stringify({video_info:{variants:[{url:variantUrl,content_type:'video/mp4'}]}}));
    const fetch=vi.fn(async (url:string)=>url===metadataUrl?metadata:ignored);
    const page=Object.assign(new EventTarget(),{fetch,postMessage});const dom=new EventTarget();
    class PageXhr extends EventTarget {open() {} send() {}}
    const open=PageXhr.prototype.open,send=PageXhr.prototype.send;
    vi.stubGlobal('window',page);vi.stubGlobal('document',dom);vi.stubGlobal('location',location);vi.stubGlobal('XMLHttpRequest',PageXhr);
    const dispose=startXVideoBridgeApp();
    try {
        expect(await page.fetch(metadataUrl)).toBe(metadata);
        await vi.waitFor(()=>expect(postMessage).toHaveBeenCalledTimes(1));
        const [payload,origin]=postMessage.mock.calls[0];
        expect(origin).toBe('https://x.com');
        expect(payload).toEqual({source:'fluent-read',type:'fluent-read-x-video-media-resources',url:'https://x.com/i/api/graphql/hash/TweetDetail',responseText:JSON.stringify([{url:variantUrl,bitrate:500}]),pageHref});
        expect(JSON.stringify(payload)).not.toContain('private');expect(metadata.bodyUsed).toBe(false);
        await page.fetch('https://example.com/i/api/graphql/hash/TweetDetail');
        await new Promise(resolve=>setTimeout(resolve,0));expect(postMessage).toHaveBeenCalledTimes(1);
        dom.dispatchEvent(new Event(YOUTUBE_BRIDGE_REPLAY_EVENT));expect(postMessage).toHaveBeenCalledTimes(2);
        location.href='https://x.com/example/status/456';dom.dispatchEvent(new Event(YOUTUBE_BRIDGE_REPLAY_EVENT));expect(postMessage).toHaveBeenCalledTimes(2);
        dom.dispatchEvent(new Event(YOUTUBE_BRIDGE_DISPOSE_EVENT));expect(page.fetch).toBe(fetch);expect(PageXhr.prototype.open).toBe(open);expect(PageXhr.prototype.send).toBe(send);
        dom.dispatchEvent(new Event(YOUTUBE_BRIDGE_ENABLE_EVENT));expect(page.fetch).not.toBe(fetch);
    } finally {dispose();dom.dispatchEvent(new Event(YOUTUBE_BRIDGE_DISPOSE_EVENT));}
    expect(page.fetch).toBe(fetch);expect(PageXhr.prototype.open).toBe(open);expect(PageXhr.prototype.send).toBe(send);
});

it('decodes bounded XHR subtitle buffers and leaves oversized fetch bodies untouched', async () => {
    const postMessage=vi.fn(), oversized=new Response('x'.repeat(2_000_001),{headers:{'content-length':'2000001'}});const fetch=vi.fn(async(_url:string)=>oversized);
    const clone=vi.spyOn(oversized,'clone');
    const page=Object.assign(new EventTarget(),{fetch,postMessage});const dom=new EventTarget();
    class PageXhr extends EventTarget {
        response=new TextEncoder().encode('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nCaption').buffer;
        get responseText():string {throw new Error('not text');}
        open(_method:string,_url:string) {} send() {this.dispatchEvent(new Event('load'));}
    }
    vi.stubGlobal('window',page);vi.stubGlobal('document',dom);vi.stubGlobal('location',{href:pageHref,origin:'https://x.com'});vi.stubGlobal('XMLHttpRequest',PageXhr);
    const dispose=startXVideoBridgeApp();
    try {
        const xhr=new PageXhr();xhr.open('GET',subtitleUrl);xhr.send();
        expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({type:'fluent-read-x-video-subtitle-resource',url:subtitleUrl,responseText:expect.stringContaining('WEBVTT'),pageHref}),'https://x.com');
        postMessage.mockClear();expect(await page.fetch(subtitleUrl)).toBe(oversized);
        expect(clone).toHaveBeenCalledOnce();await new Promise(resolve=>setTimeout(resolve,0));
        expect(postMessage).not.toHaveBeenCalled();expect(oversized.bodyUsed).toBe(false);
    } finally {dispose();}
});

it('does not publish a late X response after SPA navigation or bridge disposal', async () => {
    const releases:Array<(value:Response)=>void>=[],postMessage=vi.fn();
    const fetch=vi.fn((_url:string)=>new Promise<Response>(resolve=>{releases.push(resolve);}));
    const page=Object.assign(new EventTarget(),{fetch,postMessage});const dom=new EventTarget();
    const location={href:pageHref,origin:'https://x.com'};
    class PageXhr extends EventTarget {open() {} send() {}}
    vi.stubGlobal('window',page);vi.stubGlobal('document',dom);vi.stubGlobal('location',location);vi.stubGlobal('XMLHttpRequest',PageXhr);
    const dispose=startXVideoBridgeApp();
    try {
        const first=page.fetch(metadataUrl);location.href='https://x.com/example/status/456';
        const response=()=>new Response(JSON.stringify({video_info:{variants:[{url:variantUrl,content_type:'video/mp4'}]}}));
        releases[0](response());await first;
        const second=page.fetch(metadataUrl);dispose();releases[1](response());await second;
        await new Promise(resolve=>setTimeout(resolve,0));expect(postMessage).not.toHaveBeenCalled();
    } finally {dispose();}
    expect(page.fetch).toBe(fetch);
});


it('bounds a multibyte subtitle response without Content-Length while preserving the host response', async () => {
    const postMessage = vi.fn();
    const body = 'WEBVTT\n\n' + '字'.repeat(666_667);
    expect(body.length).toBeLessThan(1_000_000);
    expect(new TextEncoder().encode(body).length).toBeGreaterThan(2_000_000);
    const response = new Response(body);
    let markReadComplete!: () => void;
    const readComplete = new Promise<void>(resolve => { markReadComplete = resolve; });
    const clone = response.clone.bind(response);
    vi.spyOn(response, 'clone').mockImplementation(() => {
        const copy = clone();
        const reader = copy.body!.getReader();
        const cancel = reader.cancel.bind(reader);
        vi.spyOn(reader, 'cancel').mockImplementation(() => {
            markReadComplete();
            return cancel();
        });
        vi.spyOn(copy.body!, 'getReader').mockReturnValue(reader);
        return copy;
    });
    expect(response.headers.get('content-length')).toBeNull();
    const validBody = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n字幕';
    const fetch = vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce(new Response(validBody));
    const page = Object.assign(new EventTarget(), {fetch, postMessage});
    const dom = new EventTarget();
    class PageXhr extends EventTarget {open() {} send() {}}
    vi.stubGlobal('window', page); vi.stubGlobal('document', dom);
    vi.stubGlobal('location', {href: pageHref, origin: 'https://x.com'});
    vi.stubGlobal('XMLHttpRequest', PageXhr);
    const dispose = startXVideoBridgeApp();
    try {
        const original = await page.fetch(subtitleUrl);
        expect(original).toBe(response);
        // 等待克隆流被取消；不等待 tee 的取消 promise（它会等原流消费）。
        await readComplete;
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(postMessage).not.toHaveBeenCalled();
        expect(original.bodyUsed).toBe(false);
        expect(await original.text()).toBe(body);
        await page.fetch(subtitleUrl);
        await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(
            expect.objectContaining({type: 'fluent-read-x-video-subtitle-resource', responseText: validBody}),
            'https://x.com',
        ));
    } finally { dispose(); }
});
