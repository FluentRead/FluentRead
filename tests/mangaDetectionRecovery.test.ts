/** @file tests/mangaDetectionRecovery.test.ts 独立补救的原文/数值保护、双裁图一致性、原子替换、取消和资源边界。 */
import {describe,it,expect,vi} from 'vitest';
import {planMangaDetectionRecovery as plan,recoverMangaDetectionRegions as recover,MANGA_DETECTION_RECOVERY_LIMITS as limits,type MangaDetectionRecoveryPlan as Plan} from '@/src/features/image-translation/services/mangaDetectionRecovery';
import type {MangaDetectionRefinement as Record,MangaDetectionRect as Rect} from '@/src/features/image-translation/services/mangaDetectionRefinement';
import type {MangaOcrItem as Item} from '@/src/features/image-translation/services/mangaRegions';

const bounds=(x0=76,y0=66,x1=180,y1=86):Rect=>({x0,y0,x1,y1});
const item=(text:string,b:Rect,confidence=.99):Item=>({text,confidence,box:{x:b.x0,y:b.y0,width:b.x1-b.x0,height:b.y1-b.y0}});
const parent=bounds(20,20,236,180);
const record=(crop=bounds(),core=bounds(80,70,176,82),p=parent,w=256,h=192):Record=>({core,crop,parent:p,area:576,pageWidth:w,pageHeight:h});
function pixels(w=256,h=192){const data=new Uint8ClampedArray(w*h*4);for(let i=0;i<data.length;i+=4)data.set([245,240,221,255],i);return data;}
function paint(data:Uint8ClampedArray,w:number,b:Rect){for(let y=b.y0;y<b.y1;y++)for(let x=b.x0;x<b.x1;x++)if(x%8<4)data.set([8,20,24,255],(y*w+x)*4);}
function fixture(){const data=pixels(),r=record();paint(data,256,r.core);return {data,r,old:item('O HE C N T',parent,.69)};}
const prepared=(crop=bounds(),parents=[parent]):Plan=>({crop,confirmation:{x0:crop.x0-2,y0:crop.y0-2,x1:crop.x1+2,y1:crop.y1+2},parents});
const local=(crop:Rect,text='CHECK THE SOUTH GATE',confidence=.99)=>item(text,{x0:0,y0:0,x1:crop.x1-crop.x0,y1:crop.y1-crop.y0},confidence);

