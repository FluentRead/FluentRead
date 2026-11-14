import {describe,it,expect} from 'vitest';
import {planImageFlatTextRepair} from '@/src/features/image-translation/services/flatTextRepair';

const box=(x0:number,y0:number,x1:number,y1:number)=>({x0,y0,x1,y1});
function fixture(background=[238,234,213],foreground=[18,25,29]){
    const width=100,height=60,pixels=new Uint8ClampedArray(width*height*4);
    for(let at=0;at<pixels.length;at+=4)pixels.set([...background,255],at);
    const point=(x:number,y:number,color=foreground,alpha=255)=>pixels.set([...color,alpha],(y*width+x)*4);
    const rect=(x:number,y:number,w:number,h:number,color=foreground)=>{for(let j=y;j<y+h;j++)for(let i=x;i<x+w;i++)point(i,j,color);};
    const glyph=(x:number,y=20,w=14,h=20)=>{rect(x,y,3,h);rect(x+w-3,y,3,h);rect(x,y+Math.floor(h/2)-1,w,3);};
    glyph(20);glyph(55);
    const request={mask:box(10,10,90,50),source:box(15,15,85,45),fontSize:20,vertical:false};
    return {width,height,pixels,point,rect,glyph,background,foreground,request};
}
const plan=(f=fixture(),budget={remaining:2_097_152})=>planImageFlatTextRepair(f.pixels,f.width,f.height,f.request,budget);

