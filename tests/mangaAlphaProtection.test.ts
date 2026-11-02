import {afterEach,describe,expect,it,vi} from 'vitest';
import {ImageAlphaProtectionUnavailableError,MangaAlphaProtectionLimitError,isMangaAlphaProtected,isTrustedMangaAlphaRectangles,mangaAlphaClearRects,planMangaAlphaProtection,planMaskAlphaProtection,type MangaAlphaProtection} from '@/src/features/image-translation/services/mangaAlphaProtection';
import {imageMaskBoxes,inpaintTextRegions} from '@/src/features/image-translation/services/inpainting';
import {mangaMaskBoxes} from '@/src/features/image-translation/mangaPatchResult';
import type {MangaRegion} from '@/src/features/image-translation/services/mangaRegions';
const region=(bbox={x0:12,y0:12,x1:44,y1:36}):MangaRegion=>({text:'完整译文',fontSize:10,bbox});
function pixels(w=64,h=48,a=255){const p=new Uint8ClampedArray(w*h*4);for(let i=0;i<p.length;i+=4)p.set([211,31,171,a],i);return p;}
function set(p:Uint8ClampedArray,w:number,x:number,y:number,a:number){p[(y*w+x)*4+3]=a;}
afterEach(()=>vi.unstubAllGlobals());
describe('原始低 alpha 的共享保护并集',()=>{
    it('普通图未知外周或触边范围只有实际写足迹全255才可继续；不能把255误当保护孔',()=>{
        const p=pixels(),box={x0:0,y0:12,x1:40,y1:36},boxes=()=>[box],options={requireConfirmedTransparency:true};
        expect(planMaskAlphaProtection(p,64,48,[region()],boxes,options)).toBeUndefined();
        set(p,64,20,20,254);
        expect(()=>planMaskAlphaProtection(p,64,48,[region()],boxes,options)).toThrow(ImageAlphaProtectionUnavailableError);
        set(p,64,20,20,255);box.x0=12;set(p,64,20,11,96);
        expect(planMaskAlphaProtection(p,64,48,[region()],boxes,options)).toBeUndefined();
        set(p,64,20,20,0);
        expect(()=>planMaskAlphaProtection(p,64,48,[region()],boxes,options)).toThrow(ImageAlphaProtectionUnavailableError);
    });
    it('可靠半透明外周仅保护更低alpha，alpha0字底可重绘新glyph而非全图回填',()=>{
        const box={x0:12,y0:12,x1:44,y1:36},boxes=()=>[box],options={requireConfirmedTransparency:true};
        const p=pixels(64,48,128);set(p,64,20,20,96);set(p,64,21,20,0);
        expect(Array.from(planMaskAlphaProtection(p,64,48,[region()],boxes,options)!.runs)).toEqual([20,20,22]);
        const transparent=pixels(64,48,0);set(transparent,64,20,20,255);const before=transparent.slice();
        expect(planMaskAlphaProtection(transparent,64,48,[region()],boxes,options)).toBeUndefined();expect(transparent).toEqual(before);
        expect(planMaskAlphaProtection(transparent,64,48,[region()],()=>[],options)).toBeUndefined();
    });
    it('相邻已确认孔和未知但实际不透明的写区域共用并集，保护不越过边界',()=>{
        const p=pixels(),a=region({x0:12,y0:12,x1:31,y1:36}),b=region({x0:31,y0:12,x1:64,y1:36});set(p,64,30,20,0);
        const plan=planMaskAlphaProtection(p,64,48,[a,b],r=>[r.bbox],{requireConfirmedTransparency:true})!;
        expect(Array.from(plan.runs)).toEqual([20,30,31]);expect(isMangaAlphaProtected(plan,31,20)).toBe(false);
    });
    it('原sourceBoxes和附加真实足迹分别有界，源列表超限在回调前失败',()=>{
        const p=pixels(),r=region(),callback=vi.fn(()=>[r.bbox]),options={requireConfirmedTransparency:true};
        expect(()=>planMaskAlphaProtection(p,64,48,[{...r,sourceBoxes:Array(8193).fill(r.bbox)}],callback,options)).toThrow(MangaAlphaProtectionLimitError);
        expect(callback).not.toHaveBeenCalled();
        expect(()=>planMaskAlphaProtection(p,64,48,[r],()=>Array(8193).fill(r.bbox),options)).toThrow(MangaAlphaProtectionLimitError);
    });
    it.each([{x0:-1,y0:1,x1:3,y1:3},{x0:1.5,y0:1,x1:3,y1:3},{x0:1,y0:1,x1:65,y1:3},{x0:1,y0:1,x1:1,y1:3}])('strict写足迹非法时拒绝，不把无法验证的%s发布为安全',box=>{
        expect(()=>planMaskAlphaProtection(pixels(),64,48,[region()],()=>[box],{requireConfirmedTransparency:true})).toThrow(ImageAlphaProtectionUnavailableError);
    });
    it.each([[0,48],[64,0],[8193,48],[4097,4096],[64,49]])('strict源尺寸/字节不完整 %s×%s 拒绝，旧漫画无效输入契约不变',(width,height)=>{
        const p=pixels();expect(()=>planMaskAlphaProtection(p,width,height,[region()],r=>[r.bbox],{requireConfirmedTransparency:true})).toThrow(ImageAlphaProtectionUnavailableError);
        expect(planMangaAlphaProtection(p,width,height,[region()])).toBeUndefined();
    });
    it('普通图只读自己的原蒙版外周，漫画包装仍按原字号余量拒绝未知外周',()=>{
        const p=pixels(96,64),r={...region({x0:20,y0:20,x1:70,y1:40}),fontSize:30};
        set(p,96,30,30,0);set(p,96,13,13,128);
        expect(planMangaAlphaProtection(p,96,64,[r])).toBeUndefined();
        const plan=planMaskAlphaProtection(p,96,64,[r],imageMaskBoxes)!;
        expect(Array.from(plan.runs)).toEqual([30,30,31]);expect(plan.rectangles).toEqual([{x0:30,y0:30,x1:31,y1:31}]);
    });
    it('保护行段不写不采样，无稀疏RGBA复制，原孔0/96及隐藏色和明确matte均逐字保留',()=>{
        const w=64,h=48,p=pixels(w,h),r=region(),a=(20*w+24)*4,b=(22*w+28)*4;
        p.set([17,53,191,0],a);p.set([255,250,230,96],b);
        const plan=planMaskAlphaProtection(p,w,h,[r,r],imageMaskBoxes)!;
        const original=p.slice(),sizes:number[]=[],Pixels=Uint8ClampedArray;
        vi.stubGlobal('Uint8ClampedArray',class extends Pixels{
            static get [Symbol.species](){return Pixels;}
            constructor(size:number){super(size);sizes.push(size);}
        });
        expect(inpaintTextRegions(p,w,h,[r,r],true,plan)).toBe(p);
        expect(sizes).toEqual([]);expect(p).toEqual(original);
    });
    it('仅生产者冻结的矩形数组可信，另建数组或Proxy不能冒充保护来源',()=>{
        const p=pixels();set(p,64,24,20,0);const plan=planMaskAlphaProtection(p,64,48,[region()],imageMaskBoxes)!;
        expect(isTrustedMangaAlphaRectangles(plan.rectangles)).toBe(true);
        expect(isTrustedMangaAlphaRectangles([...plan.rectangles])).toBe(false);
        expect(isTrustedMangaAlphaRectangles(new Proxy(plan.rectangles,{}))).toBe(false);
    });
    it('alpha0与96逐像素冻结，不修改原RGBA，同行合并而跨连续行合并为无重叠裁剪矩形',()=>{
        const p=pixels(),original=p.slice();for(let y=18;y<22;y++)for(let x=20;x<26;x++)set(p,64,x,y,x<23?0:96);
        const frozen=p.slice(),plan=planMangaAlphaProtection(p,64,48,[region()])!;expect(p).toEqual(frozen);
        expect(plan.rectangles).toEqual([{x0:20,y0:18,x1:26,y1:22}]);expect(Array.from(plan.runs)).toEqual([18,20,26,19,20,26,20,20,26,21,20,26]);
        for(let y=0;y<48;y++)for(let x=0;x<64;x++)expect(isMangaAlphaProtected(plan,x,y)).toBe(x>=20&&x<26&&y>=18&&y<22);
        expect(p.slice(0,(18*64+20)*4)).toEqual(original.slice(0,(18*64+20)*4));expect(isMangaAlphaProtected(undefined,20,18)).toBe(false);
        expect(isMangaAlphaProtected(plan,20,-1)).toBe(false);expect(isMangaAlphaProtected(plan,20,48)).toBe(false);
        p.fill(255);expect(isMangaAlphaProtected(plan,20,18)).toBe(true);
    });
    it('重叠源框取有效阈值最大值，未知外周区域仍不能覆盖其它区域确认的孔',()=>{
        const p=pixels();for(let y=8;y<40;y++)for(let x=8;x<52;x++)set(p,64,x,y,128);
        set(p,64,24,24,96);set(p,64,25,24,200);
        const outer=region({x0:4,y0:4,x1:56,y1:44}),inner=region({x0:16,y0:16,x1:40,y1:32});
        const plan=planMangaAlphaProtection(p,64,48,[inner,outer,{...inner,sourceBoxes:[{x0:0,y0:1,x1:6,y1:5}]}])!;
        expect(isMangaAlphaProtected(plan,24,24)).toBe(true);expect(isMangaAlphaProtected(plan,25,24)).toBe(true);
        expect(plan.rectangles).toEqual([{x0:8,y0:8,x1:52,y1:40}]);
    });
    it('单像素孔在大原框仍被发现，不依赖512模型降采样；重复框不产生XOR空洞',()=>{
        const p=pixels(2048,1024),r=region({x0:8,y0:8,x1:2040,y1:1016});set(p,2048,9,9,96);
        const plan=planMangaAlphaProtection(p,2048,1024,[r,r])!;
        expect(plan.rectangles).toEqual([{x0:9,y0:9,x1:10,y1:10}]);expect(Array.from(plan.runs)).toEqual([9,9,10]);
    });
    it('不完整或不一致外周不推测阈值，合法的零alpha与无孔不分配保护结果',()=>{
        for(const p of [pixels(),pixels(64,48,0)])expect(planMangaAlphaProtection(p,64,48,[region()])).toBeUndefined();
        const p=pixels(64,48,128),r=region(),[b]=mangaMaskBoxes(r,64,48);set(p,64,20,20,0);set(p,64,b.x0-1,b.y0-1,127);
        expect(planMangaAlphaProtection(p,64,48,[r,r])).toBeUndefined();
        expect(planMangaAlphaProtection(p,64,48,[{...r,sourceBoxes:[]},{...r,sourceBoxes:[{x0:0,y0:0,x1:4,y1:4}]}])).toBeUndefined();
        expect(planMangaAlphaProtection(p,64,48,[{...r,sourceBoxes:[{x0:NaN,y0:2,x1:4,y1:4}]}])).toBeUndefined();
        const q=pixels(64,48,128);for(let y=32;y<42;y++)for(let x=30;x<50;x++)set(q,64,x,y,129);
        expect(planMangaAlphaProtection(q,64,48,[{...r,sourceBoxes:[{x0:12,y0:12,x1:20,y1:20},{x0:34,y0:35,x1:44,y1:38}]}])).toBeUndefined();
    });
    it.each([[0,48],[64,0],[8193,1],[8192,8192],[NaN,48]])('非法画布%s×%s与不完整缓冲保持无计划',(w,h)=>{
        expect(planMangaAlphaProtection(pixels(),w,h,[region()])).toBeUndefined();
    });
    it('不完整缓冲拒绝，空区域数组无保护',()=>{
        expect(planMangaAlphaProtection(new Uint8ClampedArray(4),64,48,[region()])).toBeUndefined();expect(planMangaAlphaProtection(pixels(),64,48,[])).toBeUndefined();
    });
    it('多个分离阈值和行段保持排序，间隔与末尾未覆盖行不进入保护',()=>{
        const p=pixels();for(let x=15;x<18;x++)set(p,64,x,20,0);set(p,64,23,20,96);set(p,64,16,22,0);
        const plan=planMangaAlphaProtection(p,64,48,[region()])!;
        expect(Array.from(plan.runs)).toEqual([20,15,18,20,23,24,22,16,17]);expect(isMangaAlphaProtected(plan,20,20)).toBe(false);expect(isMangaAlphaProtected(plan,14,20)).toBe(false);expect(isMangaAlphaProtected(plan,24,20)).toBe(false);
    });
    it('异常矩形数、行段和裁剪碎片在发布计划前显式失败，不截前N条',()=>{
        expect(()=>planMangaAlphaProtection(pixels(),64,48,[{...region(),sourceBoxes:Array(8193).fill(region().bbox)}])).toThrow('过于复杂');
        for(const [w,h] of [[1024,264],[140,140]]){
            const p=pixels(w,h),r=region({x0:4,y0:4,x1:w-4,y1:h-4});
            for(let y=3;y<h-3;y++)for(let x=3;x<w-3;x++)if(x%2===1&&y%2===1)set(p,w,x,y,0);
            expect(()=>planMangaAlphaProtection(p,w,h,[r])).toThrow('过于复杂');
        }
    });
    it('外周与事件预算分别拒绝病态长框集合，不静默发布部分保护计划',()=>{
        const wide=pixels(8192,8),sourceBoxes=Array.from({length:600},(_,i)=>({x0:3+i,y0:3,x1:8189,y1:4}));
        expect(()=>planMangaAlphaProtection(wide,8192,8,[{...region(),sourceBoxes}])).toThrow('过于复杂');
        const tall=pixels(8,4000),overlaps=Array.from({length:1500},(_,i)=>({x0:3,y0:3+i,x1:4,y1:1499+i}));
        expect(()=>planMangaAlphaProtection(tall,8,4000,[{...region(),sourceBoxes:overlaps}])).toThrow('过于复杂');
    });
    it('逐源像素oracle核对100组重叠/薄框/触边与未知外周的全局并集',()=>{
        let seed=712;
        const random=(n:number)=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
        for(let trial=0;trial<100;trial++){
            const w=32,h=24,p=pixels(w,h),rs=Array.from({length:1+random(5)},()=>{const x0=random(23),y0=random(15);return region({x0,y0,x1:x0+1+random(8),y1:y0+1+random(8)});});
            for(let i=0;i<12;i++)set(p,w,random(w),random(h),random(255));
            const expected=new Set<number>();
            for(const r of rs){
                const bs=mangaMaskBoxes(r,w,h);let a:number|undefined,valid=true;
                for(const b of bs){if(b.x0<=0||b.y0<=0||b.x1>=w||b.y1>=h){valid=false;break;}
                    for(let y=b.y0-1;y<=b.y1;y++)for(let x=b.x0-1;x<=b.x1;x++)if(x===b.x0-1||x===b.x1||y===b.y0-1||y===b.y1){const v=p[(y*w+x)*4+3];if(a===undefined)a=v;if(a!==v)valid=false;}}
                if(valid&&a!==undefined&&a>0)for(const b of bs)for(let y=b.y0;y<b.y1;y++)for(let x=b.x0;x<b.x1;x++)if(p[(y*w+x)*4+3]<a)expected.add(y*w+x);
            }
            const plan=planMangaAlphaProtection(p,w,h,rs);
            for(let y=0;y<h;y++)for(let x=0;x<w;x++)expect(isMangaAlphaProtected(plan,x,y)).toBe(expected.has(y*w+x));
            if(plan)for(let y=0;y<h;y++)for(let x=0;x<w;x++)expect(plan.rectangles.filter(b=>x>=b.x0&&x<b.x1&&y>=b.y0&&y<b.y1).length).toBe(expected.has(y*w+x)?1:0);
        }
    });
});
describe('避开保护区的连续完整排版候选',()=>{
    const plan=(rectangles:MangaRegion['bbox'][]):MangaAlphaProtection=>({rectangles,runs:new Uint16Array(),rowStarts:new Uint32Array()});
    const box={x0:0,y0:0,x1:100,y1:32};
    it('保留孔两侧完整高度，不把左右候选截成孔的中间高度',()=>{
        const candidates=mangaAlphaClearRects(plan([{x0:20,y0:7,x1:26,y1:25}]),box);
        expect(candidates).toContainEqual({x0:26,y0:0,x1:100,y1:32});expect(candidates).toContainEqual({x0:0,y0:0,x1:20,y1:32});
        expect(candidates).toHaveLength(4);
    });
    it('边外孔无影响，整框被保护不伪造可用空间；重叠候选只按包含关系去重',()=>{
        expect(mangaAlphaClearRects(plan([{x0:100,y0:0,x1:110,y1:10}]),box)).toEqual([box]);
        expect(mangaAlphaClearRects(plan([box]),box)).toEqual([]);
        const holes=[{x0:20,y0:7,x1:26,y1:25},{x0:40,y0:7,x1:46,y1:25}],candidates=mangaAlphaClearRects(plan(holes),box);
        expect(new Set(candidates.map(b=>JSON.stringify(b))).size).toBe(candidates.length);
        for(const r of candidates)for(const h of holes)expect(r.x1<=h.x0||r.x0>=h.x1||r.y1<=h.y0||r.y0>=h.y1).toBe(true);
    });
    it('后来产生的更大安全矩形移除早期被包含候选，页共享预算耗尽不发布部分结果',()=>{
        const holes=[{x0:40,y0:20,x1:60,y1:40},{x0:70,y0:5,x1:80,y1:10}],bounds={x0:0,y0:0,x1:100,y1:100};
        const budget={remaining:1_000_000},full=mangaAlphaClearRects(plan(holes),bounds,budget),used=1_000_000-budget.remaining;
        expect(full).toContainEqual({x0:80,y0:0,x1:100,y1:100});expect(full).not.toContainEqual({x0:80,y0:0,x1:100,y1:20});
        for(let allowance=0;allowance<used;allowance++)expect(()=>mangaAlphaClearRects(plan(holes),bounds,{remaining:allowance})).toThrow('过于复杂');
        expect(mangaAlphaClearRects(plan(holes),bounds,{remaining:used})).toEqual(full);
        const shared={remaining:used};expect(mangaAlphaClearRects(plan(holes),bounds,shared)).toEqual(full);expect(()=>mangaAlphaClearRects(plan(holes),bounds,shared)).toThrow('过于复杂');
    });
    it('大量对角独立孔的候选碎片超限明确失败，不静默丢弃较大可用矩形',()=>{
        const holes=Array.from({length:100},(_,i)=>({x0:i*9+20,y0:i*9+20,x1:i*9+23,y1:i*9+23}));
        expect(()=>mangaAlphaClearRects(plan(holes),{x0:0,y0:0,x1:1000,y1:1000})).toThrow('过于复杂');
    });
});
