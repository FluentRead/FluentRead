/**
 * @file tests/pdfSourceEdits.test.ts
 * 文件职责：验证扫描原文校订、撤销与当前页重新识别的不可变迁移。
 * 主要内容：保留原始字节、未改段落与人工译文；原文独立修订和无法唯一对应的校订可恢复，非法输入不能进入文档。
 * 模块边界：纯模型测试，不代替真实 OCR、原图渲染或历史界面验证。
 */
import {describe, expect, it} from 'vitest';
import type {ParsedDocument, PdfDocumentBlock, PdfDocumentLine, PdfDocumentPage} from '@/src/features/document-translation/core/document';
import {correctPdfSourceLines, restorePdfSourceLines, reconcilePdfRecognition, pdfSourceEditTarget, validPdfSourceEditLines, PDF_SOURCE_EDIT_MAX_CHARS} from '@/src/features/document-translation/services/pdfSourceEdits';
import {normalizeDocumentRetainedRevisions} from '@/src/features/document-translation/services/history';
import {joinPdfSourceLines} from '@/src/features/document-translation/core/pdfLayoutAnalysis';
const line = (text: string, y = 40): PdfDocumentLine => ({text, x:20, y, width:250, height:12, fontSize:10, baseline:y+10, fontFamily:'serif', runs:[]});
const block = (source: string, segmentIndex: number, y = 40): PdfDocumentBlock => ({source, segmentIndex, x:20, y, width:250, height:12, lineHeight:12, lineCount:1, fontSize:10, fontFamily:'serif', fontWeight:400, textAlign:'left', lines:[line(source,y)]});
const pages = (doc: ParsedDocument) => (doc.binary as {pages:PdfDocumentPage[]}).pages;
const create = ():ParsedDocument => ({fileName:'scan.pdf', format:'pdf', label:'PDF', parts:[], segments:[{id:0,source:'About 3,700',role:'paragraph'},{id:1,source:'Other page',role:'paragraph'}], binary:{kind:'pdf',bytes:new Uint8Array([1,2,3]),pages:[
    {pageNumber:1,width:600,height:800,scanned:false,ocrRecognized:true,segmentIndexes:[0],blocks:[block('About 3,700',0),block('123',-1,80)],ocrReviewRegions:[{x:60,y:41,width:35,height:10},{x:90,y:81,width:15,height:8}]},
    {pageNumber:2,width:600,height:800,segmentIndexes:[1],blocks:[block('Other page',1)]},
]}} as ParsedDocument);
const state = {translations:['已校订译文','其他页译文'],confirmedTranslationIds:[0,1]};
const empty = {translations:[],confirmedTranslationIds:[]};
function recognized(doc:ParsedDocument, source='Fresh text', x=20): ParsedDocument {
    return {...doc, segments:doc.segments.map((s,i)=>i===0?{...s,source}:s),binary:{...doc.binary as Extract<ParsedDocument['binary'],{kind:'pdf'}>,pages:pages(doc).map((p,i)=>i===0?{...p,blocks:p.blocks.map((b,i)=>i===0?{...block(source,0),x,sourceCorrection:undefined}:b)}:p)}};
}
describe('PDF original-source corrections',()=>{
    it('updates only the selected source and translation and restores the original recognition without touching bytes',()=>{
        const original=create(), before=structuredClone(original);
        const edited=correctPdfSourceLines(original,1,0,[' About 3,700× '],state)!;
        expect(original).toEqual(before);expect(edited.document.binary?.bytes).toBe(original.binary?.bytes);
        expect(edited.document.segments.map(s=>s.source)).toEqual(['About 3,700×','Other page']);
        expect(edited.translations).toEqual(['','其他页译文']);expect(edited.confirmedTranslationIds).toEqual([1]);
        expect(pages(edited.document)[0].ocrReviewRegions).toEqual([{x:90,y:81,width:15,height:8}]);
        expect(pages(edited.document)[0].blocks[0].lines![0].runs![0]).toMatchObject({text:'About 3,700×',x:20,y:40,width:250,height:12});
        expect(edited.retainedRevisions).toEqual([{source:'About 3,700',translation:'已校订译文',pageNumber:1,blockNumber:1}]);
        const restored=restorePdfSourceLines(edited.document,1,0,edited)!;
        expect(restored.document.segments).toEqual(original.segments);expect(pages(restored.document)[0].blocks[0].sourceCorrection).toBeUndefined();
        expect(pages(restored.document)[0].ocrReviewRegions).toHaveLength(2);
        expect(restored.retainedRevisions).toContainEqual({source:'About 3,700×',translation:'',kind:'source',pageNumber:1,blockNumber:1});
        expect(restored.translations).toEqual(['','其他页译文']);expect(restored.document.binary?.bytes).toBe(original.binary?.bytes);
    });
    it('records a same-text confirmation, deduplicates no-op saves and preserves a translated manual correction across another edit',()=>{
        const original=create();const confirmed=correctPdfSourceLines(original,1,0,['About 3,700'],state)!;
        expect(confirmed.translations).toEqual(state.translations);expect(confirmed.retainedRevisions).toEqual([]);
        const same=correctPdfSourceLines(confirmed.document,1,0,['About 3,700'],confirmed)!;
        expect(same.document).toBe(confirmed.document);expect(same.translations).not.toBe(confirmed.translations);
        const twice=correctPdfSourceLines(confirmed.document,1,0,['About 3,700×'],state)!;
        expect(twice.retainedRevisions[0]).toMatchObject({kind:'source',source:'About 3,700',translation:'已校订译文'});
        expect(pages(twice.document)[0].blocks[0].sourceCorrection?.source).toBe('About 3,700');
        const back=restorePdfSourceLines(confirmed.document,1,0,confirmed)!;
        expect(back.translations).toEqual(state.translations);expect(back.confirmedTranslationIds).toEqual([0,1]);
    });
    it('allows protected numeric and formula text corrections and keeps source-only revisions',()=>{
        const original=create();const edited=correctPdfSourceLines(original,1,1,['12³'],empty)!;
        expect(edited.document.segments).toEqual(original.segments);expect(edited.translations).toEqual([]);
        const restored=restorePdfSourceLines(edited.document,1,1,edited)!;
        expect(pages(restored.document)[0].blocks[1].source).toBe('123');
        expect(restored.retainedRevisions).toEqual([{source:'12³',translation:'',kind:'source',pageNumber:1,blockNumber:2}]);
        expect(correctPdfSourceLines(edited.document,1,1,['12⁴'],edited)!.retainedRevisions[0].source).toBe('12³');
    });
    it('shares physical-line joining while retaining unchanged line runs and uses block typography for older lines',()=>{
        const original=create(), b=pages(original)[0].blocks[0];b.height=26;b.lineCount=2;
        b.lines=[{...line('A hyphen-'),fontSize:undefined,baseline:undefined,fontFamily:undefined},line('ated word',54)];
        const edited=correctPdfSourceLines(original,1,0,['A differ-','ent word'],empty)!;
        expect(edited.document.segments[0].source).toBe('A different word');
        expect(pages(edited.document)[0].blocks[0].lines![0].runs![0]).toMatchObject({fontSize:10,baseline:52,fontFamily:'serif'});
        const unchanged=correctPdfSourceLines(original,1,0,['A hyphen-','ated word'],empty)!;
        expect(pages(unchanged.document)[0].blocks[0].lines![1]).toBe(b.lines[1]);
        expect(joinPdfSourceLines([])).toBe('');expect(joinPdfSourceLines([line('中文'),line('继续')])).toBe('中文继续');
        const noRuns={...line('heading'),runs:undefined};expect(joinPdfSourceLines([noRuns],'heading')).toBe('heading');
    });
    it('rejects malformed or empty edits, foreign formats, native pages and invalid positions',()=>{
        for(const values of [[],[''],['  '],['a','b'],['a\nb'],['a\tb'],['\ud800'],['a'.repeat(PDF_SOURCE_EDIT_MAX_CHARS+1)],[null] as any]) expect(validPdfSourceEditLines(values,1)).toBe(false);
        expect(validPdfSourceEditLines(['𠮷 α 3,700×'],1)).toBe(true);
        const original=create();expect(correctPdfSourceLines(original,1,0,['\u00ad'],empty)).toBeNull();
        for(const [p,b] of [[0,0],[1,-1],[1,.5],[1,99],[2,0]]) expect(correctPdfSourceLines(original,p,b,['text'],empty)).toBeNull();
        expect(pdfSourceEditTarget({...original,binary:undefined},1,0)).toBeUndefined();
        const p=pages(original)[0];p.scanned=true;expect(pdfSourceEditTarget(original,1,0)).toBeUndefined();p.scanned=false;
        p.ocrRecognized=false;delete p.ocrReviewRegions;expect(pdfSourceEditTarget(original,1,0)).toBeUndefined();p.ocrReviewRegions=[];
        expect(pdfSourceEditTarget(original,1,0)).toBeDefined();delete p.blocks[0].lines;expect(pdfSourceEditTarget(original,1,0)).toBeUndefined();
        expect(restorePdfSourceLines(create(),1,0,empty)).toBeNull();expect(restorePdfSourceLines(create(),99,0,empty)).toBeNull();
        for(const backup of [{source:4,lines:[],reviewRegions:[]},{source:'a',lines:null,reviewRegions:[]},{source:'a',lines:[],reviewRegions:[]},{source:'a',lines:[line('a')],reviewRegions:null}]){
            const doc=create();pages(doc)[0].blocks[0].sourceCorrection=backup as any;expect(restorePdfSourceLines(doc,1,0,empty)).toBeNull();
        }
    });
    it('deduplicates restored review boxes and supports source fallbacks on protected blocks',()=>{
        const original=create();delete pages(original)[0].blocks[1].source;
        const edited=correctPdfSourceLines(original,1,1,['123'],empty)!;
        expect(pages(edited.document)[0].blocks[1].sourceCorrection?.source).toBe('');
        const e=correctPdfSourceLines(create(),1,0,['changed'],empty)!;
        pages(e.document)[0].ocrReviewRegions=pages(create())[0].ocrReviewRegions;
        expect(pages(restorePdfSourceLines(e.document,1,0,e)!.document)[0].ocrReviewRegions).toHaveLength(2);
        delete pages(e.document)[0].ocrReviewRegions;expect(pages(restorePdfSourceLines(e.document,1,0,e)!.document)[0].ocrReviewRegions).toHaveLength(1);
        const incomplete=create();incomplete.segments=[];expect(pdfSourceEditTarget(incomplete,1,0)?.source).toBe('');
        const clean=create();delete pages(clean)[0].ocrReviewRegions;expect(correctPdfSourceLines(clean,1,0,['changed'],empty)!.retainedRevisions).toEqual([]);
    });
});
describe('explicit re-recognition reconciliation',()=>{
    it('keeps uniquely located manual source and translation, with the latest raw OCR as undo backup',()=>{
        const original=create();const edited=correctPdfSourceLines(original,1,0,['About 3,700×'],state)!;
        const next=recognized(edited.document), before=structuredClone(next);
        const result=reconcilePdfRecognition(edited.document,next,1,{...edited,translations:['人工作品','其他页译文'],confirmedTranslationIds:[0,1]})!;
        expect(next).toEqual(before);expect(result.document.segments[0].source).toBe('About 3,700×');expect(result.translations).toEqual(['人工作品','其他页译文']);expect(result.confirmedTranslationIds.sort()).toEqual([0,1]);
        expect(pages(result.document)[0].blocks[0].sourceCorrection?.source).toBe('Fresh text');
        const undo=restorePdfSourceLines(result.document,1,0,result)!;expect(undo.document.segments[0].source).toBe('Fresh text');expect(undo.retainedRevisions.at(-1)).toMatchObject({source:'About 3,700×',translation:'人工作品',kind:'source'});
    });
    it('archives moved or ambiguous human source even without a translation and leaves other pages intact',()=>{
        const edited=correctPdfSourceLines(create(),1,0,['Manual source'],empty)!;
        const moved=recognized(edited.document,'New reading',22);
        const result=reconcilePdfRecognition(edited.document,moved,1,{...edited,translations:['','其他页译文']})!;
        expect(result.document.segments[0].source).toBe('New reading');expect(result.translations).toEqual(['','其他页译文']);expect(result.retainedRevisions[0]).toMatchObject({kind:'source',source:'Manual source',translation:''});
        const duplicate=recognized(edited.document);pages(duplicate)[0].blocks.push({...pages(duplicate)[0].blocks[0]});
        expect(reconcilePdfRecognition(edited.document,duplicate,1,edited)!.retainedRevisions[0].source).toBe('Manual source');
        pages(edited.document)[0].blocks.push({...pages(edited.document)[0].blocks[0]});
        expect(reconcilePdfRecognition(edited.document,recognized(edited.document),1,edited)!.retainedRevisions.map(item=>item.blockNumber)).toEqual([1,3]);
    });
    it('keeps unchanged raw text translations, preserves protected human edits and archives changed raw text translations',()=>{
        const original=create();const same=recognized(original,'About 3,700');
        delete pages(same)[0].ocrReviewRegions;
        expect(reconcilePdfRecognition(original,same,1,state)!.translations).toEqual(state.translations);
        expect(reconcilePdfRecognition(original,same,1,empty)!.confirmedTranslationIds).toEqual([]);
        const result=reconcilePdfRecognition(original,recognized(original),1,state)!;
        expect(result.translations).toEqual(['','其他页译文']);expect(result.retainedRevisions).toContainEqual({source:'About 3,700',translation:'已校订译文',pageNumber:1,blockNumber:1});
        expect(reconcilePdfRecognition(original,recognized(original),1,empty)!.retainedRevisions).toEqual([]);
        const edited=correctPdfSourceLines(original,1,1,['12³'],empty)!;
        const output=reconcilePdfRecognition(edited.document,recognized(edited.document),1,edited)!;
        expect(pages(output.document)[0].blocks[1].source).toBe('12³');
    });
    it('accepts only the same byte identity and unchanged non-target pages; a no-op copies state without rebuilding',()=>{
        const original=create();expect(reconcilePdfRecognition(original,original,1,state)!.document).toBe(original);
        expect(reconcilePdfRecognition({...original,binary:undefined},original,1,state)).toBeNull();expect(reconcilePdfRecognition(original,{...original,binary:undefined},1,state)).toBeNull();
        expect(reconcilePdfRecognition(original,create(),1,state)).toBeNull();expect(reconcilePdfRecognition(original,recognized(original),99,state)).toBeNull();
        const next=recognized(original);pages(next).pop();expect(reconcilePdfRecognition(original,next,1,state)).toBeNull();
        const noTarget=recognized(original);pages(noTarget)[0].pageNumber=3;expect(reconcilePdfRecognition(original,noTarget,1,state)).toBeNull();
        const other=recognized(original);other.binary={...other.binary as any,pages:structuredClone(pages(other))};pages(other)[1].blocks[0].x++;
        expect(reconcilePdfRecognition(original,other,1,state)).toBeNull();
    });
});
it('validates located source-only revisions without losing content or merging separate locations',()=>{
    const source={source:' manual ',translation:'',kind:'source',pageNumber:2,blockNumber:3};
    expect(normalizeDocumentRetainedRevisions([null,{},source,{...source},{...source,blockNumber:4},{...source,pageNumber:-1}, {source:'x',translation:''},{source:' x ',translation:' y ',contextLabel:' here '}])).toEqual([
        source,{...source,blockNumber:4},{source:' manual ',translation:'',kind:'source'},{source:' x ',translation:' y ',contextLabel:'here'},
    ]);
});