describe('补救规划只操作当前页未可靠读出的区域',()=>{
    it('保留原文、像素与父框，跨视图同一核心只执行一组双裁图',()=>{
        const f=fixture(),before=f.data.slice(),original=structuredClone(f.old),otherParent=bounds(18,18,238,182);
        const result=plan(f.data,256,192,[f.r,{...f.r,parent:otherParent,crop:bounds(75,65,181,87)}],[f.old],[]);
        expect(result.plans).toEqual([prepared(bounds(),[parent,otherParent])]);expect(result.blockedParents).toEqual([]);expect(f.old).toEqual(original);expect(f.data).toEqual(before);
    });
    it('已可靠识别的父框、其他原文和原数值证据均阻止覆盖',()=>{
        const f=fixture();
        for(const [rows,protectedGroups]of [
            [[{...f.old,confidence:.9}],[]],[[f.old,item('KNOWN',bounds())],[]],[[f.old],[[item('08:45',bounds(),.1)]]],
        ] as Array<[Item[],Item[][]]>){const result=plan(f.data,256,192,[f.r],rows,protectedGroups);expect(result.plans).toEqual([]);expect(result.blockedParents).toEqual(['20,20,236,180']);}
        expect(plan(f.data,256,192,[f.r],[f.old],[[item('08:45',bounds(5,5,15,15))]]).plans).toHaveLength(1);
    });
    it('确认裁图须留在全部原父框内，不能为置信检查越界读取',()=>{
        const f=fixture();expect(plan(f.data,256,192,[{...f.r,parent:f.r.crop}],[],[]).plans).toEqual([]);
    });
    it('墨迹或相邻笔画不完整时拒绝，并可改用同一核心的完整原视图',()=>{
        const f=fixture(),tight=bounds(80,70,176,82);
        expect(plan(f.data,256,192,[{...f.r,crop:tight}],[f.old],[]).plans).toEqual([]);
        expect(plan(f.data,256,192,[{...f.r,crop:tight},f.r],[f.old],[]).plans).toEqual([prepared()]);
        const quiet=pixels();expect(plan(quiet,256,192,[f.r],[f.old],[]).plans).toEqual([]);
        const outside=fixture();outside.data.set([8,20,24,255],(92*256+100)*4);expect(plan(outside.data,256,192,[outside.r],[outside.old],[]).plans).toEqual([]);
    });
    it('未知页、非法框、过多记录或原文、缺失像素均不进入推断',()=>{
        const f=fixture();
        expect(plan(f.data,256,192,[],[],[]).plans).toEqual([]);expect(plan(f.data,256,192,Array(129).fill(f.r),[],[]).plans).toEqual([]);
        for(const [w,h]of [[0,192],[NaN,192],[8193,192],[8192,2049]])expect(plan(f.data,w,h,[f.r],[],[]).plans).toEqual([]);
        expect(plan(f.data.subarray(1),256,192,[f.r],[],[]).plans).toEqual([]);
        expect(plan(f.data,256,192,[f.r],Array(limits.items+1).fill(f.old),[]).plans).toEqual([]);
        for(const bad of [null,{...f.old,box:undefined},{...f.old,confidence:NaN},item('INVALID',bounds(-1,1,8,8))])expect(plan(f.data,256,192,[f.r],[bad as Item],[]).plans).toEqual([]);
        for(const bad of [null,item('INVALID',bounds(1,1,300,8))])expect(plan(f.data,256,192,[f.r],[],[[bad as Item]]).plans).toEqual([]);
        for(const bad of [{...f.r,pageWidth:255},{...f.r,pageHeight:191},{...f.r,core:bounds(0,0,300,1)},{...f.r,crop:bounds(85,75,170,80)},{...f.r,parent:bounds(80,70,176,82)}])expect(plan(f.data,256,192,[bad],[],[]).plans).toEqual([]);
    });
    it('候选过多时不无限追加模型调用，发生重叠的候选同时撤回',()=>{
        const w=768,h=256,data=pixels(w,h),records:Record[]=[];
        for(let n=0;n<9;n++){const x=20+n*80,core=bounds(x,100,x+40,112),crop=bounds(x-4,96,x+44,116);paint(data,w,core);records.push(record(crop,core,bounds(0,0,w,h),w,h));}
        const result=plan(data,w,h,records,[],[]);expect(result.plans).toHaveLength(8);expect(result.blockedParents).toEqual(['0,0,768,256']);
        const f=fixture(),second=record(bounds(77,66,181,86),bounds(120,70,176,82));
        const collision=plan(f.data,256,192,[f.r,second],[],[]);expect(collision.plans).toEqual([]);expect(collision.blockedParents).toEqual(['20,20,236,180']);
    });
    it('观察面积与比较额度预付，失败候选也不能反复耗尽工作量',()=>{
        const w=512,h=512,data=pixels(w,h),core=bounds(40,210,472,260),crop=bounds(26,180,486,290),r=record(crop,core,bounds(0,0,w,h),w,h);paint(data,w,core);data.set([8,20,24,255],(179*w+100)*4);
        expect(plan(data,w,h,Array(128).fill(r),[],[]).plans).toEqual([]);
        const rows=Array(limits.items).fill(item('KNOWN',bounds(2,2,3,3))),records:Record[]=[];
        for(let n=0;n<8;n++){const x=20+n*60,c=bounds(x,100,x+40,110);paint(data,w,c);records.push(record(bounds(x-4,96,x+44,114),c,bounds(0,0,w,h),w,h));}
        expect(plan(data,w,h,records,rows,[]).plans).toEqual([]);
        expect(plan(data,w,h,records,[],[rows]).plans).toEqual([]);
        expect(plan(data,w,h,records,rows.slice(0,8188),[]).plans).toEqual([]);
        expect(plan(data,w,h,[record(bounds(20,20,492,200),bounds(50,60,460,120),bounds(0,0,w,h),w,h)],[],[]).plans).toEqual([]);
    });
});

