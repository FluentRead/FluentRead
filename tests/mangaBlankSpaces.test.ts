/** 纯像素空白候选的实际安全边缘、归属、障碍并集、预算和直方图搜索回归；不运行 OCR、模型或 Canvas。 */
import {describe,expect,it,vi} from 'vitest';
import {findMangaBlankSpaces,MANGA_BLANK_SPACE_PAGE_PIXELS,type MangaBlankSpaceBox,type MangaBlankSpaceBudget} from '@/src/features/image-translation/services/mangaBlankSpaces';

function fixture(width=14,height=14,owner:MangaBlankSpaceBox={x0:2,y0:2,x1:12,y1:12}){
    const pixels=new Uint8ClampedArray(width*height*4);
    const set=(x:number,y:number,color:readonly number[]=[255,255,255,255])=>pixels.set(color,(y*width+x)*4);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++)set(x,y,[30,30,30,255]);
    for(let y=owner.y0;y<owner.y1;y++)for(let x=owner.x0;x<owner.x1;x++)set(x,y);
    return {width,height,owner,pixels,set};
}
type Fixture=ReturnType<typeof fixture>;
const budget=(remainingPixels=MANGA_BLANK_SPACE_PAGE_PIXELS):MangaBlankSpaceBudget=>({remainingPixels});
const run=(f:Fixture,obstacles:readonly MangaBlankSpaceBox[]=[],b=budget(),cancel?:()=>void)=>findMangaBlankSpaces(f.pixels,f.width,f.height,f.owner,obstacles,b,cancel);
const area=(box:MangaBlankSpaceBox)=>(box.x1-box.x0)*(box.y1-box.y0);
function expectSafe(f:Fixture,boxes:MangaBlankSpaceBox[],obstacles:readonly MangaBlankSpaceBox[]=[]){
    expect(boxes.length).toBeLessThanOrEqual(32);expect(new Set(boxes.map(box=>JSON.stringify(box))).size).toBe(boxes.length);
    expect(boxes.map(area)).toEqual(boxes.map(area).sort((a,b)=>b-a));
    for(const box of boxes){
        expect(area(box)).toBeGreaterThan(0);
        for(let y=box.y0-1;y<=box.y1;y++)for(let x=box.x0-1;x<=box.x1;x++){
            expect(x).toBeGreaterThanOrEqual(f.owner.x0);expect(x).toBeLessThan(f.owner.x1);expect(y).toBeGreaterThanOrEqual(f.owner.y0);expect(y).toBeLessThan(f.owner.y1);
            expect(Array.from(f.pixels.subarray((y*f.width+x)*4,(y*f.width+x)*4+4))).toEqual([255,255,255,255]);
            expect(obstacles.some(b=>x>=Math.floor(b.x0)&&x<Math.ceil(b.x1)&&y>=Math.floor(b.y0)&&y<Math.ceil(b.y1))).toBe(false);
        }
    }
}

