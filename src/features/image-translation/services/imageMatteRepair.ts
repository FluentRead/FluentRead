/**
 * @file src/features/image-translation/services/imageMatteRepair.ts
 * 文件职责：在原文字框的八像素观察域内证明一致RGBA静区、完整墨迹与外部图案的几何分离。
 * 主要内容：最多八个实际像素色仅提出背景候选，逐像素真实检测支持、完整静区闭环及整项共享的背景与墨色端点才允许通过；同alpha但RGB不同的AA仍属墨迹；作者混合保持下闭上开的前向域，Canvas读回逆域仅在精确半值处兼容相邻舍入结果，不使用通用色差容忍，共享预算限定最多64组端点；选定首个canonical共同端点后，全部墨迹还须位于可达九成coverage近端核心的两像素裙边，最终mask暂作截断距离场并只线性扫两趟，不逐候选重复全ROI工作；不能排除同形实色图案，端点不确定时也不穷举其他薄边解释；缺证据、穿出观察域、孤立未归属或多个背景均可解释时整项撤回。
 * 模块边界：纯同步只读像素，不创建DOM或模型、不生成概率或作者背景；实际同帧DB支持由调用方验证并提供查询，不能从本mask反造支持。结果不证明语义分割；调用方须在首次原图上预付共享预算、完成全页冲突和完整译字预检后才应用mask，不能覆盖OCR框或扩大原文保护权限。
 */
import type {OcrLine} from '@/src/shared/image/types';

type Box=OcrLine['bbox'];
type Rgba=readonly [number,number,number,number];
export interface ImageMatteObservationBox {left:number;top:number;width:number;height:number}
export interface ImageMatteFitBudget {remaining:number}
export interface ImageMatteRepair extends ImageMatteObservationBox {
    /** ROI内明确墨迹为1，不能据supportBox擦除包络内的其他像素。 */
    mask:Uint8Array;
    background:Rgba;
    /** 与原框及墨迹隔离、连接观察域外缘的完整非背景组件。 */
    artMask:Uint8Array;
    sourceBox:Box;
    supportBox:Box;
}
const HORIZON=8,MAX_PIXELS=65_536,MAX_ENDPOINTS=64;

/** 与实际读取完全相同的零扫描几何；调用方在尝试规划前按width*height收费。 */
export function imageMatteObservationBox(width:number,height:number,sourceBox:Box):ImageMatteObservationBox|undefined {
    if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<=0||height<=0
        ||width>8192||height>8192||width*height>16_777_216)return;
    const {x0,y0,x1,y1}=sourceBox;
    if(![x0,y0,x1,y1].every(Number.isFinite)||x0<0||y0<0||x1>width||y1>height||x1<=x0||y1<=y0)return;
    const left=Math.max(0,Math.floor(x0)-HORIZON),top=Math.max(0,Math.floor(y0)-HORIZON);
    const right=Math.min(width,Math.ceil(x1)+HORIZON),bottom=Math.min(height,Math.ceil(y1)+HORIZON);
    const localWidth=right-left,localHeight=bottom-top;
    if(localWidth*localHeight>MAX_PIXELS)return;
    return {left,top,width:localWidth,height:localHeight};
}

function packed(pixels:Uint8ClampedArray,offset:number):number {
    return (pixels[offset]|pixels[offset+1]<<8|pixels[offset+2]<<16|pixels[offset+3]<<24)>>>0;
}

/** Canvas量化的整数逆像；半值读回可落在相邻字节，原作者字节也在候选域内。 */
function sourceChannelRange(color:number,alpha:number):number {
    if(alpha===255)return color|(color<<8);
    const first=Math.max(0,Math.ceil((color-.5)*alpha/255));
    // 仅数学上恰为半整数的读回边界新增一个可能值，不能扩成逐通道±1容差。
    const last=Math.min(alpha,Math.floor((color+.5)*alpha/255));
    if(first>last)return color|(color<<8);
    const low=Math.max(0,Math.min(color,Math.ceil((first-.5)*255/alpha)));
    const high=Math.min(255,Math.max(color,Math.ceil((last+.5)*255/alpha)-1));
    return low|(high<<8);
}

