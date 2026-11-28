/**
 * @file src/features/video-subtitle/reading/hindiAssets.ts
 * 文件职责：声明印地语读音所需纯数据的固定来源，并复用校验缓存层按需准备词典和模型数据。
 * 主要内容：锁定 gomanize 1.2.1 源码提交的 TSV/JSON 字节数、SHA-256 和双来源，下载完成后构造本地静态 TypeScript 引擎。
 * 模块边界：只下载被当作数据解析的资源，不下载或执行 JavaScript/WASM；缓存、超时和损坏数据回收由 assetStore 负责。
 */
import {buildGithubAssetMirrorUrls, detectPreferredMirrorLocale} from '@/src/core/assets/mirrors';
import {createReadingAssetStore, type ReadingAssetFile} from './assetStore';
import {createHindiEngine} from './hindiEngine';

export const HINDI_READING_REVISION = '3e519d5cfb689c2444545396e4cfab24d3a2d84a';
const locale = detectPreferredMirrorLocale();
const urlsFor = (name: string) => buildGithubAssetMirrorUrls('budhash/gomanize', HINDI_READING_REVISION, `lang/hindi/${name}`, locale);
export const HINDI_READING_ASSETS: readonly ReadingAssetFile[] = [
  {name:'lexicon.tsv', size:208827, sha256:'6fc9955ed159d1237ae28efec2ce762bca44dd50c964f307944fb8d8a27aa517', urls:urlsFor('lexicon.tsv')},
  {name:'roman_ngrams.tsv', size:228964, sha256:'29d9e05cde8aa5cb44ce79810479cf7df8b86baafcf27fa95a8f8d10fe052d16', urls:urlsFor('roman_ngrams.tsv')},
  {name:'schwa_tree.json', size:34463, sha256:'d071eeb37f1abdb4461e5fb5379ca47d8e4120865a11c8cb6a3716396a1334ff', urls:urlsFor('schwa_tree.json')},
];

const store = createReadingAssetStore({cacheName:'fluentread-reading-hi-v1', files:HINDI_READING_ASSETS});

export async function loadHindiReadingEngine(): Promise<(text: string) => string> {
  const data = await store.ensure(), decoder = new TextDecoder('utf-8', {fatal:true});
  const read = (name: string) => decoder.decode(data.get(name)!);
  return createHindiEngine({lexiconTsv:read('lexicon.tsv'), romanNgramsTsv:read('roman_ngrams.tsv'), schwaTreeJson:read('schwa_tree.json')});
}