describe('保留源墨迹的漫画纯白排版候选',()=>{
    it('为唯一封闭气泡返回带完整一像素边缘的最大矩形，不改变任何输入',()=>{
        const f=fixture(),before=f.pixels.slice(),owner={...f.owner},b=budget(),result=run(f,[],b);
        expect(result).toEqual([{x0:3,y0:3,x1:11,y1:11}]);expectSafe(f,result);expect(f.pixels).toEqual(before);expect(f.owner).toEqual(owner);
        expect(b.remainingPixels).toBe(MANGA_BLANK_SPACE_PAGE_PIXELS-144);result[0].x0=99;expect(f.owner).toEqual(owner);
    });
    it('只返回完整小空白，不要求气泡占整页15%或将原墨迹擦掉',()=>{
        const f=fixture(7,7,{x0:2,y0:2,x1:5,y1:5});expect(run(f)).toEqual([{x0:3,y0:3,x1:4,y1:4}]);
    });
    it.each([[245,245,245,255],[255,254,255,255],[255,255,254,255],[254,255,255,255],[255,255,255,254],[0,0,0,255]])('未知颜色或alpha %j及其完整边缘都不可写',(...color)=>{
        const f=fixture();f.set(7,7,color);const before=f.pixels.slice(),result=run(f);expect(result.length).toBeGreaterThan(0);expectSafe(f,result);expect(f.pixels).toEqual(before);
    });
    it.each([235,236,245])('亮度%s不会被升级成纯白写入许可',gray=>{
        const f=fixture();for(let y=2;y<12;y++)for(let x=2;x<12;x++)f.set(x,y,[gray,gray,gray,255]);expect(run(f)).toEqual([]);
    });
    it.each([[255,235,255,255],[255,255,235,255],[255,255,255,0]])('非亮或非不透明通道%j不能作为归属组件',(...color)=>{
        const f=fixture();for(let y=2;y<12;y++)for(let x=2;x<12;x++)f.set(x,y,color);expect(run(f)).toEqual([]);
    });
    it('封闭黑环中的纯白岛不属于外部气泡，不能借RGB相同成为可写候选',()=>{
        const f=fixture(24,24,{x0:2,y0:2,x1:22,y1:22});
        for(let y=7;y<=16;y++)for(let x=7;x<=16;x++)if(x===7||x===16||y===7||y===16)f.set(x,y,[0,0,0,255]);
        const result=run(f);expect(result.length).toBeGreaterThan(0);expectSafe(f,result);
        expect(result.some(box=>box.x0<16&&8<box.x1&&box.y0<16&&8<box.y1)).toBe(false);
    });
    it.each(['left','right','top','bottom'] as const)('气泡向%s外周开放时拒绝候选，已读像素预算不返还',side=>{
        const f=fixture(),b=budget(144);f.set(side==='left'?1:side==='right'?12:7,side==='top'?1:side==='bottom'?12:7);
        expect(run(f,[],b)).toEqual([]);expect(b.remainingPixels).toBe(0);
    });
    it('四邻域不会把仅对角接触的另一个亮组件并入owner',()=>{
        const f=fixture();f.set(1,1);expect(run(f)).toEqual([{x0:3,y0:3,x1:11,y1:11}]);
    });
    it('建议owner必须与实际亮组件完全同界，不以其内部子矩形代替归属',()=>{
        const f=fixture(),b=budget(100);expect(findMangaBlankSpaces(f.pixels,14,14,{x0:3,y0:3,x1:11,y1:11},[],b)).toEqual([]);expect(b.remainingPixels).toBe(0);
        f.pixels.fill(0);expect(run(f)).toEqual([]);
    });
    it('浮点、相交、重复及图外障碍保守合并，顺序不改变结果或原框',()=>{
        const f=fixture(),obstacles=[{x0:5.8,y0:5.2,x1:7.1,y1:7.7},{x0:6,y0:6,x1:8,y1:9},{x0:-100,y0:-100,x1:1,y1:1},{x0:100,y0:100,x1:110,y1:110}],before=JSON.stringify(obstacles);
        const result=run(f,obstacles);expect(result.length).toBeGreaterThan(0);expectSafe(f,result,obstacles);expect(run(f,[...obstacles].reverse())).toEqual(result);expect(run(f,[...obstacles,obstacles[0]])).toEqual(result);expect(JSON.stringify(obstacles)).toBe(before);
        expect(run(f,[{x0:-100,y0:-100,x1:100,y1:100}])).toEqual([]);
    });
    it('一页多次查询先扣完整halo，失败不重置或退款，预算不足不开始扫描',()=>{
        const f=fixture(),b=budget(288);expect(run(f,[],b)).toHaveLength(1);expect(b.remainingPixels).toBe(144);expect(run(f,[],b)).toHaveLength(1);expect(b.remainingPixels).toBe(0);expect(run(f,[],b)).toEqual([]);expect(b.remainingPixels).toBe(0);
        const short=budget(143);expect(run(f,[],short)).toEqual([]);expect(short.remainingPixels).toBe(143);
    });
    it('只读或不实际扣费的预算对象不能放行源像素查询',()=>{
        const f=fixture();expect(run(f,[],Object.freeze(budget()))).toEqual([]);
        const ignored={get remainingPixels(){return 144;},set remainingPixels(_value:number){}};expect(run(f,[],ignored)).toEqual([]);
    });
    it('最大65536像素halo被完整计费，长扫描有界轮询取消',()=>{
        const f=fixture(258,258,{x0:1,y0:1,x1:255,y1:255}),b=budget(),cancel=vi.fn(),result=run(f,[],b,cancel);
        expect(result).toEqual([{x0:2,y0:2,x1:254,y1:254}]);expect(b.remainingPixels).toBe(MANGA_BLANK_SPACE_PAGE_PIXELS-65536);expect(cancel.mock.calls.length).toBeGreaterThan(10);expect(cancel.mock.calls.length).toBeLessThan(200);
    });
    it('取消保留同一个原始异常，预取消不扣费，已准入扫描取消不返还',()=>{
        const f=fixture(),error=Object.assign(new Error('cancelled'),{name:'AbortError'}),before=budget();expect(()=>run(f,[],before,()=>{throw error;})).toThrow(error);expect(before.remainingPixels).toBe(MANGA_BLANK_SPACE_PAGE_PIXELS);
        const during=budget();let calls=0;expect(()=>run(f,[],during,()=>{if(++calls===2)throw error;})).toThrow(error);expect(during.remainingPixels).toBe(MANGA_BLANK_SPACE_PAGE_PIXELS-144);
        const large=fixture(100,100,{x0:2,y0:2,x1:90,y1:90}),b=budget();let ticks=0;expect(()=>run(large,[],b,()=>{if(++ticks===3)throw error;})).toThrow(error);expect(b.remainingPixels).toBe(MANGA_BLANK_SPACE_PAGE_PIXELS-8100);
    });
    it('候选不超过32，后来更大空间可替换早先小空间，同面积发现顺序稳定',()=>{
        const f=fixture(70,82,{x0:2,y0:2,x1:68,y1:80}),obstacles:MangaBlankSpaceBox[]=[];
        for(let x=8;x<68;x+=7)obstacles.push({x0:x,y0:2,x1:x+1,y1:44});
        for(let y=8;y<44;y+=7)obstacles.push({x0:2,y0:y,x1:68,y1:y+1});
        const result=run(f,obstacles);expect(result).toHaveLength(32);expect(area(result[0])).toBeGreaterThanOrEqual(64*34);expectSafe(f,result,obstacles);expect(run(f,obstacles)).toEqual(result);
    });
    it('微小确定性源图的最大候选与独立穷举安全矩形一致',()=>{
        for(let seed=0;seed<6;seed++){
            const f=fixture(12,12,{x0:2,y0:2,x1:10,y1:10});for(let n=0;n<3;n++)f.set(3+(seed*3+n*2)%5,3+(seed+n*3)%5,[245,245,245,255]);
            const safe=(x:number,y:number)=>{for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const xx=x+dx,yy=y+dy;if(xx<2||xx>=10||yy<2||yy>=10)return false;const p=(yy*12+xx)*4;if(![0,1,2,3].every(c=>f.pixels[p+c]===255))return false;}return true;};
            let maximum=0;for(let top=3;top<9;top++)for(let bottom=top+1;bottom<=9;bottom++)for(let left=3;left<9;left++)for(let right=left+1;right<=9;right++){
                let blank=true;for(let y=top;y<bottom;y++)for(let x=left;x<right;x++)if(!safe(x,y))blank=false;if(blank)maximum=Math.max(maximum,(right-left)*(bottom-top));
            }
            const result=run(f);expect(result.length?area(result[0]):0).toBe(maximum);expectSafe(f,result);
        }
    });
    it.each([undefined,null,{x0:NaN,y0:2,x1:12,y1:12},{x0:2,y0:Infinity,x1:12,y1:12},{x0:3,y0:2,x1:3,y1:12},{x0:2,y0:3,x1:12,y1:3}])('无效障碍%j不读取或计费',value=>{
        const f=fixture(),b=budget();expect(run(f,[value as MangaBlankSpaceBox],b)).toEqual([]);expect(b.remainingPixels).toBe(MANGA_BLANK_SPACE_PAGE_PIXELS);
    });
    it('过多或非数组障碍、无效预算与错误RGBA类型均拒绝',()=>{
        const f=fixture();expect(run(f,Array(8193).fill(f.owner))).toEqual([]);expect(run(f,{} as MangaBlankSpaceBox[])).toEqual([]);
        for(const b of [undefined,null,budget(-1),budget(.5),budget(NaN),budget(Infinity),budget(MANGA_BLANK_SPACE_PAGE_PIXELS+1)])expect(findMangaBlankSpaces(f.pixels,14,14,f.owner,[],b as MangaBlankSpaceBudget)).toEqual([]);
        expect(findMangaBlankSpaces(new Uint8Array(f.pixels) as unknown as Uint8ClampedArray,14,14,f.owner,[],budget())).toEqual([]);
        expect(findMangaBlankSpaces(new Uint8ClampedArray(3),14,14,f.owner,[],budget())).toEqual([]);
    });
    it.each([[0,14],[-1,14],[14,0],[14,-1],[1.5,14],[NaN,14],[14,Infinity],[8193,14],[14,8193],[5000,5000]])('无效或过大图像%s×%s拒绝', (width,height)=>{
        const f=fixture();expect(findMangaBlankSpaces(f.pixels,width,height,f.owner,[],budget())).toEqual([]);
    });
    it.each([undefined,{x0:NaN,y0:2,x1:12,y1:12},{x0:2.5,y0:2,x1:12,y1:12},{x0:0,y0:2,x1:12,y1:12},{x0:2,y0:0,x1:12,y1:12},{x0:2,y0:2,x1:14,y1:12},{x0:2,y0:2,x1:12,y1:14},{x0:2,y0:2,x1:4,y1:12},{x0:2,y0:2,x1:12,y1:4}])('无效、触边或过薄owner%j拒绝且不计费',owner=>{
        const f=fixture(),b=budget();expect(findMangaBlankSpaces(f.pixels,14,14,owner as MangaBlankSpaceBox,[],b)).toEqual([]);expect(b.remainingPixels).toBe(MANGA_BLANK_SPACE_PAGE_PIXELS);
    });
    it('owner加halo超过单次65536上限时不扫描也不扣费',()=>{
        const f=fixture(260,260,{x0:1,y0:1,x1:259,y1:259}),b=budget();expect(run(f,[],b)).toEqual([]);expect(b.remainingPixels).toBe(MANGA_BLANK_SPACE_PAGE_PIXELS);
    });
});
