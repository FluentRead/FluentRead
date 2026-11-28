import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {composeMangaPage} from '@/src/features/image-translation/content/mangaCompositor';
const draw=vi.fn(),clear=vi.fn(),decode=vi.fn();let canvas:{width:number;height:number;getContext:ReturnType<typeof vi.fn>};
const source={} as HTMLImageElement;
const page={width:400,height:300,patches:[{x:10,y:20,width:50,height:30,bytes:new Uint8Array([1])}],lines:[]};
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
beforeEach(()=>{vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});vi.resetAllMocks();canvas={width:0,height:0,getContext:vi.fn(()=>({drawImage:draw,clearRect:clear}))};vi.stubGlobal('document',{createElement:()=>canvas});vi.stubGlobal('createImageBitmap',decode);});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
describe('直接合成漫画画布的生命周期',()=>{
    it('绘制原图及局部结果并立即关闭解码位图，不进行 PNG 再编码',async()=>{
        const bitmap={width:50,height:30,close:vi.fn()};decode.mockResolvedValue(bitmap);
        const c=await composeMangaPage(source,page,new AbortController().signal);expect(c).toBe(canvas);expect([c.width,c.height]).toEqual([400,300]);
        expect(draw.mock.calls).toEqual([[source,0,0,400,300],[bitmap,10,20]]);expect(bitmap.close).toHaveBeenCalledOnce();expect(decode.mock.calls[0][0].size).toBe(1);expect(vi.getTimerCount()).toBe(0);
        expect(clear).toHaveBeenCalledOnce();expect(clear).toHaveBeenCalledWith(10,20,50,30);
        expect(clear.mock.invocationCallOrder[0]).toBeGreaterThan(draw.mock.invocationCallOrder[0]);
        expect(clear.mock.invocationCallOrder[0]).toBeLessThan(draw.mock.invocationCallOrder[1]);
    });
    it('无图块仍可合成原图，不启动任何解码或清除原图',async()=>{await composeMangaPage(source,{...page,patches:[]},new AbortController().signal);expect(decode).not.toHaveBeenCalled();expect(clear).not.toHaveBeenCalled();});
    it('预取消不绘图，清理画布',async()=>{const c=new AbortController();c.abort();await expect(composeMangaPage(source,page,c.signal)).rejects.toMatchObject({name:'AbortError'});expect(draw).not.toHaveBeenCalled();expect(canvas.width).toBe(0);});
    it('浏览器缺少 Canvas 时释放画布',async()=>{canvas.getContext.mockReturnValue(null);await expect(composeMangaPage(source,page,new AbortController().signal)).rejects.toThrow('不支持');expect(canvas.height).toBe(0);});
    it.each(['sync','reject','wrong-width','wrong-height','clear','draw'] as const)('失败释放图块和画布：%s',async mode=>{
        const bitmap={width:mode==='wrong-width'?1:50,height:mode==='wrong-height'?1:30,close:vi.fn()};
        if(mode==='sync')decode.mockImplementation(()=>{throw new Error('decode');});else if(mode==='reject')decode.mockRejectedValue(new Error('decode'));else decode.mockResolvedValue(bitmap);
        if(mode==='draw')draw.mockImplementationOnce(()=>undefined).mockImplementationOnce(()=>{throw new Error('draw');});
        if(mode==='clear')clear.mockImplementationOnce(()=>{throw new Error('clear');});
        await expect(composeMangaPage(source,page,new AbortController().signal)).rejects.toThrow();expect(canvas.width).toBe(0);
        if(!['sync','reject'].includes(mode))expect(bitmap.close).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
    });
    it.each(['abort','timeout','late-reject'] as const)('解码等待停止后关闭迟到位图，无迟到结果：%s',async mode=>{
        let resolve!:(v:unknown)=>void,reject!:(e:Error)=>void;decode.mockReturnValue(new Promise((yes,no)=>{resolve=yes;reject=no;}));
        const c=new AbortController(),task=composeMangaPage(source,page,c.signal);const failure=expect(task).rejects.toThrow();await flush();
        if(mode==='timeout')vi.advanceTimersByTime(15000);else c.abort();await failure;
        const bitmap={width:50,height:30,close:vi.fn()};if(mode==='late-reject')reject(new Error('late'));else resolve(bitmap);await flush();
        if(mode!=='late-reject')expect(bitmap.close).toHaveBeenCalledOnce();expect(canvas.width).toBe(0);expect(vi.getTimerCount()).toBe(0);
    });
    it('解码完成同一微任务取消时也关闭位图',async()=>{
        const c=new AbortController(),bitmap={width:50,height:30,close:vi.fn()};decode.mockImplementation(()=>Promise.resolve(bitmap).then(v=>{queueMicrotask(()=>c.abort());return v;}));
        await expect(composeMangaPage(source,page,c.signal)).rejects.toMatchObject({name:'AbortError'});expect(bitmap.close).toHaveBeenCalledOnce();
    });
    it('多个图块共用十五秒整页预算，前块耗时不能给后块重新发放完整预算', async () => {
        let first!: (value: any) => void, second!: (value: any) => void;
        decode.mockReturnValueOnce(new Promise(resolve => {first = resolve;})).mockReturnValueOnce(new Promise(resolve => {second = resolve;}));
        let outcome: string | undefined;
        const task = composeMangaPage(source, {...page, patches: [page.patches[0], page.patches[0]]}, new AbortController().signal);
        const settled = task.then(() => {outcome = 'success';}, error => {outcome = error.message;});
        const initial = {width: 50, height: 30, close: vi.fn()}; vi.advanceTimersByTime(9000); first(initial); await flush();
        expect(decode).toHaveBeenCalledTimes(2); vi.advanceTimersByTime(6000); await flush(); const atDeadline = outcome;
        const late = {width: 50, height: 30, close: vi.fn()}; second(late); await settled; await flush();
        expect(atDeadline).toBe('译图加载超时'); expect(initial.close).toHaveBeenCalledOnce(); expect(late.close).toHaveBeenCalledOnce();
        expect(canvas).toMatchObject({width: 0, height: 0}); expect(vi.getTimerCount()).toBe(0);
    });
    it.each(['source', 'patch'] as const)('%s 绘制耗尽整页预算后不成功交付，也不启动超出并发窗的后续图块', async stage => {
        const bitmaps = Array.from({length: 5}, () => ({width: 50, height: 30, close: vi.fn()}));
        let next = 0;
        decode.mockImplementation(() => Promise.resolve(bitmaps[next++]));
        if (stage === 'source') draw.mockImplementationOnce(() => {vi.advanceTimersByTime(15000);});
        else draw.mockImplementationOnce(() => undefined).mockImplementationOnce(() => {vi.advanceTimersByTime(15000);});
        await expect(composeMangaPage(source, {...page, patches: Array(5).fill(page.patches[0])}, new AbortController().signal)).rejects.toThrow('译图加载超时');
        expect(decode).toHaveBeenCalledTimes(stage === 'source' ? 0 : 4);
        if (stage === 'patch') {
            for (let i = 0; i < 4; i++) expect(bitmaps[i].close).toHaveBeenCalledOnce();
            expect(bitmaps[4].close).not.toHaveBeenCalled();
        }
        expect(canvas).toMatchObject({width: 0, height: 0}); expect(vi.getTimerCount()).toBe(0);
    });
    it('按最多 4 路并发预解码图块并严格保持确定绘制顺序，靠前块失败关闭同窗已解码和迟到位图', async () => {
        const patches = Array.from({length: 6}, (_, index) => ({x: index * 10, y: 0, width: 50, height: 30, bytes: new Uint8Array([index + 1])}));
        const resolvers: Array<(value: unknown) => void> = [];
        decode.mockImplementation(() => new Promise(resolve => { resolvers.push(resolve); }));
        const task = composeMangaPage(source, {...page, patches}, new AbortController().signal);
        await flush();
        expect(decode).toHaveBeenCalledTimes(4);
        const bitmaps = patches.map((_, index) => ({id: index, width: 50, height: 30, close: vi.fn()}));
        // 故意乱序完成解码：3 -> 1 -> 0 -> 2，绘制顺序仍必须严格为 0, 1, 2, 3, 4, 5。
        resolvers[3](bitmaps[3]); resolvers[1](bitmaps[1]); await flush();
        expect(draw).toHaveBeenCalledTimes(1);
        resolvers[0](bitmaps[0]); await flush();
        // 0 与已预解码就绪的 1 连续绘制完成，滑动窗口立即补充解码第 4、5 块。
        expect(draw).toHaveBeenCalledTimes(3);
        expect(decode).toHaveBeenCalledTimes(6);
        resolvers[2](bitmaps[2]); resolvers[4](bitmaps[4]); resolvers[5](bitmaps[5]);
        await expect(task).resolves.toBe(canvas);
        expect(draw.mock.calls.slice(1).map(([bmp]) => (bmp as {id: number}).id)).toEqual([0, 1, 2, 3, 4, 5]);
        for (const bmp of bitmaps) expect(bmp.close).toHaveBeenCalledOnce();

        // 第 0 块尺寸错误时，已先解码完成的第 1 块与迟到的第 2 块均须关闭。
        decode.mockReset(); draw.mockReset(); clear.mockReset();
        const failResolvers: Array<(value: unknown) => void> = [];
        decode.mockImplementation(() => new Promise(resolve => { failResolvers.push(resolve); }));
        const failed = composeMangaPage(source, {...page, patches: patches.slice(0, 3)}, new AbortController().signal);
        const checked = expect(failed).rejects.toThrow('漫画译图数据无效');
        await flush();
        const bad0 = {width: 1, height: 30, close: vi.fn()};
        const ready1 = {width: 50, height: 30, close: vi.fn()};
        const late2 = {width: 50, height: 30, close: vi.fn()};
        failResolvers[1](ready1); await flush();
        failResolvers[0](bad0); await checked;
        failResolvers[2](late2); await flush();
        expect(bad0.close).toHaveBeenCalledOnce();
        expect(ready1.close).toHaveBeenCalledOnce();
        expect(late2.close).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });
    it.each(['source-only', 'last-patch'] as const)('最后的 %s 绘制耗尽预算也不能交付', async stage => {
        const bitmap = {width: 50, height: 30, close: vi.fn()}; decode.mockResolvedValue(bitmap);
        if (stage === 'source-only') draw.mockImplementationOnce(() => {vi.advanceTimersByTime(15000);});
        else draw.mockImplementationOnce(() => undefined).mockImplementationOnce(() => {vi.advanceTimersByTime(15000);});
        await expect(composeMangaPage(source, {...page, patches: stage === 'source-only' ? [] : page.patches}, new AbortController().signal)).rejects.toThrow('译图加载超时');
        expect(decode).toHaveBeenCalledTimes(stage === 'source-only' ? 0 : 1);
        if (stage === 'last-patch') expect(bitmap.close).toHaveBeenCalledOnce();
        expect(canvas).toMatchObject({width: 0, height: 0}); expect(vi.getTimerCount()).toBe(0);
    });
    it('在整页截止前完成成功，后续独立调用拥有自己的预算', async () => {
        const bitmap = {width: 50, height: 30, close: vi.fn()};
        decode.mockImplementation(() => new Promise(resolve => {setTimeout(() => resolve(bitmap), 14999);}));
        for (let i = 0; i < 2; i++) {
            const task = composeMangaPage(source, page, new AbortController().signal); vi.advanceTimersByTime(14999);
            await expect(task).resolves.toBe(canvas); expect(vi.getTimerCount()).toBe(0);
        }
        expect(bitmap.close).toHaveBeenCalledTimes(2); expect(decode).toHaveBeenCalledTimes(2);
    });
    it.each([0,24,128,255])('最终图块 alpha=%i 完整替换旧像素，透明孔洞和矩形外原画不累积',async alpha=>{
        const original=new Uint8ClampedArray(6*5*4);
        for(let i=0;i<original.length;i+=4)original.set([13+i%200,40,90,160],i);
        const before=original.slice(),surface=new Uint8ClampedArray(original.length);
        const final=new Uint8ClampedArray([200,80,30,alpha,0,0,0,0,1,200,90,255,15,25,35,64]);
        const bitmap={width:2,height:2,close:vi.fn(),pixels:final};
        clear.mockImplementation((x,y,w,h)=>{for(let row=y;row<y+h;row++)for(let col=x;col<x+w;col++)surface.fill(0,(row*6+col)*4,(row*6+col+1)*4);});
        draw.mockImplementation((image:unknown,x:number,y:number)=>{
            if(image===source){surface.set(original);return;}
            for(let row=0;row<2;row++)for(let col=0;col<2;col++){
                const from=(row*2+col)*4,to=((row+y)*6+col+x)*4;
                // 明确模拟默认 source-over；没有先清空时，透明孔洞会留下原图。
                const a=final[from+3]/255,b=surface[to+3]/255,out=a+b*(1-a);
                for(let c=0;c<3;c++)surface[to+c]=out?Math.round((final[from+c]*a+surface[to+c]*b*(1-a))/out):0;
                surface[to+3]=Math.round(out*255);
            }
        });
        decode.mockResolvedValue(bitmap);
        const packet={width:6,height:5,patches:[{x:2,y:1,width:2,height:2,bytes:new Uint8Array([1])}],lines:[]};
        for(let attempt=0;attempt<2;attempt++){
            await composeMangaPage(source,packet,new AbortController().signal);
            for(let y=0;y<5;y++)for(let x=0;x<6;x++){
                const offset=(y*6+x)*4;
                if(x>=2&&x<4&&y>=1&&y<3){
                    const at=((y-1)*2+x-2)*4,expected=final.slice(at,at+4);
                    if(expected[3]===0)expected.fill(0);
                    expect(surface.slice(offset,offset+4)).toEqual(expected);
                }else expect(surface.slice(offset,offset+4)).toEqual(before.slice(offset,offset+4));
            }
        }
        expect(original).toEqual(before);expect(bitmap.close).toHaveBeenCalledTimes(2);
    });
});
