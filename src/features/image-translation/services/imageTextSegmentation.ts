/**
 * @file src/features/image-translation/services/imageTextSegmentation.ts
 * 文件职责：为文字分割提供有界 RGBA 消息校验、Worker 内的输入构造，以及量化结果的局部支持投影。
 * 主要内容：消息只接受完整且非共享的有界 RGBA 视图，常数时间检查不扫描像素；在 Worker 内按固定白底 RGB、像素中心三角低通、右底黑色补齐构造 Float32 CHW，中间水平行按需缓存。输出先量化再逐轴重采样，只为 H8 观察区与两像素邻域预付面积和位图预算，不把分割支持本身当成擦除权限。
 * 模块边界：纯像素算法，不下载或运行模型，不读 Canvas，不改变原像素、OCR 框或文字；调用方负责同一请求、源像素所有权与取消，最终写入仍须经过整页 matte 授权。
 */
import type {ImageDetectionObservation,ImageDetectionSourceBox,ImageDetectionSupport} from './imageDetectionEvidence';

const SIDE=1024,PLANE=SIDE*SIDE,MAX_PIXELS=16_777_216,MAX_SIDE=8192;
const HORIZON=8,HALO=2,MAX_OBSERVATION=65_536,MAX_ATTEMPTS=128;
const MAX_PROJECTED_PIXELS=2_097_152,MAX_PROJECTED_BYTES=262_144;
const MAX_PROJECTION_SAMPLES=16_777_216;
const PRECISION=4_194_304;
interface Weight {start:number;values:number[]}

function validDimensions(width:number,height:number):boolean {
    return Number.isSafeInteger(width)&&Number.isSafeInteger(height)&&width>0&&height>0
        &&width<=MAX_SIDE&&height<=MAX_SIDE&&width*height<=MAX_PIXELS;
}

export interface ImageTextSegmentationSource {pixels:Uint8ClampedArray;width:number;height:number}

/** 原像素仍归调用方；postMessage 只克隆一次，不能 transfer 后破坏后续绘字或 CPU 重试。 */
export function isImageTextSegmentationSource(source:unknown):source is ImageTextSegmentationSource {
    const value=source as Partial<ImageTextSegmentationSource>|null|undefined;
    return !!value&&validDimensions(value.width!,value.height!)&&value.pixels instanceof Uint8ClampedArray
        &&value.pixels.length===value.width!*value.height!*4&&value.pixels.byteOffset===0
        &&value.pixels.buffer instanceof ArrayBuffer&&value.pixels.byteLength===value.pixels.buffer.byteLength;
}

function geometry(width:number,height:number):{width:number;height:number} {
    if(!validDimensions(width,height))throw new Error('文字分割图片尺寸无效');
    const ratio=SIDE/Math.max(width,height);
    return {width:Math.max(1,Math.round(width*ratio)),height:Math.max(1,Math.round(height*ratio))};
}

/** 逐轴三角低通；缩小时扩大采样窗口，各轴输出按整数像素四舍五入。 */
function weights(input:number,output:number,index:number):Weight {
    const scale=input/output,span=Math.max(1,scale),center=(index+.5)*scale;
    const start=Math.max(0,Math.floor(center-span+.5)),end=Math.min(input,Math.floor(center+span+.5));
    const values:number[]=[];
    let total=0;
    for(let pixel=start;pixel<end;pixel++){
        const weight=Math.max(0,1-Math.abs((pixel+.5-center)/span));
        values.push(weight);total+=weight;
    }
    for(let i=0;i<values.length;i++)values[i]=Math.round(values[i]/total*PRECISION);
    return {start,values};
}

function rounded(sum:number):number {return Math.max(0,Math.min(255,Math.floor((sum+PRECISION/2)/PRECISION)));}

/** 在推理 Worker 内构造 12MiB 自有输入；缓存窗口最多覆盖一次垂直低通所需的源行。 */
export function createImageTextSegmentationInput(pixels:Uint8ClampedArray,width:number,height:number):Float32Array {
    const size=geometry(width,height);
    if(!(pixels instanceof Uint8ClampedArray)||pixels.length!==width*height*4)throw new Error('文字分割原始像素无效');
    const input=new Float32Array(PLANE*3),horizontal=Array.from({length:size.width},(_,x)=>weights(width,size.width,x));
    const rows=new Map<number,Uint8Array>();
    const row=(y:number):Uint8Array=>{
        const cached=rows.get(y);
        if(cached)return cached;
        const result=new Uint8Array(size.width*3);
        for(let x=0;x<size.width;x++){
            const kernel=horizontal[x];
            for(let channel=0;channel<3;channel++){
                let sum=0;
                for(let k=0;k<kernel.values.length;k++){
                    const offset=(y*width+kernel.start+k)*4,alpha=pixels[offset+3];
                    const flat=Math.round((pixels[offset+channel]*alpha+255*(255-alpha))/255);
                    sum+=flat*kernel.values[k];
                }
                result[x*3+channel]=rounded(sum);
            }
        }
        rows.set(y,result);return result;
    };
    for(let y=0;y<size.height;y++){
        const vertical=weights(height,size.height,y);
        for(const key of rows.keys())if(key<vertical.start)rows.delete(key);
        const active=vertical.values.map((_,k)=>row(vertical.start+k));
        for(let x=0;x<size.width;x++)for(let channel=0;channel<3;channel++){
            let sum=0;
            for(let k=0;k<active.length;k++)sum+=active[k][x*3+channel]*vertical.values[k];
            input[channel*PLANE+y*SIDE+x]=rounded(sum)/255;
        }
    }
    return input;
}

