/**
 * @file src/features/image-translation/services/mangaRecognitionWhitespace.ts
 * 文件职责：用识别副本的真实空列与原模型 blank-run 共同补足缺失空格，保持原 SDK 的文字、框和置信语义。
 * 主要内容：借用既有四十八像素高的单次 RGBA 读回；恒色外周沿用原投影，边缘受抗锯齿字形影响时只在彩色边缘占比受限的中性底图上筛深色彩色字形空列；
 * 通过原读回索引、稳定宽度批次及 Tensor/Box 对象关联，只为有物理词间空隙的行额外扫描有界 CTC 输出；
 * 末端句点仅在同帧右下裁切像素出现小型基线点、且贴近原末字坐标时补回，无词间空隙时不扫描 CTC；
 * 原有空格逐字保留，缺少字典、形状或身份依据均返回原文；页内累计约束像素、crop、support run 和完整时间步，
 * argmax 仅观察原控制器与 SDK 有效前缀的并域，共同 padding 不再检查有限值；恢复域、数组长度、比例坐标及预算不变；
 * 推理前不保留 RGBA，收尾清除元数据，不接管 Tensor 或创建任何 Canvas/模型/重试。
 * 抗锯齿续证：恒色外周的原投影不足两处间隙时，另有262144像素观察面积、512组件与512时间步的页级余额，不占原路径额度；以同一实测墨色的双层字形和共同间隙复核。只有原SDK同字序、CTC数量及间隙字形序号均一致才补空格，不降低blank-run和空格峰门槛。
 * 灰度续证：非恒色外周且原彩色投影没有墨迹时，允许上下紧裁的中性字形使用同等独立页级余额；不消耗恒色续证额度，不增加模型或画布读回，仍只补原字符之间的空格。
 * 浅色有色底续证：原灰度旁证失败后，左右完整同色边缘与内部共同墨色可支持同样的三层字形核对；独立像素、组件和时间步余额不占原灰度路径额度，原SDK字序、唯一blank-run及空格峰门槛不变。
 * 深色底续证：非恒色外周且原路径没有旁证时，独立核对主导暗底、单一高对比墨色、三层同字形及完整背景空列；允许原字触边，不提高彩色边缘阈值。每页另限262144像素、512组件、512时间步，失败不退款；不占原有路径额度，不保留原裁图或改变字符与物理框。
 * 模块边界：只给锁定的 per-box、原比例 SDK 路径提供可选文字后处理，不导入 SDK 私有解码器，不修改概率或原像素；
 * CTC 横坐标只是空间候选，不是字形或擦除边界，物理空隙仍不能证明作者的语义空格，真实异常由调用方保留首因。
 */
import {observeMangaRecognitionInkProjection,observeMangaRecognitionNeutralProjection,observeMangaRecognitionTintedProjection,observeMangaRecognitionDarkProjection} from './mangaRecognitionInkProjection';

export const MANGA_RECOGNITION_WHITESPACE_LIMITS=Object.freeze({
    pixels:2_000_000,cropPixels:262_144,height:48,crops:128,runs:4096,steps:2000,records:8192,classes:18710,
    inkPixels:262_144,inkRuns:512,inkSteps:512,
    neutralPixels:262_144,neutralRuns:512,neutralSteps:512,
    tintedPixels:262_144,tintedRuns:512,tintedSteps:512,
    darkPixels:262_144,darkRuns:512,darkSteps:512,
});
export interface MangaWhitespaceRun {
    boxes:readonly {width:number;height:number}[];batchSize:number;dictionary:readonly string[];
    supportedPerBox:boolean;sourceRatioOne:boolean;
}
export interface MangaWhitespaceReceipt {
    readIndices:readonly number[];resizedWidths:readonly number[];paddedWidth:number;height:48;
}
interface Gap {start:number;end:number;after?:number}
export interface MangaTerminalPeriodEvidence {start:number;previousInkEnd:number}
interface Projection {width:number;gaps:Gap[];characters?:number;neutral?:true;tinted?:true;dark?:true;terminalPeriod?:MangaTerminalPeriodEvidence}
interface Trace {indices:Uint32Array;spaces:Float32Array;valid:number;paddedWidth:number}

