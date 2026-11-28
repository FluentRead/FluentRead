/**
 * @file src/features/image-translation/services/imageDetectionEvidence.ts
 * 文件职责：为同次普通图片识别保存有界检测位图，并将其绑定到私有识别数组与原图身份。
 * 主要内容：只接纳显式原比例完整帧和整数切片，按锁定SDK实际灰度量化和零阈值同步打包Float32内容区。透明图保留整帧校验；不透明图仅在原像素提示纯色背景与框外墨迹时保存局部观察区。所有失败消耗尝试及已预留预算，查询须由单帧覆盖完整观察区及两像素邻域。
 * 模块边界：不运行模型，不改变 OCR 几何或文字，不持有或转移原张量；证据只在 WeakMap 中随本次数组存活，不进入阅读或缓存。检测支持不等同文字语义，生产者负责证明同次 Canvas、模型输入及显式 resizeRatio 的来源。
 */
import {imageMatteObservationBox} from './imageMatteRepair';

export interface ImageDetectionFrame {
    pageWidth:number;pageHeight:number;
    x:number;y:number;width:number;height:number;
    /** 内容区逐行、低位在前；不包含模型 padding，尾部未用位为零。 */
    bits:Uint8Array;
}
export interface ImageDetectionFrameSource {
    pageWidth:number;pageHeight:number;
    x:number;y:number;width:number;height:number;
    resizeRatio:number;
    rotation?:number;
}
export interface ImageDetectionSourceBox {x0:number;y0:number;x1:number;y1:number}
export interface ImageDetectionObservation {left:number;top:number;width:number;height:number}
export interface ImageDetectionSupport {
    forBox(sourceBox:ImageDetectionSourceBox,observation:ImageDetectionObservation):((x:number,y:number)=>boolean)|undefined;
}
type Geometry=Omit<ImageDetectionFrame,'bits'>;
const MAX_ATTEMPTS=128,MAX_SCAN=4*1024*1024,MAX_BYTES=512*1024;
const MAX_PAGE_PIXELS=16*1024*1024,MAX_FRAME_SIDE=1728,HALO=2;

function validPage(width:number,height:number):boolean {
    return Number.isSafeInteger(width)&&Number.isSafeInteger(height)&&width>0&&height>0
        &&width<=8192&&height<=8192&&width*height<=MAX_PAGE_PIXELS;
}

function validGeometry(frame:Geometry):boolean {
    return !!frame&&validPage(frame.pageWidth,frame.pageHeight)
        &&[frame.x,frame.y,frame.width,frame.height].every(Number.isSafeInteger)
        &&frame.x>=0&&frame.y>=0&&frame.width>0&&frame.height>0
        &&frame.width<=MAX_FRAME_SIDE&&frame.height<=MAX_FRAME_SIDE
        &&frame.x+frame.width<=frame.pageWidth&&frame.y+frame.height<=frame.pageHeight;
}

function copyFrame(frame:ImageDetectionFrame):ImageDetectionFrame {
    return Object.freeze({pageWidth:frame.pageWidth,pageHeight:frame.pageHeight,x:frame.x,y:frame.y,
        width:frame.width,height:frame.height,bits:new Uint8Array(frame.bits)});
}

function detectionWindow(observation:ImageDetectionObservation,width:number,height:number):ImageDetectionObservation {
    const left=Math.max(0,observation.left-HALO),top=Math.max(0,observation.top-HALO);
    const right=Math.min(width,observation.left+observation.width+HALO);
    const bottom=Math.min(height,observation.top+observation.height+HALO);
    return {left,top,width:right-left,height:bottom-top};
}

/** 预筛只决定是否存模型数据。完整静区、墨色和原文字形仍由擦除端验证。 */
function opaqueDetectionWindow(frame:ImageDetectionFrameSource,box:ImageDetectionSourceBox,pixels:Uint8ClampedArray):ImageDetectionObservation|undefined {
    const {pageWidth,pageHeight}=frame;
    const x0=box.x0+frame.x,y0=box.y0+frame.y,x1=box.x1+frame.x,y1=box.y1+frame.y;
    const height=y1-y0,width=x1-x0;
    if(![x0,y0,x1,y1].every(Number.isSafeInteger)||height<8||width<height*2
        ||x0<7||y0<7||x1+7>pageWidth||y1+7>pageHeight||pixels.length!==pageWidth*pageHeight*4)return;
    const observation=imageMatteObservationBox(pageWidth,pageHeight,{x0,y0,x1,y1});
    if(!observation)return;
    const window=detectionWindow(observation,pageWidth,pageHeight);
    const left=window.left-frame.x,top=window.top-frame.y;
    if(left<0||top<0||left+window.width>frame.width||top+window.height>frame.height)return;

    const color=(x:number,y:number)=>{
        const index=(y*pageWidth+x)*4;
        return pixels[index]|pixels[index+1]<<8|pixels[index+2]<<16|pixels[index+3]<<24;
    };
    const background=color(x0-7,y0-7);
    if(background>>>24!==255)return;
    for(let sample=0;sample<=4;sample++){
        const x=x0+Math.floor((width-1)*sample/4);
        if(color(x,y0-7)!==background||color(x,y1+6)!==background)return;
    }
    const middle=y0+Math.floor(height/2);
    if(color(x0-7,middle)!==background||color(x1+6,middle)!==background)return;
    // 传统物理擦除框每侧最多扩四像素；只在外面仍见到墨色时采集。
    const stride=Math.max(1,Math.floor(width/32));
    for(let x=x0;x<x1;x+=stride){
        if(color(x,y0-5)!==background||color(x,y1+4)!==background)return {...window,left,top};
    }
}

