import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {matchesImageSourceInk,observeImageSourceInk} from '@/src/features/image-translation/services/sourceInk';
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
    it('旋转书脊的上下静区与整列一致时复用原金色字，不把弧形底纹当成纯色',()=>{
        const bbox=box(60,12,82,86),ink=[245,223,157,255],pixels=new Uint8ClampedArray(W*H*4);
        for(let y=0;y<H;y++)for(let x=0;x<W;x++){
            const shade=30+Math.floor(Math.abs(x-71)*.7);
            pixels.set([shade,shade+2,shade+15,255],(y*W+x)*4);
        }
        for(let y=18;y<80;y++)for(let x=63;x<78;x++)if(y%8<5)pixels.set(ink,(y*W+x)*4);
        const before=pixels.slice(),source={text:'OPEN PANEL',bbox,sourceBoxes:[bbox],fontSize:22,quarterTurn:1 as const};
        const expected={foreground:'rgb(245,223,157)',outline:'#111827',inkBoxes:[box(63,18,78,77)]};
        expect(observeImageSourceAppearances(pixels,W,H,[source]).get(source)).toEqual(expected);
        expect(pixels).toEqual(before);
        expect(observe(pixels,bbox)).toBeUndefined();
        expect(observeImageSourceInk(pixels,W,H,bbox,[bbox,bbox],true)).toBeUndefined();
        for(const [x,y,color] of [[65,4,[30,32,45,0]],[68,5,[20,26,31,255]],[69,93,[49,115,127,255]],
            [54,30,[240,50,30,255]],[70,32,[220,40,10,255]]] as const){
            const modified=before.slice();modified.set(color,(y*W+x)*4);
            expect(observeImageSourceInk(modified,W,H,bbox,[bbox],true)).toBeUndefined();
        }
    });
    it('从未修补的完整渐变恢复共同源色，并单独给出细对比描边',()=>{
        const pixels=fixture(true),before=pixels.slice(),bounds=Object.freeze(box());
        expect(observe(pixels,bounds)).toEqual({foreground:'rgb(230,220,210)',outline:'#111827',inkBoxes:[box(35,30,95,50)]});expect(pixels).toEqual(before);
        const region={text:'SOURCE',bbox:bounds,fontSize:40};
        const appearance=observeImageSourceAppearances(pixels,W,H,[region]).get(region)!;
        expect(appearance).toEqual({foreground:'rgb(230,220,210)',outline:'#111827',inkBoxes:[box(35,30,95,50)]});
        expect(expandImageTextBounds(pixels,W,H,bounds,44,appearance,[],{remaining:10000})).toBe(bounds);
        expect(appearance).not.toHaveProperty('mask');expect(appearance).not.toHaveProperty('background');
    });
    it('纯色底保留源色与底色，低对比只提供底色',()=>{
        expect(observe()).toEqual({background:[20,30,50,255],foreground:'rgb(230,220,210)',inkBoxes:[box(35,30,95,50)]});
        expect(observe(fixture(false,[60,70,90]))).toEqual({background:[20,30,50,255],inkBoxes:[box(35,30,95,50)]});
    });
    it('整体渐变的多框颜色证明不把总墨迹高度冒充一行字体',()=>{
        const pixels=fixture(true);
        for(let y=35;y<50;y++)for(let x=35;x<95;x++)pixels.set([30+x*.3,40+y*.2,70,255],(y*W+x)*4);
        for(let y=55;y<65;y++)for(let x=40;x<90;x++)pixels.set([230,220,210,255],(y*W+x)*4);
        expect(observe(pixels,box(20,20,120,75),[box(20,20,120,40),box(20,50,120,75)])).toEqual({foreground:'rgb(230,220,210)',outline:'#111827'});
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
    it('matchesImageSourceInk 逐通道共享覆盖率，紧凑控件夹紧覆盖四边边框与全部拒绝路径',()=>{
        expect(matchesImageSourceInk([128,128,128],[0,0,0],[255,255,255])).toBe(true);
        expect(matchesImageSourceInk([200,10,10],[0,0,0],[255,255,255])).toBe(false);

        const makeButton=(ink:[number,number,number]=[255,255,255],bg:[number,number,number]=[0,174,66],padX=5,padY=4)=>{
            const pixels=new Uint8ClampedArray(W*H*4);
            for(let i=0;i<pixels.length;i+=4)pixels.set([255,255,255,255],i);
            const src=box(60,40,90,56);
            for(let y=src.y0-padY;y<src.y1+padY;y++)for(let x=src.x0-padX;x<src.x1+padX;x++)pixels.set([...bg,255],(y*W+x)*4);
            for(let y=43;y<53;y++)for(let x=65;x<85;x++)pixels.set([...ink,255],(y*W+x)*4);
            return {pixels,src,outer:box(58,34,92,62)};
        };

        // 四边均在 8px 内检测到锐利边框：白字绿底与低对比浅字均正确处理
        const tight=makeButton();
        expect(observeImageSourceInk(tight.pixels,W,H,tight.outer,[tight.src])).toEqual({
            background:[0,174,66,255],foreground:'rgb(255,255,255)',inkBoxes:[box(65,43,85,53)],
        });
        const lowContrast=makeButton([20,190,80],[0,174,66]);
        expect(observeImageSourceInk(lowContrast.pixels,W,H,lowContrast.outer,[lowContrast.src])).toEqual({
            background:[0,174,66,255],inkBoxes:[box(65,43,85,53)],
        });

        // 左侧贴边无内边距（padLeft=0 -> roiLeft>=sx0，其余三边仍为绿底）拒绝
        const zeroMargin=makeButton();
        for(let y=36;y<60;y++)for(let x=55;x<60;x++)zeroMargin.pixels.set([255,255,255,255],(y*W+x)*4);
        expect(observeImageSourceInk(zeroMargin.pixels,W,H,zeroMargin.outer,[zeroMargin.src])).toBeUndefined();

        // 1px 外环含透明像素（左右环）拒绝
        const ringAlpha=makeButton();
        ringAlpha.pixels[(45*W+59)*4+3]=128;
        expect(observeImageSourceInk(ringAlpha.pixels,W,H,ringAlpha.outer,[ringAlpha.src])).toBeUndefined();

        // 夹紧 ROI 外周（上下边与左右边）存在杂色拒绝
        const badTop=makeButton();badTop.pixels[(36*W+60)*4]=200;
        expect(observeImageSourceInk(badTop.pixels,W,H,badTop.outer,[badTop.src])).toBeUndefined();
        const badLeft=makeButton();badLeft.pixels[(45*W+55)*4]=200;
        expect(observeImageSourceInk(badLeft.pixels,W,H,badLeft.outer,[badLeft.src])).toBeUndefined();

        // 夹紧 ROI 内部透明、源外杂点、无足够墨迹、混色不共享覆盖率均拒绝
        const innerAlpha=makeButton();innerAlpha.pixels[(48*W+70)*4+3]=200;
        expect(observeImageSourceInk(innerAlpha.pixels,W,H,innerAlpha.outer,[innerAlpha.src])).toBeUndefined();
        const outerSpeck=makeButton();outerSpeck.pixels[(37*W+57)*4]=200;
        expect(observeImageSourceInk(outerSpeck.pixels,W,H,outerSpeck.outer,[outerSpeck.src])).toBeUndefined();
        const emptyInk=makeButton([0,174,66],[0,174,66]);
        expect(observeImageSourceInk(emptyInk.pixels,W,H,emptyInk.outer,[emptyInk.src])).toBeUndefined();
        const mixedInk=makeButton();mixedInk.pixels.set([255,0,0,255],(48*W+70)*4);
        expect(observeImageSourceInk(mixedInk.pixels,W,H,mixedInk.outer,[mixedInk.src])).toBeUndefined();

        // 夹紧 ROI 内颜色超过 4096 上限拒绝
        const wide=260,tall=100,many=new Uint8ClampedArray(wide*tall*4);
        for(let i=0;i<many.length;i+=4)many.set([255,255,255,255],i);
        const bigSrc=box(20,20,240,80);
        for(let y=16;y<84;y++)for(let x=16;x<244;x++)many.set([0,174,66,255],(y*wide+x)*4);
        let n=0;
        for(let y=22;y<78;y++)for(let x=22;x<238;x++,n++)many.set([n&255,(n>>>8)&255,200,255],(y*wide+x)*4);
        expect(observeImageSourceInk(many,wide,tall,box(14,14,246,86),[bigSrc])).toBeUndefined();
    });
});
