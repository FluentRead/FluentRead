/**
 * @file src/features/image-translation/services/mangaDetectionCore.ts
 * 文件职责：将既有检测概率中的弱组件绑定到同次SDK原始Box，只在识别批次完成后排除缺少文字检测核心的结果。
 * 主要内容：按锁定浏览器检测器的缩放与32像素填充验证原输入/输出形状，读取未加留白的完整组件包围框；所有有限概率均低于0.3时才记为弱候选，保留有任意强响应、未知或超额候选。以帧票据、唯一映射和Box对象及坐标快照关联，页内预付像素与组件余额，取消、失败和换页均可撤回。
 * 模块边界：不改检测概率、检测框、原图、识别批次、字母或置信，不创建模型/Canvas，不处理翻译或擦除。弱组件排除只依据整个组件没有0.3响应；另行采集的强核心只供原批次完成后的独立复核，不能收缩原弱边缘或改变透明修补侧车。调用方先保留原数字证据，再排除弱识别结果。
 * 补充候选：仅同次原像素视图可旁观稀疏大组件中的完整水平核心，绑定唯一原Box与坐标快照后映回本页；后续帧复用原Box时撤回其旧视图候选，其他Box保留各自来源。采用独立像素/组件额度，不改变弱框排除规则。候选仅供原识别全部结束后的独立复核，取消、未知归属和超额均不能获得替代结果。
 */
import {collectMangaDetectionRefinementCores,createMangaDetectionRefinementBudget,MANGA_DETECTION_REFINEMENT_LIMITS,
    type MangaDetectionRefinement,type MangaDetectionRefinementCore,type MangaDetectionRefinementSource} from './mangaDetectionRefinement';
type Rect={x0:number;y0:number;x1:number;y1:number};
type Box={x:number;y:number;width:number;height:number};
type TensorShape={dims:readonly number[]};
type Output=TensorShape&{data:unknown};
interface Frame {ticket:object;sourceWidth:number;sourceHeight:number;width:number;height:number;observed:boolean;disabled:boolean;data?:Float32Array;scores:Map<string,boolean>;refinementSource?:MangaDetectionRefinementSource;refinements:Map<string,MangaDetectionRefinementCore[]>}
export const MANGA_DETECTION_CORE_LIMITS=Object.freeze({pixels:4_194_304,regionPixels:65_536,regions:8192,boxes:8192});

function rectKey(rect:Rect):string|undefined {
    const {x0,y0,x1,y1}=rect;
    return [x0,y0,x1,y1].every(Number.isSafeInteger)&&x0>=0&&y0>=0&&x1>x0&&y1>y0?[x0,y0,x1,y1].join(','):undefined;
}
function boxKey(box:Box):string|undefined {return rectKey({x0:box.x,y0:box.y,x1:box.x+box.width,y1:box.y+box.height});}
const shape=(dims:readonly number[]|undefined,channels:number,width:number,height:number)=>Array.isArray(dims)&&dims.length===4&&dims[0]===1&&dims[1]===channels&&dims[2]===height&&dims[3]===width;

function originalFrame(source:MangaDetectionRefinementSource|undefined,width:number,height:number):MangaDetectionRefinementSource|undefined {
    if(!source||width>1536||height>1536)return;
    const {pageWidth,pageHeight,x,y}=source;
    if(![pageWidth,pageHeight,x,y].every(Number.isSafeInteger)||pageWidth<=0||pageHeight<=0||pageWidth>8192||pageHeight>8192||pageWidth*pageHeight>16_777_216
        ||x<0||y<0||source.width!==width||source.height!==height||x+width>pageWidth||y+height>pageHeight)return;
    return {...source};
}

