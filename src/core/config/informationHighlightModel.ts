/**
 * @file src/core/config/informationHighlightModel.ts
 * 文件职责：固定可选信息高亮模型的来源、版本、字节数和内容校验值，并保留默认模型兼容入口。
 * 主要内容：Qwen2.5-0.5B Base 与 Qwen3-0.6B 聊天模型的 Apache-2.0 ONNX q4f16 清单；纯身份列表可独立裁剪，配置归一化不携带权重元数据，每个模型文件固定同一 revision。
 * 模块边界：纯元数据，不初始化推理、不下载权重；SHA-256 来自官方 LFS 元数据及该固定版本实际小文件。
 */
export const INFORMATION_HIGHLIGHT_MODEL_IDS = ['qwen2.5-0.5b', 'qwen3-0.6b'] as const;
export type InformationHighlightModelId = typeof INFORMATION_HIGHLIGHT_MODEL_IDS[number];
export const DEFAULT_INFORMATION_HIGHLIGHT_MODEL_ID: InformationHighlightModelId = INFORMATION_HIGHLIGHT_MODEL_IDS[0];
export interface InformationHighlightModel {
    readonly id: InformationHighlightModelId;
    readonly name: string;
    readonly repository: string;
    readonly revision: string;
    readonly files: readonly {readonly path: string; readonly size: number; readonly sha256: string}[];
    readonly bytes: number;
    readonly kvCacheDtype: 'float32' | 'float16';
}
const qwen25Files = [
    {path: 'config.json', size: 691, sha256: '90ad34e62bb47572a06e0235696076976d59e9fcf5ab173d9a44689ba01b7d52'},
    {path: 'generation_config.json', size: 117, sha256: '113ab032dbddc84029290361700100d7f448db7b21c20c6c81b798bb09062fc1'},
    {path: 'special_tokens_map.json', size: 616, sha256: '6676f091c8bc4d1b50146427cfde92073402866b87b6e39223227931b70083e9'},
    {path: 'tokenizer.json', size: 7031673, sha256: 'a8506e7111b80c6d8635951a02eab0f4e1a8e4e5772da83846579e97b16f61bf'},
    {path: 'tokenizer_config.json', size: 7229, sha256: 'cefaa66de8fae4a09ca18a9c3a7fd8b61311ed568e5f4e634f6a3d95a2a9e889'},
    {path: 'onnx/model_q4f16.onnx', size: 483003582, sha256: '30a39f89fab8f30d0f99aa1e28d3e3be6fca66a3fab915f77584ac52a8361d25'},
] as const;
const qwen3Files = [
    {path: 'config.json', size: 912, sha256: '8a04114ba59cc42b47d804d35d1d5c61d746ae4634f41f796768c6e302d39b9e'},
    {path: 'generation_config.json', size: 219, sha256: '9e9e031ae8bca36eefcdcdd0b35d83c61baa01e31d68d5f5a961c9ca1a4b95bf'},
    {path: 'special_tokens_map.json', size: 613, sha256: '76862e765266b85aa9459767e33cbaf13970f327a0e88d1c65846c2ddd3a1ecd'},
    {path: 'tokenizer.json', size: 9117040, sha256: 'e7a95fce95bf5b0946d0ddb3f9d7caa030b7e850bbe92b0edb26bcf563e9f3d5'},
    {path: 'tokenizer_config.json', size: 10360, sha256: '982fa8771b0e9e5ebf7e943631c6fc4af301aa81b509e1ca517a7389e4a51d42'},
    {path: 'onnx/model_q4f16.onnx', size: 569789750, sha256: '9e33a5911974174761d0dfdcc0bec975d9c45af0eae5e9eb647b8ba9442a8f91'},
] as const;
export const INFORMATION_HIGHLIGHT_MODELS: readonly InformationHighlightModel[] = [
    {id: 'qwen2.5-0.5b', name: 'Qwen2.5 0.5B', repository: 'onnx-community/Qwen2.5-0.5B', revision: 'bae5ceaee026f0d0592858b2bd27645a06f19c42', files: qwen25Files, bytes: /* @__PURE__ */ qwen25Files.reduce((sum, file) => sum + file.size, 0), kvCacheDtype: 'float32'},
    {id: 'qwen3-0.6b', name: 'Qwen3 0.6B', repository: 'onnx-community/Qwen3-0.6B-ONNX', revision: '1e0a4a196ecabdf9a879664110574563d3f372d3', files: qwen3Files, bytes: /* @__PURE__ */ qwen3Files.reduce((sum, file) => sum + file.size, 0), kvCacheDtype: 'float16'},
];
export function getInformationHighlightModel(value: unknown): InformationHighlightModel {
    return INFORMATION_HIGHLIGHT_MODELS.find(model => model.id === value) ?? INFORMATION_HIGHLIGHT_MODELS[0];
}
// 旧入口始终指向默认模型；固定 revision 与文件 URL 不变，兼容已校验的 v1 离线缓存。
const defaultModel = INFORMATION_HIGHLIGHT_MODELS[0];
export const INFORMATION_HIGHLIGHT_MODEL = defaultModel.repository;
export const INFORMATION_HIGHLIGHT_MODEL_NAME = defaultModel.name;
export const INFORMATION_HIGHLIGHT_MODEL_REVISION = defaultModel.revision;
export const INFORMATION_HIGHLIGHT_MODEL_FILES = defaultModel.files;
export const INFORMATION_HIGHLIGHT_MODEL_BYTES = defaultModel.bytes;