describe('双裁图结果的一致性与原子采用',()=>{
    it('只有两次一致读取才替换低置信父框，其他原文对象和顺序保持',async()=>{
        const old=item('O HE C N T',parent,.69),before=item('BEFORE',bounds(1,1,8,8)),after=item('AFTER',bounds(200,130,220,140)),rows=[before,old,after];
        const calls:Rect[]=[],result=await recover(rows,{plans:[prepared()],blockedParents:[]},async crop=>{calls.push(crop);return [local(crop)];},()=>{});
        expect(calls).toEqual([bounds(),prepared().confirmation]);expect(result.results.map(r=>r.text)).toEqual(['BEFORE','CHECK THE SOUTH GATE','AFTER']);expect(result.results[0]).toBe(before);expect(result.results[2]).toBe(after);expect(rows[1]).toBe(old);expect(result.numericEvidence).toEqual([]);
    });
    it('没有旧父框的漏行可以补入，并保留确认后的数字证据',async()=>{
        const result=await recover([],{plans:[prepared()],blockedParents:[]},async crop=>[local(crop,'08:45')],()=>{});
        expect(result.results).toEqual([item('08:45',bounds())]);expect(result.numericEvidence[0]).toBe(result.results[0]);
        const sameRow=item('LEFT',bounds(1,66,30,86));const inserted=await recover([sameRow],{plans:[prepared()],blockedParents:[]},async crop=>[local(crop)],()=>{});expect(inserted.results[0]).toBe(sameRow);
        const right=item('RIGHT',bounds(200,66,220,86));const ahead=await recover([right],{plans:[prepared()],blockedParents:[]},async crop=>[local(crop)],()=>{});expect(ahead.results[1]).toBe(right);
        const other=prepared(bounds(260,66,360,86),[bounds(240,20,500,180)]),ordered=await recover([],{plans:[other,prepared()],blockedParents:[]},async crop=>[local(crop,crop.x0<100?'LEFT':'RIGHT')],()=>{});expect(ordered.results.map(r=>r.text)).toEqual(['LEFT','RIGHT']);
    });
    it.each(['none','many','null','text-type','box','empty','long','nan','low','high','x','y','width','height','single','punctuation'])('不采用无法解释的识别结果 %s',async mode=>{
        const old=item('ORIGINAL',parent,.69),recognize=vi.fn(async(crop:Rect)=>{
            const value=local(crop);if(mode==='none')return [];if(mode==='many')return [value,value];if(mode==='null')return [null] as never;
            if(mode==='text-type')value.text=undefined as never;if(mode==='box')value.box=undefined as never;if(mode==='empty')value.text=' ';if(mode==='long')value.text='x'.repeat(257);if(mode==='nan')value.confidence=NaN;if(mode==='low')value.confidence=.94;if(mode==='high')value.confidence=1.01;if(mode==='single')value.text='N';if(mode==='punctuation')value.text='!!!';
            if(['x','y','width','height'].includes(mode))value.box[mode as keyof Item['box']]++;
            return [value];
        });
        const result=await recover([old],{plans:[prepared()],blockedParents:[]},recognize,()=>{});expect(result.results).toEqual([old]);expect(result.numericEvidence).toEqual([]);expect(recognize).toHaveBeenCalledTimes(1);
    });
    it('确认读法不一致或确认缺失时不注入文字、数字或替代框',async()=>{
        for(const confirmation of ['DIFFERENT','NONE']){let n=0;const old=item('ORIGINAL',parent,.69),result=await recover([old],{plans:[prepared()],blockedParents:[]},async crop=>++n===1?[local(crop)]:confirmation==='NONE'?[]:[local(crop,'08:45')],()=>{});expect(result.results).toEqual([old]);expect(result.numericEvidence).toEqual([]);}
    });
    it('同一父框部分失败不丢弃整块旧内容，关联父框同样原子撤回',async()=>{
        const p2=bounds(10,10,240,185),a=prepared(bounds(),[parent]),b=prepared(bounds(76,110,180,130),[parent,p2]),old=[item('FIRST',parent,.69),item('SECOND',p2,.69)];
        const result=await recover(old,{plans:[a,b],blockedParents:[]},async crop=>crop.y0<90?[local(crop)]:[],()=>{});expect(result.results).toEqual(old);
        const unused=vi.fn(async(crop:Rect)=>[local(crop)]),blocked=await recover(old,{plans:[b,a],blockedParents:['10,10,240,185']},unused,()=>{});expect(blocked.results).toEqual(old);expect(unused).not.toHaveBeenCalled();
        const absent=await recover([],{plans:[a,b],blockedParents:['20,20,236,180']},async crop=>[local(crop)],()=>{});expect(absent.results).toHaveLength(2);
    });
    it('取消与识别失败向拥有者传播，不返回半完成替换',async()=>{
        const error=new Error('cancelled');let checks=0;
        await expect(recover([],{plans:[prepared()],blockedParents:[]},async crop=>[local(crop)],()=>{if(++checks===3)throw error;})).rejects.toBe(error);
        await expect(recover([],{plans:[prepared()],blockedParents:[]},async()=>{throw error;},()=>{})).rejects.toBe(error);
        const recognize=vi.fn();await expect(recover([],{plans:[],blockedParents:[]},recognize,()=>{})).resolves.toEqual({results:[],numericEvidence:[]});expect(recognize).not.toHaveBeenCalled();
    });
});
