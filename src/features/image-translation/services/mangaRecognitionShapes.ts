/**
 * @file src/features/image-translation/services/mangaRecognitionShapes.ts
 * 文件职责：仅在固定 PP-OCRv6 识别模型完整 SHA 验证后，在内存删除两个动态形状生成链，避免 WebGPU 的形状节点落 CPU。
 * 主要内容：固定原模型与配方版本，保留 Reshape.54/73 和所有特征权重原字节；用 [0,0,-1] 与 [0,1,-1,120] 两个 INT64 常量替代十三个形状节点，删除其十一项无消费者常量；未知来源原样保留，固定来源的配方漂移明确报错；每次推理核对私有输入域。
 * 模块边界：输入必须来自 mangaOcrAssets 完整来源校验之后，不能凭调用者填写的 SHA 为未知字节背书；不写缓存、不下载模型、不创建会话、不改变 CTC 或像素。形状元数据取自已有 Apache-2.0 模型，授权沿用 third-party-notices/manga-models-Apache-2.0.txt。
 * 适用域：mangaOcr.ts 的私有 per-box SDK 入口固定 H=48，正尺寸裁图最小 W=8，空框不 forward；N>=1/W>=8 时 t=floor((W+3)/8)>0。Reshape.73 的 [0,1,-1,120] 在该域等价，故原生 run 前强制门禁，未来 SDK 默认或输入变化不能静默扩大域。
 */
