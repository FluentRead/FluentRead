'use strict';
/**
 * @file scripts/testing/manga-quality-corpus.cjs
 * 文件职责：校验漫画回归场景的真实文字、重复次数和无字区域，汇总实际 OCR 的质量失败。
 * 主要内容：共享锚点规范化、source truth 一致性、全页多余字符库存、负区域与无字页误报检查；竖排读序沿用原契约，通用独立段落允许单张标签并要求各组匹配不同实际段落。
 * 模块边界：只处理夹具声明与生产返回值，不执行 OCR、不重写识别结果，也不访问模型或浏览器。
 */
const assert = require('node:assert/strict');

function normalizeOcrAnchor(value) {return value.normalize('NFKC').toLocaleUpperCase('en-US').replace(/[^\p{L}\p{N}]/gu,'');}
function countAnchorOccurrences(text, anchor) {if(!anchor)return 0;let count=0;for(let index=text.indexOf(anchor);index>=0;index=text.indexOf(anchor,index+1))count++;return count;}
function validBox(box,width,height) {return box&&['x0','y0','x1','y1'].every(key=>Number.isFinite(box[key]))&&box.x0>=0&&box.y0>=0&&box.x0<box.x1&&box.y0<box.y1&&box.x1<=width&&box.y1<=height;}
function intersects(a,b) {return Math.min(a.x1,b.x1)>Math.max(a.x0,b.x0)&&Math.min(a.y1,b.y1)>Math.max(a.y0,b.y0);}

function validateProtectedAlphaProbes(fixture) {
    if(fixture.protectedAlphaProbes===undefined)return;
    assert.ok(Array.isArray(fixture.protectedAlphaProbes)&&fixture.protectedAlphaProbes.length>0,'Declared alpha probes form a nonempty array');
    for(const probe of fixture.protectedAlphaProbes)assert.ok(probe&&Number.isInteger(probe.x)&&probe.x>=0&&probe.x<fixture.width
        &&Number.isInteger(probe.y)&&probe.y>=0&&probe.y<fixture.height&&Array.isArray(probe.rgba)&&probe.rgba.length===4
        &&probe.rgba.every(value=>Number.isInteger(value)&&value>=0&&value<=255),'Declared alpha probes have in-image coordinates and four RGBA bytes');
}

