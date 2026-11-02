/**
 * @file tests/imageMattePage.test.ts
 * 页级 RGBA 修补的独占写入、精确脏矩形、原文与跨区域冲突和共享资源预算回归。
 * 局部背景证明是显式受控端口；其真实像素算法另由 imageMatteRepair 与入口像素回归验证。
 */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {ImageTextRegion} from '@/src/features/image-translation/paragraphs';
import type {ImageMatteRepair} from '@/src/features/image-translation/services/imageMatteRepair';
import type {ImageDetectionSupport} from '@/src/features/image-translation/services/imageDetectionEvidence';
const ports=vi.hoisted(()=>({observe:vi.fn(),plan:vi.fn(),candidate:vi.fn(),forBox:vi.fn()}));
vi.mock('@/src/features/image-translation/services/imageMatteRepair',()=>({imageMatteObservationBox:ports.observe,planImageMatteRepair:ports.plan,planImageMatteCandidate:ports.candidate}));
import {applyImageMattePage,authorizeImageMatteProposal,discardImageMatteProposal,getImageMatteProposalDrawings,planImageMattePage,proposeImageMattePage,type ImageMattePagePlan,type ImageMatteProposal} from '@/src/features/image-translation/services/imageMattePage';
type Box=ImageTextRegion['bbox'];
const matte=[230,220,210,224] as const;
const line=(bbox:Box={x0:12,y0:12,x1:28,y1:28}):ImageTextRegion=>({text:'COMPLETE',bbox,fontSize:16});
let pixels:Uint8ClampedArray;
const draw=(l:ImageTextRegion)=>({...l.bbox});
// 页编排只消费显式受控检测端口；真实same-frame/halo/bit绑定由独立Evidence模块与入口测试验证。
const support:ImageDetectionSupport={forBox:ports.forBox};
function local(box:Box):ImageMatteRepair {
    const left=Math.floor(box.x0)-8,top=Math.floor(box.y0)-8,width=Math.ceil(box.x1)-left+8,height=Math.ceil(box.y1)-top+8;
    const mask=new Uint8Array(width*height),artMask=new Uint8Array(width*height);
    const x=Math.ceil(box.x0)+2,y=Math.ceil(box.y0)+2;
    for(let dy=0;dy<3;dy++)for(let dx=0;dx<2;dx++)mask[(y+dy-top)*width+x+dx-left]=1;
    return {left,top,width,height,mask,artMask,background:matte,sourceBox:{...box},supportBox:{x0:x,y0:y,x1:x+2,y1:y+3}};
}
function run(lines=[line()],retained:ImageTextRegion[]=[],bounds=draw){return planImageMattePage(pixels,64,64,lines,retained,bounds,support);}
function solid(w:number,h:number){const p=new Uint8ClampedArray(w*h*4);for(let i=0;i<p.length;i+=4)p.set(matte,i);return p;}
function blankPlan(sourceBox:Box,left:number,top:number,width:number,height:number):ImageMatteRepair {
    return {sourceBox:{...sourceBox},left,top,width,height,background:matte,mask:new Uint8Array(width*height),artMask:new Uint8Array(width*height),supportBox:{...sourceBox}};
}
function paint(p:Uint8ClampedArray,w:number,r:ImageMatteRepair){
    for(let y=0;y<r.height;y++)for(let x=0;x<r.width;x++){
        const i=y*r.width+x;if(r.mask[i]||r.artMask[i])p.set(r.mask[i]?[0,0,0,255]:[48,104,124,96],((r.top+y)*w+r.left+x)*4);
    }
}
function repeatedRetained(count:number,bbox:Box){const kept=line(bbox);kept.sourceBoxes=Array.from({length:count-1},()=>({...bbox}));return kept;}
/** L形外伸ink的包络包住保留文本，真实行段从上边/左边绕开它。 */
function lPlan(sourceBox:Box,geometry={left:4,top:4,width:32,height:32},small=false):ImageMatteRepair {
    const r=blankPlan(sourceBox,geometry.left,geometry.top,geometry.width,geometry.height);
    const x0=small?3:14,x1=small?13:35,y0=small?12:14,y1=small?30:25;
    for(let x=x0;x<x1;x++)r.mask[(y0-r.top)*r.width+x-r.left]=1;
    for(let y=y0;y<y1;y++)r.mask[(y-r.top)*r.width+x0-r.left]=1;
    r.supportBox={x0,y0,x1,y1};return r;
}
beforeEach(()=>{
    vi.resetAllMocks();pixels=new Uint8ClampedArray(64*64*4);for(let i=0;i<pixels.length;i+=4)pixels.set(matte,i);
    ports.observe.mockImplementation((_w:number,_h:number,b:Box)=>{const p=local(b);return {left:p.left,top:p.top,width:p.width,height:p.height};});
    ports.plan.mockImplementation((_p:Uint8ClampedArray,_w:number,_h:number,b:Box)=>local(b));
    ports.candidate.mockImplementation((_p:Uint8ClampedArray,_w:number,_h:number,b:Box)=>local(b));
    ports.forBox.mockReturnValue(()=>true);
});
describe('ImageMattePage：无权限提案与分阶段授权',()=>{
    it('提案只公开冻结的布局/保护/观察几何，缺少真实支持前不能apply或伪造授权',()=>{
        const l=line(),before=pixels.slice(),proposal=proposeImageMattePage(pixels,64,64,[l],[],draw)!;
        expect(ports.plan).not.toHaveBeenCalled();expect(ports.forBox).not.toHaveBeenCalled();expect(ports.candidate).toHaveBeenCalledOnce();
        expect(Object.keys(proposal)).toEqual([]);expect(Object.isFrozen(proposal)).toBe(true);
        const view=getImageMatteProposalDrawings(proposal)!;
        expect(Object.keys(view)).toEqual(['drawings','rectangles','observations']);
        expect(view.drawings[0].line).toBe(l);expect(view.observations).toEqual([{sourceBox:l.bbox,left:4,top:4,width:32,height:32}]);
        for(const value of [view,view.observations,view.observations[0],view.observations[0].sourceBox])expect(Object.isFrozen(value)).toBe(true);
        expect(()=>applyImageMattePage(pixels,64,64,proposal as unknown as ImageMattePagePlan)).toThrow('已失效');
        expect(()=>applyImageMattePage(pixels,64,64,view as unknown as ImageMattePagePlan)).toThrow('已失效');
        const forged={...proposal} as ImageMatteProposal;
        expect(getImageMatteProposalDrawings(forged)).toBeUndefined();expect(authorizeImageMatteProposal(forged,support)).toBeUndefined();
        expect(authorizeImageMatteProposal(proposal,undefined as never)).toBeUndefined();expect(pixels).toEqual(before);
    });
    it('部分物理框失败不消耗提案或重扫颜色，之后所有真实墨点通过才原子登记一次性原owner权限',()=>{
        const first=line(),second=line({x0:36,y0:12,x1:52,y1:28});paint(pixels,64,local(first.bbox));paint(pixels,64,local(second.bbox));
        const before=pixels.slice(),proposal=proposeImageMattePage(pixels,64,64,[first,second],[],draw)!,view=getImageMatteProposalDrawings(proposal)!;
        const queried: Array<[number,number]>=[],db={forBox:vi.fn((_b:Box)=>((x:number,y:number)=>{queried.push([x,y]);return x<38;}))};
        expect(authorizeImageMatteProposal(proposal,db)).toBeUndefined();expect(db.forBox).toHaveBeenCalledTimes(2);
        expect(queried).toEqual([[14,14],[15,14],[14,15],[15,15],[14,16],[15,16],[38,14]]);
        expect(pixels).toEqual(before);expect(getImageMatteProposalDrawings(proposal)).toBe(view);
        const points: Array<[number,number]>=[],ctd={forBox:vi.fn(()=>((x:number,y:number)=>{points.push([x,y]);return true;}))};
        const plan=authorizeImageMatteProposal(proposal,ctd)!;
        expect(plan).toBeDefined();expect(points).toHaveLength(12);expect(ports.candidate).toHaveBeenCalledTimes(2);
        expect(plan.drawings).toBe(view.drawings);expect(plan.rectangles).toBe(view.rectangles);expect(pixels).toEqual(before);
        expect(getImageMatteProposalDrawings(proposal)).toBeUndefined();expect(authorizeImageMatteProposal(proposal,ctd)).toBeUndefined();
        expect(()=>applyImageMattePage(pixels.slice(),64,64,plan)).toThrow('已失效');
        applyImageMattePage(pixels,64,64,plan);expect(pixels).toEqual(solid(64,64));
        expect(()=>applyImageMattePage(pixels,64,64,plan)).toThrow('已失效');
    });
    it('缺完整观察支持或查询抛出首因均不破坏提案，显式discard及回调撤销禁止重新发布',()=>{
        const proposal=proposeImageMattePage(pixels,64,64,[line()],[],draw)!,before=pixels.slice();
        ports.forBox.mockReturnValueOnce(undefined);expect(authorizeImageMatteProposal(proposal,support)).toBeUndefined();
        const failure=new Error('same-frame evidence expired');ports.forBox.mockImplementationOnce(()=>{throw failure;});
        expect(()=>authorizeImageMatteProposal(proposal,support)).toThrow(failure);expect(getImageMatteProposalDrawings(proposal)).toBeDefined();
        discardImageMatteProposal(proposal);discardImageMatteProposal(proposal);
        expect(getImageMatteProposalDrawings(proposal)).toBeUndefined();expect(authorizeImageMatteProposal(proposal,support)).toBeUndefined();
        const cancelled=proposeImageMattePage(pixels,64,64,[line()],[],draw)!;
        const revoke={forBox:()=>()=>{discardImageMatteProposal(cancelled);return true;}};
        expect(authorizeImageMatteProposal(cancelled,revoke)).toBeUndefined();expect(pixels).toEqual(before);
    });
    it('全部候选共享原1Mi观察与绘字预算及4Mi共同端点预算，任何失败不发布提案',()=>{
        const l=line();l.sourceBoxes=[l.bbox,{...l.bbox}];let shared:{remaining:number}|undefined;
        ports.candidate.mockImplementation((_p:unknown,_w:number,_h:number,b:Box,fit:{remaining:number})=>{
            if(shared)expect(fit).toBe(shared);else shared=fit;
            fit.remaining-=2_097_152;return fit.remaining>=0?local(b):undefined;
        });
        expect(proposeImageMattePage(pixels,64,64,[l],[],draw)).toBeDefined();expect(shared!.remaining).toBe(0);
        l.sourceBoxes.push({...l.bbox});shared=undefined;
        expect(proposeImageMattePage(pixels,64,64,[l],[],draw)).toBeUndefined();expect(shared!.remaining).toBe(-2_097_152);
        ports.observe.mockReturnValue({left:0,top:0,width:1024,height:1024});ports.candidate.mockClear();
        expect(proposeImageMattePage(pixels,64,64,[line()],[],draw)).toBeUndefined();expect(ports.candidate).not.toHaveBeenCalled();
        expect(ports.forBox).not.toHaveBeenCalled();
    });
    it.each(['draw','retained','art','different-background'] as const)('支持免费提案在%s冲突处就拒绝，保留原完整保护语义',kind=>{
        const first=line(),second=line({x0:36,y0:12,x1:52,y1:28});let lines=[first],retained:ImageTextRegion[]=[];
        if(kind==='draw')lines=[first,line({x0:24,y0:12,x1:40,y1:28})];
        if(kind==='retained')retained=[line({x0:29,y0:12,x1:32,y1:28})];
        if(kind==='art')ports.candidate.mockImplementation((_p:unknown,_w:number,_h:number,b:Box)=>{const r=local(b);r.artMask[(14-r.top)*r.width+14-r.left]=1;return r;});
        if(kind==='different-background'){
            lines=[first,second];
            ports.candidate.mockImplementation((_p:unknown,_w:number,_h:number,b:Box)=>{
                const r=blankPlan(b,4,4,56,32);r.mask[10*56+10]=1;r.supportBox={x0:14,y0:14,x1:15,y1:15};
                if(b.x0>30)r.background=[0,0,0,255];return r;
            });
        }
        const before=pixels.slice();expect(proposeImageMattePage(pixels,64,64,lines,retained,draw)).toBeUndefined();
        expect(ports.forBox).not.toHaveBeenCalled();expect(pixels).toEqual(before);
    });
});
describe('ImageMattePage：全页授权与上传',()=>{
    it('缺失same-frame support或任一physical box无完整halo时不申请局部修补',()=>{
        expect(planImageMattePage(pixels,64,64,[line()],[],draw)).toBeUndefined();
        ports.forBox.mockReturnValueOnce(undefined);expect(run()).toBeUndefined();expect(ports.plan).not.toHaveBeenCalled();
        const failure=new Error('evidence frame expired');ports.forBox.mockImplementationOnce(()=>{throw failure;});expect(()=>run()).toThrow(failure);
    });
    it('多个合法区域逐物理框申请支持、共享fitBudget，保留远处原文且两份精确ink都可应用',()=>{
        const first=line(),second=line({x0:36,y0:12,x1:52,y1:28}),kept=line({x0:58,y0:50,x1:61,y1:53});
        const a=local(first.bbox),b=local(second.bbox);paint(pixels,64,a);paint(pixels,64,b);
        let shared:{remaining:number}|undefined;
        ports.plan.mockImplementation((_p:unknown,_w:number,_h:number,box:Box,supportAt:(x:number,y:number)=>boolean,fit:{remaining:number})=>{
            expect(supportAt(14,14)).toBe(true);if(shared)expect(fit).toBe(shared);else shared=fit;
            fit.remaining-=7;return local(box);
        });
        const plan=run([first,second],[kept])!;
        expect(ports.forBox).toHaveBeenCalledTimes(2);expect(shared!.remaining).toBe(4_194_304-14);
        expect(plan.uploads).toEqual([{x0:14,y0:14,x1:16,y1:17},{x0:38,y0:14,x1:40,y1:17}]);
        expect(plan.drawings.map(x=>x.line)).toEqual([first,second]);applyImageMattePage(pixels,64,64,plan);expect(pixels).toEqual(solid(64,64));
    });
    it('只有实际墨迹可改变，上传矩形没有凹洞或包络扩张，原像素在apply前不变',()=>{
        const l=line(),support=local(l.bbox);for(let i=0;i<support.mask.length;i++)if(support.mask[i])pixels.set([0,0,0,255],((support.top+Math.floor(i/support.width))*64+support.left+i%support.width)*4);
        const before=new Uint8ClampedArray(pixels),plan=run([l])!;
        expect(plan.uploads).toEqual([{x0:14,y0:14,x1:16,y1:17}]);expect(pixels).toEqual(before);
        applyImageMattePage(pixels,64,64,plan);
        const changed=[];for(let p=0;p<64*64;p++)if(pixels[p*4]!==before[p*4])changed.push(p);
        expect(changed).toEqual([14+14*64,15+14*64,14+15*64,15+15*64,14+16*64,15+16*64]);
        expect(Object.isFrozen(plan)).toBe(true);expect(Object.isFrozen(plan.drawings[0].background)).toBe(true);
        expect(()=>applyImageMattePage(pixels,64,64,plan)).toThrow('已失效');
    });
    it('拒绝伪造计划、其他buffer或尺寸，不消耗有效计划',()=>{
        const plan=run()!;expect(()=>applyImageMattePage(pixels,64,64,{...plan})).toThrow();
        expect(()=>applyImageMattePage(new Uint8ClampedArray(pixels),64,64,plan)).toThrow();
        expect(()=>applyImageMattePage(pixels,63,64,plan)).toThrow();expect(()=>applyImageMattePage(pixels,64,63,plan)).toThrow();
        expect(()=>applyImageMattePage(pixels,64,64,plan)).not.toThrow();
    });
    it('同一行重叠物理支持合并，相同span纵合；不合并隔行或跨孔',()=>{
        const l=line();l.sourceBoxes=[l.bbox,{...l.bbox}];
        ports.plan.mockImplementation((_p:unknown,_w:number,_h:number,b:Box)=>{
            const p=local(b);p.mask.fill(0);
            for(const [x,y] of [[14,14],[15,14],[14,15],[15,15],[18,15],[14,17]])p.mask[(y-p.top)*p.width+x-p.left]=1;
            return p;
        });
        expect(run([l])!.uploads).toEqual([{x0:14,y0:14,x1:16,y1:16},{x0:18,y0:15,x1:19,y1:16},{x0:14,y0:17,x1:15,y1:18}]);
    });
    it('源墨迹以外的绘字内异色及观察到的外部图案必须进入保护矩形',()=>{
        pixels.set([48,104,124,224],(13*64+13)*4);
        ports.plan.mockImplementation((_p:unknown,_w:number,_h:number,b:Box)=>{const p=local(b);p.artMask[(9-p.top)*p.width+9-p.left]=1;return p;});
        const plan=run()!;expect(plan.rectangles).toEqual([{x0:9,y0:9,x1:10,y1:10},{x0:13,y0:13,x1:14,y1:14}]);
    });
    it('一行的墨迹不能覆盖另一局部证明要求保留的图案',()=>{
        ports.plan.mockImplementation((_p:unknown,_w:number,_h:number,b:Box)=>{const p=local(b);p.artMask[(14-p.top)*p.width+14-p.left]=1;return p;});
        const before=new Uint8ClampedArray(pixels);expect(run()).toBeUndefined();expect(pixels).toEqual(before);
    });
    it('保留原文保护按真实外伸墨迹判断，不靠support包络拒绝其内部空白',()=>{
        const kept=line({x0:35,y0:13,x1:38,y1:16});
        ports.plan.mockImplementation((_p:unknown,_w:number,_h:number,b:Box)=>{
            const p=local(b);p.supportBox={x0:14,y0:14,x1:34,y1:17};return p;
        });
        expect(run([line()],[kept])).toBeDefined();
        ports.plan.mockImplementation((_p:unknown,_w:number,_h:number,b:Box)=>{const p=local(b);p.mask[(14-p.top)*p.width+33-p.left]=1;p.supportBox={x0:14,y0:14,x1:34,y1:17};return p;});
        expect(run([line()],[kept])).toBeUndefined();
    });
    it('绘字范围不能压住保留原文或另一译文，所有布局验证发生在应用前',()=>{
        expect(run([line(),line({x0:24,y0:12,x1:40,y1:28})])).toBeUndefined();
        expect(run([line()],[line({x0:29,y0:12,x1:32,y1:28})])).toBeUndefined();
        const kept=line({x0:50,y0:50,x1:53,y1:53});kept.sourceBoxes=[{x0:29,y0:12,x1:32,y1:28}];
        expect(run([line()],[kept])).toBeUndefined();
    });
    it('不能用另一物理行的不同底色填补整段，任一缺证据原子拒绝',()=>{
        const l=line();l.sourceBoxes=[l.bbox,{x0:12,y0:34,x1:28,y1:40}];
        ports.plan.mockImplementationOnce((_p:unknown,_w:number,_h:number,b:Box)=>local(b)).mockImplementationOnce((_p:unknown,_w:number,_h:number,b:Box)=>({...local(b),background:[0,0,0,255]}));
        expect(run([l])).toBeUndefined();ports.plan.mockReturnValue(undefined);expect(run()).toBeUndefined();
        ports.observe.mockReturnValue(undefined);expect(run()).toBeUndefined();
    });
    it('空物理行、无效或页外绘字、非法保留框均不能取得授权',()=>{
        const l=line();l.sourceBoxes=[];expect(run([l])).toBeUndefined();
        for(const box of [{x0:1,y0:1,x1:1,y1:2},{x0:NaN,y0:1,x1:2,y1:2},{x0:-1,y0:1,x1:2,y1:2},{x0:1,y0:-1,x1:2,y1:2},{x0:1,y0:1,x1:65,y1:2},{x0:1,y0:1,x1:2,y1:65}])expect(run([line()],[],()=>box)).toBeUndefined();
        expect(run([line()],[line({x0:NaN,y0:1,x1:2,y1:2})])).toBeUndefined();
        expect(run([line()],[line({x0:80,y0:80,x1:90,y1:90})])).toBeDefined();
    });
    it('输入与全页候选数量有硬上限，不启动局部证明',()=>{
        for(const [w,h,p] of [[0,64,pixels],[64,0,pixels],[8193,1,pixels],[8192,8192,pixels],[64,64,new Uint8ClampedArray(3)]])expect(planImageMattePage(p as Uint8ClampedArray,w as number,h as number,[line()],[],draw,support)).toBeUndefined();
        expect(run([])).toBeUndefined();expect(run(Array.from({length:129},()=>line()))).toBeUndefined();
        const l=line();l.sourceBoxes=Array.from({length:129},()=>l.bbox);expect(run([l])).toBeUndefined();expect(ports.plan).not.toHaveBeenCalled();
    });
    it('物理ROI与绘字扫描共享页级像素预算，失败计划也计费',()=>{
        ports.observe.mockReturnValue({left:0,top:0,width:1024,height:1024});expect(run()).toBeUndefined();expect(ports.plan).not.toHaveBeenCalled();
        expect(planImageMattePage(new Uint8ClampedArray(8192*130*4),8192,130,[line({x0:0,y0:0,x1:8192,y1:130})],[],draw,support)).toBeUndefined();
    });
    it('保留框数量先限额，不展开巨型sourceBoxes数组',()=>{
        const kept=line({x0:50,y0:50,x1:51,y1:51});kept.sourceBoxes=Array.from({length:8192},()=>kept.bbox);expect(run([line()],[kept])).toBeUndefined();expect(ports.plan).not.toHaveBeenCalled();
    });
    it.each([1022,1023])('外伸L形避开保留文本仍计全部精确检查，%i重复保护框不能绕过1Mi预算',count=>{
        const r=lPlan(line().bbox);paint(pixels,64,r);ports.plan.mockReturnValue(r);
        const kept=repeatedRetained(count,{x0:35,y0:20,x1:36,y1:21}),before=pixels.slice();
        // 1022*(1024 ROI检查+每box前置1+绘字前置1)=1048572，剩4；后续真实ink查验必须继续计费。
        expect(run([line()],[kept])).toBeUndefined();expect(ports.plan).toHaveBeenCalledOnce();expect(pixels).toEqual(before);
    });
    it('刚好用完1Mi碰撞预算后第二physical proof不能继续申请保护检查',()=>{
        const w=64,h=96,p=solid(w,h),one={x0:1,y0:8,x1:6,y1:65},two={x0:2,y0:8,x1:7,y1:65},l=line({x0:1,y0:8,x1:7,y1:65});l.sourceBoxes=[one,two];
        ports.observe.mockImplementation((_w:number,_h:number,b:Box)=>({left:0,top:0,width:b.x1+8,height:73}));
        ports.plan.mockImplementation((_p:unknown,_w:number,_h:number,b:Box)=>lPlan(b,{left:0,top:0,width:b.x1+8,height:73},true));
        const r=lPlan(one,{left:0,top:0,width:14,height:73},true);paint(p,w,r);
        const kept=repeatedRetained(1024,{x0:12,y0:24,x1:13,y1:25}),before=p.slice();
        // 首ROI=14*73=1022；1024*(绘字前置1+proof前置1+ROI1022)=2^20，第二proof前置即拒。
        expect(planImageMattePage(p,w,h,[l],[kept],draw,support)).toBeUndefined();expect(ports.plan).toHaveBeenCalledTimes(2);expect(p).toEqual(before);
    });
    it('精确art/ink归并的跳过访问也计费，不能在前序接近预算后免费遍历外部图案',()=>{
        const r=lPlan(line().bbox);for(const x of [4,6,8,10,12,14])r.artMask[x-r.left]=1;paint(pixels,64,r);ports.plan.mockReturnValue(r);
        const kept=repeatedRetained(1022,{x0:35,y0:20,x1:36,y1:21});
        // 候选绘字范围内是原matte，前置精确扫描后剩4checks；六个更早art行段仍须逐项扣费。
        expect(run([line()],[kept],()=>({x0:20,y0:20,x1:28,y1:28}))).toBeUndefined();
    });
    it('交叠物理proof的原始ink行段也共享65536上限，不能依靠最后union去重绕过预算',()=>{
        const p=solid(256,256),l=line({x0:8,y0:8,x1:248,y1:248});
        for(let y=8;y<248;y++)for(let x=12;x<244;x+=2)p.set([0,0,0,255],(y*256+x)*4);
        l.sourceBoxes=[0,1,2].map(i=>({x0:8+i,y0:8,x1:248-i,y1:248}));
        ports.observe.mockImplementation((_w:number,_h:number,b:Box)=>({left:b.x0-8,top:0,width:b.x1-b.x0+16,height:256}));
        ports.plan.mockImplementation((_p:unknown,_w:number,_h:number,b:Box)=>{
            const r=blankPlan(b,b.x0-8,0,b.x1-b.x0+16,256);
            for(let y=8;y<248;y++)for(let x=12;x<244;x+=2)r.mask[y*r.width+x-r.left]=1;
            r.supportBox={x0:12,y0:8,x1:243,y1:248};return r;
        });
        expect(planImageMattePage(p,256,256,[l],[],draw,support)).toBeUndefined();expect(ports.plan).toHaveBeenCalledTimes(3);
    });
    it('外部art与ink共用65536原始行段上限，重复physical框不能让保护列表膨胀',()=>{
        const p=solid(64,128),l=line({x0:16,y0:16,x1:18,y1:116});l.sourceBoxes=Array.from({length:81},(_,i)=>({x0:16+i/10000,y0:16,x1:17.75+i/10000,y1:116}));
        ports.observe.mockReturnValue({left:8,top:8,width:18,height:116});
        ports.plan.mockImplementation((_p:unknown,_w:number,_h:number,b:Box)=>{
            const r=blankPlan(b,8,8,18,116);for(let y=0;y<116;y++)for(const x of [0,2,4,6,12,14,16])r.artMask[y*18+x]=1;
            for(let y=20;y<112;y++)r.mask[(y-8)*18+8]=1;r.supportBox={x0:16,y0:20,x1:17,y1:112};return r;
        });
        expect(planImageMattePage(p,64,128,[l],[],draw,support)).toBeUndefined();expect(ports.plan.mock.calls.length).toBeLessThan(81);
    });
    it('draw范围新发现的art也与局部原始行段共用65536限额，不在最后扫描时追加无界保护',()=>{
        const p=solid(64,128),l=line({x0:16,y0:16,x1:30,y1:116});l.sourceBoxes=Array.from({length:72},(_,i)=>({x0:16+i/10000,y0:16,x1:17.75+i/10000,y1:116}));
        const make=(b:Box)=>{
            const r=blankPlan(b,8,8,18,116);for(let y=0;y<116;y++)for(const x of [0,2,4,6,12,14,16])r.artMask[y*18+x]=1;
            for(let y=20;y<112;y++)r.mask[(y-8)*18+8]=1;r.supportBox={x0:16,y0:20,x1:17,y1:112};return r;
        };
        paint(p,64,make(l.sourceBoxes[0]));for(let y=16;y<116;y++)for(const x of [26,28])p.set([48,104,124,96],(y*64+x)*4);
        ports.observe.mockReturnValue({left:8,top:8,width:18,height:116});ports.plan.mockImplementation((_p:unknown,_w:number,_h:number,b:Box)=>make(b));
        // 72*(812 art+92 ink)=65088，draw内五列art的500个新行段超过剩余448。
        expect(planImageMattePage(p,64,128,[l],[],draw,support)).toBeUndefined();expect(ports.plan).toHaveBeenCalledTimes(72);
    });
    it.each(['ink','art'] as const)('4096上传/保护矩形cap分别约束%s碎片，不发布部分页授权',kind=>{
        const p=solid(256,256),l=line({x0:8,y0:8,x1:248,y1:120});
        if(kind==='ink'){
            for(let y=8;y<120;y+=2)for(let x=8;x<248;x+=2)p.set([0,0,0,255],(y*256+x)*4);
            ports.observe.mockReturnValue({left:0,top:0,width:256,height:128});
            ports.plan.mockImplementation((_p:unknown,_w:number,_h:number,b:Box)=>{
                const r=blankPlan(b,0,0,256,128);for(let y=8;y<120;y+=2)for(let x=8;x<248;x+=2)r.mask[y*256+x]=1;
                r.supportBox={x0:8,y0:8,x1:247,y1:119};return r;
            });
        }else{
            l.sourceBoxes=[{x0:12,y0:12,x1:28,y1:28}];
            for(let y=8;y<120;y+=2)for(let x=40;x<248;x+=2)p.set([48,104,124,96],(y*256+x)*4);
        }
        expect(planImageMattePage(p,256,256,[l],[],draw,support)).toBeUndefined();expect(ports.plan).toHaveBeenCalledOnce();
    });
    it('不同matte支持包络相交但真实ink逐点不交时，不按包络误拒完整页',()=>{
        const first=line(),second=line({x0:36,y0:12,x1:52,y1:28}),a=local(first.bbox),b=local(second.bbox);
        b.background=[128,128,128,255];
        for(let x=14;x<36;x++)a.mask[(20-a.top)*a.width+x-a.left]=1;
        for(let x=34;x<40;x++)b.mask[(22-b.top)*b.width+x-b.left]=1;
        a.supportBox={x0:14,y0:14,x1:36,y1:21};b.supportBox={x0:34,y0:14,x1:40,y1:23};
        for(let y=12;y<28;y++)for(let x=36;x<52;x++)pixels.set(b.background,(y*64+x)*4);
        paint(pixels,64,a);paint(pixels,64,b);
        ports.plan.mockImplementation((_p:unknown,_w:number,_h:number,box:Box)=>box.x0<30?a:b);
        const plan=run([first,second])!;expect(plan).toBeDefined();expect(plan.drawings.map(item=>item.background)).toEqual([matte,b.background]);
    });
    it.each(['intersection','retained'] as const)('不同底色ink精确比较与后续%s仍共享接近耗尽的页级检查预算',stage=>{
        const first=line(),second=line({x0:36,y0:12,x1:52,y1:28}),a=lPlan(first.bbox),b=local(second.bbox);
        b.background=[128,128,128,255];
        if(stage==='intersection'){
            b.mask[(14-b.top)*b.width+35-b.left]=1;b.mask[(24-b.top)*b.width+29-b.left]=1;
            b.supportBox={x0:29,y0:14,x1:40,y1:25};
        }else{
            // 交集列34只有第一计划在更晚行有ink；早前小交集必须完整检查后才能继续保护框。
            a.mask[(14-a.top)*a.width+34-a.left]=0;a.mask[(24-a.top)*a.width+34-a.left]=1;
            b.mask[(14-b.top)*b.width+34-b.left]=1;b.supportBox={x0:34,y0:14,x1:40,y1:17};
        }
        paint(pixels,64,a);paint(pixels,64,b);
        ports.plan.mockImplementation((_p:unknown,_w:number,_h:number,box:Box)=>box.x0<30?a:b);
        const kept=repeatedRetained(1021,{x0:35,y0:20,x1:36,y1:21}),before=pixels.slice();
        const bounds=(item:ImageTextRegion)=>item===first?{x0:20,y0:26,x1:28,y1:28}:{x0:40,y0:26,x1:48,y1:28};
        expect(run([first,second],[kept],bounds)).toBeUndefined();expect(ports.plan).toHaveBeenCalledTimes(2);expect(pixels).toEqual(before);
    });
});