/** @internal Pure, bounded edge-pixel classifier used by the OCR observer and its ambiguity regression. */
export function findClippedTerminalPeriodEvidence(edgeInk:Uint8Array,edgeWidth:number,width:number,counts:Uint8Array):MangaTerminalPeriodEvidence|undefined {
    if(edgeWidth<16||edgeInk.length!==edgeWidth*48||counts.length!==width)return;
    const seen=new Uint8Array(edgeInk.length),queue=new Uint16Array(edgeInk.length);let candidate:MangaTerminalPeriodEvidence|undefined;
    for(let start=0;start<edgeInk.length;start++){
        if(!edgeInk[start]||seen[start])continue;
        let head=0,tail=1,minX=edgeWidth,minY=48,maxX=-1,maxY=-1;queue[0]=start;seen[start]=1;
        while(head<tail){
            const index=queue[head++],x=index%edgeWidth,y=Math.floor(index/edgeWidth);
            minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
            for(let yy=Math.max(0,y-1);yy<=Math.min(47,y+1);yy++)for(let xx=Math.max(0,x-1);xx<=Math.min(edgeWidth-1,x+1);xx++){
                const next=yy*edgeWidth+xx;if(edgeInk[next]&&!seen[next]){seen[next]=1;queue[tail++]=next;}
            }
        }
        const boxWidth=maxX-minX+1,boxHeight=maxY-minY+1,area=tail;
        if(maxX!==edgeWidth-1||minX===0||minY<36||maxY!==47||boxWidth<4||boxWidth>16||boxHeight<4||boxHeight>12
            ||area<18||area>144||area/(boxWidth*boxHeight)<.55)continue;
        const x=width-edgeWidth+minX;let previousInkEnd=x-1;
        while(previousInkEnd>=0&&counts[previousInkEnd]===0)previousInkEnd--;
        const gap=x-previousInkEnd-1;
        if(previousInkEnd<0||gap<1||gap>16||candidate)return;
        candidate={start:x,previousInkEnd};
    }
    return candidate;
}
interface Scope {
    boxes:readonly object[];indices:Map<object,number>;dictionary:readonly string[];batchSize:number;
    lastRead:number;lastWidth:number;lastIndex:number;bound:number;seen:Uint8Array;
    projections:Map<number,Projection>;traces:Map<number,Trace>;
    pending?:{input:object;indices:number[];widths:number[];width:number};
}

