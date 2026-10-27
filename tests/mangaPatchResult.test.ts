import {describe, it, expect, vi} from 'vitest';
import {parseMangaPatchPacket, mangaPatchRects, mangaMaskBoxes, mangaMaskBoxIntersects, compressMangaPage, createMangaLightCache} from '@/src/features/image-translation/mangaPatchResult';
import {normalizeMangaCachePages, mangaCachePixelBudget} from '@/src/core/config/manga';
const region = (x0=10,y0=10,x1=20,y1=20,fontSize=10) => ({text:'Hello',bbox:{x0,y0,x1,y1},fontSize});
const packet = () => ({width:100,height:100,patches:[{x:1,y:2,width:10,height:20,image:'data:image/png;base64,AQID'}]});
const lines = [{text:'译文',sourceText:'Hello',bbox:{x0:1,y0:2,x1:11,y1:22},backgroundColor:'transparent'}];
describe('漫画局部结果与有界轻量缓存',()=>{
    it('容量淘汰通知抛错不阻止新缓存或破坏上限',()=>{
        const page=compressMangaPage(packet(),lines),evicted=vi.fn(()=>{throw Error('observer failure');});
        const cache=createMangaLightCache(1,10000,evicted);expect(cache.put('a',page)).toBe(true);
        expect(cache.put('b',page)).toBe(true);expect(evicted).toHaveBeenCalledWith('a',page);
        expect(cache.get('a')).toBeUndefined();expect(cache.get('b')).toBe(page);expect(cache.stats().pages).toBe(1);
    });
    it.each([[undefined,12],[null,12],[NaN,12],[Infinity,12],['6',12],[0,1],[-2,1],[25,24],[3.9,3],[12,12]])('规范化快速容量 %s', (input,expected)=>{
        expect(normalizeMangaCachePages(input)).toBe(expected);expect(mangaCachePixelBudget(input)).toBe(Number(expected)*2_000_000);
    });
    it('描边余量与源行蒙版一致，夹紧边缘且字号余量有上限',()=>{
        expect(mangaMaskBoxes(region(-1,-1,20,20,1000),25,25)).toEqual([{x0:0,y0:0,x1:25,y1:25}]);
        expect(mangaMaskBoxes({...region(),sourceBoxes:[{x0:1.2,y0:2.3,x1:8.1,y1:9.1}]},100,100)).toEqual([{x0:0,y0:0,x1:11,y1:12}]);
    });
    it('不分配蒙版的相交判断与原蒙版一致，包括小数、边缘、越界和紧贴',()=>{
        const boxes=[{x0:-2.1,y0:-1,x1:2.2,y1:3.4},{x0:10.2,y0:20.2,x1:19.1,y1:30.9},{x0:95,y0:95,x1:105,y1:105}];
        const targets=[{x0:0,y0:0,x1:1,y1:1},{x0:0,y0:10,x1:5,y1:20},{x0:22,y0:20,x1:25,y1:35},{x0:98,y0:98,x1:100,y1:100}];
        for(const source of boxes)for(const target of targets)for(const fontSize of [0,10,1000]){
            const region={text:'text',bbox:source,fontSize},mask=mangaMaskBoxes(region,100,100)[0];
            const expected=mask.x0<target.x1&&target.x0<mask.x1&&mask.y0<target.y1&&target.y0<mask.y1;
            expect(mangaMaskBoxIntersects(source,fontSize,100,100,target)).toBe(expected);
        }
    });
    it('合并链式重叠并保留独立区域，包含整段译文和框外描边',()=>{
        const a=region(5,5,15,15), b=region(35,5,45,15), bridge=region(14,5,36,15), far=region(80,80,90,90);
        expect(mangaPatchRects([a,b,bridge,far,region(120,120,130,130)],100,100)).toEqual([{x:3,y:3,width:44,height:14},{x:78,y:78,width:14,height:14}]);
        expect(mangaPatchRects([{...region(0,0,80,80),sourceBoxes:[{x0:20,y0:20,x1:30,y1:30}]}],100,100)).toEqual([{x:0,y:0,width:80,height:80}]);
    });
    it('超过消息图块上限的密集页面仍完整覆盖，不丢字或生成超限响应',()=>{
        const regions=Array.from({length:300},(_,i)=>region(i%30*10+4,Math.floor(i/30)*10+4,i%30*10+6,Math.floor(i/30)*10+6));
        const rects=mangaPatchRects(regions,320,120);expect(rects.length).toBeLessThanOrEqual(256);
        for(const r of regions)for(const b of mangaMaskBoxes(r,320,120))expect(rects.some(p=>p.x<=b.x0&&p.y<=b.y0&&p.x+p.width>=b.x1&&p.y+p.height>=b.y1)).toBe(true);
        expect(()=>parseMangaPatchPacket({width:320,height:120,patches:rects.map(p=>({...p,image:'data:image/png;base64,AQID'}))})).not.toThrow();
    });
    it('极小检测框也覆盖绘字的最小内框，避免恢复丢像素',()=>{
        expect(mangaPatchRects([region(10,10,11,11)],100,100)).toEqual([{x:8,y:8,width:6,height:6}]);
    });
    it('超多源框归约边界不展开函数参数，保留整段与边缘蒙版且不修改输入', () => {
        const sourceBoxes = Array.from({length: 150_000}, (_, index) => ({x0: index % 100 + 20, y0: index % 50 + 30, x1: index % 100 + 24, y1: index % 50 + 36}));
        const pageRegion = {...region(10, 10, 180, 100), sourceBoxes};
        expect(mangaPatchRects([pageRegion], 200, 150)).toEqual([{x: 10, y: 10, width: 170, height: 90}]);
        expect(sourceBoxes).toHaveLength(150_000); expect(sourceBoxes[0]).toEqual({x0: 20, y0: 30, x1: 24, y1: 36});
        expect(pageRegion.bbox).toEqual({x0: 10, y0: 10, x1: 180, y1: 100});
    });
    it('接受空白页和有效结果，base64 立即转成紧凑二进制',()=>{
        expect(parseMangaPatchPacket({width:1,height:1,patches:[]})).toEqual({width:1,height:1,patches:[]});
        const p=parseMangaPatchPacket(packet());const page=compressMangaPage(p,lines);
        expect(page.patches[0].bytes).toEqual(new Uint8Array([1,2,3]));expect(page.patches[0]).not.toHaveProperty('image');expect(page.lines).toBe(lines);
        for(const data of ['AQ==','AQI=']) expect(parseMangaPatchPacket({...p,patches:[{...p.patches[0],image:'data:image/png;base64,'+data}]})).toBeTruthy();
    });
    it.each([null,{}, {width:0,height:1,patches:[]},{width:1.1,height:1,patches:[]},{width:8193,height:1,patches:[]},
        {width:8192,height:8192,patches:[]},{width:1,height:1,patches:null},{width:100,height:100,patches:Array(257).fill(null)}])('拒绝无效页面尺寸和数量 %j',value=>expect(()=>parseMangaPatchPacket(value)).toThrow('无效'));
    it.each([null,{x:-1},{y:-1},{width:0},{height:0},{x:.5},{width:101},{height:101},{image:5},{image:'https://example.test/a.png'},{image:'data:image/png;base64,A'}])('拒绝无效图块 %j',patch=>{
        const p=packet();p.patches=[patch===null?null as never:{...p.patches[0],...patch} as never];expect(()=>parseMangaPatchPacket(p)).toThrow('无效');
    });
    it('总解码像素受限，即使多块重叠也不能重复占用无限资源',()=>{
        const patch={x:0,y:0,width:4096,height:4096,image:'data:image/png;base64,AQID'};
        expect(()=>parseMangaPatchPacket({width:4096,height:4096,patches:[patch,patch]})).toThrow('无效');
    });
    it('总压缩数据受限，拒绝超大消息',()=>{
        const p=packet();p.patches[0].image='data:image/png;base64,'+'AAAA'.repeat(Math.ceil(64*1024*1024/3)+1);
        expect(()=>parseMangaPatchPacket(p)).toThrow('无效');
    });
    it('张数 LRU 和精确字节预算都生效，删除、覆盖与清空归还计数',()=>{
        const page=compressMangaPage(packet(),lines),cache=createMangaLightCache(2,10000);
        expect(cache.get('missing')).toBeUndefined();expect(cache.put('a',page)).toBe(true);const one=cache.stats().bytes;
        cache.put('b',page);expect(cache.stats()).toEqual({pages:2,bytes:one*2});cache.get('a');cache.put('c',page);
        expect(cache.get('b')).toBeUndefined();expect(cache.get('a')).toBe(page);cache.put('a',page);expect(cache.stats().bytes).toBe(one*2);
        cache.remove('a');cache.remove('missing');expect(cache.stats()).toEqual({pages:1,bytes:one});cache.clear();expect(cache.stats()).toEqual({pages:0,bytes:0});
        const limited=createMangaLightCache(100,one*2-1);limited.put('a',page);limited.put('b',page);expect(limited.get('a')).toBeUndefined();expect(limited.stats().bytes).toBe(one);
        expect(createMangaLightCache(100,one-1).put('a',page)).toBe(false);expect(createMangaLightCache(0).put('a',page)).toBe(false);
        expect(createMangaLightCache().put('a',page)).toBe(true);
    });
});
