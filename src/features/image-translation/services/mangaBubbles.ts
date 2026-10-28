/**
 * @file src/features/image-translation/services/mangaBubbles.ts
 * 文件职责：从漫画像素定位封闭浅色气泡，让小字以局部高分辨率识别并排除绘画噪声。
 * 主要内容：以扫描行四邻域填充亮色连通区域，按待处理行段增长轻量栈，不为整图预分配逐像素队列；最多二十四个小裁图参与局部识别，大型曲边浅底组件只提供保守内接区域且不增加推理；用上下边缘占比、行包络实心度、密度和面积界限排除大型矩形或多洞面板，行跨度数组按高度有界复用；同次扫描为大气泡记录最多一百二十八处内部独立浅色岛，超限撤回新增归属，仅排除完整落在岛内的物理框且不传输排除元数据；从已有原像素核对候选边缘浅底，成员绑定原 OCR 结果索引，角落与独立旁白维持原分组；按最小局部候选优先消除嵌套候选对同一物理行的重复，逐行以可靠局部识别替换重叠的全页结果，保留局部漏行与失败时的全页回退；漫画在最紧的所属气泡内合并局部及回退行并保留气泡外可靠旁白，普通图片保留物理行供独立段落策略处理；漫画与图片均保留冲突数字证据并合并重复数字保护框。
 * 模块边界：纯像素和坐标算法，不创建 Canvas、不访问网络、不运行模型；气泡本身不作为文字证据，只有后续识别出的有效文本进入翻译。
 */
import {groupMangaText,type MangaOcrItem,type MangaRegion} from './mangaRegions';
import {numericInformation,numericProtection} from './mangaNumeric';
type Box=MangaRegion['bbox'];
export interface MangaLayoutOwner extends Box {exclusions?:Box[]}
export interface MangaLayoutBubble {bbox:Box;members:number[]}
export interface MangaOcrPage {results:MangaOcrItem[];numericEvidence?:MangaOcrItem[];bubbles?:Array<{bbox:Box;results:MangaOcrItem[];numericEvidence?:MangaOcrItem[]}>;layoutBubbles?:MangaLayoutBubble[]}

export function findMangaBubbles(pixels:Uint8ClampedArray,width:number,height:number):Box[]{
    return findMangaBubbleLayout(pixels,width,height).recognition;
}

