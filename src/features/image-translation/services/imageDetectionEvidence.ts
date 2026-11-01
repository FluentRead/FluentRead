/**
 * @file src/features/image-translation/services/imageDetectionEvidence.ts
 * 文件职责：为同次普通图片识别保存有界检测位图，并将其绑定到私有识别数组与原图身份。
 * 主要内容：只接纳显式原比例完整帧和整数切片，按锁定SDK实际灰度量化和零阈值同步打包Float32内容区；所有失败消耗尝试及已预留预算；外来帧完整校验后独占复制，查询须由一个真实帧覆盖完整 H8 观察区及两像素邻域。
 * 模块边界：不运行模型，不改变 OCR 几何或文字，不持有或转移原张量；证据只在 WeakMap 中随本次数组存活，不进入阅读或缓存。检测支持不等同文字语义，生产者负责证明同次 Canvas、模型输入及显式 resizeRatio 的来源。
 */
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
const MAX_PAGE_PIXELS=16*1024*1024,MAX_FRAME_SIDE=1536,MAX_OBSERVATION=65536,HORIZON=8,HALO=2;

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

/** 每页新建；拒绝也计尝试，合法面积在读取概率前预扣且不返还。 */
export function createImageDetectionEvidenceBudget() {
    let attempts=0,scanned=0;
    const captured:ImageDetectionFrame[]=[];
    return {
        capture(data:Float32Array,modelWidth:number,modelHeight:number,frame:ImageDetectionFrameSource):void {
            if(attempts>=MAX_ATTEMPTS)return;
            attempts++;
            if(!validGeometry(frame)||frame.resizeRatio!==1||(frame.rotation!==undefined&&frame.rotation!==0)
                ||modelWidth!==Math.ceil(frame.width/32)*32||modelHeight!==Math.ceil(frame.height/32)*32)return;
            const area=frame.width*frame.height,size=Math.ceil(area/8),modelArea=modelWidth*modelHeight;
            if(modelArea>MAX_SCAN-scanned)return;
            scanned+=modelArea;
            // padding平面面积为1024的倍数，ceil(内容面积/8)<=模型面积/8；
            // 因此4Mi完整概率扫描也严格约束所有已分配bit bytes不超过512KiB。
            if(!(data instanceof Float32Array)||data.length!==modelWidth*modelHeight)return;
            const bits=new Uint8Array(size);
            for(let y=0;y<modelHeight;y++)for(let x=0;x<modelWidth;x++){
                const probability=data[y*modelWidth+x];
                if(!Number.isFinite(probability)||probability<0||probability>1)return;
                // SDK6.6 canvas-native先tensorToCanvas(round(p*255))，再以gray>0检测。
                // 此处忠实保存同一平面；额外使用常规DB的0.3阈值会凭空缩小已用范围。
                if(y<frame.height&&x<frame.width&&Math.round(probability*255)>0){const index=y*frame.width+x;bits[index>>>3]|=1<<(index&7);}
            }
            captured.push(Object.freeze({pageWidth:frame.pageWidth,pageHeight:frame.pageHeight,
                x:frame.x,y:frame.y,width:frame.width,height:frame.height,bits}));
        },
        /** 序列化的是独占副本；修改或转移返回值不会污染生产者下一次快照。 */
        frames():readonly ImageDetectionFrame[] {return Object.freeze(captured.map(copyFrame));},
    };
}

interface Binding {image:string;width:number;height:number;support:ImageDetectionSupport}
const bindings=new WeakMap<object,Binding>();

function observationFor(source:ImageDetectionSourceBox,width:number,height:number):ImageDetectionObservation|undefined {
    if(!source||![source.x0,source.y0,source.x1,source.y1].every(Number.isFinite)
        ||source.x0<0||source.y0<0||source.x1>width||source.y1>height||source.x1<=source.x0||source.y1<=source.y0)return;
    const left=Math.max(0,Math.floor(source.x0)-HORIZON),top=Math.max(0,Math.floor(source.y0)-HORIZON);
    const right=Math.min(width,Math.ceil(source.x1)+HORIZON),bottom=Math.min(height,Math.ceil(source.y1)+HORIZON);
    if((right-left)*(bottom-top)>MAX_OBSERVATION)return;
    return {left,top,width:right-left,height:bottom-top};
}

function createSupport(frames:readonly ImageDetectionFrame[],width:number,height:number):ImageDetectionSupport {
    return Object.freeze({
        forBox(source:ImageDetectionSourceBox,observation:ImageDetectionObservation):((x:number,y:number)=>boolean)|undefined {
            const expected=observationFor(source,width,height);
            if(!expected||!observation||observation.left!==expected.left||observation.top!==expected.top
                ||observation.width!==expected.width||observation.height!==expected.height)return;
            // 观察区和 halo 必须由同一帧提供，禁止把两张不完整切片拼成许可。
            const left=Math.max(0,expected.left-HALO),top=Math.max(0,expected.top-HALO);
            const right=Math.min(width,expected.left+expected.width+HALO),bottom=Math.min(height,expected.top+expected.height+HALO);
            const frame=frames.find(candidate=>candidate.x<=left&&candidate.y<=top
                &&candidate.x+candidate.width>=right&&candidate.y+candidate.height>=bottom);
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
