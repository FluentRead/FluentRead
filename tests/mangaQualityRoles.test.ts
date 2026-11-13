/** @file tests/mangaQualityRoles.test.ts 冻结原文、角色补充及原生记录的独立验收；不修改历史真值，不把回放当作当前浏览器或翻译服务验收。 */
import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const {validateQualityRoleManifest,evaluateCapturedQualityRoles}=require('../scripts/testing/manga-quality-roles.cjs');
const bytes=readFileSync(new URL('./fixtures/manga-color-quality/manifest.json',import.meta.url));
const profile=JSON.parse(readFileSync(new URL('./fixtures/manga-color-quality-roles.json',import.meta.url),'utf8'));
const recording=JSON.parse(readFileSync(new URL('./fixtures/manga-role-recording.json',import.meta.url),'utf8'));
const contracts=validateQualityRoleManifest(bytes,profile);
const clone=<T>(value:T):T=>structuredClone(value);
const union=(boxes:any[])=>boxes.reduce((a,b)=>({x0:Math.min(a.x0,b.x0),y0:Math.min(a.y0,b.y0),x1:Math.max(a.x1,b.x1),y1:Math.max(a.y1,b.y1)}));
function ideal(contract:any){
    return contract.visualGroups.map((ids:string[])=>{
        const originals=ids.map(id=>contract.regions.get(id)),ruby=contract.annotations.filter((a:any)=>a.parentRegionIds.every((id:string)=>ids.includes(id))).map((a:any)=>({text:contract.regions.get(a.regionId).text,bbox:{...contract.regions.get(a.regionId).bbox}}));
        const sourceBoxes=[...originals.map(r=>({...r.bbox})),...ruby.map((r:any)=>({...r.bbox}))];
        return {text:'Controlled translation',sourceText:originals.map(r=>r.text).join(' '),sourceBoxes,bbox:union(sourceBoxes),...(ruby.length?{ruby}:{})};
    });
}
const japanese=contracts.get('rain-garden-vertical-ruby-sidebar'),sign=contracts.get('prism-platform-gradient-signs');

