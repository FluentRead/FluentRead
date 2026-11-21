import {describe,expect,it,vi} from 'vitest';
import {isMangaRotatedLabelParent,recoverMangaRotatedLabels,rotatedLabelPadding} from '@/src/features/image-translation/services/mangaRotatedLabel';
import type {MangaOcrItem} from '@/src/features/image-translation/services/mangaRegions';

const width=284,height=412;
const parent={x:25,y:31,width:54,height:320};
const source={text:'P AN EL',confidence:.92,box:parent};
const label={x:42,y:148,width:20,height:68};
const active=()=>{};

function frame(parents=[parent]){
    const pixels=new Uint8ClampedArray(width*height*4).fill(255);
    for(const box of parents){
        for(let y=box.y;y<box.y+box.height;y++){
            for(let x=box.x;x<box.x+box.width;x++){
                const letter=x-box.x>=21&&x-box.x<33&&y-box.y>=120&&y-box.y<184&&(x-box.x)%4!==0&&(y-box.y)%6<4;
                const offset=(y*width+x)*4;
                pixels.fill(letter?240:34,offset,offset+3);
            }
        }
    }
    return pixels;
}

function reading(text:string,confidence:number,turn:1|-1,box=label,crop=parent):MangaOcrItem{
    const {x,y}=rotatedLabelPadding;
    const left=box.x-crop.x,top=box.y-crop.y;
    return {text,confidence,box:{
        x:x+(turn===1?crop.height-top-box.height:top),
        y:y+(turn===1?left:crop.width-left-box.width),
        width:box.height,height:box.width,
    }};
}

