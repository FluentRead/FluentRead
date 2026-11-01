import {afterEach,describe,expect,it,vi} from 'vitest';
import {imageMatteObservationBox,planImageMatteRepair as proveRepair,type ImageMatteFitBudget} from '@/src/features/image-translation/services/imageMatteRepair';
import {bindImageDetectionEvidence,createImageDetectionEvidenceBudget,getImageDetectionEvidence} from '@/src/features/image-translation/services/imageDetectionEvidence';
import type {OcrLine} from '@/src/shared/image/types';

type Color=readonly [number,number,number,number];
const box={x0:16,y0:16,x1:32,y1:32},background=[245,240,220,224] as const,ink=[18,28,34,255] as const;
// 旧几何/颜色控制明确使用独立的dense检测端口，不从像素或返回mask反造core；真实frame由production owner绑定。
const controlledDenseSupport=()=>true;
const budget=():ImageMatteFitBudget=>({remaining:4_194_304});
function planImageMatteRepair(p:Uint8ClampedArray,w:number,h:number,b:OcrLine['bbox']){return proveRepair(p,w,h,b,controlledDenseSupport,budget());}
function page(color:Color=background,w=48,h=48){const p=new Uint8ClampedArray(w*h*4);for(let i=0;i<p.length;i+=4)p.set(color,i);return p;}
function dot(p:Uint8ClampedArray,x:number,y:number,c:Color=ink,w=48){p.set(c,(y*w+x)*4);}
function rect(p:Uint8ClampedArray,b:OcrLine['bbox'],c:Color,w=48){for(let y=b.y0;y<b.y1;y++)for(let x=b.x0;x<b.x1;x++)dot(p,x,y,c,w);}
function fixture(bg:Color=background,fg:Color=ink){const p=page(bg);rect(p,{x0:20,y0:20,x1:23,y1:27},fg);dot(p,27,26,fg);return p;}
const value=(r:NonNullable<ReturnType<typeof planImageMatteRepair>>,x:number,y:number,art=false)=>(art?r.artMask:r.mask)[(y-r.top)*r.width+x-r.left];
/** 独立source-over与一次Canvas预乘存储/回读，生成字面观测，不调用生产准入函数。 */
function composite(bg:Color,fg:Color,t:number,canvas=false):Color {
    const a=Math.round(bg[3]+(fg[3]-bg[3])*t),out:number[]=[];
    for(let c=0;c<3;c++){
        const premul=bg[c]*bg[3]*(1-t)+fg[c]*fg[3]*t;
        const straight=a?Math.max(0,Math.min(255,Math.round(premul/(bg[3]+(fg[3]-bg[3])*t)))):0;
        out.push(canvas&&a?Math.round(Math.round(straight*a/255)*255/a):straight);
    }
    out.push(a);return out as unknown as Color;
}
afterEach(()=>vi.unstubAllGlobals());

describe('真实Canvas半值读回的共同颜色域',()=>{
    // 字面值来自固定两景首轮Chrome ImageData捕获；作者PNG只作独立对照。
    // Native raw SHA b307d8c9.../b1590808...，不在CI读取外部证据文件。
    const samples=[
        {name:'Bridge Latin',bg:[255,255,248,224],fg:[18,28,34,255],native:[142,148,147,238],authored:[143,148,147,238]},
        {name:'Bridge Japanese',bg:[248,255,250,208],fg:[18,28,34,255],native:[178,187,185,220],authored:[179,187,185,220]},
        {name:'Tidal caption',bg:[48,104,124,224],fg:[255,255,255,255],native:[150,178,187,238],authored:[150,178,188,238]},
    ] as const;
    it.each(samples)('$name的作者值与实际相邻读回均保留同一背景前景',sample=>{
        for(const pixel of [sample.authored,sample.native]){
            const p=fixture(sample.bg,sample.fg);dot(p,23,20,pixel);const before=p.slice();
            const plan=planImageMatteRepair(p,48,48,box);
            expect(plan).toBeDefined();expect(plan!.background).toEqual(sample.bg);
            expect(value(plan!,23,20)).toBe(1);expect(p).toEqual(before);
        }
    });
    it('不在精确半值逆像内的色差仍拒绝，不增加通用逐通道容差',()=>{
        const sample=samples[0],p=fixture(sample.bg,sample.fg);
        dot(p,23,20,[141,148,147,238]);const before=p.slice();
        expect(planImageMatteRepair(p,48,48,box)).toBeUndefined();expect(p).toEqual(before);
    });
});