function validateQualityFixtureExpectations(fixture) {
    validateProtectedAlphaProbes(fixture);
    assert.ok(Array.isArray(fixture.expectedSource)&&fixture.expectedSource.every(text=>typeof text==='string'&&text.trim()),'Quality scenes declare exact source text, or an empty array for a wordless page');
    assert.ok(fixture.expectedNoText===undefined||typeof fixture.expectedNoText==='boolean','Wordless expectation is explicit');
    assert.ok(Array.isArray(fixture.expectedAnchors)&&fixture.expectedAnchors.every(anchor=>typeof anchor==='string'&&normalizeOcrAnchor(anchor)),'Quality scenes declare normalized OCR anchors');
    assert.equal(new Set(fixture.expectedAnchors.map(normalizeOcrAnchor)).size,fixture.expectedAnchors.length,'Quality anchor keys are distinct after normalization');
    if(fixture.expectedNoText) {
        assert.deepEqual(fixture.expectedSource,[],'Wordless source cannot invent expected dialogue');
        assert.deepEqual(fixture.expectedAnchors,[],'Wordless source cannot invent positive anchors');
        assert.deepEqual(fixture.regions||[],[],'Wordless source cannot declare text regions');
    } else assert.ok(fixture.expectedAnchors.length>0&&fixture.expectedSource.length>0,'Text-bearing scenes declare source and anchors');
    if(fixture.anchorOccurrences) {
        assert.ok(typeof fixture.anchorOccurrences==='object'&&!Array.isArray(fixture.anchorOccurrences)&&Object.keys(fixture.anchorOccurrences).length===fixture.expectedAnchors.length,'Each declared OCR anchor has an explicit occurrence count');
        const source=normalizeOcrAnchor(fixture.expectedSource.join(' '));
        for(const anchor of fixture.expectedAnchors) {
            const count=fixture.anchorOccurrences[anchor];
            assert.ok(Number.isInteger(count)&&count>=1&&count<=50,'Declared anchor occurrence counts are bounded positive integers');
            assert.equal(countAnchorOccurrences(source,normalizeOcrAnchor(anchor)),count,'Occurrence metadata agrees with source text, including overlapping matches');
        }
    }
    const forbidden=fixture.forbiddenRegions||[],ids=new Set();
    assert.ok(Array.isArray(forbidden),'Negative regions form an explicit array');
    for(const region of forbidden) {
        assert.ok(typeof region.id==='string'&&region.id.trim()&&!ids.has(region.id),'Negative region identifiers are unique');ids.add(region.id);
        assert.ok(validBox(region.bbox,fixture.width,fixture.height),'Negative regions remain inside the source image');
        assert.ok(!(fixture.regions||[]).some(text=>intersects(text.bbox,region.bbox)),'A negative region contains no declared source text');
    }
    const validateOrderReferences=order=>{
        assert.ok(order.every(id=>{
            const matches=(fixture.regions||[]).filter(region=>region.id===id);
            return matches.length===1&&matches[0].vertical===true;
        }),'Vertical paragraph order references unique actual vertical source regions');
        assert.ok(order.every(id=>{
            const anchor=fixture.regions.find(region=>region.id===id).anchor;
            return typeof anchor==='string'&&normalizeOcrAnchor(anchor).length>0;
        }),'Vertical paragraph order references normalized nonempty source anchors');
    };
    if(fixture.readingOrder!==undefined) {
        assert.ok(Array.isArray(fixture.readingOrder)&&fixture.readingOrder.length>=2&&new Set(fixture.readingOrder).size===fixture.readingOrder.length,'A declared paragraph order uses distinct text region IDs');
        validateOrderReferences(fixture.readingOrder);
    }
    if(fixture.readingOrderGroups!==undefined) {
        const groups=fixture.readingOrderGroups;
        assert.ok(fixture.readingOrder===undefined,'Choose one paragraph order declaration');
        assert.ok(Array.isArray(groups)&&groups.length>=2&&groups.length<=24,'Independent paragraph groups form a bounded array');
        const ids=new Set();
        for(const order of groups) {
            assert.ok(Array.isArray(order)&&order.length>=2&&new Set(order).size===order.length,'Each paragraph group uses distinct text region IDs');
            validateOrderReferences(order);
            for(const id of order){assert.ok(!ids.has(id),'Paragraph groups use distinct source region IDs across speakers');ids.add(id);}
        }
    }
    if(fixture.paragraphGroups!==undefined) {
        const groups=fixture.paragraphGroups,used=new Set();
        assert.ok(fixture.readingOrder===undefined&&fixture.readingOrderGroups===undefined,'Choose one explicit paragraph declaration');
        assert.ok(Array.isArray(groups)&&groups.length>=2&&groups.length<=24,'General paragraph groups form a bounded array of independent paragraphs');
        const declared=new Set(fixture.expectedAnchors.map(normalizeOcrAnchor)),source=new Set(fixture.expectedSource.map(normalizeOcrAnchor));
        for(const group of groups) {
            assert.ok(Array.isArray(group)&&group.length>=1&&new Set(group).size===group.length,'Each general paragraph group contains distinct source region IDs');
            for(const id of group) {
                assert.ok(typeof id==='string'&&id.trim()&&!used.has(id),'General paragraph groups use distinct nonempty source IDs across paragraphs');used.add(id);
                const matches=(fixture.regions||[]).filter(region=>region.id===id);
                assert.ok(matches.length===1&&validBox(matches[0].bbox,fixture.width,fixture.height),'General paragraph groups reference unique actual source regions inside the image');
                const region=matches[0],anchor=typeof region.anchor==='string'?normalizeOcrAnchor(region.anchor):'',text=typeof region.text==='string'?normalizeOcrAnchor(region.text):'';
                assert.ok(anchor&&anchor===text&&declared.has(anchor)&&source.has(text),'General paragraph anchors belong to their complete declared source text and expected anchors');
            }
        }
    }
}