describe('PaddleOCR 深色窄带旋转标签复核',()=>{
    it('双向比对后用紧凑原像素行替换粗框，保留独立正文，并跳过重复瓦片候选',async()=>{
        const nearby={text:'STORY',confidence:.99,box:{x:91,y:148,width:80,height:20}};
        const recognize=vi.fn(async()=>[[reading(' PANEL 9 ',.995,1)],[reading('9 1 0',.77,-1)]] as const);
        const result=await recoverMangaRotatedLabels(frame(),width,height,[parent,{...parent,y:33}],[source,nearby],[],recognize,active);
        expect(result).toEqual([nearby,{text:'PANEL 9',confidence:.995,box:label,quarterTurn:1}]);
        expect(recognize).toHaveBeenCalledExactlyOnceWith(parent);
        expect(source).not.toHaveProperty('preserveSource');
    });

    it('另一转向正确时补回完全漏掉的标签',async()=>{
        const result=await recoverMangaRotatedLabels(frame(),width,height,[parent],[],[],async()=>[
            [reading('I O',.66,1)],[reading('OPEN PANEL',.988,-1)],
        ],active);
        expect(result).toEqual([{text:'OPEN PANEL',confidence:.988,box:label,quarterTurn:-1}]);
    });

    it.each([
        ['反向数值置信度接近',reading('9 0',.94,-1)],
        ['不能确认是拉丁短标签',reading('90',.997,-1)],
        ['反向其他文字置信度接近',reading('壁画',.95,-1)],
        ['出现超长误识别',reading('A'.repeat(33),.997,-1)],
        ['出现混合文字误识别',reading('PANEL 画',.997,-1)],
        ['候选缺失稳定的词形',reading('PA 72',.997,-1)],
    ])('%s 时保留粗框原像素',async(_name,alternate)=>{
        const result=await recoverMangaRotatedLabels(frame(),width,height,[parent],[source],[],async()=>[
            [reading('PANEL 9',.99,1)],[alternate],
        ],active);
        expect(result).toEqual([{...source,preserveSource:true}]);
    });

    it('返回畸形框、远处物体、超宽框或弱识别时不能替换原文',async()=>{
        const readings=[
            reading('MOSAIC',.96,1),
            reading('MOSAIC',NaN,1),
            reading('MOSAIC',1.01,1),
            reading('MOSAIC',.61,1),
            reading(' ',.99,1),
            reading('A'.repeat(65),.99,1),
            {...reading('MOSAIC',.99,1),box:{x:1,y:1,width:20,height:15}},
            reading('MOSAIC',.99,1,{...label,y:260}),
            reading('MOSAIC',.99,1,{...label,y:156,height:52}),
            reading('MOSAIC',.99,1,{...label,x:28,width:48}),
            reading('MOSAIC',.99,1,{...label,y:130,height:109}),
        ];
        const result=await recoverMangaRotatedLabels(frame(),width,height,[parent],[source],[],async()=>[readings,[]],active);
        expect(result).toEqual([{...source,preserveSource:true}]);
    });

    it('数字和其他物理行保护原源框及最终映回的字框',async()=>{
        const number={text:'42',confidence:.99,box:{x:52,y:160,width:14,height:16}};
        const adjacent={text:'NOTE',confidence:.98,box:{x:39,y:159,width:5,height:9}};
        const recognize=vi.fn(async()=>[[reading('PANEL 9',.99,1)],[]] as const);
        const protectedResult=await recoverMangaRotatedLabels(frame(),width,height,[parent],[source],[number],recognize,active);
        expect(protectedResult).toEqual([{...source,preserveSource:true}]);
        expect(recognize).not.toHaveBeenCalled();
        const collision=await recoverMangaRotatedLabels(frame(),width,height,[parent],[source,adjacent],[],recognize,active);
        expect(collision).toEqual([{...source,preserveSource:true},adjacent]);
        const numericSource={...source,text:'42'};
        const numeric=await recoverMangaRotatedLabels(frame(),width,height,[parent],[numericSource],[],recognize,active);
        expect(numeric).toEqual([numericSource]);
        expect(recognize).toHaveBeenCalledOnce();
    });

    it('透明、浅色、纯色和高亮条纹不启动复识别',async()=>{
        const transparent=frame();
        transparent[(parent.y*width+parent.x)*4+3]=0;
        const solid=frame(),stripe=frame();
        for(let y=parent.y+8;y<parent.y+parent.height-8;y++){
            for(let x=parent.x+19;x<parent.x+35;x++){
                const offset=(y*width+x)*4;
                solid.fill(34,offset,offset+3);
                if(y>=parent.y+120&&y<parent.y+184)stripe.fill(240,offset,offset+3);
            }
        }
        const recognize=vi.fn();
        for(const pixels of [transparent,solid,stripe,new Uint8ClampedArray(width*height*4).fill(255),new Uint8ClampedArray(1)]){
            expect(await recoverMangaRotatedLabels(pixels,width,height,[parent],[source],[],recognize,active)).toEqual([source]);
        }
        expect(recognize).not.toHaveBeenCalled();
    });

    it('每页最多两个紧凑暗带，取消停止后续候选',async()=>{
        const parents=[parent,{...parent,x:108},{...parent,x:194}];
        const pixels=frame(parents),failed=vi.fn(async()=>[[],[]] as const);
        await recoverMangaRotatedLabels(pixels,width,height,parents,[],[],failed,active);
        expect(failed.mock.calls).toEqual([[parent],[parents[1]]]);
        const abort=new Error('cancelled');
        const recognise=vi.fn(async()=>[[],[]] as const);
        const check=vi.fn().mockImplementationOnce(active).mockImplementation(()=>{throw abort;});
        await expect(recoverMangaRotatedLabels(pixels,width,height,parents,[],[],recognise,check)).rejects.toBe(abort);
        expect(recognise).toHaveBeenCalledOnce();
    });

    it('拒绝异常源框，并限制未命中候选的像素扫描',async()=>{
        for(const box of [
            {...parent,x:-1},{...parent,y:-1},{...parent,x:25.3},{...parent,width:0},{...parent,height:0},
            {...parent,x:width},{...parent,y:1200},{...parent,width:23},{...parent,width:129},{...parent,height:255},
            {...parent,width:128,height:1025},
        ])expect(isMangaRotatedLabelParent(box,width,1200)).toBe(false);
        const w=128,h=1024,b={x:0,y:0,width:w,height:h},rec=vi.fn(),check=vi.fn();
        await recoverMangaRotatedLabels(new Uint8ClampedArray(w*h*4).fill(255),w,h,
            [{...b,x:-1},...Array(6).fill(b)],[],[],rec,check);
        expect(rec).not.toHaveBeenCalled();
        expect(check).toHaveBeenCalledTimes(6);
    });
});
