import {afterEach, describe, expect, it, vi} from 'vitest';
import {createHash} from 'node:crypto';
import {imageMaskBoxes,inpaintTextRegions,planImageGradientRepair} from '@/src/features/image-translation/services/inpainting';
import {ImageAlphaProtectionUnavailableError,type MangaAlphaProtection} from '@/src/features/image-translation/services/mangaAlphaProtection';

function solidPixels(width: number, height: number, color = [180, 200, 220, 255]): Uint8ClampedArray {
    const result = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < result.length; index += 4) result.set(color, index);
    return result;
}

function line(x0: number, y0: number, x1: number, y1: number) {
    return {text: '文字', bbox: {x0, y0, x1, y1}};
}

function protectedRuns(height:number,coordinates:Array<[number,number,number]>):MangaAlphaProtection {
    const sorted=coordinates.slice().sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
    const rowStarts=new Uint32Array(height+1);let cursor=0;
    for(let y=0;y<=height;y++){while(cursor<sorted.length&&sorted[cursor][0]<y)cursor++;rowStarts[y]=cursor;}
    return {runs:Uint16Array.from(sorted.flat()),rowStarts,rectangles:[]};
}

function boundaryFixture(kind: string) {
    const width = 300, height = 120, background = [231, 242, 247, 185];
    const source = solidPixels(width, height, background);
    const pixel = (x: number, y: number, color: number[]) => source.set(color, (y * width + x) * 4);
    for (let y = 35; y < 76; y++) for (let x = 60; x < 76; x++) pixel(x, y, [15, 24, 29, 255]);
    if (kind === 'gray-fringe' || kind === 'color-fringe') {
        const color = kind === 'gray-fringe' ? [245, 245, 245, 255] : [255, 250, 245, 255];
        for (let y = 74; y < 76; y++) for (let x = 60; x < 76; x++) pixel(x, y, color);
    } else if (kind === 'long-rule') {
        for (let x = 45; x < 235; x++) pixel(x, 75, [15, 24, 29, 255]);
    } else if (kind === 'short-icon') {
        for (let y = 69; y < 76; y++) for (let x = 130; x < 138; x++) pixel(x, y, [15, 24, 29, 255]);
    } else if (kind === 'touching-decoration') {
        for (let x = 75; x < 95; x++) pixel(x, 75, [15, 24, 29, 255]);
    } else if (kind === 'isolated-dot') {
        pixel(160, 75, [15, 24, 29, 255]);
    } else if (kind === 'nearby-pattern') {
        pixel(150, 80, [255, 0, 0, 255]);
    } else if (kind === 'gradient') {
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixel(x, y, [220 + Math.floor(x / 15), 231 + Math.floor(x / 15), 236 + Math.floor(x / 15), 185]);
        for (let y = 35; y < 76; y++) for (let x = 60; x < 76; x++) pixel(x, y, [15, 24, 29, 255]);
    } else if (kind === 'alpha-edge') {
        for (let y = 76; y < height; y++) for (let x = 0; x < width; x++) pixel(x, y, [0, 0, 0, 0]);
    } else if (kind === 'outer-texture') {
        pixel(100, 76, [110, 170, 180, 185]);
    } else if (kind.startsWith('channel-')) {
        const channel = Number(kind.slice(-1)), color = [...background];
        color[channel] -= 1;
        for (let y = 74; y < 76; y++) for (let x = 60; x < 76; x++) pixel(x, y, background);
        // 紧邻蒙版的上、下、左、右四段均需完整验证，单字节差异也不可被多数色吞掉。
        const [x, y] = [[100, 25], [100, 74], [35, 45], [244, 45]][channel];
        pixel(x, y, color);
    }
    return {source, width, height, background, boxes: [line(40, 30, 240, 70)]};
}

function knownHoleFixture() {
    const width = 64, height = 48, source = solidPixels(width, height);
    const boxes = [line(16, 12, 44, 16), line(16, 16, 20, 32), line(16, 32, 44, 36), line(40, 16, 44, 32)];
    for (let y = 22; y < 27; y++) for (let x = 27; x < 32; x++) source.set([255, 0, 0, 155], (y * width + x) * 4);
    // 一条红线接触孔洞左边界；仅检查外矩形周长会漏掉它。
    for (let y = 22; y < 27; y++) source.set([255, 0, 0, 155], (y * width + 22) * 4);
    source.set([0, 0, 0, 255], (14 * width + 30) * 4);
    return {source, width, height, boxes};
}

afterEach(() => vi.unstubAllGlobals());