/** 大型曲边气泡只提供段落归属，不扩大二十四处小裁图的模型推理预算。 */
export function findMangaBubbleLayout(pixels:Uint8ClampedArray,width:number,height:number):{recognition:Box[];ownership:MangaLayoutOwner[]}{
    const count=width*height;
    if(![width,height].every(v=>Number.isSafeInteger(v)&&v>0&&v<=8192)||count>16_777_216||pixels.length<count*4)return {recognition:[],ownership:[]};
    const white=new Uint8Array(count);
    // 每行仅保留当前组件的跨度，复用两个高度数组；8192 高时合计 64KiB。
    const rowLeft=new Int32Array(height).fill(width),rowRight=new Int32Array(height).fill(-1);
    let stack=new Uint32Array(Math.min(count,4096)),size=0;
    for(let i=0;i<count;i++){const p=i*4;white[i]=Number(pixels[p]>235&&pixels[p+1]>235&&pixels[p+2]>235&&pixels[p+3]>=128);}
    const candidates:Array<{bbox:Box;area:number}>=[],ownership:MangaLayoutOwner[]=[];
    // 大组件面积必须超过整页 15%，故最多六个；原外接框只留在本次扫描，不进入返回元数据。
    const enclosures=new Map<MangaLayoutOwner,Box>();
    // 每个相邻连续行段只压一个种子；状态 2 只表示已排队，横向扩张仍将其视为白色。
    const addRow=(row:number,left:number,right:number)=>{
        for(let x=left;x<=right;x++){
            if(!white[row+x])continue;
            if(white[row+x]===1){
                if(size===stack.length){const expanded=new Uint32Array(Math.min(count,stack.length*2));expanded.set(stack);stack=expanded;}
                stack[size++]=row+x;white[row+x]=2;
            }
            while(x<right&&white[row+x+1])x++;
        }
    };
    for(let start=0;start<count;start++){
        if(!white[start])continue;
        let area=0,envelope=0,left=width,top=height,right=0,bottom=0,topCount=0,bottomCount=0;stack[0]=start;size=1;
        while(size){
            const index=stack[--size];
            if(!white[index])continue;
            const x=index%width,y=Math.floor(index/width),row=y*width;
            let runLeft=x,runRight=x;
            while(runLeft>0&&white[row+runLeft-1])runLeft--;
            while(runRight+1<width&&white[row+runRight+1])runRight++;
            const length=runRight-runLeft+1;
            white.fill(0,row+runLeft,row+runRight+1);area+=length;
            const previous=rowRight[y]<0?0:rowRight[y]-rowLeft[y]+1;
            rowLeft[y]=Math.min(rowLeft[y],runLeft);rowRight[y]=Math.max(rowRight[y],runRight);
            envelope+=rowRight[y]-rowLeft[y]+1-previous;
            if(y<top)topCount=length;else if(y===top)topCount+=length;
            if(y>bottom)bottomCount=length;else if(y===bottom)bottomCount+=length;
            left=Math.min(left,runLeft);right=Math.max(right,runRight);top=Math.min(top,y);bottom=Math.max(bottom,y);
            if(y>0)addRow(row-width,runLeft,runRight);if(y+1<height)addRow(row+width,runLeft,runRight);
        }
        const w=right-left+1,h=bottom-top+1;
        const density=area/(w*h),bbox={x0:left,y0:top,x1:right+1,y1:bottom+1};
        if(w>=5&&h>=5&&area>=25)for(let index=ownership.length-1;index>=0;index--){
            const owner=ownership[index],enclosure=enclosures.get(owner)!;
            // raster 起点按行递增，后发现组件的 top 不可能小于已记录大组件的 top。
            if(left<enclosure.x0||right+1>enclosure.x1||bottom+1>enclosure.y1)continue;
            // 独立白卡可能跨过保守内接框的上下边缘，仍须按原组件外接范围记录。
            // 溢出时仅撤回新增大气泡归属，原有二十四个识别裁图仍按原规则选择。
            if(owner.exclusions?.length===128){ownership.splice(index,1);enclosures.delete(owner);}
            else(owner.exclusions??=[]).push(bbox);
        }
        if(left!==0&&top!==0&&right!==width-1&&bottom!==height-1&&w>=30&&h>=30&&area>=1000&&density>=.45){
            if(area<=count*.15)candidates.push({bbox,area});
            // 大面积闭合面板不能作为对白证据；曲边外接矩形的角落也不能代表真实内部。
            else if(area<=count*.4&&density<=.9&&topCount<=w*.75&&bottomCount<=w*.75&&area/envelope>=.95){
                const inset=Math.ceil(h/4),y0=top+inset,y1=bottom+1-inset;
                let x0=left,x1=right+1;
                for(let y=y0;y<y1;y++){x0=Math.max(x0,rowLeft[y]);x1=Math.min(x1,rowRight[y]+1);}
                if(x1>x0){const owner={x0,y0,x1,y1};ownership.push(owner);enclosures.set(owner,bbox);}
            }
        }
        rowLeft.fill(width,top,bottom+1);rowRight.fill(-1,top,bottom+1);
    }
    return {recognition:candidates.sort((a,b)=>b.area-a.area).slice(0,24).map(item=>item.bbox),ownership};
}

/** 用已有原像素核对物理框边缘的浅底；仅输出原结果索引，不复制文字或向主线程发送行掩码。 */
export function assignMangaLayoutBubbles(pixels:Uint8ClampedArray,width:number,height:number,owners:MangaLayoutOwner[],items:MangaOcrItem[]):MangaLayoutBubble[]{
    if(![width,height].every(value=>Number.isSafeInteger(value)&&value>0&&value<=8192)||width*height>16_777_216||pixels.length<width*height*4)return [];
    if(!owners.length)return [];
    const points=[[0,0],[1/3,0],[2/3,0],[1,0],[0,1/3],[1,1/3],[0,2/3],[1,2/3],[0,1],[1/3,1],[2/3,1],[1,1]];
    const supported=items.map(item=>{
        const box=item.box;
        if(![box.x,box.y,box.width,box.height].every(Number.isFinite)||box.x<0||box.y<0||box.width<1||box.height<1||box.x+box.width>width||box.y+box.height>height)return false;
        let white=0;
        for(const [x,y] of points){
            const index=(Math.floor(box.y+(box.height-1)*y)*width+Math.floor(box.x+(box.width-1)*x))*4;
            if(pixels[index]>235&&pixels[index+1]>235&&pixels[index+2]>235&&pixels[index+3]>=128)white++;
        }
        return white>=9;
    });
    return owners.flatMap(bbox=>{
        const members=items.flatMap((item,index)=>supported[index]&&itemCenterInside(item,bbox)
            &&!bbox.exclusions?.some(exclusion=>item.box.x>=exclusion.x0&&item.box.y>=exclusion.y0
                &&item.box.x+item.box.width<=exclusion.x1&&item.box.y+item.box.height<=exclusion.y1)?[index]:[]);
        return members.length?[{bbox:{x0:bbox.x0,y0:bbox.y0,x1:bbox.x1,y1:bbox.y1},members}]:[];
    });
}