describe('原文、注音、视觉分区与语义读序分开验收',()=>{
    it('所有原始锚点与原文保持冻结，正确注音计入识别且仍验证父正文和物理框',()=>{
        const before=bytes.toString(),sourceProfile=JSON.stringify(profile);let anchors=0;
        for(const contract of contracts.values()){
            const lines=ideal(contract),copy=clone(lines),result=evaluateCapturedQualityRoles(contract,lines);
            expect(result.qualityFailures).toEqual([]);anchors+=result.anchors.length;
            expect(result.anchors.every((a:any)=>a.found)).toBe(true);expect(lines).toEqual(copy);
        }
        expect(anchors).toBe(34);expect(bytes.toString()).toBe(before);expect(JSON.stringify(profile)).toBe(sourceProfile);
        const result=evaluateCapturedQualityRoles(japanese,ideal(japanese));expect(result.annotationChecks).toHaveLength(2);
        expect(result.annotationChecks.every((x:any)=>x.valid&&x.physicalCopies===1)).toBe(true);
        expect(result.legacyQuality.qualityFailures).toHaveLength(4);
    });
    it('真实旧版记录仍揭示漫画标题误合并；补充角色不会把所有历史结果洗成通过',()=>{
        expect(recording.sourceManifestSha256).toBe(profile.manifestSha256);
        const failures:Record<string,string[]>={};
        for(const [mode,data] of Object.entries(recording.profiles) as [string,any][]){
            expect(data.javascriptAssetsSha256).toBe('8222c20e7175c30915370473c8e0a4d2753bc66a16134d1dc07d912ec16a981e');
            failures[mode]=data.scenes.filter((s:any)=>evaluateCapturedQualityRoles(contracts.get(s.scene),s.lines).qualityFailures.length).map((s:any)=>s.scene);
        }
        expect(failures).toEqual({image:[],manga:['prism-platform-gradient-signs']});
    });
    it.each(['missing','standalone','duplicate','changed-text','wrong-parent','shifted','missing-box','duplicate-box','invented'])('注音 %s 必须失败，不能从期望文字补回',mode=>{
        const lines=ideal(japanese),main=lines[0],ruby=main.ruby[0];
        if(mode==='missing')main.ruby.shift();
        if(mode==='standalone'){main.ruby.shift();lines.push({text:'Bad independent translation',sourceText:ruby.text,bbox:ruby.bbox,sourceBoxes:[ruby.bbox]});}
        if(mode==='duplicate')main.ruby.push(clone(ruby));
        if(mode==='changed-text')ruby.text='かさ';
        if(mode==='wrong-parent'){main.ruby.shift();lines[1].ruby=[ruby];lines[1].sourceBoxes.push(ruby.bbox);}
        if(mode==='shifted'){const old=ruby.bbox;ruby.bbox={...old,x0:old.x0+80,x1:old.x1+80};main.sourceBoxes=main.sourceBoxes.map((b:any)=>JSON.stringify(b)===JSON.stringify(old)?ruby.bbox:b);}
        if(mode==='missing-box')main.sourceBoxes=main.sourceBoxes.filter((b:any)=>JSON.stringify(b)!==JSON.stringify(ruby.bbox));
        if(mode==='duplicate-box')main.sourceBoxes.push(clone(ruby.bbox));
        if(mode==='invented')main.ruby.push({text:'うそ',bbox:clone(ruby.bbox)});
        const result=evaluateCapturedQualityRoles(japanese,lines);
        expect(result.qualityFailures.some((f:any)=>f.type.startsWith('annotation-'))).toBe(true);
        if(mode==='standalone')expect(result.anchors.every((a:any)=>a.found)).toBe(true);
        if(mode==='duplicate')expect(result.qualityFailures.some((f:any)=>f.type==='duplicate-anchor')).toBe(true);
    });
    it('视觉拆分仍保留原语义组顺序和连续性，不允许倒序或借用旁边标签',()=>{
        const lines=ideal(sign);
        for(const order of [[1,0,2,3],[0,2,1,3]]){
            const result=evaluateCapturedQualityRoles(sign,order.map(i=>lines[i]));
            expect(result.paragraphGroups.every((g:any)=>g.found)).toBe(true);
            expect(result.qualityFailures.some((f:any)=>f.type==='semantic-source-order')).toBe(true);
        }
        const merged=[{...lines[0],sourceText:lines[0].sourceText+' '+lines[1].sourceText,sourceBoxes:[...lines[0].sourceBoxes,...lines[1].sourceBoxes],bbox:union([lines[0].bbox,lines[1].bbox])},...lines.slice(2)];
        expect(evaluateCapturedQualityRoles(sign,merged).qualityFailures.some((f:any)=>f.type==='visual-region')).toBe(true);
    });
    it('完整文字也必须位于对应源区域；新增空行或多余符号区域不能被遗漏',()=>{
        const moved=ideal(sign);moved[0].bbox={...moved[0].bbox,y0:600,y1:650};
        expect(evaluateCapturedQualityRoles(sign,moved).qualityFailures.some((f:any)=>f.type==='visual-region')).toBe(true);
        const wrongPhysical=ideal(sign);wrongPhysical[0].sourceBoxes=[{x0:10,y0:650,x1:40,y1:680}];
        expect(evaluateCapturedQualityRoles(sign,wrongPhysical).qualityFailures.some((f:any)=>f.type==='visual-region')).toBe(true);
        for(const value of ['','???']){
            const lines=ideal(sign);lines.push({sourceText:value,text:value,bbox:{x0:10,y0:650,x1:40,y1:680},sourceBoxes:[{x0:10,y0:650,x1:40,y1:680}]});
            expect(evaluateCapturedQualityRoles(sign,lines).qualityFailures.some((f:any)=>f.type==='unexpected-visual-region')).toBe(true);
        }
    });
    it('重复合法文字按实际源坐标分配，不能把同文两行任意交换语义顺序',()=>{
        const fixture=clone(sign.fixture);fixture.regions[0].text=fixture.regions[0].anchor='SAME TITLE';fixture.regions[1].text=fixture.regions[1].anchor='SAME TITLE';
        fixture.expectedSource=fixture.regions.map((r:any)=>r.text);fixture.expectedAnchors=[...new Set(fixture.expectedSource)];fixture.anchorOccurrences=Object.fromEntries(fixture.expectedAnchors.map((t:string)=>[t,t==='SAME TITLE'?2:1]));
        const raw=Buffer.from(JSON.stringify({fixtures:[fixture]})),roles={version:1,manifestSha256:createHash('sha256').update(raw).digest('hex'),overrides:[profile.overrides[0]]};
        const contract=validateQualityRoleManifest(raw,roles).get(fixture.name),lines=ideal(contract);
        expect(evaluateCapturedQualityRoles(contract,lines).qualityFailures).toEqual([]);
        [lines[0],lines[1]]=[lines[1],lines[0]];
        expect(evaluateCapturedQualityRoles(contract,lines).qualityFailures.some((f:any)=>f.type==='semantic-source-order')).toBe(true);
    });
    it('角色补充不可改真值散列、丢正文、合并独立语义组或把注音当父正文',()=>{
        const variants=[{...profile,manifestSha256:'0'.repeat(64)},{...profile,overrides:[{scene:'unknown'}]},
            {...profile,overrides:[profile.overrides[0],profile.overrides[0]]},
            {...profile,overrides:[{...profile.overrides[0],skip:true}]},
            {...profile,overrides:[{...profile.overrides[0],visualGroups:[['main-a'],['main-b'],['night','route']]}]},
            {...profile,overrides:[{...profile.overrides[0],visualGroups:[['main-a'],['main-b'],['night']]}]},
            {...profile,overrides:[{...profile.overrides[0],visualGroups:[['main-b','main-a'],['night'],['route']]}]},
            {...profile,overrides:[{...profile.overrides[1],annotations:[{regionId:'ruby-right',parentRegionIds:['ruby-right']}]}]},
            {...profile,overrides:[{...profile.overrides[1],annotations:[profile.overrides[1].annotations[0],profile.overrides[1].annotations[0]]}]}];
        for(const value of variants)expect(()=>validateQualityRoleManifest(bytes,value)).toThrow();
        expect(()=>validateQualityRoleManifest(Buffer.alloc(2_097_153),profile)).toThrow();
    });
    it('未知或损坏实际注音结构直接失败，不能忽略后报通过',()=>{
        for(const ruby of [{},[{text:'',bbox:ideal(japanese)[0].bbox}],[{text:'かぜ',bbox:{x0:-1,y0:0,x1:20,y1:30}}]]){
            const lines=ideal(japanese);lines[0].ruby=ruby;expect(()=>evaluateCapturedQualityRoles(japanese,lines)).toThrow();
        }
        const lines=ideal(sign);lines[0].bbox={x0:NaN,y0:0,x1:20,y1:30};expect(()=>evaluateCapturedQualityRoles(sign,lines)).toThrow();
    });
});
