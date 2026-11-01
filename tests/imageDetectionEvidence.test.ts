import {describe,expect,it} from 'vitest';
import {bindImageDetectionEvidence,createImageDetectionEvidenceBudget,getImageDetectionEvidence,
    type ImageDetectionFrame,type ImageDetectionFrameSource} from '@/src/features/image-translation/services/imageDetectionEvidence';

const geometry=(change:Partial<ImageDetectionFrameSource>={}):ImageDetectionFrameSource=>({pageWidth:64,pageHeight:48,x:0,y:0,width:64,height:48,resizeRatio:1,...change});
const box={x0:20,y0:16,x1:28,y1:24},observation={left:12,top:8,width:24,height:24};
function frame(change:Partial<ImageDetectionFrame>={},points:Array<[number,number]>=[]):ImageDetectionFrame {
    const f={pageWidth:64,pageHeight:48,x:0,y:0,width:64,height:48,...change};
    const bits=new Uint8Array(Math.ceil(f.width*f.height/8));
    for(const [x,y] of points){const i=(y-f.y)*f.width+x-f.x;bits[i>>>3]|=1<<(i&7);}
    return {...f,bits:change.bits??bits};
}
function bound(frames:ImageDetectionFrame[]=[frame({},[[20,18]])]) {
    const regions:object[]=[];bindImageDetectionEvidence(regions,'image-A',64,48,frames);
    return {regions,support:getImageDetectionEvidence(regions,'image-A',64,48)};
}
const asFrame=(value:unknown)=>value as ImageDetectionFrame;
const asSource=(value:unknown)=>value as ImageDetectionFrameSource;

describe('同次检测概率的独占有界位图',()=>{
    it('内容区逐行低位打包，模型padding不产生支持，严格按实际Float32值>.3',()=>{
        const b=createImageDetectionEvidenceBudget(),data=new Float32Array(32*32).fill(1);
        data[0]=0;data[1]=.29999;data[2]=.30001;data[3]=1;data[32]=.2;data[33]=.9;data[34]=0;data[35]=.8;
        b.capture(data,32,32,geometry({pageWidth:4,pageHeight:2,width:4,height:2}));
        expect(b.frames()).toHaveLength(1);expect(Array.from(b.frames()[0].bits)).toEqual([0b10101100]);
        const threshold=new Float32Array(32*32);threshold[0]=.3;
        const actual=createImageDetectionEvidenceBudget();actual.capture(threshold,32,32,geometry({pageWidth:1,pageHeight:1,width:1,height:1}));
        expect(actual.frames()[0].bits[0]).toBe(+(threshold[0]>.3));
    });
    it('非整字节内容尾位为0，完全零概率仍只提供明确的无支持观察',()=>{
        const b=createImageDetectionEvidenceBudget();b.capture(new Float32Array(32*32).fill(1),32,32,geometry({width:3,height:3}));
        expect(Array.from(b.frames()[0].bits)).toEqual([255,1]);
        const zero=createImageDetectionEvidenceBudget();zero.capture(new Float32Array(64*64),64,64,geometry());
        const {support}=bound([...zero.frames()]);expect(support!.forBox(box,observation)!(20,18)).toBe(false);
    });
    it('不持有原Float32，快照的修改与transfer不影响下次快照或tensor',()=>{
        const b=createImageDetectionEvidenceBudget(),data=new Float32Array(64*64);data[18*64+20]=.9;
        b.capture(data,64,64,geometry());data.fill(0);
        const first=b.frames();expect(Object.isFrozen(first)).toBe(true);expect(Object.isFrozen(first[0])).toBe(true);
        first[0].bits.fill(0);expect(b.frames()[0].bits.some(v=>v!==0)).toBe(true);
        const second=b.frames();structuredClone(second[0].bits,{transfer:[second[0].bits.buffer]});
        expect(second[0].bits.byteLength).toBe(0);expect(b.frames()[0].bits.byteLength).toBe(384);expect(data.byteLength).toBe(64*64*4);
    });
    it.each([NaN,Infinity,-.01,1.01])('内容或padding概率%s都撤回整个frame，不发布有效前缀',bad=>{
        for(const index of [0,31*32+31]){
            const b=createImageDetectionEvidenceBudget(),p=new Float32Array(32*32).fill(.9);p[index]=bad;
            b.capture(p,32,32,geometry({width:3,height:3}));expect(b.frames()).toEqual([]);
        }
    });
    it.each([
        null,{},geometry({pageWidth:0}),geometry({pageHeight:0}),geometry({pageWidth:8193}),geometry({pageHeight:8193}),
        geometry({pageWidth:4097,pageHeight:4096}),geometry({x:.1}),geometry({y:-1}),geometry({x:-1}),
        geometry({width:0}),geometry({height:0}),geometry({width:1537,pageWidth:2000}),geometry({height:1537,pageHeight:2000}),
        geometry({x:1,width:64}),geometry({y:1,height:48}),geometry({resizeRatio:.5}),geometry({rotation:90}),
    ])('无效原帧/非原比例拒绝: %j',bad=>{
        const b=createImageDetectionEvidenceBudget();b.capture(new Float32Array(64*64),64,64,asSource(bad));expect(b.frames()).toEqual([]);
    });
    it.each([[32,64],[64,32],[NaN,64]])('模型padding尺寸必须精确匹配 %s×%s',(w,h)=>{
        const b=createImageDetectionEvidenceBudget();b.capture(new Float32Array(64*64),w,h,geometry());expect(b.frames()).toEqual([]);
    });
    it('显式rotation0可原帧借用；数据类型/长度错误拒绝',()=>{
        const b=createImageDetectionEvidenceBudget();b.capture(new Float32Array(64*64),64,64,geometry({rotation:0}));expect(b.frames()).toHaveLength(1);
        for(const data of [new Float64Array(64*64),new Float32Array(64*64-1)]){
            const x=createImageDetectionEvidenceBudget();x.capture(data as Float32Array,64,64,geometry());expect(x.frames()).toEqual([]);
        }
    });
    it('失败也占128次尝试；第129次有效输入不能绕过配额',()=>{
        const b=createImageDetectionEvidenceBudget();for(let i=0;i<128;i++)b.capture(new Float32Array(),32,32,asSource(null));
        b.capture(new Float32Array(64*64),64,64,geometry());expect(b.frames()).toEqual([]);
    });
    it('扫描预扣完整padding平面，非法数据不退款；输出bit bytes受相同预算约束',()=>{
        const b=createImageDetectionEvidenceBudget(),source=geometry({pageWidth:1024,pageHeight:1024,width:1024,height:1024});
        const bad=new Float32Array(1024*1024);bad[0]=NaN;
        for(let i=0;i<4;i++)b.capture(bad,1024,1024,source);
        b.capture(new Float32Array(64*64),64,64,geometry());expect(b.frames()).toEqual([]);
        const full=createImageDetectionEvidenceBudget(),data=new Float32Array(1024*1024);
        for(let i=0;i<5;i++)full.capture(data,1024,1024,source);
        expect(full.frames()).toHaveLength(4);expect(full.frames().reduce((n,f)=>n+f.bits.length,0)).toBe(512*1024);
    });
});

