/**
 * @file tests/imageTextSegmentation.test.ts
 * 可选分割的真实纯像素端口回归：固定 RGB/白底、低通与补齐、先量化再投影、H8/两像素支持、共享资源预算和释放。
 * 字面颜色与离散边界是独立控制，不加载模型或把人工支持当作产品擦除许可。
 */
import {describe,expect,it} from 'vitest';
import {createImageTextSegmentationInput as input,createImageTextSegmentationSupport as support} from '@/src/features/image-translation/services/imageTextSegmentation';
const SIDE=1024,PLANE=SIDE*SIDE;
const box={x0:20,y0:20,x1:24,y1:24},observation={left:12,top:12,width:20,height:20};
const channels=(tensor:Float32Array,x:number,y:number)=>[tensor[y*SIDE+x],tensor[PLANE+y*SIDE+x],tensor[2*PLANE+y*SIDE+x]];
const f=(values:number[])=>values.map(x=>Math.fround(x/255));

describe('ImageTextSegmentation：固定像素协议',()=>{
    it('RGB、白底透明与半透明颜色保持通道顺序，只在右底补黑且不写源像素',()=>{
        const pixels=new Uint8ClampedArray([255,0,0,255,0,77,88,0,0,0,255,128,0,0,0,255]),before=pixels.slice();
        const result=input(pixels,4,1);
        expect(result).toBeInstanceOf(Float32Array);expect(result.length).toBe(3*PLANE);expect(result.byteLength).toBe(12_582_912);
        expect(channels(result,128,100)).toEqual([1,0,0]);expect(channels(result,384,100)).toEqual([1,1,1]);
        expect(channels(result,640,100)).toEqual(f([127,127,255]));expect(channels(result,896,100)).toEqual([0,0,0]);
        expect(channels(result,128,256)).toEqual([0,0,0]);expect(pixels).toEqual(before);
        const vertical=input(new Uint8ClampedArray([255,0,0,255,0,0,255,255]),1,2);
        expect(channels(vertical,100,256)).toEqual([1,0,0]);expect(channels(vertical,512,256)).toEqual([0,0,0]);
    });
    it.each([
        [1,[255,254,254]],[96,[234,178,189]],[208,[210,88,112]],[224,[207,75,101]],
    ])('alpha %s 采用字面白底合成而不借隐藏 RGB 造灰背景',(alpha,rgb)=>{
        const result=input(new Uint8ClampedArray([200,50,80,alpha as number]),1,1);
        expect(channels(result,0,0)).toEqual(f(rgb as number[]));expect(channels(result,1023,1023)).toEqual(f(rgb as number[]));
    });
    it('缩小时三角低通抑制单像素条纹，使用逐轴整数结果',()=>{
        const pixels=new Uint8ClampedArray(2048*4);
        for(let x=0;x<2048;x++)pixels.set(x%2?[255,255,255,255]:[0,0,0,255],x*4);
        const result=input(pixels,2048,1);
        expect(channels(result,500,0)).toEqual(f([128,128,128]));
        expect(channels(result,0,0)).toEqual(f([109,109,109]));expect(channels(result,1023,0)).toEqual(f([146,146,146]));
        expect(channels(result,500,1)).toEqual([0,0,0]);
    });
    it.each([[0,1],[1,0],[-1,1],[1,1.5],[NaN,1],[1,Infinity],[8193,1],[1,8193],[8192,8192]])('非法几何 %s×%s 在分配输入前失败',(w,h)=>{
        expect(()=>input(new Uint8ClampedArray(),w,h)).toThrow('尺寸无效');expect(()=>support(new Uint8Array(PLANE),w,h)).toThrow('尺寸无效');
    });
    it('拒绝不完整或错误类型的源像素/输出，不把不同 shape 当成同模型平面',()=>{
        expect(()=>input(new Uint8ClampedArray(3),1,1)).toThrow('原始像素无效');
        expect(()=>input(new Uint8Array(4) as unknown as Uint8ClampedArray,1,1)).toThrow('原始像素无效');
        expect(()=>support(new Uint8Array(PLANE-1),64,64)).toThrow('输出尺寸无效');
        expect(()=>support(new Uint8ClampedArray(PLANE) as unknown as Uint8Array,64,64)).toThrow('输出尺寸无效');
    });
    it('字面阈值 127/128 与两像素边界；浮点或框外查询不扩大许可，dispose 使已返回查询失效',()=>{
        const seg=new Uint8Array(PLANE);seg[20*SIDE+20]=128;seg[30*SIDE+30]=127;
        const evidence=support(seg,1024,1024),query=evidence.forBox(box,observation)!;
        expect(query(18,18)).toBe(true);expect(query(17,20)).toBe(false);expect(query(20,20)).toBe(true);expect(query(30,30)).toBe(false);
        for(const [x,y] of [[20.5,20],[NaN,20],[20,20.5],[20,NaN],[11,20],[20,11],[32,20],[20,32]])expect(query(x,y)).toBe(false);
        evidence.dispose();expect(query(20,20)).toBe(false);expect(evidence.forBox(box,observation)).toBeUndefined();evidence.dispose();
    });
    it('裁掉补齐平面；小源图的投影先低通后阈值，不拿原 1024 二值图直接缩放',()=>{
        const seg=new Uint8Array(PLANE);
        // 1024×512 内容全127，补齐全255，不允许从底部黑padding位置借支持。
        seg.fill(127,0,512*SIDE);seg.fill(255,512*SIDE);
        const evidence=support(seg,4,2),whole={x0:0,y0:0,x1:4,y1:2},obs={left:0,top:0,width:4,height:2};
        const query=evidence.forBox(whole,obs)!;expect(query(2,1)).toBe(false);
        const checker=new Uint8Array(PLANE);for(let y=0;y<SIDE;y++)for(let x=0;x<SIDE;x++)checker[y*SIDE+x]=x%2?255:0;
        const reduced=support(checker,1,1).forBox({x0:0,y0:0,x1:1,y1:1},{left:0,top:0,width:1,height:1})!;
        expect(reduced(0,0)).toBe(true);
    });
    it('观察区必须精确匹配 H8；非法框、尺寸与超预算观察拒绝',()=>{
        const seg=new Uint8Array(PLANE),evidence=support(seg,1024,1024);
        for(const source of [undefined,{...box,x0:NaN},{...box,x0:-1},{...box,y0:-1},{...box,x1:1025},{...box,y1:1025},{...box,x1:20},{...box,y1:20}])
            expect(evidence.forBox(source as typeof box,observation)).toBeUndefined();
        for(const obs of [undefined,{...observation,left:11},{...observation,top:11},{...observation,width:19},{...observation,height:19}])
            expect(evidence.forBox(box,obs as typeof observation)).toBeUndefined();
        expect(evidence.forBox({x0:1,y0:1,x1:512,y1:512},{left:0,top:0,width:520,height:520})).toBeUndefined();
        expect(evidence.forBox({x0:0,y0:0,x1:1,y1:1},{left:0,top:0,width:9,height:9})!(0,0)).toBe(false);
    });
    it('失败请求也消耗128次尝试额度，不返回一个完整前缀作为后续许可',()=>{
        const evidence=support(new Uint8Array(PLANE),64,64);
        for(let i=0;i<128;i++)expect(evidence.forBox(undefined as unknown as typeof box,observation)).toBeUndefined();
        expect(evidence.forBox(box,observation)).toBeUndefined();
    });
    it('源 ROI/bit 预算整页共享；许多重复大框不能重复分配',()=>{
        const evidence=support(new Uint8Array(PLANE),1024,1024),large={x0:8,y0:8,x1:248,y1:248},obs={left:0,top:0,width:256,height:256};
        for(let i=0;i<31;i++)expect(evidence.forBox(large,obs)).toBeTypeOf('function');
        expect(evidence.forBox(large,obs)).toBeUndefined();
    });
    it('极小源页的重复低通同样预付系数工作量，不能靠小 ROI 绕过模型像素扫描预算',()=>{
        const evidence=support(new Uint8Array(PLANE),1,1),source={x0:0,y0:0,x1:1,y1:1},obs={left:0,top:0,width:1,height:1};
        for(let i=0;i<15;i++)expect(evidence.forBox(source,obs)).toBeTypeOf('function');
        expect(evidence.forBox(source,obs)).toBeUndefined();
    });
});