function itemCenterInside(item: MangaOcrItem, bbox: Box): boolean {
    const x = item.box.x + item.box.width / 2, y = item.box.y + item.box.height / 2;
    return x >= bbox.x0 && x < bbox.x1 && y >= bbox.y0 && y < bbox.y1;
}

/** 同一行的全页与局部检测框可能略有偏移；双方至少覆盖一半才是替代证据，局部碎字不能删除整行。 */
function overlapsOcrLine(item: MangaOcrItem, local: MangaOcrItem, minimum = .5): boolean {
    const a = item.box, b = local.box;
    const overlap = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
        * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    return overlap > 0 && overlap >= Math.max(a.width * a.height, b.width * b.height) * minimum;
}

/** 不跨气泡拼句；局部识别本身才是替代证据，气泡几何或其他对白的存在不能删除可靠原文。 */
export function collectMangaRegions(page:MangaOcrPage,language:string,width:number,height:number,profile: 'manga' | 'image' = 'manga'):MangaRegion[]{
    const bubbles=page.bubbles??[];
    const layouts=profile==='manga'?page.layoutBubbles??[]:[];
    const owners=[...bubbles.map(bubble=>bubble.bbox),...layouts.map(layout=>layout.bbox)];
    const memberships=new Map<MangaOcrItem,Set<number>>();
    for(const [index,layout] of layouts.entries())for(const member of layout.members){
        const item=Number.isSafeInteger(member)&&page.results[member];if(!item)continue;
        if(!memberships.has(item))memberships.set(item,new Set());
        memberships.get(item)!.add(bubbles.length+index);
    }
    const inside=(item:MangaOcrItem,index:number)=>index<bubbles.length?itemCenterInside(item,owners[index]):memberships.get(item)?.has(index)===true;
    const context = (item: MangaOcrItem) => bubbles.some(bubble => itemCenterInside(item,bubble.bbox)) ? 'bubble' as const : 'page' as const;
    const reliable = (item: MangaOcrItem) => groupMangaText([item], language, width, height, context(item)).length > 0;
    // 即使识别置信不足或孤字被过滤，也不让邻近译文擦掉疑似数值的物理区域。
    const guards:MangaRegion[]=[],guardKeys=new Set<string>();
    const candidates=[...page.results,...bubbles.flatMap(bubble=>bubble.results)].map(item=>({item,force:false}));
    candidates.push(...[...(page.numericEvidence??[]),...bubbles.flatMap(bubble=>bubble.numericEvidence??[])].map(item=>({item,force:true})));
    for(const {item,force} of candidates){
        const text=item.text?.replace(/\s+/gu,' ').trim();
        if(!text||!numericProtection(text)||(!force&&reliable(item)))continue;
        const b=item.box;
        if(!b||![b.x,b.y,b.width,b.height].every(Number.isFinite)||b.width<=0||b.height<=0)
            throw new Error('图片数字保护位置无效，已保留原图');
        const bbox={x0:Math.max(0,b.x),y0:Math.max(0,b.y),x1:Math.min(width,b.x+b.width),y1:Math.min(height,b.y+b.height)};
        if(bbox.x1<=bbox.x0||bbox.y1<=bbox.y0)continue;
        const key=[bbox.x0,bbox.y0,bbox.x1,bbox.y1].join(',');if(guardKeys.has(key))continue;
        if(guards.length>=4096)throw new Error('图片数字保护区域过于复杂，已保留原图');
        guardKeys.add(key);guards.push({text:'',bbox,fontSize:bbox.y1-bbox.y0,guardOnly:true});
    }
    const numeric = (item: MangaOcrItem) => item.confidence >= .9 && numericInformation(item.text.trim());
    // 不同识别视图发生数字冲突时都保留，供后续按区域保守跳过绘制。
    const numericConflict = (a: MangaOcrItem, b: MangaOcrItem) => numeric(a) || numeric(b);
    // 先按原始物理行去重，再合段；否则跨气泡的包围框中心会误删整段，或局部漏行无法并回同一对白。
    const bubbleOrder = bubbles.map((bubble,index)=>({index,area:(bubble.bbox.x1-bubble.bbox.x0)*(bubble.bbox.y1-bubble.bbox.y0)}))
        .sort((a,b)=>a.area-b.area).map(bubble=>bubble.index);
    const ownerOrder=owners.map((bbox,index)=>({index,area:(bbox.x1-bbox.x0)*(bbox.y1-bbox.y0)}))
        .sort((a,b)=>a.area-b.area).map(owner=>owner.index);
    const local = owners.map(() => [] as MangaOcrItem[]), accepted: Array<{item:MangaOcrItem;index:number}> = [];
    for(const index of bubbleOrder)for(const item of bubbles[index].results.filter(reliable)){
        // 浅色面板和内部气泡可能同时入选；只按跨候选且双向高重叠的几何证据去重，
        // 更紧的局部裁剪优先，同候选独立行、不同位置的相同对白均保留。
        if(accepted.some(previous=>previous.index!==index&&overlapsOcrLine(item,previous.item,.65)&&!numericConflict(item,previous.item)))continue;
        accepted.push({item,index});
        // 检测来源和对白归属分别保留：外层裁剪补回的漏行也属于最紧的气泡，
        // 不能在去重后把同一对白的首行与后续行分到内外两个段落。
        const owner=profile==='manga'?ownerOrder.find(candidate=>candidate===index||inside(item,candidate))!:index;
        local[owner].push(item);
    }
    const remaining = page.results.filter(reliable).filter(item => !local.some(items => items.some(candidate => overlapsOcrLine(item, candidate) && !numericConflict(item,candidate))));
    if (profile === 'image') {
        // 普通截图不能套用漫画宽松气泡间距：保留可靠物理行，交给普通段落策略合并。
        const lines = [...remaining, ...local.flat()]
            .flatMap(item => groupMangaText([item],language,width,height,context(item)))
            // 数字不能随普通正文合段，否则将来无法单独阻止翻译和保护原图。
            .map(({sourceBoxes: _boxes, ...line}) => numericInformation(line.text) ? {...line,sourceBoxes:[line.bbox]} : line)
            .sort((a,b) => a.bbox.y0-b.bbox.y0 || a.bbox.x0-b.bbox.x0);
        return appendUncoveredNumericGuards(mergeNumericRegions(lines),guards);
    }
    const fallback = owners.map(() => [] as MangaOcrItem[]), outsideItems: MangaOcrItem[] = [];
    for (const item of remaining) {
        const index = ownerOrder.find(index => inside(item, index));
        if (index === undefined) outsideItems.push(item); else fallback[index].push(item);
    }
    const paragraphs=owners.map((_bubble,index)=>groupMangaText([...local[index],...fallback[index]],language,width,height,'bubble',true));
    const outside=groupMangaText(outsideItems,language,width,height,'page',true);
    const regions = [...outside,...paragraphs.flat()].sort((a,b)=>a.bbox.y0-b.bbox.y0||b.bbox.x0-a.bbox.x0);
    return appendUncoveredNumericGuards(mergeNumericRegions(regions),guards);
}

