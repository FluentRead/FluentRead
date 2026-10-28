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
    it('数字附近无法绘制时在对应译文显示原因，复制仍只包含文字', async () => {
        reader.setLines([{sourceText:'Close',text:'近',renderSkipped:true},{sourceText:'90%',text:'90%'}]);
        reader.open();
        expect(body().querySelector('.fr-image-reader-note')?.textContent).toBe('为保护数字，此译文未绘制到图片');
        expect(body().querySelectorAll('.fr-image-reader-note')).toHaveLength(1);
        event(copy());await Promise.resolve();
        expect(writeText).toHaveBeenLastCalledWith('近\n\n90%');
    });
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
    it.each(['replace','close','hide','dispose'])('复制异步返回后不覆盖已经%s的阅读面板', async action => {
        let complete!: () => void;
        writeText.mockImplementationOnce(() => new Promise<void>(resolve => {complete = resolve;}));
        reader.setLines([{text:'旧结果'}]);reader.open();event(copy());
        if(action==='replace') reader.setLines([{text:'新结果'}]);
        else if(action==='close') reader.close();
        else if(action==='hide') reader.element.hidden=true;
        else reader.dispose();
        complete();await Promise.resolve();expect(feedback().textContent).not.toBe('已复制');
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
