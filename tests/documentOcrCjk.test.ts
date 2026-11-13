/**
 * @file tests/documentOcrCjk.test.ts
 * 文件职责：验证真实扫描汉字的两倍率上下文复核以及无法确认时的原文保留。
 * 主要内容：用真实 OCR 行重放漏字、低清误读、表格标签和细笔画断词；限制修改到原低分汉字，覆盖数字与英文保留、预算、异常与取消。
 * 模块边界：裁剪识别由可控回调提供；实际引擎与图像缩放结果另有浏览器证据。
 */
import {describe,expect,it,vi} from 'vitest';
import type {Block,Line} from 'tesseract.js';
import {normalizeOcrLines} from '@/src/features/image-translation/core';
import {recoverDocumentOcrCjk} from '@/src/features/image-translation/services/documentOcrCjk';
import fixture from './fixtures/pdf-scanned-cjk-ocr.json';
const data=(line:unknown)=>[{paragraphs:[{lines:[line]}]}] as Block[];
const source=(name:string)=>data(structuredClone(fixture.cases.find(c=>c.name===name)!.line));
const line=(texts=['方法','两'],scores=[96,55]):Line=>({text:texts.join(' '),bbox:{x0:0,y0:0,x1:200,y1:30},baseline:{x0:0,y0:25,x1:200,y1:25},words:texts.map((text,i)=>({text,confidence:scores[i],bbox:{x0:i*50,y0:0,x1:i*50+40,y1:30}}))} as Line);
const read=(text='方法丙',confidence=95)=>vi.fn(async(_box?:unknown,_scale?:number)=>({text,confidence}));
describe('document Chinese context recovery',()=>{
 it.each([['title','扫描论文识别与翻译实验'],['method','方法丙'],['lowBody','本研究比较不同采样频率下的测量误差。实验共']])('recovers the actual %s reading only after agreeing pixel reads',async(name,expected)=>{
   const blocks=source(name),before=structuredClone(blocks),ordinary=normalizeOcrLines(blocks),reader=read(expected);
   const result=await recoverDocumentOcrCjk(blocks,ordinary,reader);
   expect(result.some(l=>l.text===expected)).toBe(true);expect(reader.mock.calls).toHaveLength(2);expect(reader.mock.calls.map(c=>c[1])).toEqual([.5,.75]);
   expect(blocks).toEqual(before);expect(result.filter(l=>l.documentReview)).toEqual([]);
   if(name==='method')expect(result.some(l=>l.text==='256')).toBe(true);
 });
 it('joins a thin horizontal Han glyph to its next character without inventing a space or collapsing a column gap',()=>{
   const blocks=source('thinHan');expect(normalizeOcrLines(blocks)).toHaveLength(1);expect(normalizeOcrLines(blocks)[0].text).toContain('成本一定减');
   const next=line(['一','定'],[96,96]);next.words[0].bbox={x0:0,y0:14,x1:30,y1:18};next.words[1].bbox={x0:51,y0:0,x1:81,y1:30};expect(normalizeOcrLines(data(next))).toHaveLength(1);
   next.words[1].bbox={x0:150,y0:0,x1:180,y1:30};expect(normalizeOcrLines(data(next))).toHaveLength(2);
 });
 it.each(['disagree','score','length','highWord','number','latin','punctuation'])('retains the original candidate with a review region when %s fails',async reason=>{
   const raw=line(['方法','两','128','test'],[96,0,96,96]);raw.bbox.x1=240;
   const reader=read('方法丙128test');
   if(reason==='disagree')reader.mockResolvedValueOnce({text:'方法乙128test',confidence:95});
   if(reason==='score')reader.mockResolvedValueOnce({text:'方法丙128test',confidence:89});
   if(reason==='length')reader.mockResolvedValue({text:'方法丙丁128test',confidence:95});
   if(reason==='highWord')reader.mockResolvedValue({text:'万法丙128test',confidence:95});
   if(reason==='number')reader.mockResolvedValue({text:'方法丙129test',confidence:95});
   if(reason==='latin')reader.mockResolvedValue({text:'方法丙128Test',confidence:95});
   if(reason==='punctuation')reader.mockResolvedValue({text:'方法丙128tes!',confidence:95});
   const blocks=data(raw),result=await recoverDocumentOcrCjk(blocks,normalizeOcrLines(blocks),reader);
   expect(result.find(l=>l.text)?.text).toBe('方法两128 test');expect(result.some(l=>l.documentReview)).toBe(true);
 });
 it('preserves whitespace within Latin runs when low Chinese characters are corrected',async()=>{
   const raw=line(['方法','两','hello','world'],[96,0,96,96]);raw.bbox.x1=240;const blocks=data(raw);
   const result=await recoverDocumentOcrCjk(blocks,normalizeOcrLines(blocks),read('方法丙hello world'));
   expect(result.find(l=>l.text)?.text).toBe('方法丙hello world');
 });
 it('confirms an unchanged low reading without raising the original confidence and keeps unrelated review marks',async()=>{
   const blocks=data(line());const ordinary=[...normalizeOcrLines(blocks),{text:'',bbox:{x0:300,y0:0,x1:320,y1:20},documentReview:true as const}];
   const result=await recoverDocumentOcrCjk(blocks,ordinary,read('方法两'));
   expect(result.filter(l=>l.documentReview)).toHaveLength(1);expect(blocks[0].paragraphs[0].lines[0].words[1].confidence).toBe(55);
 });
 it.each(['mapping','box','horizontal','vertical','unsafeNumber','unsafeLatin','viewMismatch','length','tall'])('keeps unsafe %s context unchanged and visible for review',async kind=>{
   const raw=line();let ordinary=normalizeOcrLines(data(raw));
   if(kind==='mapping')raw.text='missing 方法 两';
   if(kind==='box')raw.words[0].bbox.x1=NaN;
   if(kind==='horizontal'){raw.bbox.x0=200;raw.bbox.x1=300;}
   if(kind==='vertical')raw.baseline={x0:0,y0:0,x1:0,y1:100};
   if(kind==='unsafeNumber'){raw.words[0].text='128';raw.words[0].confidence=0;raw.text='128 两';ordinary=normalizeOcrLines(data(raw));}
   if(kind==='unsafeLatin'){raw.words[0].text='noise';raw.words[0].confidence=0;raw.text='noise 两';ordinary=normalizeOcrLines(data(raw));}
   if(kind==='viewMismatch')ordinary=[{text:'Different source',bbox:{x0:0,y0:0,x1:90,y1:30}}];
   if(kind==='length'){raw.words[0].text='方'.repeat(170);raw.text=raw.words[0].text+' 两';ordinary=normalizeOcrLines(data(raw));}
   if(kind==='tall'){raw.words[0].bbox.y1=100;raw.words[1].bbox.y0=200;raw.words[1].bbox.y1=230;ordinary=normalizeOcrLines(data(raw));}
   const reader=read(),result=await recoverDocumentOcrCjk(data(raw),ordinary,reader);
   expect(reader).not.toHaveBeenCalled();expect(result.slice(0,ordinary.length)).toEqual(ordinary);expect(result.at(-1)?.documentReview).toBe(true);
 });
 it('preserves an all-low Han context without allowing unanchored corrections',async()=>{
   const raw=line(['字'],[0]),reader=read('词');
   const result=await recoverDocumentOcrCjk(data(raw),[],reader);expect(reader).not.toHaveBeenCalled();expect(result[0].text).toBe('字');expect(result[1].documentReview).toBe(true);
 });
 it('bounds repeated reading work, leaves later contexts for review and accepts no invalid confidence',async()=>{
   const lines=Array.from({length:25},(_,i)=>{const l=line();l.bbox.y0=i*40;l.bbox.y1=i*40+30;l.words.forEach(w=>{w.bbox.y0=i*40;w.bbox.y1=i*40+30;});return l;});
   const blocks=[{paragraphs:[{lines}]}] as Block[],reader=read();const result=await recoverDocumentOcrCjk(blocks,normalizeOcrLines(blocks),reader);
   expect(reader).toHaveBeenCalledTimes(48);expect(result.filter(l=>l.documentReview)).toHaveLength(1);expect(result.filter(l=>l.text==='方法丙')).toHaveLength(24);
   for(const score of [NaN,Infinity,101])expect((await recoverDocumentOcrCjk(data(line()),normalizeOcrLines(data(line())),read('方法丙',score))).at(-1)?.documentReview).toBe(true);
 });
 it('propagates cancellation and reader failures without mutating supplied lines',async()=>{
   const blocks=data(line()),ordinary=normalizeOcrLines(blocks),before=structuredClone(ordinary),controller=new AbortController();
   const reader=vi.fn(async()=>{controller.abort();return {text:'方法丙',confidence:95};});
   await expect(recoverDocumentOcrCjk(blocks,ordinary,reader,controller.signal)).rejects.toMatchObject({name:'AbortError'});expect(reader).toHaveBeenCalledOnce();expect(ordinary).toEqual(before);
   await expect(recoverDocumentOcrCjk(blocks,ordinary,reader,controller.signal)).rejects.toMatchObject({name:'AbortError'});
   await expect(recoverDocumentOcrCjk(blocks,ordinary,vi.fn(async()=>{throw new Error('failed');}))).rejects.toThrow('failed');
   let calls=0;const second=new AbortController();await expect(recoverDocumentOcrCjk(blocks,ordinary,async()=>{if(++calls===2)second.abort();return{text:'方法丙',confidence:95};},second.signal)).rejects.toMatchObject({name:'AbortError'});
 });
 it('does not touch non-Han or trusted lines and tolerates empty worker containers',async()=>{
   const reader=read();expect(await recoverDocumentOcrCjk(null,[],reader)).toEqual([]);expect(await recoverDocumentOcrCjk([{}, {paragraphs:[{}]}] as Block[],[],reader)).toEqual([]);
   const raw=line(['hello','word'],[96,0]);expect(await recoverDocumentOcrCjk(data(raw),[],reader)).toEqual([]);
   raw.words=[];expect(await recoverDocumentOcrCjk(data(raw),[],reader)).toEqual([]);delete(raw as any).words;expect(await recoverDocumentOcrCjk(data(raw),[],reader)).toEqual([]);
   const invalid=line();invalid.bbox.x0=NaN;expect(await recoverDocumentOcrCjk(data(invalid),[],reader)).toEqual([]);expect(reader).not.toHaveBeenCalled();
 });
});
