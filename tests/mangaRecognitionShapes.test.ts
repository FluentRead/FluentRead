import {describe,expect,it} from 'vitest';
import {assertMangaRecognitionInput,optimizeVerifiedMangaRecognition,MANGA_RECOGNITION_SOURCE_SHA,MANGA_RECOGNITION_SHAPES_VERSION,MANGA_RECOGNITION_DERIVED_SHA} from '@/src/features/image-translation/services/mangaRecognitionShapes';
import {recognitionWireToy} from './helpers/mangaOnnxFixture';
const asset={bytes:21159378,sha256:MANGA_RECOGNITION_SOURCE_SHA};
describe('固定来源的私有漫画识别形状配方',()=>{
    it('无来源支持的未来模型原样返回，不推断固定宽度或另取模型',()=>{
        const unknown=new ArrayBuffer(2);expect(optimizeVerifiedMangaRecognition(unknown,{bytes:2,sha256:'new-model'})).toBe(unknown);
        expect(MANGA_RECOGNITION_SHAPES_VERSION).toBe('ppocrv6-shapes-ab-clean-v1');expect(MANGA_RECOGNITION_DERIVED_SHA).toHaveLength(64);
    });
    it('已声明固定来源却容量/图不匹配，明确失败而不回旧图掩盖告警',()=>{
        expect(()=>optimizeVerifiedMangaRecognition(new ArrayBuffer(1),asset)).toThrow('容量');
        expect(()=>optimizeVerifiedMangaRecognition(new ArrayBuffer(asset.bytes),{...asset,bytes:1})).toThrow('容量');
        expect(()=>optimizeVerifiedMangaRecognition(new ArrayBuffer(asset.bytes),asset)).toThrow('配方');
    });
    it('真实wire的便携toy改写成独占内存，来源元数据与原缓冲不变，不创建模型/下载',()=>{
        const original=recognitionWireToy(),before=new Uint8Array(original).slice();
        const result=optimizeVerifiedMangaRecognition(original,asset);
        expect(result).not.toBe(original);expect(result.byteLength).toBe(21158034);expect(Buffer.compare(Buffer.from(original),Buffer.from(before.buffer))).toBe(0);
    });
    it('预取消不解析、不分配；改写期间观察到取消也不能发布结果',()=>{
        const abort=new AbortController();abort.abort();expect(()=>optimizeVerifiedMangaRecognition(new ArrayBuffer(0),asset,abort.signal)).toThrow(expect.objectContaining({name:'AbortError'}));
        const original=recognitionWireToy();let reads=0;
        const observed={get aborted(){return ++reads>1;}} as AbortSignal;
        expect(()=>optimizeVerifiedMangaRecognition(original,asset,observed)).toThrow(expect.objectContaining({name:'AbortError'}));
    });
    it.each([1,2,6,9])('保持动态batch %s 与最小/宽幅输入，不固定序列长度',n=>{
        for(const width of [8,9,31,48,319,4096])expect(()=>assertMangaRecognitionInput({x:{type:'float32',dims:[n,3,48,width]}})).not.toThrow();
    });
    it.each([
        undefined,null,{}, {x:{}},{x:{type:'float32',dims:'1,3,48,8'}},{x:{type:'float32',dims:[1,3,48]}},
        {x:{type:'float32',dims:[0,3,48,8]}},{x:{type:'float32',dims:[1.5,3,48,8]}},{x:{type:'float32',dims:[Infinity,3,48,8]}},
        {x:{type:'float32',dims:[1,4,48,8]}},{x:{type:'float32',dims:[1,3,32,8]}},{x:{type:'float32',dims:[1,3,48,0]}},
        {x:{type:'float32',dims:[1,3,48,7]}},{x:{type:'float32',dims:[1,3,48,8.5]}},{x:{type:'float32',dims:[1,3,48,NaN]}},
        {x:{type:'int64',dims:[1,3,48,8]}},
    ])('未来/不支持输入域在原生推理前拒绝 %#',feeds=>expect(()=>assertMangaRecognitionInput(feeds)).toThrow('支持范围'));
});