/** 已有数值框完整覆盖时不重复计费；比较超额仍保留未证明覆盖的物理框。 */
function appendUncoveredNumericGuards(regions:MangaRegion[],guards:MangaRegion[]):MangaRegion[]{
    if(!guards.length)return regions;
    const boxes=regions.filter(region=>numericProtection(region.text)).map(region=>region.bbox);
    if(!boxes.length)return [...regions,...guards];
    const key=(box:Box)=>[box.x0,box.y0,box.x1,box.y1].join(',');
    const exact=new Set(boxes.map(key));let comparisons=0;
    const uncovered=guards.filter(guard=>{
        const g=guard.bbox;if(exact.has(key(g)))return false;
        for(const b of boxes){
            if(++comparisons>1_000_000)return true;
            if(b.x0<=g.x0&&b.y0<=g.y0&&b.x1>=g.x1&&b.y1>=g.y1)return false;
        }
        return true;
    });
    return [...regions,...uncovered];
}

/** 同文重叠数字在阅读中只显示一次，但其保护框覆盖所有检测位置。 */
function mergeNumericRegions(regions: MangaRegion[]): MangaRegion[] {
    const merged: MangaRegion[] = []; let comparisons = 0;
    for (const region of regions) {
        let existing: MangaRegion | undefined;
        if (numericInformation(region.text)) for (const candidate of merged) {
            if (++comparisons > 1_000_000) break;
            const a = candidate.bbox, b = region.bbox;
            const intersection = Math.max(0, Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0))
                * Math.max(0, Math.min(a.y1,b.y1)-Math.max(a.y0,b.y0));
            const larger = Math.max((a.x1-a.x0)*(a.y1-a.y0),(b.x1-b.x0)*(b.y1-b.y0));
            if (candidate.text === region.text && intersection >= larger * .5) {existing = candidate;break;}
        }
        if (!existing) {merged.push(region);continue;}
        const a = existing.bbox, b = region.bbox;
        existing.bbox = {x0:Math.min(a.x0,b.x0),y0:Math.min(a.y0,b.y0),x1:Math.max(a.x1,b.x1),y1:Math.max(a.y1,b.y1)};
        existing.sourceBoxes = [existing.bbox];
    }
    return merged;
}
