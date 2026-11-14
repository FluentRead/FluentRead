/**
 * @file src/features/image-translation/services/sourceTypographyGeometry.ts
 * 文件职责：从同帧原像素观察分离字形的轻微倾角和投影尺度，供排版独立核对，不把带横线的底色当作纯色修补依据。
 * 主要内容：整页先支付有限物理框预算；仅分析不透明横排，以亮度双峰分离和完整背景边缘确认有界前景，拒绝低对比、连续长线、少量组件及大块图案。
 * 逐行凸包保留全部前景像素的投影包络；互不重叠的完整组件字组用有限搜索独立核对方向，拒绝支持冲突，避免把上下伸笔画的阶梯误当成基线。多行还须方向、字高、上下顺序和水平交叠一致。
 * 模块边界：纯像素与几何观察，不改变OCR、文字、颜色、原框或原数组，不返回擦除mask、字体识别结论或写入权限；调用方仍须用完整原文独立核对字体尺度并验证最终译文字形。
 */
import type {ImageTextRegion} from '../paragraphs';

type Box=ImageTextRegion['bbox'];
interface Point {x:number;y:number}
interface Roi {left:number;top:number;width:number;height:number}
interface PhysicalInk {hull:Point[];radians:number}
interface Component {start:number;end:number;left:number;right:number}
interface OrientationRange {low:number;high:number}
export interface ImageSourceTypographyGeometry {
    readonly owner:ImageTextRegion;
    readonly sourceText:string;
    readonly radians:number;
    readonly originX:number;
    readonly originY:number;
    /** 以origin为中心、逆转倾角后的实际前景包络；不是可擦除或可绘制区域。 */
    readonly bounds:Box;
    readonly width:number;
    readonly height:number;
    readonly count:number;
    /** 各物理行投影后相对轴向包络的最小高度收益；上下伸笔画可使它为负，不能独自证明字体。 */
    readonly heightGain:number;
    /** 仅在物理行中线间距一致时提供；不是识别出的字体行高。 */
    readonly linePitch?:number;
}
const MAX_PIXELS=65_536,PAGE_PIXELS=2_097_152,STEP=Math.PI/720;
const valid=(b:Box|undefined,w:number,h:number):b is Box=>!!b&&[b.x0,b.y0,b.x1,b.y1].every(Number.isFinite)
    &&b.x0>=0&&b.y0>=0&&b.x1<=w&&b.y1<=h&&b.x1>b.x0&&b.y1>b.y0;

