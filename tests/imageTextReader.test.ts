import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {createImageTextReader} from '@/src/features/image-translation/content/textReader';

let reader: ReturnType<typeof createImageTextReader>;
let window: ReturnType<typeof parseHTML>['window'];
const writeText = vi.fn();
const onClose = vi.fn();
function event(target: Element, type = 'click', trusted = true, key = '') {
    const value = new window.Event(type, {bubbles: true, cancelable: true});
    Object.defineProperties(value, {isTrusted: {value: trusted}, key: {value: key}});
    target.dispatchEvent(value);
    return value;
}
const compare = () => reader.element.querySelector('header button')!;
const copy = () => reader.element.querySelector('footer button')!;
const body = () => reader.element.querySelector('.fr-image-reader-body')!;
const feedback = () => reader.element.querySelector('[role=status]')!;
beforeEach(() => {
    vi.useFakeTimers();vi.clearAllMocks();
    const dom = parseHTML('<html><body></body></html>');window = dom.window;
    vi.stubGlobal('document', dom.document);vi.stubGlobal('navigator', {clipboard:{writeText}});
    writeText.mockResolvedValue(undefined);
    reader = createImageTextReader(text => text, onClose);
    dom.document.body.append(reader.element);
});
afterEach(() => {reader.dispose();vi.useRealTimers();vi.unstubAllGlobals();});

