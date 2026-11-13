'use strict';
/**
 * @file scripts/testing/manga-quality-roles.cjs
 * 文件职责：在不修改冻结原文和旧评分的前提下，分别验收正文、附属注音、视觉分区与原语义组读序。
 * 主要内容：角色补充文件绑定完整原manifest散列；注音仍参与原锚点和字符库存，还必须匹配原像素区域、父正文及唯一物理框；视觉组只能拆分原语义组，不能合并独立内容，按完整文字和源坐标匹配不同实际区域，再检查原语义顺序连续。
 * 模块边界：纯验收数据，不修改生产识别或翻译，不重写原图片/真值；有角色补充时同时返回原评分，不把识别原文正确当作译文语义正确。
 */
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {normalizeOcrAnchor,validateQualityFixtureExpectations,evaluateQualityFixture,evaluateCapturedQualityFixture}=require('./manga-quality-corpus.cjs');
const sameBox=(a,b)=>a&&b&&['x0','y0','x1','y1'].every(k=>a[k]===b[k]);
const validBox=(b,w,h)=>b&&['x0','y0','x1','y1'].every(k=>Number.isFinite(b[k]))&&b.x0>=0&&b.y0>=0&&b.x1<=w&&b.y1<=h&&b.x1>b.x0&&b.y1>b.y0;
const area=b=>(b.x1-b.x0)*(b.y1-b.y0);
function overlap(a,b){const intersection=Math.max(0,Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0))*Math.max(0,Math.min(a.y1,b.y1)-Math.max(a.y0,b.y0));return intersection/(area(a)+area(b)-intersection);}
const union=boxes=>boxes.reduce((a,b)=>({x0:Math.min(a.x0,b.x0),y0:Math.min(a.y0,b.y0),x1:Math.max(a.x1,b.x1),y1:Math.max(a.y1,b.y1)}));

function validateQualityRoleManifest(manifestBytes,profile){
    assert.ok(Buffer.isBuffer(manifestBytes)&&manifestBytes.length>0&&manifestBytes.length<=2_097_152,'Roles require bounded original manifest bytes');
    assert.ok(profile?.version===1&&profile.manifestSha256===createHash('sha256').update(manifestBytes).digest('hex'),'Roles bind the complete unchanged source manifest');
    const manifest=JSON.parse(manifestBytes),fixtures=manifest.fixtures;
    assert.ok(Array.isArray(fixtures)&&fixtures.length>0&&fixtures.length<=32,'Role corpus has 1–32 source scenes');
    assert.ok(Array.isArray(profile.overrides)&&profile.overrides.length<=fixtures.length,'Role overrides are bounded');
    const overrides=new Map();
    for(const entry of profile.overrides){
        assert.ok(entry&&typeof entry.scene==='string'&&fixtures.some(f=>f.name===entry.scene)&&!overrides.has(entry.scene),'Role scenes are known and unique');
        assert.ok(Object.keys(entry).every(k=>['scene','annotations','visualGroups'].includes(k)),'Unknown role policy fields are rejected');
        overrides.set(entry.scene,entry);
    }
    const contracts=new Map();
    for(const fixture of fixtures){
        validateQualityFixtureExpectations(fixture);
        const override=overrides.get(fixture.name),regions=new Map((fixture.regions??[]).map(r=>[r.id,r]));
        assert.equal(regions.size,(fixture.regions??[]).length,'Role source IDs are unique');
        const annotations=override?.annotations??[],annotationIds=new Set();
        assert.ok(Array.isArray(annotations)&&annotations.length<=128,'Annotations form a bounded array');
        for(const annotation of annotations){
            assert.ok(annotation&&regions.has(annotation.regionId)&&!annotationIds.has(annotation.regionId),'Annotation source IDs are known and unique');
            annotationIds.add(annotation.regionId);
        }
        for(const annotation of annotations){
            const parents=annotation.parentRegionIds;
            assert.ok(Object.keys(annotation).every(k=>['regionId','parentRegionIds'].includes(k)),'Annotation role fields are explicit');
            assert.ok(Array.isArray(parents)&&parents.length>0&&parents.length<=4&&new Set(parents).size===parents.length
                &&parents.every(id=>regions.has(id)&&!annotationIds.has(id)),'Annotations reference distinct body source parents');
        }
        assert.ok(fixture.expectedNoText||Array.isArray(fixture.paragraphGroups),'Role profiles require explicit source semantic groups');
        const semanticGroups=(fixture.paragraphGroups??[]).map(g=>g.filter(id=>!annotationIds.has(id))).filter(g=>g.length);
        const visualGroups=override?.visualGroups??semanticGroups;
        assert.ok(Array.isArray(visualGroups)&&visualGroups.length<=128,'Visual groups are bounded');
        const used=new Set();
        for(const group of visualGroups){
            assert.ok(Array.isArray(group)&&group.length>0&&group.length<=128&&group.every(id=>regions.has(id)&&!annotationIds.has(id)&&!used.has(id))&&new Set(group).size===group.length,'Visual groups use each body source once');
            assert.ok(semanticGroups.some(original=>{const start=original.indexOf(group[0]);return start>=0&&group.every((id,i)=>original[start+i]===id);}),'Visual groups only partition a source semantic group in order');
            group.forEach(id=>used.add(id));
        }
        assert.deepEqual([...used].sort(),[...regions.keys()].filter(id=>!annotationIds.has(id)).sort(),'Every body source is covered by a visual group');
        contracts.set(fixture.name,{fixture,regions,annotations,visualGroups,semanticGroups});
    }
    return contracts;
}

