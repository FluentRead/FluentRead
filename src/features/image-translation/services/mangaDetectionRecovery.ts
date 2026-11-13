/**
 * @file src/features/image-translation/services/mangaDetectionRecovery.ts
 * 文件职责：在原识别及其重试全部完成后，为被弱连接放大的检测框规划独立裁图复核，并原子采用一致的识别结果。
 * 主要内容：按同页核心合并重叠视图，保留原父框归属，避开其他原文和数值保护；对紧凑裁图与略扩大的确认裁图分别核验完整墨迹。最多八组双裁图，源像素和比较次数独立有界；两次读取须文字一致、置信可靠且返回原输入框，多候选父框须全部成功才能替换。
 * 模块边界：不创建模型、Canvas或网络请求，不改变已有识别批次或补写字符；调用方提供独立识别端口和取消信号。原数字证据不能被本模块移除，未知归属、预算不足或不一致均保留原结果。
 */
import type {MangaOcrItem} from './mangaRegions';
import {numericProtection} from './mangaNumeric';
import {imageMatteObservationBox} from './imageMatteRepair';
import {hasCompleteMangaDetectionCropInk,type MangaDetectionRect as Rect,type MangaDetectionRefinement} from './mangaDetectionRefinement';

export const MANGA_DETECTION_RECOVERY_LIMITS=Object.freeze({candidates:8,pixels:1_048_576,comparisons:65_536,items:8192});
export interface MangaDetectionRecoveryPlan {crop:Rect;confirmation:Rect;parents:Rect[]}
export interface MangaDetectionRecoveryPlans {plans:MangaDetectionRecoveryPlan[];blockedParents:string[]}
const key=(r:Rect)=>[r.x0,r.y0,r.x1,r.y1].join(',');
const rect=(item:MangaOcrItem):Rect=>({x0:item.box.x,y0:item.box.y,x1:item.box.x+item.box.width,y1:item.box.y+item.box.height});
const area=(r:Rect)=>(r.x1-r.x0)*(r.y1-r.y0);
const inside=(a:Rect,b:Rect)=>a.x0>=b.x0&&a.y0>=b.y0&&a.x1<=b.x1&&a.y1<=b.y1;
const overlap=(a:Rect,b:Rect)=>Math.max(0,Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0))*Math.max(0,Math.min(a.y1,b.y1)-Math.max(a.y0,b.y0));
const valid=(r:Rect,w:number,h:number)=>[r.x0,r.y0,r.x1,r.y1].every(Number.isFinite)&&r.x0>=0&&r.y0>=0&&r.x1>r.x0&&r.y1>r.y0&&r.x1<=w&&r.y1<=h;

/** 来源只能是当前页的原像素检测视图；保护集合包括局部气泡和既有数值证据。 */
export function planMangaDetectionRecovery(pixels:Uint8ClampedArray,width:number,height:number,records:readonly MangaDetectionRefinement[],
    results:readonly MangaOcrItem[],protectedGroups:readonly (readonly MangaOcrItem[])[]):MangaDetectionRecoveryPlans {
    const empty=()=>({plans:[],blockedParents:[]}),limits=MANGA_DETECTION_RECOVERY_LIMITS;
    if(!records.length||records.length>128||![width,height].every(value=>Number.isSafeInteger(value)&&value>0&&value<=8192)
        ||width*height>16_777_216||pixels.length<width*height*4)return empty();
    let count=results.length;for(const group of protectedGroups)count+=group.length;if(count>limits.items)return empty();
    if(results.some(item=>!item?.box)||protectedGroups.some(group=>group.some(item=>!item?.box)))return empty();
    const originals=results.map(item=>({item,bounds:rect(item)})),protectedItems=protectedGroups.flatMap(group=>group.map(item=>rect(item)));
    if(originals.some(({item,bounds})=>!valid(bounds,width,height)||!Number.isFinite(item.confidence))||protectedItems.some(r=>!valid(r,width,height)))return empty();
    const groups:Array<{core:Rect;crops:Rect[];parents:Map<string,Rect>}>=[];
    let comparisons=0,observedPixels=0;
    for(const record of records){
        if(record.pageWidth!==width||record.pageHeight!==height||![record.core,record.crop,record.parent].every(r=>valid(r,width,height))
            ||!inside(record.core,record.crop)||!inside(record.crop,record.parent))return empty();
        let match:typeof groups[number]|undefined;
        // 128条记录最多8128次归并比较；把用量带入后续障碍门禁，无需不可达的早停分支。
        for(const group of groups){comparisons++;if(overlap(group.core,record.core)>=Math.max(area(group.core),area(record.core))*.9){match=group;break;}}
        if(match){match.crops.push(record.crop);match.parents.set(key(record.parent),record.parent);}
        else groups.push({core:record.core,crops:[record.crop],parents:new Map([[key(record.parent),record.parent]])});
    }
    groups.sort((a,b)=>a.core.y0-b.core.y0||a.core.x0-b.core.x0);
    const blocked=new Set<string>(),plans:MangaDetectionRecoveryPlan[]=[];
    for(const group of groups){
        const parents=[...group.parents.values()];
        const reject=()=>{for(const parent of parents)blocked.add(key(parent));};
        if(plans.length>=limits.candidates){reject();continue;}
        let chosen:MangaDetectionRecoveryPlan|undefined;
        for(const crop of group.crops.sort((a,b)=>area(a)-area(b))){
            const confirmation={x0:crop.x0-2,y0:crop.y0-2,x1:crop.x1+2,y1:crop.y1+2};
            if(!parents.every(parent=>inside(confirmation,parent)))continue;
            let obstructed=false;
            for(const original of originals){
                if(++comparisons>limits.comparisons)return empty();
                if(!overlap(confirmation,original.bounds))continue;
                if(!group.parents.has(key(original.bounds))||original.item.confidence>=.9){obstructed=true;break;}
            }
            if(obstructed)continue;
            for(const obstacle of protectedItems){if(++comparisons>limits.comparisons)return empty();if(overlap(confirmation,obstacle)){obstructed=true;break;}}
            if(obstructed)continue;
            let complete=true;
            for(const bounds of [crop,confirmation]){
                const roi=imageMatteObservationBox(width,height,bounds);
                if(!roi){complete=false;break;}
                const cost=roi.width*roi.height;if(observedPixels+cost>limits.pixels)return empty();observedPixels+=cost;
                if(!hasCompleteMangaDetectionCropInk(pixels,width,height,bounds)){complete=false;break;}
            }
            if(complete){chosen={crop,confirmation,parents};break;}
        }
        if(chosen)plans.push(chosen);else reject();
    }
    const colliding=new Set<MangaDetectionRecoveryPlan>();
    for(let a=0;a<plans.length;a++)for(let b=a+1;b<plans.length;b++){
        if(++comparisons>limits.comparisons)return empty();
        if(overlap(plans[a].confirmation,plans[b].confirmation)){colliding.add(plans[a]);colliding.add(plans[b]);}
    }
    for(const plan of colliding)for(const parent of plan.parents)blocked.add(key(parent));
    return {plans:plans.filter(plan=>!colliding.has(plan)),blockedParents:[...blocked]};
}

