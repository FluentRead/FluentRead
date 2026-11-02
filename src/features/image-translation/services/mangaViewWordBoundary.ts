/**
 * @file src/features/image-translation/services/mangaViewWordBoundary.ts
 * 文件职责：以本页原像素核对两个已识别拉丁字行的空格边界，避免可靠局部视图无条件覆盖另一视图中受物理支持的边界。
 * 主要内容：限制同字符、高重叠横行与页级六十四次/两百万像素预算，借用有界原 ROI；仅不透明近灰墨浅底、低两层完整稳定字形及显著间隙可选择既有候选；高层抗锯齿仅可连合至多两像素的词内间隔，并须保留词隙与字符索引；证明绑定本页原对象、完整快照、尺寸和 ROI，融合只保留局部几何并采用选中文本的原置信度；实际去重采用后才确认融合对象，并在分组输入与输出源框唯一对应时用内部 WeakMap 保存双视图来历。
 * 模块边界：不运行模型、不修改字符、不合成第三种空格文本、不访问 Canvas；reader 由当前原图 owner 提供，未知纹理、无法核对字符归属的字形连接、多墨色、透明或失配均不提供证明。物理间隙不能保证语义词界，不能将证明作为字形擦除蒙版或通用语言分词。
 */
import type {MangaOcrItem,MangaRegion} from './mangaRegions';
type Box={x0:number;y0:number;x1:number;y1:number};
export interface MangaViewBoundaryBubble {bbox:Box;results:MangaOcrItem[]}
export interface MangaViewBoundaryRect {left:number;top:number;width:number;height:number}
export interface MangaViewBoundaryFrame {width:number;height:number;read:(roi:MangaViewBoundaryRect,maxPixels:number)=>Uint8ClampedArray|undefined}
type Snapshot={text:string;confidence:number;box:MangaOcrItem['box']};
export interface MangaViewWordBoundaryProof {
    version:'manga-view-word-boundary-v1';width:number;height:number;ordinal:number;pixels:number;roi:MangaViewBoundaryRect;
    whole:MangaOcrItem;local:MangaOcrItem;bubble:MangaViewBoundaryBubble;wholeSnapshot:Snapshot;localSnapshot:Snapshot;
    preferred:'whole'|'local';boundaries:number[];
}
export interface MangaViewWordBoundaryProvenance {whole:Snapshot;local:Snapshot;textView:'whole'|'local';geometryView:'local'}
const VERSION='manga-view-word-boundary-v1',MAX_PAIRS=64,MAX_PIXELS=2_000_000,MAX_ROI=65_536;
const provenance=new WeakMap<object,readonly MangaViewWordBoundaryProvenance[]>();
function snapshot(item:MangaOcrItem):Snapshot {return{text:item.text,confidence:item.confidence,box:{...item.box}};}
function same(a:Snapshot,b:Snapshot):boolean {return a.text===b.text&&a.confidence===b.confidence&&['x','y','width','height'].every(key=>a.box[key as keyof Snapshot['box']]===b.box[key as keyof Snapshot['box']]);}
function texts(whole:unknown,local:unknown):{letters:string;whole:number[];local:number[]}|undefined {
    if(typeof whole!=='string'||typeof local!=='string')return;
    if(whole.length>128||local.length>128||![whole,local].every(value=>/^ *[A-Za-z]+(?: [A-Za-z]+)* *$/.test(value)))return;
    const letters=whole.replaceAll(' ','');if(letters!==local.replaceAll(' ','')||letters.length<4||letters.length>64)return;
    const boundaries=(text:string)=>{let index=0;const result:number[]=[];for(const char of text.trim()){if(char===' ')result.push(index);else index++;}return result;};
    return{letters,whole:boundaries(whole),local:boundaries(local)};
}
function validBox(box:MangaOcrItem['box'],width:number,height:number):boolean {
    return [box.x,box.y,box.width,box.height].every(Number.isFinite)&&box.x>=0&&box.y>=0&&box.width>0&&box.height>0
        &&box.x+box.width<=width&&box.y+box.height<=height&&box.width>=box.height*1.5;
}
function roiFor(whole:MangaOcrItem,local:MangaOcrItem,width:number,height:number):MangaViewBoundaryRect|undefined {
    if(![width,height].every(v=>Number.isSafeInteger(v)&&v>0&&v<=8192)||!validBox(whole.box,width,height)||!validBox(local.box,width,height))return;
    const a=whole.box,b=local.box,overlap=Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));
    if(overlap<Math.max(a.width*a.height,b.width*b.height)*.5||Math.max(a.height,b.height)>Math.min(a.height,b.height)*1.8)return;
    const left=Math.max(0,Math.floor(Math.min(a.x,b.x))-2),top=Math.max(0,Math.floor(Math.min(a.y,b.y))-2);
    const right=Math.min(width,Math.ceil(Math.max(a.x+a.width,b.x+b.width))+2),bottom=Math.min(height,Math.ceil(Math.max(a.y+a.height,b.y+b.height))+2);
    if(right-left>512||bottom-top>128)return;
    return{left,top,width:right-left,height:bottom-top};
}
/** 上调阈值只会增加投影列；逐粗段唯一归并细段，不能把灰色新岛当成字符或跨过词隙。 */
function stableCoarsening(fine:number[][],coarse:number[][],boundaries:number[]):boolean {
    const groups=new Uint8Array(fine.length);let next=0;
    for(let group=0;group<coarse.length;group++){
        const first=next;
        while(next<fine.length&&fine[next][0]<coarse[group][1])groups[next++]=group;
        if(next===first||Math.abs(coarse[group][0]-fine[first][0])>2||Math.abs(coarse[group][1]-fine[next-1][1])>2)return false;
        // 已选词隙至少三像素；只可合并一、二像素的非词界间隔，不减少原字符索引。
        for(let index=first+1;index<next;index++)if(fine[index][0]-fine[index-1][1]>2)return false;
    }
    for(const boundary of boundaries){
        const observed=coarse[groups[boundary]][0]-coarse[groups[boundary-1]][1];
        if(Math.abs(observed-(fine[boundary][0]-fine[boundary-1][1]))>2)return false;
    }
    return true;
}
function projection(data:Uint8ClampedArray,width:number,height:number,characters:number):number[]|undefined {
    if(data.length!==width*height*4)return;
    const counts=[new Uint16Array(width),new Uint16Array(width),new Uint16Array(width)],thresholds=[80,120,160];
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
        const p=(y*width+x)*4,r=data[p],g=data[p+1],b=data[p+2],value=Math.max(r,g,b);
        if(data[p+3]!==255||value-Math.min(r,g,b)>16||((x===0||y===0||x===width-1||y===height-1)&&value<220))return;
        for(let t=0;t<3;t++)if(value<=thresholds[t])counts[t][x]++;
    }
    const runs=counts.map(columns=>{const values:number[][]=[];for(let x=0;x<width;){if(!columns[x]){x++;continue;}const from=x;while(x<width&&columns[x])x++;values.push([from,x]);}return values;});
    if(runs[2].length>characters)return;
    const resolved=runs[2].length===characters?runs:runs.slice(0,2);
    if(resolved.some(values=>values.length!==characters))return;
    if(resolved.some(values=>values.some((edge,index)=>edge.some((value,side)=>Math.abs(value-runs[0][index][side])>2))))return;
    const supported=resolved.map(values=>{
        const gaps=values.slice(1).map((run,index)=>run[0]-values[index][1]),sorted=gaps.slice().sort((a,b)=>a-b);
        // 大而均匀的字距可能是 tracking 或逐字列表，不能把它当词间空白。
        if(sorted[Math.floor(sorted.length/2)]>=height*.3)return;
        return gaps.flatMap((gap,index)=>{const others=gaps.filter((_,i)=>i!==index).sort((a,b)=>a-b);return gap>=2*others[Math.floor((others.length-1)/2)]+1?[index+1]:[];});
    });
    if(supported.some(value=>value===undefined)||supported.some(value=>JSON.stringify(value)!==JSON.stringify(supported[0])))return;
    if(resolved.length===2&&!stableCoarsening(runs[0],runs[2],supported[0]!))return;
    return supported[0];
}
function active(signal?:AbortSignal){if(signal?.aborted)throw new DOMException('漫画识别已取消','AbortError');}