interface Interval {lowN:number;lowD:number;lowClosed:boolean;highN:number;highD:number;highClosed:boolean}
/** offset+slope*t >=0或>0；整数有理数比较，避免epsilon把不允许的half-tie拼成witness。 */
function constrain(interval:Interval,offset:number,slope:number,strict:boolean):boolean {
    if(slope===0)return strict?offset>0:offset>=0;
    const denominator=Math.abs(slope),numerator=slope>0?-offset:offset;
    if(slope>0){
        const compare=numerator*interval.lowD-interval.lowN*denominator;
        if(compare>0){interval.lowN=numerator;interval.lowD=denominator;interval.lowClosed=!strict;}
        else if(compare===0)interval.lowClosed&&=!strict;
    }else{
        const compare=numerator*interval.highD-interval.highN*denominator;
        if(compare<0){interval.highN=numerator;interval.highD=denominator;interval.highClosed=!strict;}
        else if(compare===0)interval.highClosed&&=!strict;
    }
    const compare=interval.lowN*interval.highD-interval.highN*interval.lowD;
    return compare<0||(compare===0&&interval.lowClosed&&interval.highClosed);
}

/** 固定整项共同BG/F之后，单pixel四通道只能共享一个coverage；interval对象跨比较复用。 */
function forwardFits(alpha:number,ranges:Uint16Array,rangeOffset:number,endpoints:Uint8Array,bgAlpha:number,inkAlpha:number,interval:Interval):boolean {
    interval.lowN=0;interval.lowD=1;interval.lowClosed=true;interval.highN=1;interval.highD=1;interval.highClosed=true;
    const deltaAlpha=inkAlpha-bgAlpha;
    if(!constrain(interval,2*bgAlpha-2*alpha+1,2*deltaAlpha,false)
        ||!constrain(interval,2*alpha+1-2*bgAlpha,-2*deltaAlpha,true))return false;
    for(let channel=0;channel<3;channel++){
        const range=ranges[rangeOffset+channel],lower=2*(range&255)-1,upper=2*(range>>>8)+1;
        const base=endpoints[channel]*bgAlpha,delta=endpoints[channel+3]*inkAlpha-base;
        if(!constrain(interval,2*base-lower*bgAlpha,2*delta-lower*deltaAlpha,false)
            ||!constrain(interval,upper*bgAlpha-2*base,upper*deltaAlpha-2*delta,true))return false;
    }
    return true;
}

function channelCandidates(range:number,observed:number):number[] {
    const low=range&255,high=range>>>8,values:number[]=[];
    // 优先试实际观测字节这个canonical witness，其他整数仍需整项共同成立。
    if(observed>=low&&observed<=high)values.push(observed);
    for(let value=low;value<=high;value++)if(value!==observed)values.push(value);
    return values;
}

interface ObservedMoat {labels:Uint8Array;background:number;supportBox:Box}
/** 先独立证明几何静区；多种闭环背景即歧义，不能借墨色拟合来吞掉真实内层背景。 */
function observeMoat(colors:Uint32Array,roi:ImageMatteObservationBox,sourceBox:Box,background:number):ObservedMoat|undefined {
    const {left,top,width,height}=roi,area=colors.length;
    const x0=Math.floor(sourceBox.x0)-left,y0=Math.floor(sourceBox.y0)-top;
    const x1=Math.ceil(sourceBox.x1)-left,y1=Math.ceil(sourceBox.y1)-top;
    // 0静区、1未访问差异、2确认墨、3外部art、4当前组件。
    const labels=new Uint8Array(area),queue=new Uint32Array(area);
    let observedInside=false;
    for(let index=0;index<area;index++){
        if(colors[index]!==background)labels[index]=1;
        else {const x=index%width,y=Math.floor(index/width);if(x>=x0&&x<x1&&y>=y0&&y<y1)observedInside=true;}
    }
    if(!observedInside)return;
    let inkCount=0,supportLeft=width,supportTop=height,supportRight=0,supportBottom=0;
    for(let start=0;start<area;start++){
        if(labels[start]!==1)continue;
        let head=0,tail=1,core=false,edge=false;queue[0]=start;labels[start]=4;
        while(head<tail){
            const index=queue[head++],x=index%width,y=Math.floor(index/width);
            core ||= x>=x0&&x<x1&&y>=y0&&y<y1;
            edge ||= x===0||y===0||x===width-1||y===height-1;
            for(let ny=Math.max(0,y-1);ny<=Math.min(height-1,y+1);ny++)for(let nx=Math.max(0,x-1);nx<=Math.min(width-1,x+1);nx++){
                const next=ny*width+nx;if(labels[next]!==1)continue;labels[next]=4;queue[tail++]=next;
            }
        }
        // 交框且穿ROI、或既不交框也不连外界，都没有完整几何归属。
        if(core===edge)return;
        for(let i=0;i<tail;i++){
            const index=queue[i];labels[index]=core?2:3;
            if(core){const x=index%width,y=Math.floor(index/width);inkCount++;
                supportLeft=Math.min(supportLeft,x);supportTop=Math.min(supportTop,y);
                supportRight=Math.max(supportRight,x+1);supportBottom=Math.max(supportBottom,y+1);}
        }
    }
    if(inkCount===0)return;
    // K包含完整原框及附着墨。K的完整一像素八邻域必须全是同一RGBA，不能只凭多数环。
    for(let index=0;index<area;index++){
        const x=index%width,y=Math.floor(index/width),core=x>=x0&&x<x1&&y>=y0&&y<y1;
        if(!core&&labels[index]!==2)continue;
        // 四条非空外射线保证core不触ROI边；组件检查已排除触边墨，故八邻域都可观察。
        for(let ny=y-1;ny<=y+1;ny++)for(let nx=x-1;nx<=x+1;nx++){
            const neighbour=ny*width+nx;
            if((nx>=x0&&nx<x1&&ny>=y0&&ny<y1)||labels[neighbour]===2)continue;
            if(labels[neighbour]!==0)return;
        }
    }
    return {labels,background,supportBox:{x0:left+supportLeft,y0:top+supportTop,x1:left+supportRight,y1:top+supportBottom}};
}