/** 每页新建；拒绝也计尝试，合法面积在读取概率前预扣且不返还。 */
export function createImageDetectionEvidenceBudget() {
    let attempts=0,scanned=0,bytes=0;
    const captured:ImageDetectionFrame[]=[];
    return {
        capture(data:Float32Array,modelWidth:number,modelHeight:number,frame:ImageDetectionFrameSource,
            opaque?:{box:ImageDetectionSourceBox;pixels:Uint8ClampedArray}):void {
            if(attempts>=MAX_ATTEMPTS)return;
            attempts++;
            if(!validGeometry(frame)||frame.resizeRatio!==1||(frame.rotation!==undefined&&frame.rotation!==0)
                ||modelWidth!==Math.ceil(frame.width/32)*32||modelHeight!==Math.ceil(frame.height/32)*32)return;
            const window=opaque&&opaqueDetectionWindow(frame,opaque.box,opaque.pixels);
            if(opaque&&!window)return;
            const {left,top,width,height}=window??{left:0,top:0,width:frame.width,height:frame.height};
            const scanWidth=window?width:modelWidth,scanHeight=window?height:modelHeight;
            const area=scanWidth*scanHeight,size=Math.ceil(width*height/8);
            if(area>MAX_SCAN-scanned||size>MAX_BYTES-bytes)return;
            scanned+=area;
            bytes+=size;
            if(!(data instanceof Float32Array)||data.length!==modelWidth*modelHeight)return;
            const bits=new Uint8Array(size);
            for(let y=0;y<scanHeight;y++)for(let x=0;x<scanWidth;x++){
                const probability=data[(top+y)*modelWidth+left+x];
                if(!Number.isFinite(probability)||probability<0||probability>1)return;
                // SDK6.6 canvas-native先tensorToCanvas(round(p*255))，再以gray>0检测。
                // 此处忠实保存同一平面；额外使用常规DB的0.3阈值会凭空缩小已用范围。
                if(y<height&&x<width&&Math.round(probability*255)>0){const index=y*width+x;bits[index>>>3]|=1<<(index&7);}
            }
            captured.push(Object.freeze({pageWidth:frame.pageWidth,pageHeight:frame.pageHeight,
                x:frame.x+left,y:frame.y+top,width,height,bits}));
        },
        /** 序列化的是独占副本；修改或转移返回值不会污染生产者下一次快照。 */
        frames():readonly ImageDetectionFrame[] {return Object.freeze(captured.map(copyFrame));},
    };
}

interface Binding {image:string;width:number;height:number;support:ImageDetectionSupport}
const bindings=new WeakMap<object,Binding>();

function createSupport(frames:readonly ImageDetectionFrame[],width:number,height:number):ImageDetectionSupport {
    return Object.freeze({
        forBox(source:ImageDetectionSourceBox,observation:ImageDetectionObservation):((x:number,y:number)=>boolean)|undefined {
            const expected=source&&imageMatteObservationBox(width,height,source);
            if(!expected||!observation||observation.left!==expected.left||observation.top!==expected.top
                ||observation.width!==expected.width||observation.height!==expected.height)return;
            // 观察区和 halo 必须由同一帧提供，禁止把两张不完整切片拼成许可。
            const window=detectionWindow(expected,width,height),{left,top}=window;
            const frame=frames.find(candidate=>candidate.x<=left&&candidate.y<=top
                &&candidate.x+candidate.width>=left+window.width&&candidate.y+candidate.height>=top+window.height);
            if(!frame)return;
            // 冻结标量，不持有调用方可修改的 sourceBox/observation。
            return (x:number,y:number):boolean=>{
                if(!Number.isSafeInteger(x)||!Number.isSafeInteger(y)||x<expected.left||y<expected.top
                    ||x>=expected.left+expected.width||y>=expected.top+expected.height)return false;
                for(let ny=Math.max(0,y-HALO);ny<=Math.min(height-1,y+HALO);ny++){
                    for(let nx=Math.max(0,x-HALO);nx<=Math.min(width-1,x+HALO);nx++){
                        const index=(ny-frame.y)*frame.width+nx-frame.x;
                        if((frame.bits[index>>>3]&(1<<(index&7)))!==0)return true;
                    }
                }
                return false;
            };
        },
    });
}

/** 私有数组身份绑定；任何无效新绑定先撤销旧证据，不遗留过期许可。 */
export function bindImageDetectionEvidence(regions:object,image:string,width:number,height:number,frames:readonly ImageDetectionFrame[]):void {
    if(!Array.isArray(regions))return;
    bindings.delete(regions);
    if(typeof image!=='string'||!image.length||!validPage(width,height)||!Array.isArray(frames)
        ||frames.length===0||frames.length>MAX_ATTEMPTS)return;
    let area=0,bytes=0;
    // 先完整验证，绝不把有效前缀当作整页证据发布。
    for(const frame of frames){
        if(!validGeometry(frame)||frame.pageWidth!==width||frame.pageHeight!==height||!(frame.bits instanceof Uint8Array))return;
        const pixels=frame.width*frame.height,size=Math.ceil(pixels/8);
        area+=pixels;bytes+=size;
        if(area>MAX_SCAN||bytes>MAX_BYTES||frame.bits.length!==size)return;
        const remainder=pixels&7;
        if(remainder!==0&&(frame.bits[size-1]>>remainder)!==0)return;
    }
    const owned=Object.freeze(frames.map(copyFrame));
    bindings.set(regions,{image,width,height,support:createSupport(owned,width,height)});
}

/** 只接纳本次数组、精确原图字符串与尺寸；分组或克隆出的新数组没有权限。 */
export function getImageDetectionEvidence(regions:object,image:string,width:number,height:number):ImageDetectionSupport|undefined {
    const binding=bindings.get(regions);
    return binding&&binding.image===image&&binding.width===width&&binding.height===height?binding.support:undefined;
}