/** owner 在枚举时先筛掉一致视图；前后空格差异不构成词界冲突，也不应触发原图读取。 */
export function hasMangaViewWordBoundaryDifference(whole:string,local:string):boolean {
    const value=texts(whole,local);return !!value&&JSON.stringify(value.whole)!==JSON.stringify(value.local);
}

/** 每页创建一次；read 必须从当前原 bitmap/frame 返回该整数 ROI 的紧密 RGBA，不接受已放大或 flattened alpha 的像素。 */
export function createMangaViewWordBoundaryBudget(frame:MangaViewBoundaryFrame,signal?:AbortSignal){
    let attempts=0,pixels=0;
    return{prove(whole:MangaOcrItem,local:MangaOcrItem,bubble:MangaViewBoundaryBubble):MangaViewWordBoundaryProof|undefined {
        active(signal);if(attempts>=MAX_PAIRS)return;const ordinal=++attempts;
        if(![whole.confidence,local.confidence].every(v=>Number.isFinite(v)&&v>=.65&&v<=1))return;
        const strings=texts(whole.text,local.text);if(!strings||JSON.stringify(strings.whole)===JSON.stringify(strings.local))return;
        const roi=roiFor(whole,local,frame.width,frame.height);if(!roi)return;const count=roi.width*roi.height;
        if(pixels+count>MAX_PIXELS)return;pixels+=count;
        const wholeSnapshot=snapshot(whole),localSnapshot=snapshot(local),data=frame.read(roi,MAX_ROI);active(signal);
        if(!(data instanceof Uint8ClampedArray))return;
        const boundaries=projection(data,roi.width,roi.height,strings.letters.length);if(!boundaries)return;
        const wholeMatches=JSON.stringify(strings.whole)===JSON.stringify(boundaries),localMatches=JSON.stringify(strings.local)===JSON.stringify(boundaries);
        if(wholeMatches===localMatches||!same(wholeSnapshot,whole)||!same(localSnapshot,local))return;
        return{version:VERSION,width:frame.width,height:frame.height,ordinal,pixels:count,roi,whole,local,bubble,wholeSnapshot,localSnapshot,preferred:wholeMatches?'whole':'local',boundaries};
    },get usage(){return{attempts,pixels};}};
}