describe('图片文字独立阅读面板', () => {
    it('安全呈现原文和译文，切换对照不会把识别内容当 HTML 执行', () => {
        reader.setLines([{sourceText:'<img src=x onerror=evil()>',text:'译文'}, {text:'仅译文'}]);
        expect(reader.element.hidden).toBe(true);
        reader.open();expect(reader.element.hidden).toBe(false);
        expect(body().textContent).toBe('译文仅译文');
        event(compare(), 'click', false);expect(compare().getAttribute('aria-pressed')).toBe('false');
        event(compare());expect(compare().getAttribute('aria-pressed')).toBe('true');
        expect(body().textContent).toContain('<img src=x onerror=evil()>');
        expect(body().querySelector('img')).toBeNull();
        reader.refreshLanguage();expect(body().textContent).toContain('译文');
        event(compare());expect(body().textContent).toBe('译文仅译文');
        reader.setLines([{text:'没有原文'}]);expect((compare() as HTMLElement).hidden).toBe(true);
    });
    it('只复制当前展示模式并提供成功或可手动复制的失败提示', async () => {
        reader.setLines([{sourceText:'Hello',text:'你好'}, {text:'第二段'}]);reader.open();
        event(copy());await Promise.resolve();
        expect(writeText).toHaveBeenLastCalledWith('你好\n\n第二段');
        expect(feedback().textContent).toBe('已复制');
        await vi.advanceTimersByTimeAsync(2500);expect(feedback().textContent).toContain('本地 OCR');
        event(compare());event(copy());await Promise.resolve();
        expect(writeText).toHaveBeenLastCalledWith('Hello\n你好\n\n第二段');
        writeText.mockRejectedValueOnce(new Error('denied'));
        event(copy());await Promise.resolve();expect(feedback().textContent).toContain('手动复制');
    });
    it.each(['old-fails', 'old-succeeds'] as const)('较早复制迟到时不覆盖较新的复制反馈：%s', async outcome => {
        let resolveOld!: () => void, rejectOld!: (error: Error) => void;
        let resolveNew!: () => void, rejectNew!: (error: Error) => void;
        writeText.mockImplementationOnce(() => new Promise<void>((resolve, reject) => {resolveOld = resolve;rejectOld = reject;}));
        writeText.mockImplementationOnce(() => new Promise<void>((resolve, reject) => {resolveNew = resolve;rejectNew = reject;}));
        reader.setLines([{sourceText:'Hello',text:'你好'}]);reader.open();
        event(copy());event(copy());
        if (outcome === 'old-fails') resolveNew();else rejectNew(new Error('new failure'));
        await Promise.resolve();
        const expected = outcome === 'old-fails' ? '已复制' : '复制失败，请选中文字后手动复制';
        expect(feedback().textContent).toBe(expected);
        if (outcome === 'old-fails') rejectOld(new Error('old failure'));else resolveOld();
        await Promise.resolve();expect(feedback().textContent).toBe(expected);
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(2500);expect(feedback().textContent).toContain('本地 OCR');
    });
    it('切换对照后旧复制结果和旧反馈计时器不能覆盖新模式', async () => {
        let finish!: () => void;
        writeText.mockImplementationOnce(() => new Promise<void>(resolve => {finish = resolve;}));
        reader.setLines([{sourceText:'Hello',text:'你好'}]);reader.open();event(copy());
        event(compare());event(compare());finish();await Promise.resolve();
        expect(feedback().textContent).toContain('本地 OCR');expect(vi.getTimerCount()).toBe(0);
        event(compare());
        event(copy());await Promise.resolve();expect(feedback().textContent).toBe('已复制');
        event(compare());expect(feedback().textContent).toContain('本地 OCR');expect(vi.getTimerCount()).toBe(0);
    });
    it('新复制开始时清除旧反馈计时器，结果只保留自己的完整展示时间', async () => {
        let finish!: () => void;
        reader.setLines([{text:'译文'}]);reader.open();event(copy());await Promise.resolve();
        expect(feedback().textContent).toBe('已复制');await vi.advanceTimersByTimeAsync(2000);
        writeText.mockImplementationOnce(() => new Promise<void>(resolve => {finish = resolve;}));
        event(copy());expect(feedback().textContent).toContain('本地 OCR');expect(vi.getTimerCount()).toBe(0);
        finish();await Promise.resolve();await vi.advanceTimersByTimeAsync(500);
        expect(feedback().textContent).toBe('已复制');await vi.advanceTimersByTimeAsync(2000);
        expect(feedback().textContent).toContain('本地 OCR');
    });
    it('复制进行中切换界面语言后，用当前语言显示完成结果', async () => {
        let finish!: () => void;
        let language = 'zh';
        reader.dispose();
        reader = createImageTextReader(text => language === 'en' && text === '已复制' ? 'Copied' : text, onClose);
        document.body.append(reader.element);
        writeText.mockImplementationOnce(() => new Promise<void>(resolve => {finish = resolve;}));
        reader.setLines([{text:'译文'}]);reader.open();event(copy());
        language = 'en';reader.refreshLanguage();finish();await Promise.resolve();
        expect(feedback().textContent).toBe('Copied');
    });
    it('面板内部键盘与滚轮被隔离，Escape 和关闭按钮归还入口焦点', () => {
        reader.open();const host = vi.fn();document.body.addEventListener('wheel', host);
        event(body(), 'wheel');expect(host).not.toHaveBeenCalled();
        event(body(),'keydown',false,'Escape');expect(reader.element.hidden).toBe(false);
        event(body(),'keydown',true,'Enter');expect(reader.element.hidden).toBe(false);
        expect(event(body(),'keydown',true,'Escape').defaultPrevented).toBe(true);
        expect(reader.element.hidden).toBe(true);expect(onClose).toHaveBeenCalledOnce();
        reader.open();event(reader.element.querySelectorAll('header button')[1]);
        expect(onClose).toHaveBeenCalledTimes(2);
    });
    it.each([
        ['replace', 'resolve'], ['replace', 'reject'], ['close', 'resolve'], ['close', 'reject'],
        ['hide', 'resolve'], ['hide', 'reject'], ['dispose', 'resolve'], ['dispose', 'reject'],
    ] as const)('复制异步 %s 后迟到 %s 不覆盖阅读面板', async (action, outcome) => {
        let complete!: () => void;
        let fail!: (error: Error) => void;
        writeText.mockImplementationOnce(() => new Promise<void>((resolve, reject) => {complete = resolve;fail = reject;}));
        reader.setLines([{text:'旧结果'}]);reader.open();event(copy());
        if(action==='replace') reader.setLines([{text:'新结果'}]);
        else if(action==='close') reader.close();
        else if(action==='hide') reader.element.hidden=true;
        else reader.dispose();
        if (outcome === 'resolve') complete();else fail(new Error('late failure'));
        await Promise.resolve();expect(feedback().textContent).toContain('本地 OCR');
        expect(vi.getTimerCount()).toBe(0);
    });
    it('卸载后即使收到保留的可信回调也不再执行动作', () => {
        reader.dispose();
        const callbacks: EventListener[]=[];
        const create=document.createElement.bind(document);
        vi.spyOn(document,'createElement').mockImplementation(tag=>{
            const node=create(tag);const add=node.addEventListener.bind(node);
            node.addEventListener=((type:string,callback:EventListener,options?:any)=>{if(type==='click')callbacks.push(callback);add(type,callback,options);}) as typeof node.addEventListener;
            return node;
        });
        reader=createImageTextReader(text=>text,onClose);const target=reader.element.querySelector('header button')!;
        reader.dispose();callbacks[0]({isTrusted:true,target,stopPropagation:vi.fn()} as unknown as Event);
        expect(target.getAttribute('aria-pressed')).toBe('false');expect(onClose).not.toHaveBeenCalled();
    });
});

it('对照与复制不重复相同结果，混合结果仍展示正常译文', async () => {
    reader.setLines([{sourceText: 'Café', text: 'Cafe\u0301'}, {sourceText: 'Read every day', text: '每天阅读'}]);
    reader.open(); event(compare());
    expect(body().querySelectorAll('pre')).toHaveLength(3);
    expect(body().textContent).toBe('CaféRead every day每天阅读');
    event(copy()); await Promise.resolve();
    expect(writeText).toHaveBeenLastCalledWith('Café\n\nRead every day\n每天阅读');
    reader.setLines([{sourceText: 'Hello world', text: ' Hello  world '}]);
    expect((compare() as HTMLElement).hidden).toBe(true);
    expect(body().querySelectorAll('pre')).toHaveLength(1);
    expect(body().textContent).toBe('Hello world');
});
