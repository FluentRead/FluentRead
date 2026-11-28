import {describe,expect,it} from 'vitest';
import {planMangaOcrDeskew,trimMangaOcrDeskew} from '@/src/features/image-translation/services/mangaOcrDeskew';

function pixels(width=400,height=100,background=[255,255,255]){
    const data=new Uint8ClampedArray(width*height*4);
    for(let i=0;i<data.length;i+=4)data.set([...background,255],i);
    return {width,height,data};
}
function line(degrees=10,thickness=8,width=400,height=100){
    const image=pixels(width,height),slope=Math.tan(degrees*Math.PI/180);
    for(let x=20;x<width-20;x++)for(let dy=0;dy<thickness;dy++){
        const y=Math.round(height/2+(x-width/2)*slope)+dy-Math.floor(thickness/2);
        if(y>=0&&y<height)image.data.set([0,0,0,255],(y*width+x)*4);
    }
    return image;
}
describe('纯像素漫画斜行几何',()=>{
    it.each([10,-10])('从实际墨迹估计%s度基线，留足旋转边界且不改变输入',degrees=>{
        const image=line(degrees),before=image.data.slice(),plan=planMangaOcrDeskew(image.data,image.width,image.height)!;
        expect(plan.radians*180/Math.PI).toBeCloseTo(degrees,1);
        expect(plan.width).toBeGreaterThan(image.width);expect(plan.height).toBeGreaterThan(image.height);
        expect(image.data).toEqual(before);
    });
    it.each([[NaN,100],[400,1.5],[119,100],[400,19],[200,100],[5000,500],[400,100]])('拒绝非法/短/竖/超预算或不完整缓冲 %s×%s',(width,height)=>{
        expect(planMangaOcrDeskew(new Uint8ClampedArray(),width,height)).toBeUndefined();
    });
    it('空白、稀疏线条、暗底与彩色墨迹不会触发文字复识别',()=>{
        const blank=pixels();expect(planMangaOcrDeskew(blank.data,400,100)).toBeUndefined();
        const sparse=pixels(3000,600);for(let x=10;x<100;x++)sparse.data.set([0,0,0,255],(x*3000+x)*4);
        expect(planMangaOcrDeskew(sparse.data,3000,600)).toBeUndefined();
        const dark=pixels(400,100,[150,150,150]);dark.data.fill(0,0,1000);
        expect(planMangaOcrDeskew(dark.data,400,100)).toBeUndefined();
        const colored=line();for(let i=0;i<colored.data.length;i+=4){if(colored.data[i]===0)colored.data[i+1]=255;}
        colored.data.set([0,0,255,255],0);colored.data.set([255,0,0,255],4);
        expect(planMangaOcrDeskew(colored.data,400,100)).toBeUndefined();
        const warm=pixels(400,100,[255,255,230]);expect(planMangaOcrDeskew(warm.data,400,100)).toBeUndefined();
    });
    it.each([0,2,20])('接近水平和过度倾斜保留原处理：%s度',degrees=>{
        const image=line(degrees);expect(planMangaOcrDeskew(image.data,400,100)).toBeUndefined();
    });
    it('多条墨迹占满框高时拒绝估角，避免把插画当作紧凑行',()=>{
        const image=pixels(1000,300),slope=Math.tan(Math.PI/18);
        for(const offset of [-95,95])for(let x=100;x<900;x++)for(let dy=0;dy<4;dy++){
            const y=Math.round(150+(x-500)*slope*.5)+offset+dy;
            image.data.set([0,0,0,255],(y*1000+x)*4);
        }
        expect(planMangaOcrDeskew(image.data,image.width,image.height)).toBeUndefined();
    });
    it('旋转后像素超预算的宽白边输入不分配大画布',()=>{
        const image=line(10,10,4000,200);
        expect(planMangaOcrDeskew(image.data,image.width,image.height)).toBeUndefined();
    });
    it('旋转后的完整墨迹加边距，夹紧边界且字高改善不足时不重试',()=>{
        const centered=line(0,8),before=centered.data.slice();
        expect(trimMangaOcrDeskew(centered.data,400,100,100)).toEqual({x:18,y:44,width:364,height:12});
        expect(centered.data).toEqual(before);
        const edge=pixels(200,50);for(let x=0;x<200;x++)edge.data.set([0,0,0,255],x*4);
        expect(trimMangaOcrDeskew(edge.data,200,50,50)).toEqual({x:0,y:0,width:200,height:3});
        expect(trimMangaOcrDeskew(centered.data,400,100,10)).toBeUndefined();
        const narrow=pixels();narrow.data.set([0,0,0,255],0);
        expect(trimMangaOcrDeskew(narrow.data,400,100,100)).toBeUndefined();
        const blank=pixels();expect(trimMangaOcrDeskew(blank.data,400,100,100)).toBeUndefined();
    });
    it.each([[NaN,100,100],[400,1.5,100],[400,100,NaN],[0,100,100],[400,0,100],[400,100,0],[4000,1000,100],[400,100,100]])('裁白边拒绝无效缓冲与尺寸%s×%s/%s',(width,height,originalHeight)=>{
        expect(trimMangaOcrDeskew(new Uint8ClampedArray(),width,height,originalHeight)).toBeUndefined();
    });
    it.each([[255,0,0],[180,180,180],[255,255,180]])('裁白边同时保留深色和%s前景，不以置信度掩盖整词裁丢',(...shade)=>{
        const image=pixels();
        for(let x=120;x<380;x++)for(let y=45;y<53;y++)image.data.set([0,0,0,255],(y*400+x)*4);
        for(let x=20;x<70;x++)for(let y=45;y<53;y++)image.data.set([...shade,255],(y*400+x)*4);
        expect(trimMangaOcrDeskew(image.data,400,100,100)).toEqual({x:18,y:43,width:364,height:12});
    });
    it.each([[239,239,239],[255,239,235],[235,235,239]])('旋转后的黑前缀不能遮盖%s浅色尾字的完整像素支撑',(...shade)=>{
        const image=pixels();
        for(let y=45;y<53;y++){
            for(let x=20;x<160;x++)image.data.set([0,0,0,255],(y*400+x)*4);
            for(let x=200;x<380;x++)image.data.set([...shade,255],(y*400+x)*4);
        }
        const before=image.data.slice(),trim=trimMangaOcrDeskew(image.data,400,100,100)!;
        expect(trim).toEqual({x:18,y:43,width:364,height:12});
        for(let y=0;y<100;y++)for(let x=0;x<400;x++){
            const index=(y*400+x)*4;
            if(image.data[index]>=240&&image.data[index+1]>=240&&image.data[index+2]>=240&&image.data[index+3]===255)continue;
            expect(x>=trim.x&&x<trim.x+trim.width&&y>=trim.y&&y<trim.y+trim.height).toBe(true);
        }
        expect(image.data).toEqual(before);
    });
    it.each([[240,240,240],[245,245,245],[255,250,245],[254,254,254]])('不透明近白 JPEG 底噪%s会被裁除，使压缩漫画斜行成功复识别',(...shade)=>{
        const image=pixels(400,100,shade);
        for(let x=20;x<380;x++)for(let y=45;y<53;y++)image.data.set([0,0,0,255],(y*400+x)*4);
        const before=image.data.slice();
        expect(trimMangaOcrDeskew(image.data,400,100,100)).toEqual({x:18,y:43,width:364,height:12});
        expect(image.data).toEqual(before);
    });
    it('半透明近白像素与非近白边缘噪点仍作为前景保留，字高改善不足时保守回原框',()=>{
        const semi=pixels();
        for(let y=45;y<53;y++){
            for(let x=20;x<70;x++)semi.data.set([0,0,0,255],(y*400+x)*4);
            for(let x=200;x<380;x++)semi.data.set([250,250,250,200],(y*400+x)*4);
        }
        expect(trimMangaOcrDeskew(semi.data,400,100,100)).toEqual({x:18,y:43,width:364,height:12});
        const noisy=pixels();
        for(let x=20;x<380;x++)for(let y=45;y<53;y++)noisy.data.set([0,0,0,255],(y*400+x)*4);
        noisy.data.set([239,239,239,255],20*4);
        noisy.data.set([230,235,239,255],(99*400+379)*4);
        const before=noisy.data.slice();
        expect(trimMangaOcrDeskew(noisy.data,400,100,100)).toBeUndefined();
        expect(noisy.data).toEqual(before);
    });
    it('短黑前缀不足最小裁宽时，完整浅灰尾字仍按真实整行宽度保留',()=>{
        const image=pixels();
        for(let y=45;y<53;y++){
            for(let x=20;x<70;x++)image.data.set([0,0,0,255],(y*400+x)*4);
            for(let x=200;x<380;x++)image.data.set([235,235,235,255],(y*400+x)*4);
        }
        // 阈值以下的浅灰前景支撑可使同一行满足既有最小宽度。
        expect(trimMangaOcrDeskew(image.data,400,100,100)).toEqual({x:18,y:43,width:364,height:12});
    });
    it('支持直接从整图 RGBA 缓冲按 (pageWidth, x0, y0, width, height) 零画布估角',()=>{
        const pageWidth=600,pageHeight=240,page=pixels(pageWidth,pageHeight,[30,30,30]);
        const sub=line(10,8,400,100);
        const ox=80,oy=60;
        for(let y=0;y<sub.height;y++)for(let x=0;x<sub.width;x++){
            const src=(y*sub.width+x)*4,dst=((oy+y)*pageWidth+ox+x)*4;
            page.data[dst]=sub.data[src];page.data[dst+1]=sub.data[src+1];page.data[dst+2]=sub.data[src+2];page.data[dst+3]=sub.data[src+3];
        }
        const direct=planMangaOcrDeskew(sub.data,sub.width,sub.height);
        const fromPage=planMangaOcrDeskew(page.data,pageWidth,ox,oy,sub.width,sub.height);
        expect(fromPage).toEqual(direct);
        // 越界、负偏移、非整行缓冲长度及非整数参数均拒绝
        expect(planMangaOcrDeskew(page.data,pageWidth,-1,oy,400,100)).toBeUndefined();
        expect(planMangaOcrDeskew(page.data,pageWidth,ox,-1,400,100)).toBeUndefined();
        expect(planMangaOcrDeskew(page.data,pageWidth,201,oy,400,100)).toBeUndefined();
        expect(planMangaOcrDeskew(page.data,pageWidth,ox,141,400,100)).toBeUndefined();
        expect(planMangaOcrDeskew(page.data.subarray(0,page.data.length-4),pageWidth,ox,oy,400,100)).toBeUndefined();
        expect(planMangaOcrDeskew(page.data,0,0,0,400,100)).toBeUndefined();
        expect(planMangaOcrDeskew(page.data,pageWidth,ox,oy,400,undefined as unknown as number)).toBeUndefined();
    });
});