/** 每个调用只识别一个独立本地裁图；结果坐标必须仍是该裁图的完整输入框。 */
export async function recoverMangaDetectionRegions(results:readonly MangaOcrItem[],prepared:MangaDetectionRecoveryPlans,
    recognize:(crop:Rect)=>Promise<readonly MangaOcrItem[]>,checkActive:()=>void):Promise<{results:MangaOcrItem[];numericEvidence:MangaOcrItem[]}> {
    checkActive();
    const outcomes=new Map<MangaDetectionRecoveryPlan,MangaOcrItem>();
    const present=new Set(results.map(item=>key(rect(item)))),failed=new Set(prepared.blockedParents);
    const blocked=(plan:MangaDetectionRecoveryPlan)=>plan.parents.some(parent=>present.has(key(parent))&&failed.has(key(parent)));
    const propagateFailure=()=>{
        let changed=true;
        while(changed){
            changed=false;
            for(const plan of prepared.plans){
                if(!blocked(plan))continue;
                for(const parent of plan.parents){
                    const value=key(parent);if(failed.has(value))continue;
                    failed.add(value);changed=true;
                }
            }
        }
    };
    propagateFailure();
    const accepted=(items:readonly MangaOcrItem[],crop:Rect):MangaOcrItem|undefined=>{
        if(items.length!==1)return;
        const item=items[0];if(!item||typeof item.text!=='string'||!item.box)return;
        const text=item.text.trim();
        if(!text||text.length>256||!Number.isFinite(item.confidence)||item.confidence<.95||item.confidence>1
            ||item.box.x!==0||item.box.y!==0||item.box.width!==crop.x1-crop.x0||item.box.height!==crop.y1-crop.y0
            ||(!numericProtection(text)&&(Array.from(text.replace(/\s/gu,'')).length<2||!/[\p{Letter}\p{Number}]/u.test(text))))return;
        return {...item,text};
    };
    for(const plan of prepared.plans){
        if(blocked(plan))continue;
        checkActive();const first=accepted(await recognize(plan.crop),plan.crop);checkActive();
        if(first){
            const second=accepted(await recognize(plan.confirmation),plan.confirmation);checkActive();
            if(second?.text===first.text)outcomes.set(plan,{...first,box:{x:plan.crop.x0,y:plan.crop.y0,width:plan.crop.x1-plan.crop.x0,height:plan.crop.y1-plan.crop.y0}});
        }
        if(!outcomes.has(plan)){for(const parent of plan.parents)failed.add(key(parent));propagateFailure();}
    }
    const additions:Array<MangaOcrItem>=[],removed=new Set<string>(),numericEvidence:MangaOcrItem[]=[];
    for(const [plan,item]of outcomes){
        if(blocked(plan))continue;
        additions.push(item);for(const parent of plan.parents)removed.add(key(parent));
        if(numericProtection(item.text))numericEvidence.push(item);
    }
    const output=results.filter(item=>!removed.has(key(rect(item))));
    for(const item of additions.sort((a,b)=>a.box.y-b.box.y||a.box.x-b.box.x)){
        const position=output.findIndex(other=>other.box.y>item.box.y||other.box.y===item.box.y&&other.box.x>item.box.x);
        if(position<0)output.push(item);else output.splice(position,0,item);
    }
    return {results:output,numericEvidence};
}