/** 只消费当前 page graph 中同一对象的证明；choose 无副作用，owner 去重采用后 accept，再把该次分组的实际 sourceItems 交给 record。 */
export function createMangaViewWordBoundaryConsumer(wholeItems:MangaOcrItem[],bubbles:MangaViewBoundaryBubble[],proofs:MangaViewWordBoundaryProof[]|undefined,width:number,height:number){
    const selected=new Map<MangaOcrItem,{item:MangaOcrItem;proof:MangaViewWordBoundaryProof}>();
    if(proofs&&proofs.length<=MAX_PAIRS){
        let charged=0;const ordinals=new Set<number>(),ambiguous=new Set<MangaOcrItem>();
        for(const proof of proofs){
            if(!proof?.whole?.box||!proof.local?.box||!proof.wholeSnapshot?.box||!proof.localSnapshot?.box||!Array.isArray(proof.bubble?.results))continue;
            const roi=roiFor(proof.whole,proof.local,width,height);
            if(proof.version!==VERSION||proof.width!==width||proof.height!==height||!Number.isSafeInteger(proof.ordinal)||proof.ordinal<1||proof.ordinal>MAX_PAIRS||ordinals.has(proof.ordinal)
                ||!roi||JSON.stringify(roi)!==JSON.stringify(proof.roi)||proof.pixels!==roi.width*roi.height||charged+proof.pixels>MAX_PIXELS)continue;
            charged+=proof.pixels;ordinals.add(proof.ordinal);
            if(!wholeItems.includes(proof.whole)||!bubbles.includes(proof.bubble)||!proof.bubble.results.includes(proof.local)||!same(proof.wholeSnapshot,proof.whole)||!same(proof.localSnapshot,proof.local)
                ||!['whole','local'].includes(proof.preferred))continue;
            const strings=texts(proof.whole.text,proof.local.text);if(!strings)continue;
            const chosen=strings[proof.preferred],other=strings[proof.preferred==='whole'?'local':'whole'];
            if(JSON.stringify(chosen)!==JSON.stringify(proof.boundaries)||JSON.stringify(other)===JSON.stringify(proof.boundaries))continue;
            if(ambiguous.has(proof.local))continue;
            if(selected.has(proof.local)){selected.delete(proof.local);ambiguous.add(proof.local);continue;}
            const text=proof.preferred==='whole'?proof.wholeSnapshot:proof.localSnapshot;
            selected.set(proof.local,{item:{...proof.local,text:text.text,confidence:text.confidence},proof});
        }
    }
    const choices=new Map([...selected.values()].map(choice=>[choice.item,choice]));
    const adopted=new Map<MangaOcrItem,MangaViewWordBoundaryProof>();
    const boxKey=(box:Box)=>[box.x0,box.y0,box.x1,box.y1].join(',');
    const itemKey=(item:MangaOcrItem)=>boxKey({x0:item.box.x,y0:item.box.y,x1:item.box.x+item.box.width,y1:item.box.y+item.box.height});
    const acceptedSources=new Map<string,MangaOcrItem|null>();
    return{choose(item:MangaOcrItem,bubble:MangaViewBoundaryBubble):MangaOcrItem {
        const choice=selected.get(item);if(!choice||choice.proof.bubble!==bubble)return item;
        return choice.item;
    },accept(item:MangaOcrItem,bubble:MangaViewBoundaryBubble):void {
        if(!choices.size)return;
        const key=itemKey(item);acceptedSources.set(key,acceptedSources.has(key)?null:item);
        const choice=choices.get(item);if(choice?.proof.bubble===bubble)adopted.set(item,choice.proof);
    },record(regions:MangaRegion[],sourceItems:MangaOcrItem[]):MangaRegion[]{
        if(!adopted.size)return regions;
        // 仅实际传给本次分组的对象可关联；同框的多个输入或多个输出都无法证明唯一来历。
        const sources=new Map<string,MangaOcrItem|null>(),outputs=new Map<string,number>();
        for(const item of sourceItems){const key=itemKey(item);sources.set(key,sources.has(key)?null:item);}
        for(const region of regions)for(const box of region.sourceBoxes??[region.bbox]){const key=boxKey(box);outputs.set(key,(outputs.get(key)??0)+1);}
        for(const region of regions){
            const matches:MangaViewWordBoundaryProof[]=[];provenance.delete(region);
            for(const box of region.sourceBoxes??[region.bbox]){
                const key=boxKey(box),item=sources.get(key);if(!item||acceptedSources.get(key)!==item)continue;
                const proof=adopted.get(item);
                if(!proof||outputs.get(key)!==1||!same(proof.wholeSnapshot,proof.whole)||!same(proof.localSnapshot,proof.local))continue;
                const text=proof.preferred==='whole'?proof.wholeSnapshot:proof.localSnapshot;
                if(!same({text:text.text,confidence:text.confidence,box:proof.localSnapshot.box},item))continue;
                matches.push(proof);
            }
            if(matches.length)provenance.set(region,matches.map(proof=>({whole:proof.wholeSnapshot,local:proof.localSnapshot,textView:proof.preferred,geometryView:'local'})));
        }
        return regions;
    }};
}
/** 内部可核验来历不作为区域属性序列化，也不进入用户阅读面板。 */
export function getMangaViewWordBoundaryProvenance(region:object):readonly MangaViewWordBoundaryProvenance[]|undefined {return provenance.get(region);}
