/**
 * @file src/features/image-translation/services/mangaRecognitionWhitespace.ts
 * 文件职责：用识别副本的真实空列与原模型 blank-run 共同补足缺失空格，保持原 SDK 的文字、框和置信语义。
 * 主要内容：借用既有四十八像素高的单次 RGBA 读回，完整验证不透明恒色外周并预筛显著内部空隙；
 * 通过原读回索引、稳定宽度批次及 Tensor/Box 对象关联，只为有物理候选的行额外扫描有界 CTC 输出；
 * 原有空格逐字保留，缺少字典、形状或身份依据均返回原文；页内累计约束像素、crop、support run 和完整时间步，
 * argmax 仅观察原控制器与 SDK 有效前缀的并域，共同 padding 不再检查有限值；恢复域、数组长度、比例坐标及预算不变；
 * 推理前不保留 RGBA，收尾清除元数据，不接管 Tensor 或创建任何 Canvas/模型/重试。
 * 模块边界：只给锁定的 per-box、原比例 SDK 路径提供可选文字后处理，不导入 SDK 私有解码器，不修改概率或原像素；
 * CTC 横坐标只是空间候选，不是字形或擦除边界，物理空隙仍不能证明作者的语义空格，真实异常由调用方保留首因。
 */

export const MANGA_RECOGNITION_WHITESPACE_LIMITS=Object.freeze({
    pixels:2_000_000,cropPixels:262_144,height:48,crops:128,runs:4096,steps:2000,records:8192,classes:18710,
});
export interface MangaWhitespaceRun {
    boxes:readonly {width:number;height:number}[];batchSize:number;dictionary:readonly string[];
    supportedPerBox:boolean;sourceRatioOne:boolean;
}
export interface MangaWhitespaceReceipt {
    readIndices:readonly number[];resizedWidths:readonly number[];paddedWidth:number;height:48;
}
interface Gap {start:number;end:number}
interface Projection {width:number;gaps:Gap[]}
interface Trace {indices:Uint32Array;spaces:Float32Array;valid:number;paddedWidth:number}
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
    const current=()=>{if(!active||signal?.aborted){scope=undefined;return;}return scope;};
    const disable=()=>{scope=undefined;};
    function project(data:Uint8ClampedArray,width:number):Projection|undefined {
        if(crops>=limits.crops||pixels+width*48>limits.pixels||runs>=limits.runs)return;
        crops++;pixels+=width*48;
        const counts=new Uint8Array(width),r=data[0],g=data[1],b=data[2];
        for(let y=0;y<48;y++)for(let x=0;x<width;x++){
            const offset=(y*width+x)*4;
            if(data[offset+3]!==255)return;
            const same=data[offset]===r&&data[offset+1]===g&&data[offset+2]===b;
            if((x===0||y===0||x===width-1||y===47)&&!same)return;
            if(!same)counts[x]++;
        }
        const edges:number[]=[];
        for(let x=0;x<width;){
            if(counts[x]===0){x++;continue;}
            if(runs>=limits.runs)return;
            runs++;edges.push(x);while(x<width&&counts[x]!==0)x++;edges.push(x);
        }
        const gaps=Array.from({length:Math.max(0,edges.length/2-1)},(_,i)=>({start:edges[i*2+1],end:edges[i*2+2],index:i}));
        if(gaps.length<2)return;
        const sorted=[...gaps].sort((a,b)=>(a.end-a.start)-(b.end-b.start)||a.index-b.index),rank=new Uint32Array(gaps.length);
        sorted.forEach((gap,index)=>{rank[gap.index]=index;});
        const mid=Math.floor((gaps.length-1)/2);
        const significant=gaps.filter(gap=>{const other=sorted[mid+(rank[gap.index]<=mid?1:0)];return gap.end-gap.start>=2*(other.end-other.start)+1;});
        if(significant.length)return{width,gaps:significant.map(({start,end})=>({start,end}))};
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
            const gap=gaps[low-1];if(gap&&x<gap.end)candidates.push({units,gap});
        }
        const uses=new Map<Gap,number>();for(const candidate of candidates)uses.set(candidate.gap,(uses.get(candidate.gap)??0)+1);
        const at=new Set(candidates.filter(candidate=>uses.get(candidate.gap)===1).map(candidate=>candidate.units));
        let output='';units=0;
        for(const char of text){output+=char;if(char!==' '){units+=char.length;if(at.has(units))output+=' ';}}
        return output;
    }
    return{
        beginPage(pageSignal?:AbortSignal){scope=undefined;signal=pageSignal;active=true;crops=pixels=runs=steps=0;},
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
            if(!batch.indices.some(index=>run.projections.has(index))||steps+T>limits.steps)return;
            const data=output.data;
            if(!(data instanceof Float32Array)||data.length!==dims[0]*T*limits.classes){disable();return;}
            for(let row=0;row<batch.indices.length;row++){
                const index=batch.indices[row];if(!run.projections.has(index)||steps+T>limits.steps)continue;
                steps+=T;const trace=capture(data,row,T,batch.widths[row],batch.width);if(trace)run.traces.set(index,trace);
            }
        },
        applyToSdkResults<T extends {text:string;box:object}>(results:T[]):T[]{
            const run=current();if(!run||run.pending||run.bound!==run.boxes.length)return results;
            // 先检查完整集合，不能先改一行再发现后续 Box 身份无从证明。
            const seen=new Set<object>();
            for(const result of results){if(!run.indices.has(result.box)||seen.has(result.box))return results;seen.add(result.box);}
            let changed=false;
            const texts=results.map(result=>{
                const index=run.indices.get(result.box)!,trace=run.traces.get(index),projection=run.projections.get(index);
                const text=trace&&projection?recover(result.text,trace,projection,run.dictionary):result.text;
                if(text!==result.text)changed=true;return text;
            });
            return changed?results.map((result,index)=>texts[index]===result.text?result:{...result,text:texts[index]}):results;
        },
        endRun(){scope=undefined;},
        endPage(){scope=undefined;signal=undefined;active=false;},
    };
}