describe('图片文字背景修复', () => {
    it.each([
        [0,1,1,4,4],[12,-1,1,4,4],[12,1,-1,4,4],[12,1,1,2,4],[12,1,1,4,2],
        [12,10,1,4,4],[12,1,10,4,4],[12,1.5,1,4,4],[NaN,1,1,4,4],
    ])('无效渐变范围不建立写入计划：%j',(...args:number[])=>{
        expect(planImageGradientRepair(solidPixels(12,12),...args as [number,number,number,number,number])).toBeUndefined();
    });
    it('渐变计划不写原图，冻结四角颜色并限制目标尺寸和写入边界',()=>{
        const width=16,height=16,source=solidPixels(width,height);
        for(let y=0;y<height;y++)for(let x=0;x<width;x++)source.set([30+x*4,40+y*3,90+x+y,255],(y*width+x)*4);
        const clean=source.slice();source.set([0,0,0,255],(7*width+7)*4);
        const original=source.slice(),repair=planImageGradientRepair(source,width,3,3,10,10,true)!;
        expect(repair).toBeTypeOf('function');expect(source).toEqual(original);
        const wrong=new Uint8ClampedArray(12).fill(37);expect(()=>repair(wrong)).toThrow('尺寸不一致');expect(wrong.every(value=>value===37)).toBe(true);
        source.fill(0);const result=original.slice();repair(result);expect(result).toEqual(clean);
    });
    it.each([0,127,254])('内部 alpha=%s 时不能仅凭不透明渐变外周铺平透明图案',alpha=>{
        const pixels=solidPixels(12,12);
        for(let y=0;y<12;y++)for(let x=0;x<12;x++)pixels.set([50+x,70+y,90,255],(y*12+x)*4);
        pixels[(6*12+6)*4+3]=alpha;const original=pixels.slice();
        expect(planImageGradientRepair(pixels,12,2,2,8,8,true)).toBeUndefined();expect(pixels).toEqual(original);
    });
    it('已判为复杂的同色边界不被渐变专用准入降为纯色；普通修补仍可使用它',()=>{
        const pixels=solidPixels(12,12);
        expect(planImageGradientRepair(pixels,12,2,2,8,8,true)).toBeUndefined();
        expect(planImageGradientRepair(pixels,12,2,2,8,8)).toBeTypeOf('function');
    });
    it('渐变边界中存在透明变化时保持原有alpha扩散，不按不透明底色铺平',()=>{
        const width=64,height=48,pixels=solidPixels(width,height),region=line(16,16,48,32);
        for(let y=0;y<height;y++)for(let x=0;x<width;x++)pixels.set([100+x,120+y,180,255],(y*width+x)*4);
        const [box]=imageMaskBoxes(region,width,height);
        for(let x=box.x0;x<box.x1;x++)pixels[(box.y1*width+x)*4+3]=120;
        const result=inpaintTextRegions(pixels,width,height,[region]);
        expect(result[((box.y1-1)*width+32)*4+3]).toBeLessThan(255);
        expect(result[(box.y1*width+32)*4+3]).toBe(120);
    });
    it('二维渐变清字不产生扩散接缝，修复边界外逐字节不变', () => {
        const width=160,height=100,clean=solidPixels(width,height);
        for(let y=0;y<height;y++)for(let x=0;x<width;x++)clean.set([Math.round(30+x*.6+y*.3),Math.round(80+y*.5),Math.round(170-x*.2),255],(y*width+x)*4);
        const source=clean.slice(),region=line(20,25,140,75);
        for(let y=25;y<75;y++)for(let x=20;x<140;x++)if(x%12<6)source.set([5,5,5,255],(y*width+x)*4);
        const result=inpaintTextRegions(source,width,height,[region]);
        const [box]=imageMaskBoxes(region,width,height);
        let maxError=0;
        for(let y=0;y<height;y++)for(let x=0;x<width;x++)for(let channel=0;channel<4;channel++){
            const index=(y*width+x)*4+channel;
            if(x>=box.x0&&x<box.x1&&y>=box.y0&&y<box.y1)maxError=Math.max(maxError,Math.abs(result[index]-clean[index]));
            else expect(result[index]).toBe(source[index]);
        }
        expect(maxError).toBeLessThanOrEqual(1);
    });
    it('只读上下文的低alpha也不作为种子，纯色仍无队列且不改保护RGBA',()=>{
        const w=64,h=48,p=solidPixels(w,h,[232,219,191,96]),queues:number[]=[],Queue=Uint32Array;
        const r=line(20,20,40,28),hole=(22*w+42)*4;
        // 真实mask为[18,18,42,30)，x42只在其一像素读取上下文。
        p.set([17,53,191,32],hole);p.set([1,3,5,255],(24*w+25)*4);
        const proof=protectedRuns(h,[[22,0,1],[22,2,3],[22,42,43],[22,62,63]]);
        vi.stubGlobal('Uint32Array',class extends Queue {constructor(size:number){super(size);queues.push(size);}});
        const result=inpaintTextRegions(p,w,h,[r],true,proof);
        expect(queues).toEqual([]);expect(Array.from(result.subarray(hole,hole+4))).toEqual([17,53,191,32]);
        expect(Array.from(result.subarray((22*w+41)*4,(22*w+41)*4+4))).toEqual([232,219,191,96]);
        expect(Array.from(result.subarray((24*w+25)*4,(24*w+25)*4+4))).toEqual([232,219,191,96]);
    });
    it.each([false,true])('透明保护闭环不能跨环填纯色，非均匀=%s均拒绝不可达原字岛',nonuniform=>{
        const w=64,h=48,p=solidPixels(w,h),r=line(12,12,52,36),coordinates:Array<[number,number,number]>=[];
        for(let y=16;y<32;y++){
            const spans:Array<[number,number]>=y===16||y===31?[[20,44]]:[[20,21],[43,44]];
            for(const [x0,x1] of spans){coordinates.push([y,x0,x1]);for(let x=x0;x<x1;x++)p.set([17,53,191,0],(y*w+x)*4);}
        }
        p.set([1,3,5,255],(24*w+30)*4);
        if(nonuniform)p.set([181,200,220,255],(9*w+24)*4);
        const before=p.slice(),proof=protectedRuns(h,coordinates);
        expect(()=>inpaintTextRegions(p,w,h,[r],false,proof)).toThrow(ImageAlphaProtectionUnavailableError);
        expect(p).toEqual(before);
    });
    it('实际待修蒙版全部受保护时不分配队列，不写入原RGBA',()=>{
        const w=32,h=24,p=solidPixels(w,h,[17,53,191,0]),before=p.slice(),Queue=Uint32Array,queues:number[]=[];
        const proof=protectedRuns(h,Array.from({length:10},(_,y)=>[y+6,6,20]));
        vi.stubGlobal('Uint32Array',class extends Queue {constructor(size:number){super(size);queues.push(size);}});
        expect(inpaintTextRegions(p,w,h,[line(8,8,18,14)],true,proof)).toBe(p);
        expect(p).toEqual(before);expect(queues).toEqual([]);
    });
    it('非均匀边界仍只采mask0，两个分离簇共同保护孔与隐藏RGB',()=>{
        const w=64,h=48,p=solidPixels(w,h),boxes=[line(10,16,18,26),line(40,16,48,26)];
        const proof=protectedRuns(h,[[20,0,1],[20,12,13],[20,42,43],[20,62,63]]);
        p.set([17,53,191,0],(20*w+12)*4);p.set([27,63,181,32],(20*w+42)*4);
        p.set([181,200,220,255],(13*w+12)*4);p.set([179,200,220,255],(13*w+42)*4);
        const result=inpaintTextRegions(p,w,h,boxes,false,proof);
        expect(Array.from(result.subarray((20*w+12)*4,(20*w+12)*4+4))).toEqual([17,53,191,0]);
        expect(Array.from(result.subarray((20*w+42)*4,(20*w+42)*4+4))).toEqual([27,63,181,32]);
        for(let y=14;y<28;y++)for(const [x0,x1]of [[8,20],[38,50]])for(let x=x0;x<x1;x++){
            if(x===12&&y===20||x===42&&y===20)continue;
            expect(result[(y*w+x)*4+3]).toBe(255);
        }
    });
    it('保护规划复用普通图精确余量与半开边界，不使用漫画字号扩张',()=>{
        expect(imageMaskBoxes({...line(10,10,40,40),fontSize:100},64,48)).toEqual([{x0:7,y0:7,x1:43,y1:43}]);
        expect(imageMaskBoxes({...line(10,10,40,40),sourceBoxes:[line(-1,0,4,4).bbox,line(60,44,68,52).bbox,line(NaN,0,1,1).bbox]},64,48))
            .toEqual([{x0:0,y0:0,x1:6,y1:6},{x0:58,y0:42,x1:64,y1:48}]);
        expect(imageMaskBoxes({...line(10,10,40,40),sourceBoxes:[]},64,48)).toEqual([]);
    });
    it.each([
        ['分离和触图边', [[-2, -2, 8, 8], [60, 60, 72, 72], [30, 20, 40, 30]], '8eb6e03e85b61098bc3f80a55d308193350aa391e407bc441f34e1dbd4f8d034'],
        ['后来桥接', [[10, 10, 20, 20], [35, 10, 45, 20], [19, 10, 36, 20]], '70a03e5e598e7c03179856fbb641d13899201714c0a6e3fa12ce566e6a8ea7e5'],
        ['八邻域角相接', [[10, 10, 20, 20], [24, 24, 34, 34]], 'bdf0a4d17a937c881cc31a33483de88098b07443971d6ea16d603ccecf850545'],
    ] as const)('%s 的半透明渐变逐字节保留基线修补结果', (_name, coordinates, expected) => {
        const source = new Uint8ClampedArray(80 * 80 * 4);
        for (let y = 0; y < 80; y++) for (let x = 0; x < 80; x++) {
            source.set([x * 3, y * 3, (x + y) * 2, (x + y) % 4 === 0 ? 0 : 128], (y * 80 + x) * 4);
        }
        const boxes = coordinates.map(([x0, y0, x1, y1]) => line(x0, y0, x1, y1));
        // 摘要来自性能修改前 55cb1513 的整图蒙版算法，防止局部坐标或簇边界改变颜色/透明度。
        const result = inpaintTextRegions(source, 80, 80, boxes);
        expect(createHash('sha256').update(result).digest('hex')).toBe(expected);
        expect(inpaintTextRegions(source.slice(), 80, 80, boxes, true)).toEqual(result);
    });

    it('可显式复用独占像素，默认仍保留输入；无框时也不复制独占缓冲', () => {
        const source = solidPixels(30, 20);
        source.set([0, 0, 0, 255], (8 * 30 + 12) * 4);
        const boxes = [line(5, 5, 15, 12)];
        const expected = inpaintTextRegions(source, 30, 20, boxes);
        const owned = source.slice();
        expect(inpaintTextRegions(owned, 30, 20, boxes, true)).toBe(owned);
        expect(owned).toEqual(expected);
        expect(source[(8 * 30 + 12) * 4]).toBe(0);
        expect(inpaintTextRegions(owned, 30, 20, [], true)).toBe(owned);
    });

    it('大图稀疏文字只分配局部蒙版，不分配整图蒙版或额外 RGBA 副本', () => {
        const source = solidPixels(1024, 1024);
        const boxes = [line(20, 20, 40, 30), line(900, 900, 920, 910)];
        source.set([0, 0, 0, 255], (25 * 1024 + 30) * 4);
        source.set([0, 0, 0, 255], (905 * 1024 + 910) * 4);
        const masks: number[] = [];
        const Mask = Uint8Array, Pixels = Uint8ClampedArray;
        vi.stubGlobal('Uint8Array', class extends Mask {
            constructor(size: number) {super(size); masks.push(size);}
        });
        const copies = vi.fn();
        vi.stubGlobal('Uint8ClampedArray', class extends Pixels {
            constructor(input: Uint8ClampedArray) {super(input); copies();}
        });
        const output = inpaintTextRegions(source, 1024, 1024, boxes, true);
        expect(output).toBe(source);
        expect(masks).toEqual([26 * 16, 26 * 16]);
        expect(copies).not.toHaveBeenCalled();
        expect(Array.from(output.slice((25 * 1024 + 30) * 4, (25 * 1024 + 30) * 4 + 4))).toEqual([180, 200, 220, 255]);
        expect(Array.from(output.slice((905 * 1024 + 910) * 4, (905 * 1024 + 910) * 4 + 4))).toEqual([180, 200, 220, 255]);
    });

    it('后来的文字桥接两个相邻修复区域，跨簇去重且不改变像素结果', () => {
        const source = solidPixels(60, 60);
        const boxes = [line(8, 8, 16, 16), line(32, 8, 40, 16), line(15, 8, 33, 16), line(8, 32, 16, 40)];
        for (const {bbox} of boxes) source.set([0, 0, 0, 255], (bbox.y0 * 60 + bbox.x0) * 4);
        expect(inpaintTextRegions(source, 60, 60, boxes)).toEqual(solidPixels(60, 60));
        expect(inpaintTextRegions(source, 60, 60, boxes.slice().reverse())).toEqual(solidPixels(60, 60));
    });
    it('小字两像素边缘清理覆盖 OCR 未含的链接下划线，不把绿色向背景扩散', () => {
        const source = solidPixels(60, 25, [255, 255, 255, 255]);
        for (let x = 10; x < 40; x++) source.set([0, 180, 70, 255], (16 * 60 + x) * 4);
        source.set([0, 180, 70, 255], (8 * 60 + 20) * 4);
        expect(inpaintTextRegions(source, 60, 25, [line(10, 6, 40, 15)])).toEqual(solidPixels(60, 25, [255, 255, 255, 255]));
    });
    it('整段排版只擦除源行框，行间图案与短末行旁的像素保持原样', () => {
        const source = solidPixels(60, 40);
        const boxes = [line(5, 5, 45, 13).bbox, line(5, 25, 25, 33).bbox];
        source.set([0, 0, 0, 255], (9 * 60 + 10) * 4);
        source.set([0, 0, 0, 255], (29 * 60 + 10) * 4);
        source.set([255, 0, 0, 255], (19 * 60 + 30) * 4);
        source.set([0, 255, 0, 255], (29 * 60 + 40) * 4);
        const result = inpaintTextRegions(source, 60, 40, [{...line(5, 5, 45, 33), sourceBoxes: boxes}]);
        const pixel = (x: number, y: number) => Array.from(result.slice((y * 60 + x) * 4, (y * 60 + x) * 4 + 4));
        expect(pixel(10, 9)).toEqual([180, 200, 220, 255]);
        expect(pixel(10, 29)).toEqual([180, 200, 220, 255]);
        expect(pixel(30, 19)).toEqual([255, 0, 0, 255]);
        expect(pixel(40, 29)).toEqual([0, 255, 0, 255]);
    });
    it('忽略不安全尺寸、无效边界和图片以外的识别框，始终保持独立输出', () => {
        const source = solidPixels(4, 4);
        for (const [width, height] of [[NaN, 4], [4, Infinity], [1.5, 4], [0, 4], [4, 0], [-1, 4], [10, 10]]) {
            const output = inpaintTextRegions(source, width, height, [line(0, 0, 1, 1)]);
            expect(output).toEqual(source);
            expect(output).not.toBe(source);
        }
        const invalid = [line(NaN, 0, 1, 1), line(2, 0, 1, 1), line(0, 2, 1, 1),
            line(-3, 0, -1, 1), line(0, -3, 1, -1), line(4, 0, 5, 1), line(0, 4, 1, 5)];
        expect(inpaintTextRegions(source, 4, 4, invalid)).toEqual(source);
        expect(inpaintTextRegions(source, 4, 4, [])).toEqual(source);
    });

    it('填满超过旧算法 96 层上限的大字区域，保留蒙版外像素和输入缓冲', () => {
        const width = 400;
        const height = 400;
        const source = solidPixels(width, height);
        for (let y = 75; y < 325; y += 1) {
            for (let x = 75; x < 325; x += 1) source.set([0, 0, 0, 255], (y * width + x) * 4);
        }
        const output = inpaintTextRegions(source, width, height, [line(75, 75, 325, 325)]);
        expect(Array.from(output.slice((200 * width + 200) * 4, (200 * width + 200) * 4 + 4)))
            .toEqual([180, 200, 220, 255]);
        const expected = solidPixels(width, height);
        expect(output.every((value, index) => value === expected[index])).toBe(true);
        expect(source[(200 * width + 200) * 4]).toBe(0);
    });

    it('重叠框只修复一次，输入顺序不影响修复结果', () => {
        const source = solidPixels(30, 20);
        const first = line(5, 5, 15, 12);
        const second = line(10, 6, 25, 13);
        source.set([0, 0, 0, 255], (8 * 30 + 12) * 4);
        const output = inpaintTextRegions(source, 30, 20, [first, second, first]);
        expect(output).toEqual(solidPixels(30, 20));
        expect(output).toEqual(inpaintTextRegions(source, 30, 20, [second, first]));
    });

    it('大量相接源框不反复复制已合并成员，完整输出和邻近图案保持不变', () => {
        const source = solidPixels(12, 12);
        source.set([0, 0, 0, 255], (5 * 12 + 5) * 4);
        source.set([255, 0, 0, 255], (10 * 12 + 10) * 4);
        const boxes = Array.from({length: 5000}, () => line(4, 4, 6, 6));
        const expected = inpaintTextRegions(source, 12, 12, [boxes[0]]);
        const before = source.slice();
        const originalPush = Array.prototype.push;
        let appended = 0;
        let output!: Uint8ClampedArray;
        try {
            // 单独计数实际数组写入，仍调用原 push；同步算法结束后立即恢复。
            Array.prototype.push = function (...values: unknown[]) {
                appended += values.length;
                return originalPush.apply(this, values);
            };
            output = inpaintTextRegions(source, 12, 12, boxes);
        } finally {
            Array.prototype.push = originalPush;
        }
        expect(output).toEqual(expected);
        expect(source).toEqual(before);
        expect(boxes).toHaveLength(5000);
        expect(appended).toBeLessThan(30_000);
    });

    it('透明背景移除原文字的不透明度，预乘插值不会引入透明像素的杂色', () => {
        const transparent = solidPixels(12, 12, [255, 0, 0, 0]);
        transparent.set([0, 0, 0, 255], (6 * 12 + 6) * 4);
        const output = inpaintTextRegions(transparent, 12, 12, [line(4, 4, 8, 8)]);
        expect(Array.from(output.slice((6 * 12 + 6) * 4, (6 * 12 + 6) * 4 + 4))).toEqual([0, 0, 0, 0]);
        expect(Array.from(output.slice(0, 4))).toEqual([255, 0, 0, 0]);

        const translucent = solidPixels(12, 12, [0, 120, 240, 128]);
        translucent.set([0, 0, 0, 255], (6 * 12 + 6) * 4);
        const repaired = inpaintTextRegions(translucent, 12, 12, [line(4, 4, 8, 8)]);
        expect(Array.from(repaired.slice((6 * 12 + 6) * 4, (6 * 12 + 6) * 4 + 4))).toEqual([0, 120, 240, 128]);
    });

    it('图像边缘框仍能扩散，但完全没有已知边界时保留原图', () => {
        const source = solidPixels(12, 12);
        source.set([0, 0, 0, 255], 0);
        expect(inpaintTextRegions(source, 12, 12, [line(-1, -1, 3, 3)])).toEqual(solidPixels(12, 12));
        expect(inpaintTextRegions(source, 12, 12, [line(-1, -1, 13, 13)])).toEqual(source);
    });

    it('对称渐变保持对称，单层的左右处理顺序不会污染相邻像素', () => {
        const source = solidPixels(21, 21);
        for (let y = 0; y < 21; y += 1) {
            for (let x = 0; x < 21; x += 1) source.set([Math.abs(x - 10) * 20, y * 10, 100, 255], (y * 21 + x) * 4);
        }
        const output = inpaintTextRegions(source, 21, 21, [line(7, 7, 14, 14)]);
        for (let y = 6; y < 15; y += 1) {
            for (let x = 6; x < 15; x += 1) expect(output[(y * 21 + x) * 4]).toBe(output[(y * 21 + 20 - x) * 4]);
        }
    });

    it.each([
        ['black-fringe', 'c0a794dd6cd0f74d445a0cc34176aed42524eec43a8ed7a642b988ddf18892a6'], ['gray-fringe', '18ccb52c3f76704661d08f4774730a0c517d3a2d9c4958b629f56d4494b7475e'], ['color-fringe', 'bd00db1a09923db596d1df16eaca50f7486893662a75b6053c1f40d1e640b224'],
        ['long-rule', 'afd095de5d204761a71e8a951e19ea000659e8422d66a70bbeeb7bd170a5999c'], ['short-icon', '54ca5ace82b2fa01fb51a4957923e3a743cb9339f71aecac34e8794df51035a0'], ['touching-decoration', '2ae4955dbb4a38d3a33ff9b78884b1eef531fc007907d4028bb10920de4f48a0'],
        ['isolated-dot', 'e27f487fdcfef48ffc365d7cb7ab818baf5cced50ad9628dbcfd82e76610d298'], ['nearby-pattern', 'a92b2159cf202d26936995febc5ac1433a86181ff3d6b2684569dae45c386bb0'],
        ['gradient', 'f8764f0cb9e1daccf9ef23bef67cea5166cf1d97b340d427cec403cbea56f236'], ['alpha-edge', '9c353db42363ee5b108eba2a47e1ae0b6981730987fdfce493e7a89059fa0e7f'], ['outer-texture', '2e822eacae3a9115b658c14a619e8d8f3f7e10a74d223b4314d93395999b7c75'],
        ['channel-0', '82872665579fdd93242c773aecdfb010b371f1dae61accde2f333b5e3a3fd742'], ['channel-1', 'cdb0778073e31a46d34e2b27c1b7faf9adc146cdfa55cc42412ed08d9e1abd0b'], ['channel-2', 'b76c5c6e2b0308d625de48af7ab34616fb3bdf97ca5ce966f44852c37e1d7c86'], ['channel-3', '206eb909b97a2835ea794b606ba1747d2e681d6f51b6c66777a9f4228971b267'],
    ])('%s：实际已知边界不同则保留旧扩散的完整像素与框外内容', (kind, expected) => {
        const {source, width, height, boxes} = boundaryFixture(kind);
        const before = source.slice();
        const output = inpaintTextRegions(source, width, height, boxes);
        expect(createHash('sha256').update(output).digest('hex')).toBe(expected);
        expect(source).toEqual(before);
        let outsideChanged = 0;
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            if (x >= 36 && x < 244 && y >= 26 && y < 74) continue;
            for (let channel = 0; channel < 4; channel++) {
                const offset = (y * width + x) * 4 + channel;
                if (before[offset] !== output[offset]) outsideChanged++;
            }
        }
        expect(outsideChanged).toBe(0);
    });

    it('远白圈中的黑卡仍使用紧邻黑色底边，白字修复后不把整张卡填白', () => {
        const source = solidPixels(64, 48, [255, 255, 255, 255]);
        for (let y = 16; y < 32; y++) for (let x = 16; x < 44; x++) source.set([0, 0, 0, 255], (y * 64 + x) * 4);
        for (let y = 21; y < 26; y++) for (let x = 23; x < 37; x++) source.set([255, 255, 255, 255], (y * 64 + x) * 4);
        const output = inpaintTextRegions(source, 64, 48, [line(20, 20, 40, 28)]);
        for (let y = 16; y < 32; y++) for (let x = 16; x < 44; x++) expect(Array.from(output.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 4))).toEqual([0, 0, 0, 255]);
    });

    it('真实四边框围出的彩色半透明孔洞属于已知边界，不能被外矩形纯色吞掉', () => {
        const {source, width, height, boxes} = knownHoleFixture(), queues: number[] = [], Queue = Uint32Array;
        vi.stubGlobal('Uint32Array', class extends Queue {constructor(size: number) {super(size); queues.push(size);}});
        const output = inpaintTextRegions(source, width, height, boxes);
        expect(createHash('sha256').update(output).digest('hex')).toBe('61b152f159621f53106b61427013ee7288e72f7492ec00bb36c83f5a3c9ef8f9');
        expect(queues).toHaveLength(1);
        expect(Array.from(output.slice((24 * width + 22) * 4, (24 * width + 22) * 4 + 4))).toEqual([255, 0, 0, 155]);
    });

    it.each([[12, 12], [18, 12], [12, 18], [18, 18]])('薄框的对角已知像素也参与准入：%j', (x, y) => {
        const source = solidPixels(40, 40), Queue = Uint32Array, queues: number[] = [];
        source.set([0, 0, 0, 255], (15 * 40 + 15) * 4);
        source.set([255, 0, 0, 155], (y * 40 + x) * 4);
        vi.stubGlobal('Uint32Array', class extends Queue {constructor(size: number) {super(size); queues.push(size);}});
        const output = inpaintTextRegions(source, 40, 40, [line(15, 15, 16, 16)]);
        expect(queues).toEqual([25]);
        expect(Array.from(output.slice((y * 40 + x) * 4, (y * 40 + x) * 4 + 4))).toEqual([255, 0, 0, 155]);
    });

    it.each([[15, 15, 16, 16], [15, 15, 15.1, 40], [15, 15, 40, 15.1]])('一像素或不足一像素的源框仍有完整周边：%j', (x0, y0, x1, y1) => {
        const source = solidPixels(60, 60), Queue = Uint32Array, queues: number[] = [];
        source.set([0, 0, 0, 255], (15 * 60 + 15) * 4);
        vi.stubGlobal('Uint32Array', class extends Queue {constructor(size: number) {super(size); queues.push(size);}});
        expect(inpaintTextRegions(source, 60, 60, [line(x0, y0, x1, y1)])).toEqual(solidPixels(60, 60));
        expect(queues).toEqual([]);
    });

    it('成员内周被更大蒙版覆盖时不把待擦字误作已知边界', () => {
        const source = solidPixels(60, 60), Queue = Uint32Array, queues: number[] = [];
        source.set([0, 0, 0, 255], (17 * 60 + 17) * 4);
        source.set([255, 0, 0, 155], (23 * 60 + 23) * 4);
        vi.stubGlobal('Uint32Array', class extends Queue {constructor(size: number) {super(size); queues.push(size);}});
        const boxes = [line(20, 20, 21, 21), line(15, 15, 35, 35)];
        expect(inpaintTextRegions(source, 60, 60, boxes)).toEqual(solidPixels(60, 60));
        expect(inpaintTextRegions(source, 60, 60, boxes.slice().reverse())).toEqual(solidPixels(60, 60));
        expect(queues).toEqual([]);
    });

    it.each([[0, 20, 4, 24], [20, 0, 24, 4], [56, 20, 60, 24], [20, 56, 24, 60]])('外圈不完整时保留扩散路径：%j', (x0, y0, x1, y1) => {
        const source = solidPixels(60, 60), Queue = Uint32Array, queues: number[] = [];
        source.set([0, 0, 0, 255], (y0 * 60 + x0) * 4);
        vi.stubGlobal('Uint32Array', class extends Queue {constructor(size: number) {super(size); queues.push(size);}});
        expect(inpaintTextRegions(source, 60, 60, [line(x0, y0, x1, y1)])).toEqual(solidPixels(60, 60));
        expect(queues).toHaveLength(1);
    });

    it('全透明外圈不使用隐藏 RGB 作为背景，保持旧预乘扩散语义', () => {
        const source = solidPixels(60, 60, [255, 10, 20, 0]), queues: number[] = [], Queue = Uint32Array;
        source.set([0, 0, 0, 255], (22 * 60 + 22) * 4);
        vi.stubGlobal('Uint32Array', class extends Queue {constructor(size: number) {super(size); queues.push(size);}});
        const output = inpaintTextRegions(source, 60, 60, [line(20, 20, 24, 24)]);
        expect(Array.from(output.slice((22 * 60 + 22) * 4, (22 * 60 + 22) * 4 + 4))).toEqual([0, 0, 0, 0]);
        expect(queues).toEqual([64]);
    });

    it.each([1, 2, 127, 128, 185, 254, 255])('已知边界 alpha=%i 的常量 RGBA 快填与原逐层扩散相同', alpha => {
        const source = solidPixels(64, 48, [17, 83, 211, alpha]), queues: number[] = [], Queue = Uint32Array;
        source.set([230, 30, 100, 255], (22 * 64 + 30) * 4);
        vi.stubGlobal('Uint32Array', class extends Queue {constructor(size: number) {super(size); queues.push(size);}});
        expect(inpaintTextRegions(source, 64, 48, [line(20, 20, 40, 28)])).toEqual(solidPixels(64, 48, [17, 83, 211, alpha]));
        expect(queues).toEqual([]);
    });

    it('大量重叠框只填去重后的局部蒙版一次，纯色簇不分配队列或额外 RGBA', () => {
        const source = solidPixels(60, 60, [20, 60, 90, 185]), Mask = Uint8Array, Queue = Uint32Array, Pixels = Uint8ClampedArray;
        source.set([0, 0, 0, 255], (22 * 60 + 22) * 4);
        const masks: number[] = [], queues: number[] = [], copies = vi.fn();
        vi.stubGlobal('Uint8Array', class extends Mask {constructor(size: number) {super(size); masks.push(size);}});
        vi.stubGlobal('Uint32Array', class extends Queue {constructor(size: number) {super(size); queues.push(size);}});
        vi.stubGlobal('Uint8ClampedArray', class extends Pixels {constructor(input: Uint8ClampedArray) {super(input); copies();}});
        expect(inpaintTextRegions(source, 60, 60, Array.from({length: 1000}, () => line(20, 20, 24, 24)), true)).toBe(source);
        expect(masks).toEqual([100]);
        expect(queues).toEqual([]);
        expect(copies).not.toHaveBeenCalled();
        expect(Array.from(source.slice((22 * 60 + 22) * 4, (22 * 60 + 22) * 4 + 4))).toEqual([20, 60, 90, 185]);
    });

    it('相邻独立簇逐簇等价快填，紧邻的非均匀边界仍使用原扩散', () => {
        const source = solidPixels(60, 60), boxes = [line(10, 20, 14, 24), line(20, 20, 24, 24)];
        source.set([0, 0, 0, 255], (18 * 60 + 18) * 4);
        source.set([0, 0, 0, 255], (22 * 60 + 16) * 4);
        source.set([0, 0, 0, 255], (22 * 60 + 12) * 4);
        const first = inpaintTextRegions(source, 60, 60, boxes);
        const reversed = inpaintTextRegions(source, 60, 60, boxes.slice().reverse());
        expect(first).toEqual(reversed);
        // 只依据实际紧邻边界，第二簇的快填不会抹去第一簇边界旁的黑色残字影响。
        expect(first[(22 * 60 + 15) * 4]).toBeLessThan(180);
        expect(inpaintTextRegions(source.slice(), 60, 60, boxes, true)).toEqual(first);
    });
});