export interface ImageTextSegmentationSupport extends ImageDetectionSupport {dispose():void}

/** 接管同次 Worker 返回的自有量化输出；调用方不得再修改或转移它，释放后所有旧查询失效。 */
export function createImageTextSegmentationSupport(seg:Uint8Array,width:number,height:number):ImageTextSegmentationSupport {
    const size=geometry(width,height);
    if(!(seg instanceof Uint8Array)||seg.length!==PLANE)throw new Error('文字分割输出尺寸无效');
    let active=true,attempts=0,projected=0,allocated=0,samples=0;
    let owned:Uint8Array|undefined=seg;
    return Object.freeze({
        dispose():void {active=false;owned=undefined;},
        forBox(source:ImageDetectionSourceBox,observation:ImageDetectionObservation):((x:number,y:number)=>boolean)|undefined {
            if(!active||attempts>=MAX_ATTEMPTS)return;
            attempts++;
            if(!source||![source.x0,source.y0,source.x1,source.y1].every(Number.isFinite)
                ||source.x0<0||source.y0<0||source.x1>width||source.y1>height||source.x1<=source.x0||source.y1<=source.y0)return;
            const left=Math.max(0,Math.floor(source.x0)-HORIZON),top=Math.max(0,Math.floor(source.y0)-HORIZON);
            const right=Math.min(width,Math.ceil(source.x1)+HORIZON),bottom=Math.min(height,Math.ceil(source.y1)+HORIZON);
            const ow=right-left,oh=bottom-top;
            if(ow*oh>MAX_OBSERVATION||!observation||observation.left!==left||observation.top!==top||observation.width!==ow||observation.height!==oh)return;
            const x0=Math.max(0,left-HALO),y0=Math.max(0,top-HALO),x1=Math.min(width,right+HALO),y1=Math.min(height,bottom+HALO);
            const rw=x1-x0,rh=y1-y0,area=rw*rh,bytes=Math.ceil(area/8);
            if(area>MAX_PROJECTED_PIXELS-projected||bytes>MAX_PROJECTED_BYTES-allocated)return;
            projected+=area;allocated+=bytes;
            const horizontal=Array.from({length:rw},(_,x)=>weights(size.width,width,x0+x));
            const vertical=Array.from({length:rh},(_,y)=>weights(size.height,height,y0+y));
            const first=vertical[0].start,last=vertical[rh-1];
            const rowCount=last.start+last.values.length-first;
            const work=horizontal.reduce((sum,k)=>sum+k.values.length,0)*rowCount
                +vertical.reduce((sum,k)=>sum+k.values.length,0)*rw;
            if(work>MAX_PROJECTION_SAMPLES-samples)return;
            samples+=work;
            const bits=new Uint8Array(bytes);
            const rows=new Map<number,Uint8Array>();
            // 先水平整数重采样、再垂直整数重采样；缩小时同样低通，不先二值化。
            for(let y=0;y<rh;y++){
                const kernel=vertical[y];
                for(const key of rows.keys())if(key<kernel.start)rows.delete(key);
                const activeRows=kernel.values.map((_,k)=>{
                    const sourceY=kernel.start+k,cached=rows.get(sourceY);
                    if(cached)return cached;
                    const row=new Uint8Array(rw);
                    for(let x=0;x<rw;x++){
                        const wx=horizontal[x];let sum=0;
                        for(let j=0;j<wx.values.length;j++)sum+=owned![sourceY*SIDE+wx.start+j]*wx.values[j];
                        row[x]=rounded(sum);
                    }
                    rows.set(sourceY,row);return row;
                });
                for(let x=0;x<rw;x++){
                    let sum=0;
                    for(let k=0;k<activeRows.length;k++)sum+=activeRows[k][x]*kernel.values[k];
                    if(rounded(sum)>=128){const index=y*rw+x;bits[index>>>3]|=1<<(index&7);}
                }
            }
            return (x:number,y:number):boolean=>{
                if(!active||!Number.isSafeInteger(x)||!Number.isSafeInteger(y)||x<left||y<top||x>=right||y>=bottom)return false;
                for(let ny=Math.max(y0,y-HALO);ny<Math.min(y1,y+HALO+1);ny++)for(let nx=Math.max(x0,x-HALO);nx<Math.min(x1,x+HALO+1);nx++){
                    const index=(ny-y0)*rw+nx-x0;
                    if((bits[index>>>3]&(1<<(index&7)))!==0)return true;
                }
                return false;
            };
        },
    });
}