function finish(colors:Uint32Array,roi:ImageMatteObservationBox,sourceBox:Box,observed:ObservedMoat,
    supportAt:(x:number,y:number)=>boolean,fitBudget:ImageMatteFitBudget):ImageMatteRepair|undefined {
    const {labels,background,supportBox}=observed,area=colors.length,bgAlpha=background>>>24;
    let peak=0,largest=0;
    for(let index=0;index<area;index++)if(labels[index]===2){
        const value=colors[index],alpha=value>>>24;
        if(alpha<bgAlpha||alpha===0)return;
        if(supportAt(roi.left+index%roi.width,roi.top+Math.floor(index/roi.width))!==true)return;
        let distance=0;
        for(let channel=0;channel<4;channel++){
            const delta=channel===3?(alpha-bgAlpha)*255:((value>>>(channel*8))&255)*alpha-((background>>>(channel*8))&255)*bgAlpha;
            distance+=delta*delta;
        }
        if(distance>largest){largest=distance;peak=value;}
    }
    const inkAlpha=peak>>>24,endpointRanges:number[]=[];
    let combinations=1;
    for(let endpoint=0;endpoint<2;endpoint++)for(let channel=0;channel<3;channel++){
        const value=endpoint===0?background:peak,alpha=value>>>24;
        const range=alpha===0?0:sourceChannelRange((value>>>(channel*8))&255,alpha);
        endpointRanges.push(range);combinations*=(range>>>8)-(range&255)+1;
        if(combinations>MAX_ENDPOINTS)return;
    }
    const choices=endpointRanges.map((range,index)=>channelCandidates(range,((index<3?background:peak)>>>((index%3)*8))&255));
    const inkIndices:number[]=[];
    for(let index=0;index<area;index++)if(labels[index]===2)inkIndices.push(index);
    const ranges=new Uint16Array(inkIndices.length*3);
    for(let i=0;i<inkIndices.length;i++){
        const value=colors[inkIndices[i]],alpha=value>>>24;
        for(let channel=0;channel<3;channel++)ranges[i*3+channel]=sourceChannelRange((value>>>(channel*8))&255,alpha);
    }
    const interval:Interval={lowN:0,lowD:1,lowClosed:true,highN:1,highD:1,highClosed:true},endpoints=new Uint8Array(6);
    // 暂借最终mask存0..3截断Chebyshev距离；不新增ROI数组或整页像素读取。
    const mask=new Uint8Array(area);mask.fill(3);
    let fits=false;
    for(let candidate=0;candidate<combinations;candidate++){
        let remainder=candidate;
        for(let channel=0;channel<6;channel++){endpoints[channel]=choices[channel][remainder%choices[channel].length];remainder=Math.floor(remainder/choices[channel].length);}
        let valid=true;
        for(let i=0;i<inkIndices.length;i++){
            if(--fitBudget.remaining<0)return;
            if(!forwardFits(colors[inkIndices[i]]>>>24,ranges,i*3,endpoints,bgAlpha,inkAlpha,interval)){valid=false;break;}
            // 同一量化witness中可达t>=.9，才属近端核心；high=.9且开区间仍拒绝。
            // constrain复用本pixel已验证的interval，下个forwardFits会完整重置。
            mask[inkIndices[i]]=constrain(interval,-9,10,false)?0:3;
        }
        if(valid){fits=true;break;}
    }
    if(!fits)return;
    // 只对首个canonical有效共同端点跑一次薄边准入；不以64次距离变换穷举其他解释。
    // 中间coverage只能作薄AA，不能让与黑字同色线上的整块灰牌都被当成字擦掉。
    for(let y=0;y<roi.height;y++)for(let x=0;x<roi.width;x++){
        const index=y*roi.width+x;
        mask[index]=Math.min(mask[index],x?mask[index-1]+1:3,y?mask[index-roi.width]+1:3,
            x&&y?mask[index-roi.width-1]+1:3,y&&x+1<roi.width?mask[index-roi.width+1]+1:3);
    }
    for(let y=roi.height-1;y>=0;y--)for(let x=roi.width-1;x>=0;x--){
        const index=y*roi.width+x;
        mask[index]=Math.min(mask[index],x+1<roi.width?mask[index+1]+1:3,y+1<roi.height?mask[index+roi.width]+1:3,
            x+1<roi.width&&y+1<roi.height?mask[index+roi.width+1]+1:3,x&&y+1<roi.height?mask[index+roi.width-1]+1:3);
    }
    for(let index=0;index<area;index++)if(labels[index]===2&&mask[index]>2)return;
    const artMask=new Uint8Array(area);
    for(let index=0;index<area;index++){mask[index]=+(labels[index]===2);artMask[index]=+(labels[index]===3);}
    return {...roi,mask,artMask,background:[background&255,(background>>>8)&255,(background>>>16)&255,bgAlpha],sourceBox:{...sourceBox},
        supportBox};
}