describe('原蒙版内的纯色文字独立修补证据',()=>{
    it.each([
        [[238,234,213],[18,25,29]],[[10,20,30],[240,245,250]],
        [[200,255,200],[10,0,10]],[[200,200,255],[10,10,0]],
    ])('共同墨色与真实抗锯齿混合通过后只恢复已有清字框：%j %j',(background,foreground)=>{
        const f=fixture(background,foreground),color=background.map((v,c)=>Math.round(v+(foreground[c]-v)*.25));
        f.rect(19,20,1,20,color);const original=f.pixels.slice(),budget={remaining:10000},repair=plan(f,budget)!;
        expect(repair).toBeTypeOf('function');expect(budget.remaining).toBe(10000-82*42);expect(f.pixels).toEqual(original);
        const output=original.slice();repair(output);
        for(let y=0;y<f.height;y++)for(let x=0;x<f.width;x++){
            const at=(y*f.width+x)*4;
            expect(Array.from(output.slice(at,at+4))).toEqual(x>=10&&x<90&&y>=10&&y<50?[...background,255]:Array.from(original.slice(at,at+4)));
        }
        expect(()=>repair(new Uint8ClampedArray(output.length-4))).toThrow('缓冲尺寸不一致');
        f.pixels.fill(0);f.request.mask.x0=0;const another=original.slice();repair(another);expect(another).toEqual(output);
    });
    it('竖排方向只交换字形尺度检查，不改变物理框与像素颜色',()=>{
        const f=fixture(),width=f.height,height=f.width,pixels=new Uint8ClampedArray(f.pixels.length);
        for(let y=0;y<f.height;y++)for(let x=0;x<f.width;x++)pixels.set(f.pixels.slice((y*f.width+x)*4,(y*f.width+x)*4+4),(x*width+y)*4);
        const flip=(b:ReturnType<typeof box>)=>box(b.y0,b.x0,b.y1,b.x1);
        const repair=planImageFlatTextRepair(pixels,width,height,{mask:flip(f.request.mask),source:flip(f.request.source),fontSize:20,vertical:true},{remaining:10000});
        expect(repair).toBeTypeOf('function');
    });
    it.each([
        {width:0},{height:0},{width:100.5},{height:NaN},{pixels:new Uint8ClampedArray(1)},
    ])('非法图像几何不读取像素或消耗额度：%j',change=>{
        const f={...fixture(),...change},budget={remaining:10000};expect(plan(f,budget)).toBeUndefined();expect(budget.remaining).toBe(10000);
    });
    it.each([
        box(0,10,90,50),box(10,0,90,50),box(10,10,100,50),box(10,10,90,60),box(10,10,10,50),box(10,10,90,10),box(NaN,10,90,50),
    ])('缺少真实外周或无效蒙版不产生计划：%j',mask=>{
        const f=fixture();f.request.mask=mask;expect(plan(f)).toBeUndefined();
    });
    it.each([
        box(9,15,85,45),box(15,9,85,45),box(15,15,91,45),box(15,15,85,51),box(15,15,15,45),box(15,15,85,15),box(15,NaN,85,45),
    ])('原物理行必须完整属于原蒙版：%j',source=>{
        const f=fixture();f.request.source=source;expect(plan(f)).toBeUndefined();
    });
    it.each([1,513,NaN,Infinity])('无效原字号 %s 保持原像素',fontSize=>{
        const f=fixture();f.request.fontSize=fontSize;expect(plan(f)).toBeUndefined();
    });
    it.each([0,3443,Infinity,NaN,3444.5])('未满足预付像素预算 %s 时不采样',remaining=>{
        const f=fixture(),budget={remaining};let reads=0;
        const pixels=new Proxy(f.pixels,{get(target,key){if(typeof key==='string'&&/^\d+$/u.test(key))reads++;return Reflect.get(target,key,target);}});
        expect(plan({...f,pixels},budget)).toBeUndefined();expect(reads).toBe(0);expect(budget.remaining).toBe(remaining);
    });
    it('单框65536像素上限在任何像素取样前检查，失败不退款',()=>{
        const f=fixture(),budget={remaining:65536};f.point(9,9,[0,0,0]);expect(plan(f,budget)).toBeUndefined();expect(budget.remaining).toBe(65536-3444);
        const pixels=new Uint8ClampedArray(300*300*4).fill(255),large={mask:box(1,1,257,255),source:box(20,20,230,230),fontSize:20};
        const untouched={remaining:100000};expect(planImageFlatTextRepair(pixels,300,300,large,untouched)).toBeUndefined();expect(untouched.remaining).toBe(100000);
        const exact={remaining:65536};expect(planImageFlatTextRepair(pixels,300,300,{...large,mask:box(1,1,255,255)},exact)).toBeUndefined();expect(exact.remaining).toBe(0);
    });
    it.each([[9,9],[10,9],[90,9],[9,20],[90,20],[9,50],[10,50],[90,50]])('外周必须逐像素同色且完全不透明：%s,%s',(x,y)=>{
        for(const channel of [0,1,2,3]){const f=fixture();f.pixels[(y*f.width+x)*4+channel]-=1;expect(plan(f)).toBeUndefined();}
    });
    it('内部透明像素、纯空白和低对比字都不被归为可靠单墨色文字',()=>{
        const f=fixture();f.point(40,20,f.background,254);expect(plan(f)).toBeUndefined();
        const empty=fixture();empty.rect(10,10,80,40,empty.background);expect(plan(empty)).toBeUndefined();
        expect(plan(fixture([240,240,240],[220,220,220]))).toBeUndefined();
    });
    it('过多颜色、其他色相以及共同墨色之外的明暗都保留原模型路径',()=>{
        const crowded=fixture();for(let i=0;i<513;i++)crowded.point(11+i%78,11+Math.floor(i/78),[i%256,Math.floor(i/256),100]);expect(plan(crowded)).toBeUndefined();
        for(const color of [[120,0,120],[255,255,255],[0,0,0]]){
            const f=fixture([220,220,220],[40,40,40]);f.point(45,20,color);expect(plan(f)).toBeUndefined();
        }
    });
    it('过稀、整块涂黑、单一形状与两个实心图块均不足以证明文字',()=>{
        const tiny=fixture();tiny.rect(10,10,80,40,tiny.background);tiny.point(20,20);expect(plan(tiny)).toBeUndefined();
        const filled=fixture();filled.rect(10,10,80,40);expect(plan(filled)).toBeUndefined();
        const single=fixture();single.rect(50,15,30,30,single.background);expect(plan(single)).toBeUndefined();
        const art=fixture();art.rect(20,20,14,20);art.rect(55,20,14,20);expect(plan(art)).toBeUndefined();
    });
    it.each([[10,20],[20,10],[89,20],[20,49]])('接触蒙版边缘的墨迹不能在%s,%s被截断',(x,y)=>{
        const f=fixture();f.point(x,y);expect(plan(f)).toBeUndefined();
    });
    it('每个组件须有实心墨迹，跨行大图案和过长连接字形不猜测',()=>{
        const weak=fixture();weak.point(80,20,weak.background.map((v,c)=>Math.round(v+(weak.foreground[c]-v)*.25)));expect(plan(weak)).toBeUndefined();
        const tall=fixture();tall.rect(10,10,80,40,tall.background);tall.glyph(20,12,14,35);expect(plan(tall)).toBeUndefined();
        const long=fixture();long.rect(10,10,80,40,long.background);long.glyph(13,20,70,20);expect(plan(long)).toBeUndefined();
    });
    it('第257个独立组件撤回本次计划，不以大量散点填平整个区域',()=>{
        const width=128,height=128,pixels=new Uint8ClampedArray(width*height*4).fill(255);
        for(let i=0;i<257;i++)pixels.set([0,0,0,255],((5+Math.floor(i/17)*6)*width+5+(i%17)*6)*4);
        expect(planImageFlatTextRepair(pixels,width,height,{mask:box(2,2,126,126),source:box(3,3,125,125),fontSize:20},{remaining:20000})).toBeUndefined();
    });
});