/** 同宽同内容也不能替代原索引；所有可选状态只属于当前串行 run。 */
export function createMangaRecognitionWhitespace(){
    const limits=MANGA_RECOGNITION_WHITESPACE_LIMITS;
    let active=false,signal:AbortSignal|undefined,scope:Scope|undefined;
    let crops=0,pixels=0,runs=0,steps=0;
    let inkPixels=0,inkRuns=0,inkSteps=0;
    let neutralPixels=0,neutralRuns=0,neutralSteps=0;
    let tintedPixels=0,tintedRuns=0,tintedSteps=0;
    let darkPixels=0,darkRuns=0,darkSteps=0;
    const current=()=>{if(!active||signal?.aborted){scope=undefined;return;}return scope;};
    const disable=()=>{scope=undefined;};
    function withTerminalPeriod(text:string,position:number|undefined,projection:Projection):string {
        const terminal=projection.terminalPeriod;
        if(!terminal||position===undefined||!Number.isFinite(position)||position<0||position>1||!/[A-Za-z]$/u.test(text))return text;
        const lastCharacterX=position*projection.width;
        if(terminal.previousInkEnd>=lastCharacterX&&terminal.previousInkEnd-lastCharacterX<=48
            &&terminal.start-lastCharacterX<=56)return`${text}.`;
        return text;
    }
    function project(data:Uint8ClampedArray,width:number):Projection|undefined {
        if(crops>=limits.crops||pixels+width*48>limits.pixels||runs>=limits.runs)return;
        crops++;pixels+=width*48;
        const baseR=data[0],baseG=data[1],baseB=data[2];let flatBorder=true,invalidBorder=false,chromaticBorder=0,borderPixels=0;
        const inspectBorder=(x:number,y:number)=>{
            const offset=(y*width+x)*4,r=data[offset],g=data[offset+1],b=data[offset+2];
            if(data[offset+3]!==255){flatBorder=false;invalidBorder=true;return;}
            if(r!==baseR||g!==baseG||b!==baseB)flatBorder=false;
            if(Math.max(r,g,b)-Math.min(r,g,b)>=24)chromaticBorder++;
            borderPixels++;
        };
        for(let x=0;x<width;x++){inspectBorder(x,0);inspectBorder(x,47);}
        for(let y=1;y<47;y++){inspectBorder(0,y);inspectBorder(width-1,y);}
        if(invalidBorder)return;
        const darkProjection=():Projection|undefined=>{
            if(flatBorder||darkPixels+width*48*2>limits.darkPixels)return;
            darkPixels+=width*48*2;const budget={remaining:limits.darkRuns-darkRuns};
            const projection=observeMangaRecognitionDarkProjection(data,width,budget);darkRuns=limits.darkRuns-budget.remaining;
            if(projection)return{width,...projection,dark:true};
        };

        const counts=new Uint8Array(width),edgeWidth=Math.min(24,width),edgeStart=width-edgeWidth,edgeInk=new Uint8Array(edgeWidth*48);
        if(flatBorder){
            for(let y=0;y<48;y++)for(let x=0;x<width;x++){
                const offset=(y*width+x)*4;
                if(data[offset+3]!==255)return;
                if(data[offset]!==baseR||data[offset+1]!==baseG||data[offset+2]!==baseB){
                    counts[x]++;if(x>=edgeStart)edgeInk[y*edgeWidth+x-edgeStart]=1;
                }
            }
        }else{
            // BGR text on neutral/tinted balloons can have glyphs touching the crop edge. Keep this
            // fallback narrow: reject colorful borders and count only dark chromatic ink pixels.
            if(chromaticBorder>borderPixels*.6)return darkProjection();
            for(let y=0;y<48;y++)for(let x=0;x<width;x++){
                const offset=(y*width+x)*4,r=data[offset],g=data[offset+1],b=data[offset+2];
                if(data[offset+3]!==255)return;
                const high=Math.max(r,g,b),chroma=high-Math.min(r,g,b);
                if(chroma>=24&&high<=170){counts[x]++;if(x>=edgeStart)edgeInk[y*edgeWidth+x-edgeStart]=1;}
            }
        }
        const terminalPeriod=findClippedTerminalPeriodEvidence(edgeInk,edgeWidth,width,counts);
        const edges:number[]=[];
        for(let x=0;x<width;){
            if(counts[x]===0){x++;continue;}
            if(runs>=limits.runs)return;
            runs++;edges.push(x);while(x<width&&counts[x]!==0)x++;edges.push(x);
        }
        const gaps=Array.from({length:Math.max(0,edges.length/2-1)},(_,i)=>({start:edges[i*2+1],end:edges[i*2+2],index:i}));
        if(gaps.length<2){
            if(flatBorder&&edges.length&&inkPixels+width*48*2<=limits.inkPixels){
                inkPixels+=width*48*2;const budget={remaining:limits.inkRuns-inkRuns};
                const supplemental=observeMangaRecognitionInkProjection(data,width,budget);inkRuns=limits.inkRuns-budget.remaining;
                // 恒色完整外周不含触碰右下边缘的裁切句点；保留非恒色分支原有句点处理。
                if(supplemental)return{width,...supplemental};
            }
            if(!flatBorder&&!edges.length&&Math.max(baseR,baseG,baseB)-Math.min(baseR,baseG,baseB)<=16
                &&neutralPixels+width*48*2<=limits.neutralPixels){
                neutralPixels+=width*48*2;const budget={remaining:limits.neutralRuns-neutralRuns};
                const supplemental=observeMangaRecognitionNeutralProjection(data,width,budget);neutralRuns=limits.neutralRuns-budget.remaining;
                if(supplemental)return{width,...supplemental,neutral:true};
            }
            // 先按已读首像素筛掉原灰度背景，不让灰度反例消耗浅色底的独立余额。
            if(!flatBorder&&!edges.length&&Math.max(baseR,baseG,baseB)>=220&&Math.max(baseR,baseG,baseB)-Math.min(baseR,baseG,baseB)>16
                &&tintedPixels+width*48*2<=limits.tintedPixels){
                tintedPixels+=width*48*2;const budget={remaining:limits.tintedRuns-tintedRuns};
                const supplemental=observeMangaRecognitionTintedProjection(data,width,budget);tintedRuns=limits.tintedRuns-budget.remaining;
                if(supplemental)return{width,...supplemental,tinted:true};
            }
            return terminalPeriod?{width,gaps:[],terminalPeriod}:darkProjection();
        }
        const sorted=[...gaps].sort((a,b)=>(a.end-a.start)-(b.end-b.start)||a.index-b.index),rank=new Uint32Array(gaps.length);
        sorted.forEach((gap,index)=>{rank[gap.index]=index;});
        const mid=Math.floor((gaps.length-1)/2);
        const significant=gaps.filter(gap=>{const other=sorted[mid+(rank[gap.index]<=mid?1:0)];return gap.end-gap.start>=2*(other.end-other.start)+1;});
        if(significant.length||terminalPeriod)return{width,gaps:significant.map(({start,end})=>({start,end})),...(terminalPeriod?{terminalPeriod}:{})};
        return darkProjection();
    }
    function capture(data:Float32Array,row:number,T:number,width:number,paddedWidth:number):Trace|undefined {
        const indices=new Uint32Array(T),spaces=new Float32Array(T),C=limits.classes;
        const valid=Math.max(1,Math.min(T,Math.ceil(T*width/paddedWidth)));
        // 两种合法浮点算序可能相差一帧；保留原恢复域，同时校验 SDK 仍有效的额外边界帧。
        const sdkValid=Math.max(1,Math.min(T,Math.ceil(T*(width/paddedWidth)))),scanLength=Math.max(valid,sdkValid);
        for(let t=0;t<scanLength;t++){
            const base=(row*T+t)*C,blank=data[base],space=data[base+C-1];let max=blank,index=0;
            for(let c=1;c<C;c++)if(data[base+c]>max){max=data[base+c];index=c;}
            if(![blank,space,max].every(Number.isFinite))return;
            indices[t]=index;spaces[t]=space;
        }
        return{indices,spaces,paddedWidth,valid};
    }
    function recover(text:string,trace:Trace,projection:Projection,dictionary:readonly string[]):string {
        const chars:Array<{character:string;t:number;index:number}>=[];let last=-1;
        for(let t=0;t<trace.valid;t++){
            const index=trace.indices[t];
            if(index!==0&&index!==last){
                const character=index===limits.classes-1?' ':dictionary[index];
                if(typeof character!=='string'||!character.length||character.length>2)return text;
                if(character!==' ')chars.push({character,t,index});
            }
            last=index;
        }
        if(chars.map(char=>char.character).join('')!==text.replaceAll(' ',''))return text;
        if(projection.characters!==undefined&&(chars.length!==projection.characters||chars.some(char=>!/^[A-Za-z0-9]$/u.test(char.character))))return text;
        const existing=new Set<number>();let units=0;
        for(const char of text){if(char===' ')existing.add(units);else units+=char.length;}
        const candidates:Array<{units:number;gap:Gap}>=[];units=0;
        for(let i=0;i+1<chars.length;i++){
            const left=chars[i],right=chars[i+1];units+=left.character.length;
            if(existing.has(units)||!/^[A-Za-z0-9]$/u.test(left.character)||!/^[A-Za-z0-9]$/u.test(right.character))continue;
            let count=0,inside=false,foreign=false,peak=-1;
            for(let t=left.t+1;t<right.t;t++){
                if(trace.indices[t]===0){if(!inside)count++;inside=true;if(peak<0||trace.spaces[t]>trace.spaces[peak])peak=t;}
                else{inside=false;if(trace.indices[t]!==left.index)foreign=true;}
            }
            if(count!==1||foreign||peak<0||!(trace.spaces[peak]>.001))continue;
            const x=(peak+.5)*trace.paddedWidth/trace.indices.length,gaps=projection.gaps;let low=0,high=gaps.length;
            while(low<high){const mid=(low+high)>>1;if(gaps[mid].start<x)low=mid+1;else high=mid;}
            const gap=gaps[low-1];if(gap&&x<gap.end&&(projection.characters===undefined||gap.after===i+1))candidates.push({units,gap});
        }
        const uses=new Map<Gap,number>();for(const candidate of candidates)uses.set(candidate.gap,(uses.get(candidate.gap)??0)+1);
        const at=new Set(candidates.filter(candidate=>uses.get(candidate.gap)===1).map(candidate=>candidate.units));
        let output='';units=0;
        for(const char of text){output+=char;if(char!==' '){units+=char.length;if(at.has(units))output+=' ';}}
        const lastCharacter=chars.at(-1),position=lastCharacter&&output===output.trimEnd()&&/[A-Za-z]$/u.test(output)
            ?(lastCharacter.t+.5)/trace.valid:undefined;
        return withTerminalPeriod(output,position,projection);
    }
    return{
        beginPage(pageSignal?:AbortSignal){scope=undefined;signal=pageSignal;active=true;crops=pixels=runs=steps=inkPixels=inkRuns=inkSteps=neutralPixels=neutralRuns=neutralSteps=tintedPixels=tintedRuns=tintedSteps=darkPixels=darkRuns=darkSteps=0;},
        beginRun(options:MangaWhitespaceRun){
            scope=undefined;
            if(!active||signal?.aborted||!options.supportedPerBox||!options.sourceRatioOne||options.boxes.length>limits.records
                ||!Number.isSafeInteger(options.batchSize)||options.batchSize<1||options.batchSize>limits.records
                ||options.dictionary.length!==limits.classes||options.dictionary[0]!==''||options.dictionary[limits.classes-1]!=='')return;
            const boxes:object[]=[],indices=new Map<object,number>();
            for(const box of options.boxes){
                if(!Number.isFinite(box.width)||!Number.isFinite(box.height))return;
                if(box.width<=0||box.height<=0)continue;
                if(indices.has(box))return;
                indices.set(box,boxes.length);boxes.push(box);
            }
            if(!boxes.length)return;
            scope={boxes,indices,dictionary:options.dictionary,batchSize:options.batchSize,lastRead:-1,lastWidth:0,lastIndex:-1,
                bound:0,seen:new Uint8Array(boxes.length),projections:new Map(),traces:new Map()};
        },
        observeBorrowedRead(readIndex:number,width:number,height:number,data:Uint8ClampedArray){
            const run=current();if(!run)return;
            if(!Number.isSafeInteger(readIndex)||readIndex<=run.lastRead||readIndex>=run.boxes.length||!Number.isSafeInteger(width)
                ||width<8||height!==48||width*height>limits.cropPixels||!(data instanceof Uint8ClampedArray)||data.length!==width*height*4){disable();return;}
            run.lastRead=readIndex;const projection=project(data,width);if(projection)run.projections.set(readIndex,projection);
        },
        bindInput(input:object,receipt:MangaWhitespaceReceipt){
            const run=current();if(!run)return;
            const {readIndices:indices,resizedWidths:widths,paddedWidth:width,height}=receipt;
            if(typeof input!=='object'||input===null||run.pending||height!==48||!Number.isSafeInteger(width)||width<8
                ||indices.length!==Math.min(run.batchSize,run.boxes.length-run.bound)||!indices.length||widths.length!==indices.length){disable();return;}
            let previousWidth=run.lastWidth,previousIndex=run.lastIndex,max=0;const unique=new Set<number>();
            for(let row=0;row<indices.length;row++){
                const index=indices[row],w=widths[row],projection=run.projections.get(index);
                if(!Number.isSafeInteger(index)||index<0||index>=run.boxes.length||run.seen[index]||unique.has(index)
                    ||!Number.isSafeInteger(w)||w<8||w<previousWidth||(w===previousWidth&&index<=previousIndex)
                    ||(projection&&projection.width!==w)){disable();return;}
                unique.add(index);previousWidth=w;previousIndex=index;max=Math.max(max,w);
            }
            if(width!==max){disable();return;}
            for(const index of indices)run.seen[index]=1;
            run.bound+=indices.length;run.lastWidth=previousWidth;run.lastIndex=previousIndex;
            run.pending={input,indices:[...indices],widths:[...widths],width};
        },
        observeOutput(input:object,output:{dims:readonly number[];data:unknown}){
            const run=current();if(!run)return;
            const batch=run.pending;run.pending=undefined;
            if(!batch||input!==batch.input){disable();return;}
            const dims=output.dims;
            if(dims.length!==3||!dims.every(value=>Number.isSafeInteger(value)&&value>0)||dims[0]!==batch.indices.length
                ||dims[2]!==limits.classes||!Number.isSafeInteger(dims[0]*dims[1]*dims[2])){disable();return;}
            const T=dims[1];
            const canCapture=(index:number)=>{const projection=run.projections.get(index);return !!projection?.gaps.length
                &&(projection.characters===undefined?steps+T<=limits.steps:projection.dark?darkSteps+T<=limits.darkSteps:projection.tinted?tintedSteps+T<=limits.tintedSteps:projection.neutral?neutralSteps+T<=limits.neutralSteps:inkSteps+T<=limits.inkSteps);};
            if(!batch.indices.some(canCapture))return;
            const data=output.data;
            if(!(data instanceof Float32Array)||data.length!==dims[0]*T*limits.classes){disable();return;}
            for(let row=0;row<batch.indices.length;row++){
                const index=batch.indices[row];if(!canCapture(index))continue;
                const projection=run.projections.get(index)!;
                if(projection.characters===undefined)steps+=T;else if(projection.dark)darkSteps+=T;else if(projection.tinted)tintedSteps+=T;else if(projection.neutral)neutralSteps+=T;else inkSteps+=T;
                const trace=capture(data,row,T,batch.widths[row],batch.width);if(trace)run.traces.set(index,trace);
            }
        },
        applyToSdkResults<T extends {text:string;box:object;positions?:readonly number[]}>(results:T[]):T[]{
            const run=current();if(!run||run.pending||run.bound!==run.boxes.length)return results;
            // 先检查完整集合，不能先改一行再发现后续 Box 身份无从证明。
            const seen=new Set<object>();
            for(const result of results){if(!run.indices.has(result.box)||seen.has(result.box))return results;seen.add(result.box);}
            let changed=false;
            const texts=results.map(result=>{
                const index=run.indices.get(result.box)!,trace=run.traces.get(index),projection=run.projections.get(index);
                const text=projection?trace?recover(result.text,trace,projection,run.dictionary)
                    :withTerminalPeriod(result.text,result.positions?.at(-1),projection):result.text;
                if(text!==result.text)changed=true;return text;
            });
            return changed?results.map((result,index)=>texts[index]===result.text?result:{...result,text:texts[index]}):results;
        },
        endRun(){scope=undefined;},
        endPage(){scope=undefined;signal=undefined;active=false;},
    };
}