describe('worker帧验证、私有数组绑定与单帧查询',()=>{
    it('数组/image/尺寸全匹配才返回，同值副本与structuredClone没有权限',()=>{
        const {regions,support}=bound();expect(support).toBeDefined();expect(Object.isFrozen(support)).toBe(true);
        expect(getImageDetectionEvidence(regions,'image-B',64,48)).toBeUndefined();
        expect(getImageDetectionEvidence(regions,'image-A',63,48)).toBeUndefined();
        expect(getImageDetectionEvidence(regions,'image-A',64,47)).toBeUndefined();
        expect(getImageDetectionEvidence([...regions],'image-A',64,48)).toBeUndefined();
        expect(getImageDetectionEvidence(structuredClone(regions),'image-A',64,48)).toBeUndefined();
        expect(getImageDetectionEvidence([], 'image-A',64,48)).toBeUndefined();
    });
    it('binding独占copy隔离后续worker修改/transfer，且不向reading数组挂字段',()=>{
        const source=frame({},[[20,18]]),{regions,support}=bound([source]);source.bits.fill(0);
        structuredClone(source.bits,{transfer:[source.bits.buffer]});
        expect(support!.forBox(box,observation)!(20,18)).toBe(true);expect(Object.keys(regions)).toEqual([]);
    });
    it('二维真实bit邻域是Chebyshev2，不能用core包络或同行借点',()=>{
        const {support}=bound([frame({},[[20,18],[30,28]])]);const query=support!.forBox(box,observation)!;
        expect(query(18,16)).toBe(true);expect(query(22,20)).toBe(true);expect(query(17,18)).toBe(false);
        expect(query(25,23)).toBe(false);expect(query(28,26)).toBe(true);
        for(const p of [[NaN,18],[20,Infinity],[20.5,18],[20,18.5],[11,18],[20,7],[36,18],[20,32]])expect(query(...p as [number,number])).toBe(false);
    });
    it('冻结sourceBox及observation标量，不能事后移动查询许可',()=>{
        const {support}=bound(),b={...box},o={...observation},q=support!.forBox(b,o)!;
        b.x0=1;o.left=1;expect(q(20,18)).toBe(true);expect(q(1,18)).toBe(false);
    });
    it('单tile必须完整覆盖ROI及2halo，不能拼两个半帧或只覆盖sourceBox',()=>{
        const partial=bound([frame({width:32}),frame({x:32,width:32})]);expect(partial.support!.forBox(box,observation)).toBeUndefined();
        const noHalo=bound([frame({x:12,y:8,width:24,height:24})]);expect(noHalo.support!.forBox(box,observation)).toBeUndefined();
        const tile=bound([frame({x:10,y:6,width:28,height:28},[[20,18]])]);expect(tile.support!.forBox(box,observation)!(18,16)).toBe(true);
    });
    it('完整帧查询不能借相邻不完整帧中的正点，也不跨帧OR补证',()=>{
        const partial=frame({width:32},[[20,18]]),complete=frame();
        const {support}=bound([partial,complete]);
        expect(support!.forBox(box,observation)!(20,18)).toBe(false);
    });
    it('page边界显式clip halo，fractional源框按floor/ceil±8匹配',()=>{
        const {support}=bound([frame({},[[0,0],[63,47]])]);
        const top=support!.forBox({x0:.25,y0:.5,x1:3.5,y1:4.5},{left:0,top:0,width:12,height:13})!;
        expect(top(0,0)).toBe(true);expect(top(3,0)).toBe(false);
        const bottom=support!.forBox({x0:60,y0:44,x1:64,y1:48},{left:52,top:36,width:12,height:12})!;
        expect(bottom(63,47)).toBe(true);expect(bottom(60,47)).toBe(false);
    });
    it.each([
        null,{x0:NaN,y0:1,x1:4,y1:4},{x0:-1,y0:1,x1:4,y1:4},{x0:1,y0:-1,x1:4,y1:4},
        {x0:1,y0:1,x1:65,y1:4},{x0:1,y0:1,x1:4,y1:49},{x0:4,y0:1,x1:4,y1:4},{x0:1,y0:4,x1:4,y1:4},
    ])('无效sourceBox不借帧: %j',b=>{
        expect(bound().support!.forBox(b as typeof box,observation)).toBeUndefined();
    });
    it('超65Ki观察区或不对应当前box的ROI不提供点函数',()=>{
        const f=frame({pageWidth:400,pageHeight:400,width:400,height:400}),regions:object[]=[];
        bindImageDetectionEvidence(regions,'large',400,400,[f]);const support=getImageDetectionEvidence(regions,'large',400,400)!;
        expect(support.forBox({x0:1,y0:1,x1:300,y1:300},{left:0,top:0,width:308,height:308})).toBeUndefined();
        for(const change of [null,{...observation,left:13},{...observation,top:9},{...observation,width:23},{...observation,height:23}])expect(bound().support!.forBox(box,change as typeof observation)).toBeUndefined();
    });
    it.each([null,{},frame({pageWidth:63}),frame({pageHeight:47}),frame({bits:new Uint8ClampedArray(384) as unknown as Uint8Array}),frame({bits:new Uint8Array(383)})])('worker坏帧整份拒绝，无有效前缀: %j',bad=>{
        const {regions}=bound();bindImageDetectionEvidence(regions,'image-A',64,48,[frame(),asFrame(bad)]);
        expect(getImageDetectionEvidence(regions,'image-A',64,48)).toBeUndefined();
    });
    it('未用尾bits非零拒绝；合法尾bits及多帧可绑定',()=>{
        const regions:object[]=[],f=frame({width:3,height:3,bits:new Uint8Array([255,1])});
        bindImageDetectionEvidence(regions,'image-A',64,48,[f,frame()]);expect(getImageDetectionEvidence(regions,'image-A',64,48)).toBeDefined();
        f.bits[1]=3;bindImageDetectionEvidence(regions,'image-A',64,48,[f]);expect(getImageDetectionEvidence(regions,'image-A',64,48)).toBeUndefined();
    });
    it.each([
        {image:'',width:64,height:48,frames:[frame()]},{image:1,width:64,height:48,frames:[frame()]},
        {image:'image-A',width:0,height:48,frames:[frame()]},{image:'image-A',width:64,height:48,frames:null},
        {image:'image-A',width:64,height:48,frames:[]},{image:'image-A',width:64,height:48,frames:Array(129).fill(frame())},
    ])('无效重绑撤销旧许可 %j',args=>{
        const {regions}=bound();bindImageDetectionEvidence(regions,args.image as string,args.width,args.height,args.frames as ImageDetectionFrame[]);
        expect(getImageDetectionEvidence(regions,'image-A',64,48)).toBeUndefined();
    });
    it('非数组不能获得数组权限',()=>{
        const regions={};bindImageDetectionEvidence(regions,'image-A',64,48,[frame()]);expect(getImageDetectionEvidence(regions,'image-A',64,48)).toBeUndefined();
    });
    it('外来frames总内容面积与ceil bitbytes分别有界，尾byte不绕过512KiB',()=>{
        const regions:object[]=[],page={pageWidth:4096,pageHeight:4096};
        bindImageDetectionEvidence(regions,'large',4096,4096,[frame({...page,width:1536,height:1536}),frame({...page,width:1536,height:1536})]);
        expect(getImageDetectionEvidence(regions,'large',4096,4096)).toBeUndefined();
        const a=frame({...page,width:1536,height:1536}),b=frame({...page,width:1197,height:1533}),c=frame({...page,width:1,height:1});
        expect(a.width*a.height+b.width*b.height+c.width*c.height).toBeLessThan(4*1024*1024);
        bindImageDetectionEvidence(regions,'large',4096,4096,[a,b]);expect(getImageDetectionEvidence(regions,'large',4096,4096)).toBeDefined();
        bindImageDetectionEvidence(regions,'large',4096,4096,[a,b,c]);expect(getImageDetectionEvidence(regions,'large',4096,4096)).toBeUndefined();
    });
});
