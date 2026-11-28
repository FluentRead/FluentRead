/** @file tests/mangaRecognitionTightColorWhitespace.test.ts
 * 用真实 Paddle 裁图和已记录的 CTC 字类、空格分数复放浅底彩字词界。
 * 保存现有空格、同源 Box 和颜色夹具散列，未记录的预测类别不参与断言。
 */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {describe, expect, it} from 'vitest';
import {createMangaRecognitionWhitespace,MANGA_RECOGNITION_WHITESPACE_LIMITS as limits} from '@/src/features/image-translation/services/mangaRecognitionWhitespace';

interface RecordedCrop {
    scene: string;
    source: string;
    sourceSha256: string;
    sdkText: string;
    expectedText: string;
    crop: {width: number; height: number};
    rgbaFile: string;
    rgbaSha256: string;
    gzipSha256: string;
    trace: {indices: number[]; spaces: number[]; characters: string[]; paddedWidth: number; classes: number};
}

const fixtures=new URL('./fixtures/',import.meta.url);
const recordsRoot=new URL('image-translation/',fixtures);
const recording=JSON.parse(readFileSync(new URL('tight-color-whitespace.json',recordsRoot),'utf8')) as {
    sourceManifest: string; sourceManifestSha256: string; records: RecordedCrop[];
};
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

function recordedPixels(record:RecordedCrop):Uint8ClampedArray {
    const compressed=readFileSync(new URL(record.rgbaFile,recordsRoot));
    expect(sha(compressed)).toBe(record.gzipSha256);
    const pixels=gunzipSync(compressed,{maxOutputLength:record.crop.width*record.crop.height*4});
    expect(sha(pixels)).toBe(record.rgbaSha256);
    return new Uint8ClampedArray(pixels);
}

function replay(record:RecordedCrop,options:{spaceScale?:number;mutate?:(pixels:Uint8ClampedArray)=>void}={}){
    const pixels=recordedPixels(record);
    options.mutate?.(pixels);
    const before=pixels.slice();
    const {indices,spaces,characters,paddedWidth,classes}=record.trace;
    const box={width:record.crop.width,height:48};
    const padding={width:paddedWidth,height:48};
    const steps=indices.length;
    const dictionary=Array<string>(classes).fill('');
    const data=new Float32Array(2*steps*classes);
    for(let t=0;t<steps;t++){
        const index=indices[t];
        data[t*classes+classes-1]=spaces[t]*(options.spaceScale??1);
        if(index!==classes-1){
            data[t*classes+index]=1;
            dictionary[index]=characters[t];
        }
        data[(steps+t)*classes]=1;
    }
    const controller=createMangaRecognitionWhitespace();
    controller.beginPage();
    controller.beginRun({boxes:[box,padding],batchSize:2,dictionary,supportedPerBox:true,sourceRatioOne:true});
    controller.observeBorrowedRead(0,record.crop.width,48,pixels);
    const input={};
    controller.bindInput(input,{readIndices:[0,1],resizedWidths:[record.crop.width,paddedWidth],paddedWidth,height:48});
    controller.observeOutput(input,{dims:[2,steps,classes],data});
    const source={text:record.sdkText,box,confidence:.97,tag:{recorded:true}};
    const result=controller.applyToSdkResults([source]);
    controller.endRun();
    controller.endPage();
    expect(pixels).toEqual(before);
    return {source,result:result[0]};
}

describe('紧裁彩字标签的真实词界',()=>{
    it.each(recording.records)('保持真实裁图的文字与空格边界 · $sdkText',record=>{
        expect(sha(readFileSync(new URL(recording.sourceManifest,fixtures)))).toBe(recording.sourceManifestSha256);
        expect(sha(readFileSync(new URL(record.source,fixtures)))).toBe(record.sourceSha256);
        const {source,result}=replay(record);
        expect(result.text).toBe(record.expectedText);
        expect(result.text.replaceAll(' ','')).toBe(source.text.replaceAll(' ',''));
        expect(result.box).toBe(source.box);
        expect(result.confidence).toBe(source.confidence);
        expect(result.tag).toBe(source.tag);
        if(record.expectedText===record.sdkText)expect(result).toBe(source);
    });
    it('缺少模型词界或完整物理空列时保留原读数',()=>{
        const record=recording.records.find(x=>x.sdkText==='KEEPTHE PINKTAG')!;
        expect(replay(record,{spaceScale:0}).result.text).toBe(record.sdkText);
        const {result}=replay(record,{mutate:pixels=>{
            for(let y=0;y<48;y++)for(let x=197;x<230;x++)pixels.set([255,240,255,255],(y*record.crop.width+x)*4);
        }});
        expect(result.text).toBe('KEEPTHE PINK TAG');
    });
    it('重叠字形需要更强的模型词界和连续底色空列',()=>{
        const record=recording.records.find(item=>item.sdkText==='NORTHDOOR')!;
        expect(replay(record,{spaceScale:0.2}).result.text).toBe(record.sdkText);
        expect(replay(record,{mutate:pixels=>{
            for(let y=0;y<48;y++)pixels.set([50,110,147,255],(y*record.crop.width+238)*4);
        }}).result.text).toBe(record.sdkText);
    });
    it('连续紧裁标签按页限制像素和模型时间步消耗',()=>{
        const record=recording.records.find(item=>item.sdkText==='KEEPTHE PINKTAG')!;
        const pixels=recordedPixels(record);
        const box={width:record.crop.width,height:48};
        const classes=record.trace.classes;
        const dictionary=Array<string>(classes).fill('');
        const controller=createMangaRecognitionWhitespace();
        let reads=0;
        const observe=(steps:number,data:Float32Array)=>{
            controller.beginRun({boxes:[box],batchSize:1,dictionary,supportedPerBox:true,sourceRatioOne:true});
            controller.observeBorrowedRead(0,box.width,box.height,pixels);
            const input={};
            controller.bindInput(input,{readIndices:[0],resizedWidths:[box.width],paddedWidth:box.width,height:48});
            controller.observeOutput(input,{dims:[1,steps,classes],get data(){reads++;return data;}});
            controller.endRun();
        };
        const permitted=Math.floor(limits.lightColorPixels/(box.width*box.height*2));
        controller.beginPage();
        const short=new Float32Array(classes);
        for(let i=0;i<=permitted;i++)observe(1,short);
        expect(reads).toBe(permitted);
        controller.beginPage();
        reads=0;
        const steps=limits.lightColorSteps/2;
        const long=new Float32Array(steps*classes);
        for(let i=0;i<3;i++)observe(steps,long);
        expect(reads).toBe(2);
        controller.endPage();
    });
});
