/**
 * @file src/features/video-subtitle/reading/japaneseDictionary.ts
 * 文件职责：固定日语分词词典的数据版本、大小、摘要和下载来源，首次日语读音请求才准备词典。
 * 主要内容：锁定 @faanau/kuromoji 0.2.1 的十二份 gzip 数据，通过本 feature 可信缓存返回原始压缩字节。
 * 模块边界：不加载远程脚本、不处理字幕或构建分词器；调用者在 Worker 中解压并装配随扩展提供的本地算法。
 */
import {buildNpmAssetMirrorUrls, detectPreferredMirrorLocale} from '@/src/core/assets/mirrors';
import {createReadingAssetStore, type ReadingAssetFile} from './assetStore';

export const JAPANESE_DICTIONARY_VERSION = '0.2.1';
const locale = detectPreferredMirrorLocale();

const manifest = [
    ['base.dat.gz', 3956825, '0803327762e1c93ca731e4319ab8343340f2806bb84941207782cde9d2d5a8eb'],
    ['cc.dat.gz', 1692067, '02b7631be0d4de3a1a75cd9f9cc51536e4f94c9e6b389b813e06ba0f6e7de765'],
    ['check.dat.gz', 3111633, '193ae0035fff6fe812b58d9ee730e7a7d7ee601d918481ce51075c58114f6cc9'],
    ['tid.dat.gz', 1605820, 'd43d831cb6fb0f0a411739cd287a6d5e998e121a8daca614df14a81a0dcac586'],
    ['tid_map.dat.gz', 1485576, '33efd5ffd87a70f669add093fa39dee44341d58f940844ef107c8fd98bb795b2'],
    ['tid_pos.dat.gz', 5916009, '60dbfc99a6ab993f30c5dab648bec6ad7f9aaefa5c14e1843837d95e509f8895'],
    ['unk.dat.gz', 10512, 'f7f991cdeb9bfd3e9c0e4577cc50ee0815a11c508cccd444a9d3ab3c81521100'],
    ['unk_char.dat.gz', 306, '9a8e86fd9aff32d323fbb59f5a7006f05927a11f8173c90712cc56293aeb3225'],
    ['unk_compat.dat.gz', 338, '50f60aa29bc2e86c2903ab8c825bb6fa604d2b294d96941c1d3924259791899d'],
    ['unk_invoke.dat.gz', 1140, '6b210889548457c3006913afd12c8b525562255f2709e404604be9614a25e94c'],
    ['unk_map.dat.gz', 1190, '6df12460e5477230bb6fd9641def918b699fc0a8868016b6c9f794488630509b'],
    ['unk_pos.dat.gz', 10540, '5b183a29f281acc7e0542beca47b83f7985047c0a2d27e78a66f32276be5ad11'],
] as const;

export const JAPANESE_DICTIONARY_FILES: readonly ReadingAssetFile[] = manifest.map(([name, size, sha256]) => ({
    name, size, sha256, urls: buildNpmAssetMirrorUrls('@faanau/kuromoji', JAPANESE_DICTIONARY_VERSION, `dict/${name}`, locale),
}));
export const JAPANESE_DICTIONARY_BYTES = JAPANESE_DICTIONARY_FILES.reduce((total, file) => total + file.size, 0);

const dictionary = createReadingAssetStore({cacheName: 'fluentread-reading-ja-0.2.1-v1', files: JAPANESE_DICTIONARY_FILES});
export const ensureJapaneseDictionary = dictionary.ensure;

/** loader 传来的路径只用来选择清单文件，不能控制实际下载 URL。 */
export function readJapaneseDictionaryFile(url: string): Promise<ArrayBuffer> {
    return dictionary.get(url.slice(url.lastIndexOf('/') + 1));
}
