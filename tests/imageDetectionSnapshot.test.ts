/**
 * @file tests/imageDetectionSnapshot.test.ts
 * 已加载栅格的单帧资格回归；只核签名、PNG块和工作上限，不将该检查当图片解码器。
 */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {isSingleFrameImageData} from '@/src/features/image-translation/services/imageDetectionSnapshot';
const signature=[137,80,78,71,13,10,26,10];
const chunk=(type:string,data:number[]=[])=>[data.length>>>24,(data.length>>>16)&255,(data.length>>>8)&255,data.length&255,...Array.from(type,c=>c.charCodeAt(0)),...data,0,0,0,0];
// 结构变体使用合成块；CRC/实际像素解码不属于被测资格函数的合同。
const uri=(bytes:number[],mime='png')=>`data:image/${mime};base64,${Buffer.from(bytes).toString('base64')}`;
const header=()=>chunk('IHDR',Array(13).fill(0));
const png=(middle:number[][]=[chunk('IDAT',[1])])=>uri([...signature,...header(),...middle.flat(),...chunk('IEND')]);
afterEach(()=>vi.restoreAllMocks());
describe('检测侧车仅借用已确认单帧图像',()=>{
    it('接纳实际静态PNG及相符JPEG/BMP签名，拒绝伪造MIME和动画格式',()=>{
        expect(isSingleFrameImageData('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQK0AAAAASUVORK5CYII=')).toBe(true);
        expect(isSingleFrameImageData(uri([255,216,255,224],'jpeg'))).toBe(true);
        expect(isSingleFrameImageData(uri([255,216,255],'jpg'))).toBe(true);
        expect(isSingleFrameImageData(uri([66,77,0],'bmp'))).toBe(true);
        for(const data of [uri([255,216,255],'jpeg'),uri([66,77,0],'bmp'),png()])expect(isSingleFrameImageData(data+'#abc')).toBe(false);
        for(const data of ['https://example.com/image.png','data:image/gif;base64,R0lGODlh','data:image/svg+xml;base64,PHN2Zz4=','data:image/webp;base64,UklGRg==',uri([71,73,70,56],'jpeg'),uri([0,77,0],'bmp'),uri([255,0,255],'jpeg'),uri([255,216,0],'jpeg'),uri([66,0,0],'bmp')])expect(isSingleFrameImageData(data)).toBe(false);
    });
    it.each(['acTL','fcTL','fdAT'])('PNG的%s不因声明或实际帧数而当静态图',type=>{
        expect(isSingleFrameImageData(png([chunk(type,[0,0,0,1]),chunk('IDAT',[1])]))).toBe(false);
        expect(isSingleFrameImageData(png([chunk('IDAT',[1]),chunk(type)]))).toBe(false);
    });
    it('完整PNG块可跨多个base64三字节边界，未知静态附加块不改变帧数',()=>{
        for(const length of [1,2,3,4,5])expect(isSingleFrameImageData(png([chunk('tEXt',Array(length).fill(65)),chunk('IDAT',[1]),chunk('IDAT',[2,3])]))).toBe(true);
        expect(isSingleFrameImageData(png([chunk('tEXt',[65])]))).toBe(false);
    });
    it('空值、短签名和不完整base64拒绝，不需要解压整个输入',()=>{
        for(const s of ['data:image/png;base64,','data:image/png;base64,A',uri([137,80]),uri([0,...signature.slice(1)]),uri([255],'jpeg')])expect(isSingleFrameImageData(s)).toBe(false);
        expect(isSingleFrameImageData('data:image/png;base64,!!!!!!!!!!!!')).toBe(false);
    });
    it('必须从唯一13字节IHDR开始，并有完整IDAT/IEND且没有尾随字节',()=>{
        for(const bytes of [signature,[...signature,...chunk('tEXt',[1]),...chunk('IEND')],[...signature,...chunk('IHDR',[1]),...chunk('IDAT'),...chunk('IEND')],
            [...signature,...header(),...header(),...chunk('IDAT'),...chunk('IEND')],[...signature,...header(),...chunk('IDAT'),...chunk('IEND',[1])],
            [...signature,...header(),...chunk('IDAT'),...chunk('IEND'),0],[...signature,...header(),...chunk('IDAT')]])expect(isSingleFrameImageData(uri(bytes))).toBe(false);
    });
    it('坏块长度、截断以及超过1024块的工作量均拒绝',()=>{
        const enormous=[...signature,...header(),255,255,255,255,73,68,65,84];expect(isSingleFrameImageData(uri(enormous))).toBe(false);
        const beyond=[...signature,...header(),0,0,1,0,73,68,65,84,0,0,0,0];expect(isSingleFrameImageData(uri(beyond))).toBe(false);
        expect(isSingleFrameImageData(png(Array.from({length:1024},()=>chunk('IDAT'))))).toBe(false);
    });
    it('解码头部失败按未知格式处理，不扩展到RGBA或继续调用解析器',()=>{
        vi.spyOn(globalThis,'atob').mockImplementation(()=>{throw new Error('invalid encoded header');});
        expect(isSingleFrameImageData(png())).toBe(false);
    });
});