function observationBox(b:Box,w:number,h:number):Roi|undefined {
    if(b.x1-b.x0<48||b.y1-b.y0<10||(b.x1-b.x0)/(b.y1-b.y0)<2.5)return;
    const left=Math.floor(b.x0)-4,top=Math.floor(b.y0)-4,right=Math.ceil(b.x1)+4,bottom=Math.ceil(b.y1)+4;
    if(left<0||top<0||right>w||bottom>h||(right-left)*(bottom-top)>MAX_PIXELS)return;
    return{left,top,width:right-left,height:bottom-top};
}
function convexHull(points:Point[]):Point[] {
    points.sort((a,b)=>a.x-b.x||a.y-b.y);
    const hull:Point[]=[];
    const cross=(a:Point,b:Point,c:Point)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
    for(const point of points){while(hull.length>1&&cross(hull[hull.length-2],hull[hull.length-1],point)<=0)hull.pop();hull.push(point);}
    const lower=hull.length;
    for(let i=points.length-2;i>=0;i--){const point=points[i];while(hull.length>lower&&cross(hull[hull.length-2],hull[hull.length-1],point)<=0)hull.pop();hull.push(point);}
    hull.pop();return hull;
}
function project(hull:readonly Point[],radians:number):Box {
    const c=Math.cos(radians),s=Math.sin(radians),pad=(Math.abs(c)+Math.abs(s))/2;
    let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
    for(const point of hull){const x=c*point.x+s*point.y,y=-s*point.x+c*point.y;x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);}
    return{x0:x0-pad,y0:y0-pad,x1:x1+pad,y1:y1+pad};
}
/** 分开的完整前景组件组提供方向旁证；不以整行最小包围框把大小写/上下伸笔画的阶梯误认为基线。 */
function groupOrientation(order:Uint32Array,components:readonly Component[],roi:Roi,start:number,end:number):OrientationRange|undefined {
    const lefts=new Int32Array(roi.height).fill(roi.width),rights=new Int32Array(roi.height).fill(-1);let count=0;
    for(const component of components){
        if(component.left<start||component.right>end)continue;
        count++;
        for(let i=component.start;i<component.end;i++){const index=order[i],x=index%roi.width,y=Math.floor(index/roi.width);lefts[y]=Math.min(lefts[y],x);rights[y]=Math.max(rights[y],x);}
    }
    if(count<2)return;
    const points:Point[]=[];
    for(let y=0;y<roi.height;y++)if(rights[y]>=0){points.push({x:roi.left+lefts[y]+.5,y:roi.top+y+.5});if(rights[y]!==lefts[y])points.push({x:roi.left+rights[y]+.5,y:roi.top+y+.5});}
    const hull=convexHull(points),axis=project(hull,0);if(axis.x1-axis.x0<24)return;
    let best=60,minHeight=axis.y1-axis.y0;const heights:number[]=[];
    for(let step=-60;step<=60;step++){
        const angle=step*STEP,b=project(hull,angle),height=b.y1-b.y0;
        heights.push(height);if(height<minHeight){best=step+60;minHeight=height;}
    }
    const radians=(best-60)*STEP;
    // 子窗比整行短，不能要求同一比例的高度收益；至少超过一个投影像素，再由分离字组交叉核对。
    if(Math.abs(radians)<STEP*6||Math.abs(radians)>STEP*58||minHeight<6||(axis.y1-axis.y0)-minHeight<=1)return;
    // 允许一个像素的包络量化不确定性；零度已超出此区间，连续扩展不能跨零或不相容的角度岛。
    let low=best,high=best;
    while(low>2&&heights[low-1]<=minHeight+1)low--;
    while(high<118&&heights[high+1]<=minHeight+1)high++;
    return{low:(low-60)*STEP,high:(high-60)*STEP};
}
function observePhysical(pixels:Uint8ClampedArray,imageWidth:number,roi:Roi):PhysicalInk|undefined {
    const {left,top,width:w,height:h}=roi,area=w*h,hist=new Uint32Array(256),gray=new Uint8Array(area);
    let total=0,squares=0;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
        const offset=((top+y)*imageWidth+left+x)*4;if(pixels[offset+3]!==255)return;
        const value=(77*pixels[offset]+150*pixels[offset+1]+29*pixels[offset+2])>>>8;
        gray[y*w+x]=value;hist[value]++;total+=value;squares+=value*value;
    }
    const variance=squares-total*total/area;let count=0,sum=0,best=0,threshold=0,separation=0;
    for(let value=0;value<255;value++){
        count+=hist[value];sum+=hist[value]*value;if(!count||count===area)continue;
        const difference=sum/count-(total-sum)/(area-count),score=count*(area-count)/area*difference*difference;
        if(score>best){best=score;threshold=value;separation=Math.abs(difference);}
    }
    if(variance<=0||best<variance*.85||separation<48)return;
    const darkBackground=gray[0]<=threshold,mask=new Uint8Array(area);let ink=0;
    const extrema:Point[]=[];
    for(let y=0;y<h;y++){
        let first=w,last=-1;
        for(let x=0;x<w;x++)if((gray[y*w+x]<=threshold)!==darkBackground){
            if(x===0||y===0||x===w-1||y===h-1)return;
            mask[y*w+x]=1;ink++;first=Math.min(first,x);last=x;
        }
        if(last>=0){extrema.push({x:left+first+.5,y:top+y+.5});if(last!==first)extrema.push({x:left+last+.5,y:top+y+.5});}
    }
    if(ink<24||ink<area*.01||ink>area*.45)return;
    const queue=new Uint32Array(area),order=new Uint32Array(ink),components:Component[]=[];let stored=0,largest=0,widest=0;
    for(let start=0;start<area;start++){
        if(mask[start]!==1)continue;
        if(components.length===1024)return;
        let head=0,tail=1,x0=w,x1=0;queue[0]=start;mask[start]=2;
        while(head<tail){
            const index=queue[head++],x=index%w,y=Math.floor(index/w);x0=Math.min(x0,x);x1=Math.max(x1,x+1);
            for(let ny=y-1;ny<=y+1;ny++)for(let nx=x-1;nx<=x+1;nx++){
                const next=ny*w+nx;if(mask[next]!==1)continue;mask[next]=2;queue[tail++]=next;
            }
        }
        largest=Math.max(largest,tail);widest=Math.max(widest,x1-x0);
        order.set(queue.subarray(0,tail),stored);components.push({start:stored,end:stored+tail,left:left+x0,right:left+x1});stored+=tail;
    }
    const hull=convexHull(extrema);if(components.length<3||largest>ink*.6)return;
    const axis=project(hull,0);if(widest>(axis.x1-axis.x0)*.6)return;
    for(const divisions of [4,2]){
        const angles:OrientationRange[]=[];
        for(let i=0;i<divisions;i++){
            const angle=groupOrientation(order,components,roi,axis.x0+(axis.x1-axis.x0)*i/divisions,axis.x0+(axis.x1-axis.x0)*(i+1)/divisions);
            if(angle!==undefined)angles.push(angle);
        }
        if(angles.length<(divisions===4?3:2))continue;
        const low=Math.max(...angles.map(angle=>angle.low)),high=Math.min(...angles.map(angle=>angle.high));
        if(low>high)return;
        // 整行只在独立字组共同支持的区间内择优；不能靠字形阶梯把角度拉出旁证范围。
        let radians=low,minHeight=Infinity;
        for(let step=Math.round(low/STEP);step<=Math.round(high/STEP);step++){
            const angle=step*STEP,b=project(hull,angle),height=b.y1-b.y0;
            if(height<minHeight){radians=angle;minHeight=height;}
        }
        return{hull,radians};
    }
}

