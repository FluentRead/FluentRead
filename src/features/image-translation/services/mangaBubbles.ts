/**
 * @file src/features/image-translation/services/mangaBubbles.ts
 * 文件职责：从漫画像素定位封闭浅色气泡，让小字以局部高分辨率识别并排除绘画噪声。
 * 主要内容：以四邻域扫描亮色连通区域，排除页面边缘、过小、过大和稀疏背景，最多返回二十四个局部区域；漫画单独合并每个气泡中的识别行并保留气泡外可靠旁白；普通图片去重局部结果后保留物理行，不套用漫画分组间距。
 * 模块边界：纯像素和坐标算法，不创建 Canvas、不访问网络、不运行模型；气泡本身不作为文字证据，只有后续识别出的有效文本进入翻译。
 */
import {groupMangaText,type MangaOcrItem,type MangaRegion} from './mangaRegions';
type Box=MangaRegion['bbox'];
export interface MangaOcrPage {results:MangaOcrItem[];bubbles?:Array<{bbox:Box;results:MangaOcrItem[]}>}

export function findMangaBubbles(pixels:Uint8ClampedArray,width:number,height:number):Box[]{
    const count=width*height;
    if(![width,height].every(v=>Number.isSafeInteger(v)&&v>0)||count>16_777_216||pixels.length<count*4)return [];
    const white=new Uint8Array(count),queue=new Uint32Array(count);
    for(let i=0;i<count;i++){const p=i*4;white[i]=Number(pixels[p]>235&&pixels[p+1]>235&&pixels[p+2]>235&&pixels[p+3]>=128);}
    const candidates:Array<{bbox:Box;area:number}>=[];
    for(let start=0;start<count;start++){
        if(!white[start])continue;
        let head=0,tail=1,left=width,top=height,right=0,bottom=0;queue[0]=start;white[start]=0;
        const add=(index:number)=>{if(white[index]){white[index]=0;queue[tail++]=index;}};
        while(head<tail){
            const index=queue[head++],x=index%width,y=Math.floor(index/width);
            left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
            if(x>0)add(index-1);if(x+1<width)add(index+1);if(y>0)add(index-width);if(y+1<height)add(index+width);
        }
        const w=right-left+1,h=bottom-top+1;
        if(left===0||top===0||right===width-1||bottom===height-1||w<30||h<30||tail<1000||tail/(w*h)<.45||tail>count*.15)continue;
        candidates.push({bbox:{x0:left,y0:top,x1:right+1,y1:bottom+1},area:tail});
    }
    return candidates.sort((a,b)=>b.area-a.area).slice(0,24).map(item=>item.bbox);
}

/** 不跨气泡拼句；对白较多时，只保留气泡之外的整段旁白，避免把拟声字当成孤立台词。 */
export function collectMangaRegions(page:MangaOcrPage,language:string,width:number,height:number,profile: 'manga' | 'image' = 'manga'):MangaRegion[]{
    const bubbles=page.bubbles??[];
    if (profile === 'image') {
        // 普通截图不能套用漫画宽松气泡间距：保留可靠物理行，交给普通段落策略合并。
        const outside = page.results.filter(item => !bubbles.some(({bbox}) => {
            const x = item.box.x + item.box.width / 2, y = item.box.y + item.box.height / 2;
            return x >= bbox.x0 && x < bbox.x1 && y >= bbox.y0 && y < bbox.y1;
        }));
        return [...outside, ...bubbles.flatMap(bubble => bubble.results)]
            .flatMap(item => groupMangaText([item],language,width,height))
            .map(({sourceBoxes: _boxes, ...line}) => line)
            .sort((a,b) => a.bbox.y0-b.bbox.y0 || a.bbox.x0-b.bbox.x0);
    }
    const paragraphs=bubbles.map(bubble=>groupMangaText(bubble.results,language,width,height));
    const dialogue=paragraphs.filter(regions=>regions.length>0).length>=2;
    const outside=groupMangaText(page.results,language,width,height).filter(region=>{
        const x=(region.bbox.x0+region.bbox.x1)/2,y=(region.bbox.y0+region.bbox.y1)/2;
        if(bubbles.some(({bbox:b})=>x>=b.x0&&x<b.x1&&y>=b.y0&&y<b.y1))return false;
        return !dialogue||(region.sourceBoxes!.length>=2&&region.text.length>=12);
    });
    return [...outside,...paragraphs.flat()].sort((a,b)=>a.bbox.y0-b.bbox.y0||b.bbox.x0-a.bbox.x0);
}