import {rewriteMangaOnnxFields,type MangaOnnxFieldRecipe} from './mangaOnnxFields';
export const MANGA_RECOGNITION_SOURCE_SHA='5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634';
export const MANGA_RECOGNITION_SHAPES_VERSION='ppocrv6-shapes-ab-clean-v1';
export const MANGA_RECOGNITION_DERIVED_SHA='74e090ae2d77172c1b763dde792a4c4a611bdf8b6049789c003fc9dda0ff525f';
const SOURCE_BYTES=21159378;
function hex(value:string):Uint8Array {return Uint8Array.from({length:value.length/2},(_,index)=>parseInt(value.slice(index*2,index*2+2),16));}
// 配方只含形状节点/标量的原字段，不含任何特征权重；精确字段顺序和属性也必须匹配。
export const MANGA_RECOGNITION_SHAPE_RECIPE:MangaOnnxFieldRecipe={
    requiredModelFields:["0806","42040a00100b"].map(hex),
    graphCounts:{1:481,5:241},
    remove:[
        {name:"Shape.0",bytes:hex("0a2d0a1270326f2e70645f6f702e6164642e36352e30120753686170652e311a0753686170652e3022055368617065")},
        {name:"Identity.148",bytes:hex("0a380a0753686170652e31121570326f2e70645f6f702e736861706536342e302e301a0c4964656e746974792e31343822084964656e74697479")},
        {name:"Slice.0",bytes:hex("0a96010a1570326f2e70645f6f702e736861706536342e302e300a1d70326f2e70645f6f702e66756c6c5f696e745f61727261792e36312e300a1d70326f2e70645f6f702e66756c6c5f696e745f61727261792e36322e300a1268656c7065722e636f6e7374616e742e34300a1268656c7065722e636f6e7374616e742e33391207536c6963652e311a07536c6963652e302205536c696365")},
        {name:"Squeeze.0",bytes:hex("0a3f0a07536c6963652e31121370326f2e70645f6f702e736c6963652e302e301a0953717565657a652e30220753717565657a652a0b0a04617865734000a00107")},
        {name:"Shape.2",bytes:hex("0a2d0a1270326f2e70645f6f702e6164642e36352e30120753686170652e331a0753686170652e3222055368617065")},
        {name:"Slice.2",bytes:hex("0a650a0753686170652e330a1268656c7065722e636f6e7374616e742e34330a1268656c7065722e636f6e7374616e742e34340a1268656c7065722e636f6e7374616e742e3432120e68656c7065722e736c6963652e301a07536c6963652e322205536c696365")},
        {name:"Concat.2",bytes:hex("0a4d0a0e68656c7065722e736c6963652e300a1268656c7065722e636f6e7374616e742e34311208436f6e6361742e331a08436f6e6361742e322206436f6e6361742a0b0a04617869731800a00102")},
        {name:"Identity.201",bytes:hex("0a480a1370326f2e70645f6f702e736c6963652e302e30121970326f2e6275696c74696e2e636f6d62696e652e312e305f321a0c4964656e746974792e32303122084964656e74697479")},
        {name:"Identity.205",bytes:hex("0a410a1970326f2e6275696c74696e2e636f6d62696e652e312e305f32120c6175746f2e636173742e39341a0c4964656e746974792e32303522084964656e74697479")},
        {name:"Unsqueeze.2",bytes:hex("0a470a0c6175746f2e636173742e3934121268656c7065722e756e73717565657a652e321a0b556e73717565657a652e322209556e73717565657a652a0b0a04617865734000a00107")},
        {name:"Concat.4",bytes:hex("0a80010a1268656c7065722e756e73717565657a652e300a1268656c7065722e756e73717565657a652e310a1268656c7065722e756e73717565657a652e320a1268656c7065722e756e73717565657a652e33120f68656c7065722e636f6e6361742e301a08436f6e6361742e342206436f6e6361742a0b0a04617869731800a00102")},
        {name:"Identity.207",bytes:hex("0a3e0a0f68656c7065722e636f6e6361742e30121370326f2e70645f6f702e737461636b2e302e301a0c4964656e746974792e32303722084964656e74697479")},
        {name:"Identity.208",bytes:hex("0a3b0a1370326f2e70645f6f702e737461636b2e302e30120c6175746f2e636173742e39361a0c4964656e746974792e32303822084964656e74697479")},
        {name:"p2o.pd_op.full_int_array.61.0",bytes:hex("2a2d08011007421d70326f2e70645f6f702e66756c6c5f696e745f61727261792e36312e304a080300000000000000")},
        {name:"p2o.pd_op.full_int_array.62.0",bytes:hex("2a2d08011007421d70326f2e70645f6f702e66756c6c5f696e745f61727261792e36322e304a080400000000000000")},
        {name:"helper.constant.40",bytes:hex("2a2208011007421268656c7065722e636f6e7374616e742e34304a080000000000000000")},
        {name:"helper.constant.39",bytes:hex("2a2208011007421268656c7065722e636f6e7374616e742e33394a080100000000000000")},
        {name:"helper.constant.43",bytes:hex("2a2208011007421268656c7065722e636f6e7374616e742e34334a080000000000000000")},
        {name:"helper.constant.44",bytes:hex("2a2208011007421268656c7065722e636f6e7374616e742e34344a080200000000000000")},
        {name:"helper.constant.42",bytes:hex("2a2208011007421268656c7065722e636f6e7374616e742e34324a080000000000000000")},
        {name:"helper.constant.41",bytes:hex("2a2208011007421268656c7065722e636f6e7374616e742e34314a08ffffffffffffffff")},
        {name:"helper.unsqueeze.0",bytes:hex("2a2208011007421268656c7065722e756e73717565657a652e304a080000000000000000")},
        {name:"helper.unsqueeze.1",bytes:hex("2a2208011007421268656c7065722e756e73717565657a652e314a080100000000000000")},
        {name:"helper.unsqueeze.3",bytes:hex("2a2208011007421268656c7065722e756e73717565657a652e334a087800000000000000")},
    ],
    append:["2a28080310074208436f6e6361742e334a1800000000000000000000000000000000ffffffffffffffff","2a3408041007420c6175746f2e636173742e39364a2000000000000000000100000000000000ffffffffffffffff7800000000000000"].map(hex),
};
function active(signal?:AbortSignal):void {if(signal?.aborted)throw new DOMException('漫画识别已取消','AbortError');}
/** 仅供资源层校验完成后调用；派生缓冲只交给会话，原始缓存仍保留原 SHA 对应文件。 */
export function optimizeVerifiedMangaRecognition(buffer:ArrayBuffer,asset:{bytes:number;sha256:string},signal?:AbortSignal):ArrayBuffer {
    active(signal);
    if(asset.sha256!==MANGA_RECOGNITION_SOURCE_SHA)return buffer;
    if(asset.bytes!==SOURCE_BYTES||buffer.byteLength!==SOURCE_BYTES)throw new Error('漫画识别模型形状优化的固定来源容量不匹配');
    const result=rewriteMangaOnnxFields(buffer,MANGA_RECOGNITION_SHAPE_RECIPE);
    active(signal);return result;
}
/** 当前私有 SDK 只生成 float32 x[N,3,48,W]；不接受零尺寸、外部任意张量或未来未证明的宽高。 */
export function assertMangaRecognitionInput(feeds:unknown):void {
    const tensor=(feeds as {x?:{dims?:unknown;type?:unknown}}|undefined)?.x,dims=tensor?.dims;
    if(tensor?.type!=='float32'||!Array.isArray(dims)||dims.length!==4||!Number.isInteger(dims[0])||dims[0]<1
        ||dims[1]!==3||dims[2]!==48||!Number.isInteger(dims[3])||dims[3]<8)
        throw new Error('漫画识别输入超出固定模型形状优化的支持范围');
}
