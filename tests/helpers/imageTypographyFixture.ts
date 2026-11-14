// 固定5x7字形的独立像素构造器；不依赖本机字体，也不调用生产方向算法。
import type {ImageTextRegion} from '@/src/features/image-translation/paragraphs';
const GLYPHS=['01111/10000/10000/01110/00001/00001/11110','01110/10001/10001/10001/10001/10001/01110','10001/10001/10001/10001/10001/10001/01110','11110/10001/10001/11110/10100/10010/10001','01111/10000/10000/10000/10000/10000/01111','11111/10000/10000/11110/10000/10000/11111'].map(g=>g.split('/'));
export function page(width=640,height=360,background=245){
    const pixels=new Uint8ClampedArray(width*height*4);
    for(let i=0;i<pixels.length;i+=4)pixels.set([background,background,background,255],i);
    return{pixels,width,height};
}
export function word(p:ReturnType<typeof page>,cx=220,cy=80,degrees=-5,scale=3,ink=20):ImageTextRegion {
    const angle=degrees*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle),w=(GLYPHS.length*7-2)*scale,h=7*scale;
    let x0=p.width,y0=p.height,x1=0,y1=0;
    for(let y=0;y<p.height;y++)for(let x=0;x<p.width;x++){
        const u=c*(x+.5-cx)+s*(y+.5-cy)+w/2,v=-s*(x+.5-cx)+c*(y+.5-cy)+h/2;
        if(u<0||v<0||v>=h)continue;
        const glyph=Math.floor(u/(7*scale)),column=Math.floor(u/scale)%7,row=Math.floor(v/scale);
        if(glyph>=GLYPHS.length||column>=5||GLYPHS[glyph][row][column]!=='1')continue;
        p.pixels.set([ink,ink,ink,255],(y*p.width+x)*4);x0=Math.min(x0,x);x1=Math.max(x1,x+1);y0=Math.min(y0,y);y1=Math.max(y1,y+1);
    }
    return{text:'SOURCE',fontSize:h,bbox:{x0:x0-3,y0:y0-3,x1:x1+3,y1:y1+3}};
}