function evaluateCapturedQualityRoles(contract,lines){
    const {fixture,regions,annotations,visualGroups,semanticGroups}=contract;
    assert.ok(Array.isArray(lines)&&lines.length<=4096,'Actual body rows are bounded');
    const legacyQuality=evaluateCapturedQualityFixture(fixture,lines),recognized=lines.map((line,lineIndex)=>({...line,kind:'body',lineIndex})),records=[];
    for(const [lineIndex,line] of lines.entries()){
        assert.ok(validBox(line.bbox,fixture.width,fixture.height),'Actual visual region bounds are valid');
        assert.ok(line.ruby===undefined||Array.isArray(line.ruby)&&line.ruby.length<=128,'Actual ruby metadata is bounded');
        for(const ruby of line.ruby??[]){
            assert.ok(ruby&&typeof ruby.text==='string'&&ruby.text.length>0&&ruby.text.length<=4096&&validBox(ruby.bbox,fixture.width,fixture.height),'Actual annotation text and coordinates are explicit');
            assert.ok(records.length<4096,'Total annotation records are bounded');
            records.push({lineIndex,ruby});recognized.push({sourceText:ruby.text,bbox:ruby.bbox,sourceBoxes:[ruby.bbox],kind:'annotation',lineIndex});
        }
    }
    const completeTexts=recognized.map(r=>r.sourceText),source=evaluateQualityFixture(fixture,{texts:completeTexts,lines:recognized}),qualityFailures=[...source.qualityFailures];
    const counts=new Map(annotations.map(a=>[a.regionId,0])),annotationChecks=[];
    const bodyBoxes=line=>line.sourceBoxes?.length?line.sourceBoxes.filter(b=>!(line.ruby??[]).some(r=>sameBox(b,r.bbox))):[line.bbox];
    for(const {lineIndex,ruby} of records){
        const line=lines[lineIndex],text=normalizeOcrAnchor(ruby.text);
        const matches=annotations.filter(a=>normalizeOcrAnchor(regions.get(a.regionId).text)===text&&overlap(ruby.bbox,regions.get(a.regionId).bbox)>=.25
            &&a.parentRegionIds.every(id=>normalizeOcrAnchor(line.sourceText).includes(normalizeOcrAnchor(regions.get(id).text))&&bodyBoxes(line).some(b=>overlap(b,regions.get(id).bbox)>=.25)));
        const physicalCopies=(line.sourceBoxes??[]).filter(b=>sameBox(b,ruby.bbox)).length;
        const valid=matches.length===1&&physicalCopies===1;
        const check={text:ruby.text,lineIndex,bbox:ruby.bbox,regionId:matches.length===1?matches[0].regionId:null,physicalCopies,valid};annotationChecks.push(check);
        if(valid)counts.set(matches[0].regionId,counts.get(matches[0].regionId)+1);
        else qualityFailures.push({type:'annotation-ownership',...check,reason:'An annotation must match its source location, recognized body parent and one physical source box'});
    }
    for(const expected of annotations){const count=counts.get(expected.regionId);if(count!==1)qualityFailures.push({type:'annotation-occurrence',regionId:expected.regionId,expected:1,actual:count});}
    const checks=visualGroups.map(ids=>{
        const expectedText=ids.map(id=>normalizeOcrAnchor(regions.get(id).text)).join(''),expectedBoxes=ids.map(id=>regions.get(id).bbox),bounds=union(expectedBoxes);
        const matches=lines.flatMap((line,index)=>normalizeOcrAnchor(line.sourceText)===expectedText&&overlap(line.bbox,bounds)>=.2&&expectedBoxes.every(box=>bodyBoxes(line).some(b=>overlap(b,box)>=.2))?[index]:[]);
        return {regionIds:ids,matches,paragraphIndex:-1,found:false};
    });
    const owners=new Map();
    function assign(group,seen){for(const index of checks[group].matches){if(seen.has(index))continue;seen.add(index);if(!owners.has(index)||assign(owners.get(index),seen)){owners.set(index,group);return true;}}return false;}
    checks.forEach((_,i)=>assign(i,new Set()));
    for(const [paragraph,group] of owners){checks[group].paragraphIndex=paragraph;checks[group].found=true;}
    for(const check of checks)if(!check.found)qualityFailures.push({type:'visual-region',regionIds:check.regionIds,reason:'Each visual group requires a distinct complete body text and matching source geometry'});
    for(let index=0;index<lines.length;index++)if(!owners.has(index))qualityFailures.push({type:'unexpected-visual-region',lineIndex:index,sourceText:lines[index].sourceText});
    const groupOf=new Map();visualGroups.forEach((ids,index)=>ids.forEach(id=>groupOf.set(id,index)));
    const semanticChecks=semanticGroups.map(ids=>{
        const parts=[...new Set(ids.map(id=>groupOf.get(id)))],positions=parts.map(i=>checks[i].paragraphIndex),found=positions.every((p,i)=>p>=0&&(!i||p===positions[i-1]+1));
        return {regionIds:ids,paragraphs:positions,found};
    });
    for(const check of semanticChecks)if(!check.found)qualityFailures.push({type:'semantic-source-order',...check,reason:'Visual parts of one source semantic group stay consecutive and in source order'});
    return {sourceTexts:lines.map(l=>l.sourceText),recognizedSourceTexts:completeTexts,...source,paragraphGroups:checks.map(({matches,...check})=>check),
        annotationChecks,semanticSourceGroups:semanticChecks,qualityFailures,legacyQuality,
        roleScope:'Original body plus actual ruby metadata are counted without changing source truth. Annotation ownership, distinct visual regions and original semantic order are separate gates. No translation-provider accuracy claim.'};
}
module.exports={validateQualityRoleManifest,evaluateCapturedQualityRoles};
