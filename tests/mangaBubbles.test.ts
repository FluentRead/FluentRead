import {describe,expect,it} from 'vitest';
import {findMangaBubbles,collectMangaRegions} from '@/src/features/image-translation/services/mangaBubbles';
const image=(w:number,h:number)=>new Uint8ClampedArray(w*h*4);
function rect(p:Uint8ClampedArray,w:number,x:number,y:number,width:number,height:number,color=[255,255,255,255]){for(let yy=y;yy<y+height;yy++)for(let xx=x;xx<x+width;xx++)p.set(color,(yy*w+xx)*4);}
const text=(value:string,x:number,y:number,width=40,height=12)=>({text:value,confidence:.99,box:{x,y,width,height}});
const box=(x:number,y:number,w=80,h=80)=>({x0:x,y0:y,x1:x+w,y1:y+h});
describe('漫画局部气泡识别边界',()=>{
    it('普通截图 Paddle 保留源行供严格段落分组，局部放大结果替换重复检测', () => {
        const page = {results: [text('wrong small', 25, 30), text('Title', 160, 180, 90, 16), text('Body line', 160, 200, 200, 12)],
            bubbles: [{bbox: box(10, 10), results: [text('First', 20, 20), text('second', 20, 34)]}]};
        const lines = collectMangaRegions(page, 'en', 400, 400, 'image');
        expect(lines.map(line => line.text)).toEqual(['First', 'second', 'Title', 'Body line']);
        expect(lines.every(line => line.sourceBoxes === undefined)).toBe(true);
        expect(collectMangaRegions({results: []}, 'en', 400, 400, 'image')).toEqual([]);
    });
    it('拒绝无效尺寸和像素预算，定位封闭浅色气泡而非页面背景',()=>{
        for(const [w,h] of [[0,100],[1.5,100],[100,NaN],[4097,4097],[200,200]])expect(findMangaBubbles(image(1,1),w,h)).toEqual([]);
        const p=image(300,300);rect(p,300,30,40,40,40);rect(p,300,170,150,60,40);rect(p,300,0,0,20,300);
        expect(findMangaBubbles(p,300,300)).toEqual([box(170,150,60,40),box(30,40,40,40)]);
    });
    it('排除四条页面边界、过小、过大、透明和稀疏区域',()=>{
        const p=image(800,800);rect(p,800,0,100,40,40);rect(p,800,100,0,40,40);rect(p,800,760,100,40,40);rect(p,800,100,760,40,40);
        rect(p,800,200,200,29,60);rect(p,800,240,200,60,29);rect(p,800,310,200,30,30);rect(p,800,360,200,350,350);
        rect(p,800,200,400,100,8);rect(p,800,200,400,8,100);rect(p,800,30,600,40,40,[255,255,255,127]);
        rect(p,800,100,600,40,40,[235,255,255,255]);rect(p,800,160,600,40,40,[255,235,255,255]);rect(p,800,220,600,40,40,[255,255,235,255]);
        expect(findMangaBubbles(p,800,800)).toEqual([]);
    });
    it('像素相邻且只使用四邻域，候选最多二十四个',()=>{
        const p=image(900,900);for(let y=0;y<6;y++)for(let x=0;x<6;x++)rect(p,900,10+x*140,10+y*140,35,35);
        expect(findMangaBubbles(p,900,900)).toHaveLength(24);
        const edge=image(100,100);rect(edge,100,0,0,1,100);rect(edge,100,0,0,100,1);rect(edge,100,99,0,1,100);rect(edge,100,0,99,100,1);
        expect(findMangaBubbles(edge,100,100)).toEqual([]);
    });
    it('局部识别替换整页重复结果，不跨气泡拼句',()=>{
        const page={results:[text('small incorrect',25,30),text('Outside caption',160,180)],bubbles:[{bbox:box(10,10),results:[text('Hello',20,20),text('world',20,36)]}]};
        expect(collectMangaRegions(page,'en',400,400).map(r=>r.text)).toEqual(['Hello world','Outside caption']);
        expect(collectMangaRegions({results:page.results},'en',400,400)).toHaveLength(2);
    });
    it('对白较多时只保留外部完整旁白，空气泡和拟声碎片不进入翻译',()=>{
        const page={results:[text('Noise',150,200),text('short',150,240),text('row',150,254),text('Reliable caption',200,290),text('second line',200,306),text('Below',25,90),text('Left',0,30),text('Right',90,30)],
            bubbles:[{bbox:box(10,10),results:[text('Hello',20,20)]},{bbox:box(200,10),results:[text('Again',210,20)]},{bbox:box(10,110),results:[]}]};
        const regions=collectMangaRegions(page,'en',400,400);
        expect(regions.map(r=>r.text)).toEqual(['Again','Hello','Reliable caption second line']);
        expect(collectMangaRegions({results:[],bubbles:[{bbox:box(10,10),results:[]}]},'en',400,400)).toEqual([]);
    });
});