describe('共同foreground端点的有界AA裙边',()=>{
    it.each([.01,.9])('实际SDK量化会保留的coarse p=%s平台不能凭dense检测吞掉灰牌',probability=>{
        const p=page([255,255,255,255],64,48),source={x0:18,y0:14,x1:46,y1:34};
        rect(p,{x0:20,y0:16,x1:44,y1:32},[128,128,128,255],64);
        rect(p,{x0:26,y0:20,x1:29,y1:28},[0,0,0,255],64);
        rect(p,{x0:35,y0:20,x1:38,y1:28},[255,255,255,255],64);
        const before=p.slice(),probabilities=new Float32Array(64*64),detector=createImageDetectionEvidenceBudget();
        for(let y=16;y<32;y++)for(let x=20;x<44;x++)probabilities[y*64+x]=probability;
        detector.capture(probabilities,64,64,{pageWidth:64,pageHeight:48,x:0,y:0,width:64,height:48,resizeRatio:1});
        const regions:object[]=[],image=`coarse-card:${probability}`,frames=detector.frames();expect(frames).toHaveLength(1);
        bindImageDetectionEvidence(regions,image,64,48,frames);
        const observation=imageMatteObservationBox(64,48,source)!,query=getImageDetectionEvidence(regions,image,64,48)?.forBox(source,observation);
        expect(query).toBeDefined();const unsupported:number[]=[];
        // 字面整片检测概率来自测试输入，不能从待修mask反造支持；四角、黑白字和其余全部平台点均受支持。
        for(let y=16;y<32;y++)for(let x=20;x<44;x++)if(!query!(x,y))unsupported.push(y*64+x);
        expect(unsupported).toEqual([]);expect(query!(10,6)).toBe(false);
        expect(proveRepair(p,64,48,source,query!,budget())).toBeUndefined();expect(p).toEqual(before);
    });
    it('宽渐变条不能被同一黑白颜色线解释成任意厚度AA',()=>{
        const p=page([255,255,255,255]);
        for(let y=20;y<28;y++)for(let x=20;x<28;x++)dot(p,x,y,composite([255,255,255,255],[0,0,0,255],(x-19)/8));
        expect(planImageMatteRepair(p,48,48,box)).toBeUndefined();
    });
    it('宽低对比阴影连着黑字也不能由一个端点anchor授权',()=>{
        const p=page([255,255,255,255]);rect(p,{x0:18,y0:18,x1:30,y1:30},[192,192,192,255]);
        rect(p,{x0:23,y0:21,x1:26,y1:27},[0,0,0,255]);expect(planImageMatteRepair(p,48,48,box)).toBeUndefined();
    });
    it('一至两像素薄AA保留，第三像素孤立中间色未知',()=>{
        const p=fixture([255,255,255,255],[0,0,0,255]);dot(p,24,20,[153,153,153,255]);
        expect(planImageMatteRepair(p,48,48,box)).toBeDefined();dot(p,25,20,[153,153,153,255]);
        expect(planImageMatteRepair(p,48,48,box)).toBeUndefined();
    });
    it('低alpha文字的相对端点与薄边按原RGBA量化解释，不套opaque绝对亮度',()=>{
        const p=fixture([0,0,0,0],[255,255,255,32]);dot(p,24,20,[255,255,255,13]);
        expect(planImageMatteRepair(p,48,48,box)).toBeDefined();
    });
    it('coverage上界恰为九成时沿用半开域，开上界不能冒作近端核心',()=>{
        const open=fixture([0,0,0,255],[5,5,5,255]);dot(open,25,20,[4,4,4,255]);
        expect(planImageMatteRepair(open,48,48,box)).toBeUndefined();
        const closed=fixture([5,5,5,255],[0,0,0,255]);dot(closed,25,20,[1,1,1,255]);
        expect(planImageMatteRepair(closed,48,48,box)).toBeDefined();
    });
    it('真实全黑平台填满原框时仍因没有框内matte观测而未知',()=>{
        const p=page([255,255,255,255],64,48),source={x0:20,y0:16,x1:44,y1:32};
        rect(p,source,[0,0,0,255],64);expect(proveRepair(p,64,48,source,controlledDenseSupport,budget())).toBeUndefined();
    });
});