/** 通用组完整匹配规范化原文并各占不同实际段落，防止借用别段子串；旧竖排按序锚点契约不变。 */
function evaluateQualityReadingOrder(fixture,texts) {
    const general=fixture.paragraphGroups!==undefined,groups=general?fixture.paragraphGroups:fixture.readingOrderGroups;
    const fallback=fixture.readingOrder??(fixture.regions||[]).filter(region=>region.vertical).sort((a,b)=>b.bbox.x0-a.bbox.x0).map(region=>region.id);
    const orders=groups??(fallback.length>=2?[fallback]:[]);
    if(!orders.length)return {qualityFailures:[]};
    const normalized=texts.map(normalizeOcrAnchor);
    const checks=orders.map(order=>{
        const anchors=order.map(id=>fixture.regions.find(region=>region.id===id).anchor),complete=general?anchors.map(normalizeOcrAnchor).join(''):'';
        const matches=[];
        for(const [index,paragraph] of normalized.entries()) {
            let cursor=0;
            if(general?paragraph===complete:anchors.every(anchor=>{const needle=normalizeOcrAnchor(anchor),position=paragraph.indexOf(needle,cursor);if(position<0)return false;cursor=position+needle.length;return true;}))matches.push(index);
        }
        return {anchors,matches,paragraphIndex:matches[0]??-1,found:matches.length>0};
    });
    const qualityFailures=checks.filter(check=>!check.found).map(({matches:_matches,...check})=>({type:general?'paragraph-order':'vertical-paragraph-order',...check,reason:general?'Each general group must match a complete normalized actual source paragraph in order, without borrowing text from other groups':'Each declared group of main columns must share one actual OCR paragraph in source order'}));
    if(groups&&qualityFailures.length===0) {
        // 增广匹配允许不同位置的相同对白，不能把每组都绑定到首个匹配段落。
        const owners=new Map();
        function assign(group,seen) {
            for(const paragraph of checks[group].matches) {
                if(seen.has(paragraph))continue;seen.add(paragraph);
                if(!owners.has(paragraph)||assign(owners.get(paragraph),seen)){owners.set(paragraph,group);return true;}
            }
            return false;
        }
        const separate=checks.every((_,index)=>assign(index,new Set()));
        if(!separate)qualityFailures.push({type:general?'paragraph-separation':'vertical-paragraph-separation',reason:general?'Independent source groups must match distinct actual OCR paragraphs':'Independent speakers must match distinct actual OCR paragraphs'});
        for(const [paragraph,group] of owners)checks[group].paragraphIndex=paragraph;
    }
    const values=checks.map(({matches:_matches,...check})=>check);
    return {...(general?{paragraphGroups:values}:groups?{verticalParagraphGroups:values}:{verticalParagraphOrder:values[0]}),qualityFailures};
}

function evaluateQualityFixture(fixture,{texts,lines}) {
    assert.ok(Array.isArray(texts)&&texts.every(text=>typeof text==='string'),'Actual text transport is an array');
    assert.ok(Array.isArray(lines),'Actual offscreen OCR layout was captured, including empty pages');
    const recognized=normalizeOcrAnchor(texts.join(' '));
    const anchors=fixture.expectedAnchors.map(anchor=>{
        const occurrences=countAnchorOccurrences(recognized,normalizeOcrAnchor(anchor));
        const sourceOccurrences=countAnchorOccurrences(normalizeOcrAnchor(fixture.expectedSource.join(' ')),normalizeOcrAnchor(anchor));
        const expectedOccurrences=fixture.anchorOccurrences?.[anchor]??(sourceOccurrences===1?1:undefined);
        return {anchor,occurrences,expectedOccurrences,found:occurrences>0&&(expectedOccurrences===undefined||occurrences===expectedOccurrences)};
    });
    const qualityFailures=anchors.filter(anchor=>!anchor.found).map(({anchor,occurrences,expectedOccurrences})=>({type:expectedOccurrences!==undefined&&occurrences>expectedOccurrences?'duplicate-anchor':'ocr-anchor',anchor,occurrences,expectedOccurrences,
        reason:occurrences===0?'Actual production OCR does not contain the normalized expected anchor':'Actual production OCR anchor count differs from the source-declared count'}));
    const negativeDetections=[];
    const sourceTexts=[];
    for(const [lineIndex,line] of lines.entries()) {
        assert.ok(typeof line.sourceText==='string','Actual offscreen lines retain their recognized source text, independently of translated output');
        sourceTexts.push(line.sourceText);
        // 实际物理行框优先；段落外接框可能跨过受保护画面，不能据此制造误报。
        const boxes=Array.isArray(line.sourceBoxes)&&line.sourceBoxes.length?line.sourceBoxes:[line.bbox];
        assert.ok(boxes.every(box=>validBox(box,fixture.width,fixture.height)),'Actual OCR source boxes are valid image coordinates');
        for(const region of fixture.forbiddenRegions||[]) {
            const overlaps=boxes.filter(box=>intersects(box,region.bbox));
            if(overlaps.length)negativeDetections.push({regionId:region.id,lineIndex,sourceText:line.sourceText??line.text,sourceBoxes:overlaps});
        }
    }
    for(const detection of negativeDetections)qualityFailures.push({type:'artwork-ocr-false-positive',...detection,reason:'Actual production OCR source box intersects a declared wordless artwork region'});
    // 不依赖送翻译的子集：数字、ID 或无需改写的行仍属于实际 OCR 产物。
    // 库存只额外检查多字，无法证明没有缺字或顺序正确；锚点、阅读顺序与负区域保持独立门禁。
    const inventory=value=>{const counts=new Map();for(const character of normalizeOcrAnchor(value))counts.set(character,(counts.get(character)||0)+1);return counts;};
    const expected=inventory(fixture.expectedSource.join(' ')),actual=inventory(sourceTexts.join(' '));
    const excess=[...actual].filter(([character,count])=>count>(expected.get(character)||0)).map(([character,count])=>({character,expected:expected.get(character)||0,actual:count,excess:count-(expected.get(character)||0)}));
    const sourceCharacterInventory={expected:Object.fromEntries(expected),actual:Object.fromEntries(actual),excess,scope:'Normalized Unicode character counts detect additions; they do not prove complete recognition, text order, or artwork provenance'};
    if(excess.length)qualityFailures.push({type:'unexpected-ocr-characters',excess,reason:'Actual offscreen source text contains more normalized characters than declared source truth'});
    if(fixture.expectedNoText&&(texts.some(text=>text.trim())||lines.length))qualityFailures.push({type:'wordless-page-text',paragraphs:texts.length,lines:lines.length,reason:'The source page contains no text and must not produce translated dialogue'});
    return {anchors,negativeDetections,sourceCharacterInventory,qualityFailures};
}