/** 固定H8/64Ki ROI，最多八候选的全像素工作；调用方必须累计ROI面积，不可每行重置预算。 */
export function planImageMatteRepair(pixels:Uint8ClampedArray,width:number,height:number,sourceBox:Box,
    supportAt:(x:number,y:number)=>boolean,fitBudget:ImageMatteFitBudget):ImageMatteRepair|undefined {
    if(typeof supportAt!=='function'||!fitBudget||!Number.isSafeInteger(fitBudget.remaining)||fitBudget.remaining<0)return;
    const box={x0:sourceBox.x0,y0:sourceBox.y0,x1:sourceBox.x1,y1:sourceBox.y1};
    const roi=imageMatteObservationBox(width,height,box);
    if(!roi||pixels.length<width*height*4)return;
    const colors=new Uint32Array(roi.width*roi.height);
    for(let y=0;y<roi.height;y++)for(let x=0;x<roi.width;x++)colors[y*roi.width+x]=packed(pixels,((roi.top+y)*width+roi.left+x)*4);
    // 任一完整闭环都必穿原框中心的四条外射线；集合交集不漏掉内层静区，也最多八候选。
    const x0=Math.floor(box.x0)-roi.left,y0=Math.floor(box.y0)-roi.top,x1=Math.ceil(box.x1)-roi.left,y1=Math.ceil(box.y1)-roi.top;
    const middleX=Math.floor((x0+x1-1)/2),middleY=Math.floor((y0+y1-1)/2);
    const rays=[Array.from({length:x0},(_,i)=>colors[middleY*roi.width+x0-1-i]),
        Array.from({length:roi.width-x1},(_,i)=>colors[middleY*roi.width+x1+i]),
        Array.from({length:y0},(_,i)=>colors[(y0-1-i)*roi.width+middleX]),
        Array.from({length:roi.height-y1},(_,i)=>colors[(y1+i)*roi.width+middleX])];
    const candidates=new Set(rays[0]);
    for(const ray of rays.slice(1)){const colorsOnRay=new Set(ray);for(const candidate of candidates)if(!colorsOnRay.has(candidate))candidates.delete(candidate);}
    let result:ObservedMoat|undefined;
    for(const background of candidates){
        const candidate=observeMoat(colors,roi,box,background);
        if(candidate){if(result)return;result=candidate;}
    }
    return result?finish(colors,roi,box,result,supportAt,fitBudget):undefined;
}