describe('完整RGBA静区与原矩形组件的有界观察',()=>{
    it('真实检测端口与全页fit预算必需，缺失/非法值不尝试证明',()=>{
        const p=fixture(),support=vi.fn(()=>true);
        expect(proveRepair(p,48,48,box,undefined as unknown as typeof support,budget())).toBeUndefined();
        expect(proveRepair(p,48,48,box,support,undefined as unknown as ImageMatteFitBudget)).toBeUndefined();
        for(const remaining of [NaN,-1,1.5,Infinity])expect(proveRepair(p,48,48,box,support,{remaining})).toBeUndefined();
        expect(support).not.toHaveBeenCalled();
    });
    it('每个ink点都要真实支持，不能用一个组件anchor覆盖平台或遗漏的AA',()=>{
        const p=fixture(),points=new Set<string>();for(let y=20;y<27;y++)for(let x=20;x<23;x++)points.add(`${x},${y}`);points.add('27,26');
        const support=vi.fn((x:number,y:number)=>points.has(`${x},${y}`)),b=budget();
        expect(proveRepair(p,48,48,box,support,b)).toBeDefined();expect(support).toHaveBeenCalledTimes(22);
        points.delete('22,26');expect(proveRepair(p,48,48,box,support,budget())).toBeUndefined();
        const failure=new Error('same frame expired');expect(()=>proveRepair(p,48,48,box,()=>{throw failure;},budget())).toThrow(failure);
    });
    it('轻微宽松bbox中的灰牌没有逐pixel真实DB支持时拒绝，真实黑白字不得反造平台core',()=>{
        const p=page([255,255,255,255],64,48),source={x0:18,y0:14,x1:46,y1:34};
        const black={x0:26,y0:20,x1:29,y1:28},white={x0:35,y0:20,x1:38,y1:28};
        rect(p,{x0:20,y0:16,x1:44,y1:32},[128,128,128,255],64);rect(p,black,[0,0,0,255],64);rect(p,white,[255,255,255,255],64);
        rect(p,{x0:10,y0:10,x1:18,y1:11},[0,255,255,96],64);
        const supports=(x:number,y:number)=>[black,white].some(b=>x>=b.x0&&x<b.x1&&y>=b.y0&&y<b.y1),before=p.slice();
        expect(proveRepair(p,64,48,source,supports,budget())).toBeUndefined();expect(p).toEqual(before);
    });
    it('候选比较共享预算，逐pixel预扣且失败/后续行不返还，原图不写',()=>{
        const p=fixture(),before=p.slice(),b={remaining:22};
        expect(proveRepair(p,48,48,box,controlledDenseSupport,b)).toBeDefined();expect(b.remaining).toBe(0);
        expect(proveRepair(p,48,48,box,controlledDenseSupport,b)).toBeUndefined();expect(b.remaining).toBe(-1);
        const short={remaining:1};expect(proveRepair(p,48,48,box,controlledDenseSupport,short)).toBeUndefined();expect(short.remaining).toBe(-1);expect(p).toEqual(before);
    });
    it('alpha1白/红/绿不能由同一共享前景及单调Canvas量化生成，宽域超64也未知',()=>{
        const p=page([0,0,0,0]);dot(p,20,20,[255,255,255,1]);dot(p,21,20,[255,0,0,1]);dot(p,22,20,[0,255,0,1]);
        const b=budget();expect(proveRepair(p,48,48,box,controlledDenseSupport,b)).toBeUndefined();expect(b.remaining).toBe(4_194_304);
    });
    it('预算按端点域而非alpha名单；64组域可有共同witness，narrow作者alpha1也可证明',()=>{
        const p=fixture([64,64,64,128],[192,192,192,128]);expect(planImageMatteRepair(p,48,48,box)).toBeDefined();
        const low=fixture([128,128,128,1],[255,255,255,255]);expect(planImageMatteRepair(low,48,48,box)).toBeDefined();
    });
    it.each([[1,0,0,255],[0,1,0,255]] as const)('half-tie必须下闭上开，不给不同通道各挑舍入方向：%j',(...args)=>{
        const p=fixture([0,0,0,255],[1,1,0,255]);dot(p,23,20,args as unknown as Color);
        expect(planImageMatteRepair(p,48,48,box)).toBeUndefined();
    });
    it('同一half-tie witness合法且原source support完整时接纳',()=>{
        const p=fixture([0,0,0,255],[2,1,0,255]);dot(p,23,20,[1,1,0,255]);expect(planImageMatteRepair(p,48,48,box)).toBeDefined();
    });
    it('相反通道共享唯一t=.5的合法half-tie，与反向对比的闭上界保持一致',()=>{
        const one=fixture([0,1,0,255],[1,0,0,255]);dot(one,23,20,[1,1,0,255]);expect(planImageMatteRepair(one,48,48,box)).toBeDefined();
        const inverse=fixture([2,2,0,255],[0,0,0,255]);dot(inverse,23,20,[1,1,0,255]);expect(planImageMatteRepair(inverse,48,48,box)).toBeDefined();
    });
    it('共享端点的alpha也必须可生成所有源pixel，不能只检查RGB方向',()=>{
        const p=fixture([0,0,0,128],[255,255,255,129]);dot(p,23,20,[0,0,0,255]);
        expect(planImageMatteRepair(p,48,48,box)).toBeUndefined();
    });
    it('原bbox±8零扫描几何，fractional原框不被整数观察域覆盖',()=>{
        const source={x0:16.25,y0:16.5,x1:31.25,y1:31.75},p=fixture(),before=p.slice();
        expect(imageMatteObservationBox(48,48,source)).toEqual({left:8,top:8,width:32,height:32});
        const r=planImageMatteRepair(p,48,48,source)!;
        expect(r.sourceBox).toEqual(source);expect(r.sourceBox).not.toBe(source);
        expect(r.background).toEqual(background);expect(r.supportBox).toEqual({x0:20,y0:20,x1:28,y1:27});
        expect(r.mask.reduce((a,b)=>a+b,0)).toBe(22);expect(p).toEqual(before);
        expect(value(r,20,20)).toBe(1);expect(value(r,27,26)).toBe(1);expect(value(r,24,24)).toBe(0);
        expect(r.mask.buffer).not.toBe(p.buffer);expect(r.artMask.buffer).not.toBe(p.buffer);expect(r.artMask.buffer).not.toBe(r.mask.buffer);
    });
    it('非矩形闭环绕开外部有色边框和完整外伸AA，不用矩形环多数色',()=>{
        const bg=[10,19,29,255] as const,fg=[255,255,255,255] as const,p=fixture(bg,fg),art=[130,220,224,255] as const;
        for(let y=8;y<40;y++)for(let x=8;x<40;x++)if(x+y<=28)dot(p,x,y,art);
        for(let y=27;y<=32;y++)dot(p,21,y,fg);
        const r=planImageMatteRepair(p,48,48,box)!;
        expect(r.background).toEqual(bg);expect(r.supportBox.y1).toBe(33);
        expect(value(r,21,32)).toBe(1);expect(value(r,14,14,true)).toBe(1);expect(value(r,14,14)).toBe(0);
        expect(value(r,15,15,true)).toBe(0);expect(value(r,22,28)).toBe(0);
    });
    it('只填明确ink后逐字恢复作者matte，opaque/semi外art及空白孔不被包络擦除',()=>{
        const p=fixture(),before=p.slice();rect(p,{x0:8,y0:8,x1:14,y1:14},[55,133,201,96]);
        const r=planImageMatteRepair(p,48,48,box)!,out=p.slice();
        for(let y=0;y<r.height;y++)for(let x=0;x<r.width;x++)if(r.mask[y*r.width+x])out.set(r.background,((y+r.top)*48+x+r.left)*4);
        const expected=page();rect(expected,{x0:8,y0:8,x1:14,y1:14},[55,133,201,96]);expect(out).toEqual(expected);
        expect(Array.from(p.subarray((20*48+20)*4,(20*48+20)*4+4))).toEqual(ink);expect(before[(20*48+20)*4]).toBe(ink[0]);
    });
    it.each([false,true])('已保存Atlas AA字节及Canvas回读共用覆盖率，canvas=%s',canvas=>{
        const bg=canvas?[248,244,224,235] as const:[249,244,224,235] as const;
        const aa=canvas?[158,160,149,243] as const:[158,159,149,243] as const,p=fixture(bg);
        dot(p,23,20,aa);const r=planImageMatteRepair(p,48,48,box)!;
        expect(r).toBeDefined();expect(value(r,23,20)).toBe(1);
    });
    it('alpha等于matte但RGB改变的低级AA也被完整记录',()=>{
        const bg=[48,104,124,224] as const,p=fixture(bg,[255,255,255,255]);dot(p,23,20,[49,105,125,224]);
        const r=planImageMatteRepair(p,48,48,box)!;expect(r).toBeDefined();expect(value(r,23,20)).toBe(1);
    });
    it('单侧射线上的外art候选必须与另外三侧相交验证，不把first候选或主色当证明',()=>{
        const p=fixture();rect(p,{x0:8,y0:8,x1:9,y1:40},[55,133,201,96]);
        const r=planImageMatteRepair(p,48,48,box)!;expect(r.background).toEqual(background);expect(value(r,8,23,true)).toBe(1);
    });
    it.each([0,1,32,96,128,224,235,254,255])('source-over各通道共同覆盖率，matte A=%i',a=>{
        for(const canvas of [false,true]){
            const raw:[number,number,number,number]=a===0?[0,0,0,0]:[80,110,140,a],fg=[225,170,90,255] as const;
            const bg=canvas?composite(raw,raw,0,true):raw,body=canvas?composite(fg,fg,1,true):fg;
            const p=fixture(bg,body);for(let i=0;i<5;i++)dot(p,23+i,20,composite(raw,fg,[.02,.1,.3,.6,.9][i],canvas));
            const r=planImageMatteRepair(p,48,48,box)!;
            // 这两组Canvas观测的三个背景通道各有128/8个raw整数逆像，域远大于64；拒绝由域预算决定。
            if(canvas&&(a===1||a===32)){expect(r).toBeUndefined();continue;}
            expect(r,`alpha ${a}, canvas ${canvas}`).toBeDefined();
            for(let i=0;i<5;i++)expect(value(r,23+i,20)).toBe(1);
        }
    });
    it('全透明matte允许合法半透明源字，不以全图alpha0禁止生成新字',()=>{
        const p=fixture([0,0,0,0],[25,45,65,128]);dot(p,23,20,[25,45,65,13]);
        const r=planImageMatteRepair(p,48,48,box)!;expect(r).toBeDefined();expect(r.background).toEqual([0,0,0,0]);expect(value(r,23,20)).toBe(1);
    });
    it.each([
        [158,164,149,243],[66,170,90,250],[250,5,80,255],
    ].map(color=>({color:color as unknown as Color})))('跨通道偏色/多墨色不能分别挑覆盖率：$color',({color})=>{
        const p=fixture([248,244,224,235]);dot(p,23,20,color);expect(planImageMatteRepair(p,48,48,box)).toBeUndefined();
    });
    it.each([90,110])('墨与背景相同通道R=100时，偏色R=%i不能藏进共同覆盖率',r=>{
        const p=fixture([100,180,220,255],[100,80,60,255]);dot(p,23,20,[r,130,140,255]);
        expect(planImageMatteRepair(p,48,48,box)).toBeUndefined();
    });
    it.each(['cutout','hidden-rgb'] as const)('不能把%s当作待擦源墨',kind=>{
        const bg=kind==='cutout'?background:[0,0,0,0] as const,p=fixture(bg);
        dot(p,23,20,kind==='cutout'?[245,240,220,96]:[17,53,191,0]);
        expect(planImageMatteRepair(p,48,48,box)).toBeUndefined();
    });
    it.each(['unanchored','cross-edge','art-core-touch','art-adjacent-core'] as const)('%s无完整组件归属时整项回退',kind=>{
        const p=fixture();
        if(kind==='unanchored')dot(p,35,35);
        if(kind==='cross-edge')for(let x=8;x<=20;x++)dot(p,x,20);
        if(kind==='art-core-touch')rect(p,{x0:8,y0:8,x1:18,y1:18},[55,133,201,96]);
        if(kind==='art-adjacent-core')rect(p,{x0:8,y0:8,x1:16,y1:16},[55,133,201,96]);
        const before=p.slice();expect(planImageMatteRepair(p,48,48,box)).toBeUndefined();expect(p).toEqual(before);
    });
    it('白外底/灰内底/黑白多色的两个matte几何解释必须拒绝，不能因墨色模型偏好而吞背景',()=>{
        const p=page([255,255,255,255]);rect(p,{x0:12,y0:12,x1:36,y1:36},[128,128,128,255]);
        rect(p,{x0:20,y0:20,x1:23,y1:27},[0,0,0,255]);dot(p,28,28,[255,255,255,255]);
        expect(planImageMatteRepair(p,48,48,box)).toBeUndefined();
    });
    it('框内没有实际matte观测时不猜背景，纯空白也不补造ink计划',()=>{
        const p=page();rect(p,box,ink);expect(planImageMatteRepair(p,48,48,box)).toBeUndefined();
        expect(planImageMatteRepair(page(),48,48,box)).toBeUndefined();
    });
    it('源框触页界无法形成完整静区；裁页观察不读越界像素',()=>{
        const p=fixture(),source={x0:0,y0:16,x1:32,y1:32};
        expect(imageMatteObservationBox(48,48,source)).toEqual({left:0,top:8,width:40,height:32});
        expect(planImageMatteRepair(p,48,48,source)).toBeUndefined();
    });
    it.each([
        [0,48,box],[48,0,box],[1.5,48,box],[48,1.5,box],[8193,48,box],[48,8193,box],[8192,8192,box],
        [48,48,{...box,x0:NaN}],[48,48,{...box,y0:Infinity}],[48,48,{...box,x0:-1}],
        [48,48,{...box,y0:-1}],[48,48,{...box,x1:49}],[48,48,{...box,y1:49}],
        [48,48,{...box,x1:16}],[48,48,{...box,y1:16}],
    ] satisfies [number,number,OcrLine['bbox']][])('非法页/框%d×%d,%j零准入',(w,h,b)=>{
        expect(imageMatteObservationBox(w,h,b)).toBeUndefined();expect(planImageMatteRepair(new Uint8ClampedArray(),w,h,b)).toBeUndefined();
    });
    it('ROI 65536含边界，超过预算或像素不足时无部分结果',()=>{
        expect(imageMatteObservationBox(512,512,{x0:8,y0:8,x1:248,y1:248})).toEqual({left:0,top:0,width:256,height:256});
        expect(imageMatteObservationBox(512,512,{x0:8,y0:8,x1:249,y1:248})).toBeUndefined();
        expect(planImageMatteRepair(new Uint8ClampedArray(4),48,48,box)).toBeUndefined();
    });
    it('不复制整页RGBA，输出局部独占且源getter异常保持首因',()=>{
        const p=fixture(),Pixels=Uint8ClampedArray,copies=vi.fn();
        vi.stubGlobal('Uint8ClampedArray',class extends Pixels {constructor(size:number){super(size);copies(size);}});
        const result=planImageMatteRepair(p,48,48,box)!;expect(result.mask).toHaveLength(32*32);expect(copies).not.toHaveBeenCalled();
        const failure=new Error('source ownership expired'),source={...box,get x0():number{throw failure;}};
        expect(()=>planImageMatteRepair(p,48,48,source)).toThrow(failure);
    });
});
