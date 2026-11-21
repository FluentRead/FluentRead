/**
 * @file src/features/image-translation/services/mangaRecognitionConnectedBands.ts
 * 文件职责：在紧裁文字的颜色强度图中定位横向投影可能重叠的独立字形。
 * 主要内容：在三层墨色阈值下验证八邻域连通块、共同字形顺序和逐层包含关系。仅接受同一水平行中贯穿中段的部件，允许相邻包围框重叠至多两列。三层共用组件余额及同一批临时索引。
 * 模块边界：输入来自已确认同一颜色混合关系的48像素高裁图。连通几何不识别具体文字、不授权擦除，词隙还须满足完整背景空列并与原模型字序一致。
 */
export const MAX_CONNECTED_RECOGNITION_PIXELS=65_536;
const CROP_HEIGHT=48;

interface GlyphBounds {start:number;end:number;top:number;bottom:number}

function collectGlyphs(strength:Uint8Array,width:number,threshold:number,visited:Uint8Array,queue:Uint16Array,
    budget:{remaining:number}):GlyphBounds[]|undefined {
    visited.fill(0);
    const glyphs:GlyphBounds[]=[];
    for(let index=0;index<strength.length;index++){
        if(visited[index]||strength[index]<threshold)continue;
        if(budget.remaining<=0||glyphs.length===64)return;
        budget.remaining--;
        let next=0,finish=1;
        queue[0]=index;
        visited[index]=1;
        let start=width,end=0,top=CROP_HEIGHT,bottom=0;
        while(next<finish){
            const position=queue[next++],x=position%width,y=Math.floor(position/width);
            start=Math.min(start,x);end=Math.max(end,x+1);
            top=Math.min(top,y);bottom=Math.max(bottom,y+1);
            for(let row=Math.max(0,y-1);row<Math.min(CROP_HEIGHT,y+2);row++){
                for(let column=Math.max(0,x-1);column<Math.min(width,x+2);column++){
                    const neighbor=row*width+column;
                    if(visited[neighbor]||strength[neighbor]<threshold)continue;
                    visited[neighbor]=1;
                    queue[finish++]=neighbor;
                }
            }
        }
        if(end-start<3||end-start>96||top>12||bottom<36)return;
        glyphs.push({start,end,top,bottom});
    }
    glyphs.sort((left,right)=>left.start-right.start);
    for(let i=1;i<glyphs.length;i++){
        const left=glyphs[i-1],right=glyphs[i];
        if(right.start<=left.start||right.end<=left.end||left.end-right.start>2)return;
    }
    return glyphs;
}

function contains(outer:GlyphBounds,inner:GlyphBounds):boolean {
    return outer.start<=inner.start&&outer.end>=inner.end&&outer.top<=inner.top&&outer.bottom>=inner.bottom;
}

export function observeMangaRecognitionConnectedBands(strength:Uint8Array,width:number,levels:readonly [number,number,number],
    budget:{remaining:number}):{weak:GlyphBounds[];middle:GlyphBounds[];strong:GlyphBounds[]}|undefined {
    if(strength.length!==width*CROP_HEIGHT||strength.length>MAX_CONNECTED_RECOGNITION_PIXELS)return;
    const visited=new Uint8Array(strength.length),queue=new Uint16Array(strength.length);
    const weak=collectGlyphs(strength,width,levels[0],visited,queue,budget);
    if(!weak||weak.length<4)return;
    const middle=collectGlyphs(strength,width,levels[1],visited,queue,budget);
    if(!middle||middle.length!==weak.length)return;
    const strong=collectGlyphs(strength,width,levels[2],visited,queue,budget);
    if(!strong||strong.length!==middle.length)return;
    for(let i=0;i<middle.length;i++){
        if(!contains(weak[i],middle[i])||!contains(middle[i],strong[i]))return;
    }
    return {weak,middle,strong};
}