/** 只读几何不授予字色或背景；超过整页预算时整体撤回，避免采用结果依赖遍历顺序。 */
export function observeImageSourceTypographyGeometry(pixels:Uint8ClampedArray,width:number,height:number,regions:readonly ImageTextRegion[]):Map<ImageTextRegion,ImageSourceTypographyGeometry> {
    const result=new Map<ImageTextRegion,ImageSourceTypographyGeometry>();
    if(![width,height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=8192)||width*height>16_777_216||pixels.length<width*height*4||regions.length>4096)return result;
    const jobs:Array<{region:ImageTextRegion;rois:Roi[]}>=[];let cost=0;
    for(const region of regions){
        if(!region||region.vertical||region.ruby?.length||region.guardOnly||region.numericUncertain||typeof region.text!=='string'||region.text.length<3||region.text.length>256||/[\r\n]/u.test(region.text)||!/\p{Letter}/u.test(region.text)||!valid(region.bbox,width,height))continue;
        const sources=region.sourceBoxes??[region.bbox];
        if(!Array.isArray(sources)||!sources.length||sources.length>128||!Array.from(sources).every(b=>valid(b,width,height)&&b.x0>=region.bbox.x0&&b.y0>=region.bbox.y0&&b.x1<=region.bbox.x1&&b.y1<=region.bbox.y1))continue;
        const rois=sources.map(b=>observationBox(b,width,height));if(rois.some(roi=>!roi))continue;
        cost+=rois.reduce((sum,roi)=>sum+roi!.width*roi!.height,0);if(cost>PAGE_PIXELS)return result;
        jobs.push({region,rois:rois as Roi[]});
    }
    for(const{region,rois}of jobs){
        const physical=rois.map(roi=>observePhysical(pixels,width,roi));if(physical.some(ink=>!ink))continue;
        const radians=physical.reduce((sum,ink)=>sum+ink!.radians,0)/physical.length;
        if(physical.some(ink=>Math.abs(ink!.radians-radians)>STEP*3))continue;
        let heightGain=Infinity;
        const boxes=physical.map(ink=>{const box=project(ink!.hull,radians),axis=project(ink!.hull,0);heightGain=Math.min(heightGain,(axis.y1-axis.y0)-(box.y1-box.y0));return box;}).sort((a,b)=>a.y0-b.y0||a.x0-b.x0);
        let span=0,tall=0,short=Infinity,x0=Infinity,x1=-Infinity,compatible=true,pitchSum=0,minPitch=Infinity,maxPitch=0;
        for(let i=0;i<boxes.length;i++){
            const b=boxes[i],h=b.y1-b.y0;span+=b.x1-b.x0;tall=Math.max(tall,h);short=Math.min(short,h);x0=Math.min(x0,b.x0);x1=Math.max(x1,b.x1);
            if(i){const a=boxes[i-1],pitch=(b.y0+b.y1-a.y0-a.y1)/2;pitchSum+=pitch;minPitch=Math.min(minPitch,pitch);maxPitch=Math.max(maxPitch,pitch);if(a.y1>b.y0||Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0)<Math.min(a.x1-a.x0,b.x1-b.x0)*.5)compatible=false;}
        }
        if(!compatible||tall>short*1.35)continue;
        const y0=boxes[0].y0,y1=boxes[boxes.length-1].y1,u=(x0+x1)/2,v=(y0+y1)/2,c=Math.cos(radians),s=Math.sin(radians);
        const linePitch=boxes.length>1&&maxPitch<=minPitch*1.15?pitchSum/(boxes.length-1):undefined;
        result.set(region,{owner:region,sourceText:region.text,radians,originX:c*u-s*v,originY:s*u+c*v,bounds:{x0:x0-u,y0:y0-v,x1:x1-u,y1:y1-v},width:span,height:tall,count:boxes.length,heightGain,...(linePitch===undefined?{}:{linePitch})});
    }
    return result;
}