/** 每个检测器独占；raw数据只借用到该次检测结束，弱Box快照只存活于当前页。 */
export function createMangaDetectionCore(){
    const limits=MANGA_DETECTION_CORE_LIMITS;
    let active=false,signal:AbortSignal|undefined,frame:Frame|undefined,negative=new WeakMap<object,string>(),pixels=0,regions=0;
    let refinementBudget=createMangaDetectionRefinementBudget(),refinements:Array<{value:MangaDetectionRefinement;box:Box;key:string}>=[],refinementOverflow=false;
    const alive=()=>active&&!signal?.aborted;
    const invalidate=(value:Frame)=>{value.disabled=true;value.data=undefined;value.scores.clear();value.refinements.clear();};
    return {
        beginPage(abort?:AbortSignal){active=true;signal=abort;frame=undefined;negative=new WeakMap();pixels=regions=0;refinementBudget=createMangaDetectionRefinementBudget();refinements=[];refinementOverflow=false;},
        beginFrame(sourceWidth:number|undefined,sourceHeight:number|undefined,maxSide:number|undefined,source?:MangaDetectionRefinementSource):object|undefined {
            if(!alive())return;
            // 不支持交错检测帧；一旦所有权不明，本页保持原行为。
            if(frame){active=false;frame=undefined;negative=new WeakMap();return;}
            if(![sourceWidth,sourceHeight].every(value=>Number.isSafeInteger(value)&&value!>0&&value!<=8192)
                ||sourceWidth!*sourceHeight!>16_777_216||maxSide!==1536)return;
            const ratio=Math.min(1,maxSide/Math.max(sourceWidth!,sourceHeight!));
            const width=Math.ceil(Math.round(sourceWidth!*ratio)/32)*32,height=Math.ceil(Math.round(sourceHeight!*ratio)/32)*32;
            if(!width||!height)return;
            const ticket={};frame={ticket,sourceWidth:sourceWidth!,sourceHeight:sourceHeight!,width,height,observed:false,disabled:false,scores:new Map(),
                refinementSource:originalFrame(source,sourceWidth!,sourceHeight!),refinements:new Map()};return ticket;
        },
        get ticket(){return frame?.ticket;},
        observe(ticket:object|undefined,input:TensorShape|undefined,output:Output|undefined){
            const value=frame;if(!alive()||!value||ticket!==value.ticket)return;
            if(value.observed){invalidate(value);return;}value.observed=true;
            if(!shape(input?.dims,3,value.width,value.height)||!shape(output?.dims,1,value.width,value.height))return;
            const data=output!.data;if(data instanceof Float32Array&&data.length===value.width*value.height)value.data=data;
        },
        observeRegion(ticket:object|undefined,width:number,height:number,raw:Rect,mapped:Rect){
            const value=frame;if(!alive()||!value||ticket!==value.ticket||value.disabled||!value.data)return;
            if(width!==value.width||height!==value.height||value.data.length!==width*height||++regions>limits.regions){invalidate(value);return;}
            if(!rectKey(mapped))return;
            const output={...mapped,x1:Math.min(mapped.x1,value.sourceWidth),y1:Math.min(mapped.y1,value.sourceHeight)},key=rectKey(output);
            if(!key)return;
            const duplicate=value.scores.has(key);value.scores.set(key,false);value.refinements.delete(key);if(duplicate)return;
            if(!rectKey(raw)||raw.x1>width||raw.y1>height)return;
            if(value.refinementSource&&!refinementOverflow){
                const candidates=collectMangaDetectionRefinementCores(value.data,width,height,raw,output,refinementBudget);
                if(candidates?.length)value.refinements.set(key,candidates);
            }
            const area=(raw.x1-raw.x0)*(raw.y1-raw.y0);
            if(area>limits.regionPixels||pixels+area>limits.pixels)return;pixels+=area;
            for(let y=raw.y0;y<raw.y1;y++)for(let x=raw.x0;x<raw.x1;x++){
                const probability=value.data[y*width+x];
                if(!Number.isFinite(probability)||probability<0||probability>1||probability>=.3)return;
            }
            value.scores.set(key,true);
        },
        bindBoxes(ticket:object|undefined,boxes:readonly Box[]){
            const value=frame;
            if(!alive()||!value||ticket!==value.ticket||!Array.isArray(boxes)||boxes.length>limits.boxes){negative=new WeakMap();refinements=[];return;}
            // 同一对象可被SDK在下一帧复用；即使局部坐标相同，旧页内映射也不再拥有该Box。
            const returned=new Set(boxes);
            refinements=refinements.filter(item=>!returned.has(item.box));
            const unique=new Map<string,Box|undefined>();
            for(const box of boxes){
                if(!box||typeof box!=='object')continue;
                negative.delete(box);const key=boxKey(box);if(key)unique.set(key,unique.has(key)?undefined:box);
            }
            for(const [key,box]of unique){
                if(box&&value.scores.get(key)===true)negative.set(box,key);
                const source=value.refinementSource,candidates=value.refinements.get(key);
                if(!box||!source||!candidates||refinementOverflow)continue;
                const mapped=(r:Rect)=>({x0:r.x0+source.x,y0:r.y0+source.y,x1:r.x1+source.x,y1:r.y1+source.y});
                for(const candidate of candidates){
                    if(refinements.length>=MANGA_DETECTION_REFINEMENT_LIMITS.records){refinementOverflow=true;refinements=[];break;}
                    refinements.push({box,key,value:{...candidate,core:mapped(candidate.core),crop:mapped(candidate.crop),parent:mapped({x0:box.x,y0:box.y,x1:box.x+box.width,y1:box.y+box.height}),pageWidth:source.pageWidth,pageHeight:source.pageHeight}});
                }
            }
        },
        rejects(box:Box):boolean {const key=alive()&&box&&typeof box==='object'?negative.get(box):undefined;return key!==undefined&&key===boxKey(box);},
        endFrame(ticket:object|undefined){if(frame?.ticket===ticket)frame=undefined;},
        takeRefinements():MangaDetectionRefinement[]{const available=alive()&&!refinementOverflow?refinements.filter(item=>item.key===boxKey(item.box)).map(item=>item.value):[];refinements=[];return available;},
        endPage(){active=false;signal=undefined;frame=undefined;negative=new WeakMap();refinements=[];},
        get usage(){return{pixels,regions};},
        get refinementUsage(){return {...refinementBudget,overflow:refinementOverflow};},
    };
}
