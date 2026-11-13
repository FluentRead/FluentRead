import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {observeImageSourceInk} from '@/src/features/image-translation/services/sourceInk';
import {observeImageSourceAppearances,expandImageTextBounds} from '@/src/features/image-translation/services/sourceAppearance';

const box=(x0=20,y0=20,x1=120,y1=60)=>({x0,y0,x1,y1});
const W=160,H=100;
function fixture(gradient=false,ink=[230,220,210]){
    const pixels=new Uint8ClampedArray(W*H*4);
    for(let y=0;y<H;y++)for(let x=0;x<W;x++)pixels.set(gradient?[30+x*.3,40+y*.2,70,255]:[20,30,50,255],(y*W+x)*4);
    for(let y=30;y<50;y++)for(let x=35;x<95;x++)pixels.set([...ink,255],(y*W+x)*4);
    return pixels;
}
const observe=(pixels=fixture(),bounds=box(),sources=[bounds])=>observeImageSourceInk(pixels,W,H,bounds,sources);

describe('源墨色的只读渐变与完整物理框观察',()=>{
    it('从未修补的完整渐变恢复共同源色，并单独给出细对比描边',()=>{
        const pixels=fixture(true),before=pixels.slice(),bounds=Object.freeze(box());
        expect(observe(pixels,bounds)).toEqual({foreground:'rgb(230,220,210)',outline:'#111827'});expect(pixels).toEqual(before);
        const region={text:'SOURCE',bbox:bounds,fontSize:40};
        const appearance=observeImageSourceAppearances(pixels,W,H,[region]).get(region)!;
        expect(appearance).toEqual({foreground:'rgb(230,220,210)',outline:'#111827'});
        expect(expandImageTextBounds(pixels,W,H,bounds,44,appearance,[],{remaining:10000})).toBe(bounds);
        expect(appearance).not.toHaveProperty('mask');expect(appearance).not.toHaveProperty('background');
    });
    it('纯色底保留源色与底色，低对比只提供底色',()=>{
        expect(observe()).toEqual({background:[20,30,50,255],foreground:'rgb(230,220,210)'});
        expect(observe(fixture(false,[60,70,90]))).toEqual({background:[20,30,50,255]});
    });
    it('冻结招牌原像素恢复白标题、深色副标题与黄色夜牌，不靠修改真值通过',()=>{
        const raw=gunzipSync(readFileSync(new URL('./fixtures/manga-color-quality/truth/prism-platform-gradient-signs.source-rgba.bin.gz',import.meta.url)));
        const pixels=new Uint8ClampedArray(raw.buffer,raw.byteOffset,raw.byteLength),before=pixels.slice();
        const cases=[
            [box(181,130,1003,167),'rgb(245,245,250)','#111827'],
            [box(179,205,894,233),'rgb(18,26,45)','#ffffff'],
            [box(831,480,1306,507),'rgb(248,215,80)',undefined],
        ] as const;
        for(const [bounds,foreground,outline] of cases)expect(observeImageSourceInk(pixels,1600,900,bounds,[bounds])).toMatchObject({foreground,...(outline?{outline}:{})});
        expect(pixels).toEqual(before);
    });
    it('原字框外三像素的断开抗锯齿尾缘只影响样式，不授权清字',()=>{
        const pixels=fixture(),bounds=box();pixels.set([230,220,210,255],(62*W+90)*4);
        const region={text:'SOURCE',bbox:bounds,fontSize:40};
        expect(observeImageSourceAppearances(pixels,W,H,[region]).get(region)?.foreground).toBe('rgb(230,220,210)');
        pixels.set([230,220,210,255],(64*W+90)*4);expect(observe(pixels)).toBeUndefined();
    });
    it('框外图案、内部透明、边界纹理和不完整外围均撤回',()=>{
        for(const [x,y,color] of [[15,40,[230,220,210,255]],[45,40,[230,220,210,254]],[12,12,[21,30,50,255]],[20,12,[21,30,50,255]],[12,30,[21,30,50,255]]] as const){
            const pixels=fixture();pixels.set(color,(y*W+x)*4);expect(observe(pixels)).toBeUndefined();
        }
        const pixels=fixture(true);pixels.set([255,0,0,255],(12*W+13)*4);expect(observe(pixels)).toBeUndefined();
        expect(observe(fixture(),box(0,0,120,60))).toBeUndefined();
    });
    it('混色与不共享覆盖率的同色通道不会被容差吞掉',()=>{
        const pixels=fixture(false,[20,210,180]);expect(observe(pixels)?.foreground).toBe('rgb(20,210,180)');
        pixels.set([22,210,180,255],(40*W+50)*4);expect(observe(pixels)).toBeUndefined();
        const mixed=fixture();mixed.set([230,30,50,255],(40*W+50)*4);expect(observe(mixed)).toBeUndefined();
    });
    it('没有足够重复墨色、过多颜色和不够清晰的渐变均保持未知',()=>{
        const empty=fixture();for(let y=20;y<60;y++)for(let x=20;x<120;x++)empty.set([20,30,50,255],(y*W+x)*4);
        expect(observe(empty)).toBeUndefined();
        for(let n=0;n<7;n++)empty.set([230,220,210,255],(30*W+35+n)*4);expect(observe(empty)).toBeUndefined();
        for(let n=0;n<100;n++)empty.set([80+n,100,120,255],((30+Math.floor(n/50))*W+35+n%50)*4);
        for(let n=0;n<8;n++)empty.set([230,220,210,255],(40*W+35+n)*4);expect(observe(empty)).toBeUndefined();
        const noisy=fixture(),bounds=box(10,10,150,90);let n=0;
        for(let y=15;y<85;y++)for(let x=15;x<145;x++,n++)noisy.set([n&255,(n>>>8)+70,180,255],(y*W+x)*4);
        expect(observe(noisy,bounds)).toBeUndefined();expect(observe(fixture(true,[90,100,130]))).toBeUndefined();
    });
    it('尺寸、源框、像素和观察面积的无效输入不进入推断',()=>{
        const pixels=fixture();
        expect(observeImageSourceInk(pixels,0,H,box(),[box()])).toBeUndefined();
        expect(observeImageSourceInk(new Uint8ClampedArray(2),W,H,box(),[box()])).toBeUndefined();
        for(const sources of [[],Array(129).fill(box()),[box(80,20,70,60)],[box(20,70,120,60)],[box(NaN,20,120,60)],[box(1,20,120,60)]])expect(observe(pixels,box(),sources)).toBeUndefined();
        expect(observeImageSourceInk(new Uint8ClampedArray(1000*1000*4),1000,1000,box(10,10,990,990),[box()])).toBeUndefined();
    });
});