// 生产翻译传输会跳过数字或保留原文；质量统计必须使用完整实际 sourceText，不能把传输子集当作 OCR 全集。
function evaluateCapturedQualityFixture(fixture,lines) {
    assert.ok(Array.isArray(lines),'Actual offscreen OCR layout was captured, including empty pages');
    const sourceTexts=lines.map(line=>{
        assert.ok(typeof line?.sourceText==='string','Actual offscreen lines retain their recognized source text, independently of translated output');
        return line.sourceText;
    });
    const {qualityFailures:sourceFailures,...source}=evaluateQualityFixture(fixture,{texts:sourceTexts,lines});
    const {qualityFailures:orderFailures,...order}=evaluateQualityReadingOrder(fixture,sourceTexts);
    return {sourceTexts,...source,...order,qualityFailures:[...sourceFailures,...orderFailures]};
}

function evaluateQualityAlphaProbes(fixture,{sourcePixels,translatedPixels}) {
    validateProtectedAlphaProbes(fixture);
    const probes=fixture.protectedAlphaProbes??[];
    if(!probes.length)return {protectedAlphaPixels:{declared:0,probes:[],scope:'No protectedAlphaProbes declared; no transparency coverage claimed'},qualityFailures:[]};
    for(const pixels of [sourcePixels,translatedPixels])assert.ok(Array.isArray(pixels)&&pixels.length===probes.length
        &&pixels.every(pixel=>Array.isArray(pixel)&&pixel.length===4&&pixel.every(value=>Number.isInteger(value)&&value>=0&&value<=255)),'Every declared alpha probe has a complete actual RGBA capture');
    const evaluated=probes.map((probe,index)=>{
        const source=sourcePixels[index],translated=translatedPixels[index];
        assert.equal(source[3],probe.rgba[3],'Source alpha agrees with the frozen fixture');
        return {x:probe.x,y:probe.y,...(probe.regionId?{regionId:probe.regionId}:{}),expectedAlpha:probe.rgba[3],source,translated,passed:translated[3]===source[3]};
    });
    return {protectedAlphaPixels:{declared:probes.length,probes:evaluated,scope:'Declared alpha values only; RGB may round through premultiplied Canvas. No full-image alpha or glyph-ownership guarantee'},
        qualityFailures:evaluated.filter(probe=>!probe.passed).map(({passed:_passed,...probe})=>({type:'alpha-protection',...probe,reason:'Translated output changes a source-declared protected alpha probe'}))};
}

module.exports={normalizeOcrAnchor,countAnchorOccurrences,validateQualityFixtureExpectations,evaluateQualityReadingOrder,evaluateQualityFixture,evaluateCapturedQualityFixture,evaluateQualityAlphaProbes};
