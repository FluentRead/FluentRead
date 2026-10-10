/**
 * @file src/features/information-highlight/offscreen/artifacts.ts
 * 文件职责：把各个固定信息高亮模型清单接到互相独立的通用校验分块缓存。
 * 主要内容：保留默认模型的 v1 缓存与固定官方 canonical URL，为备选模型分别提供离线读取端口；没有原文或云端分析请求。
 * 模块边界：仅组合纯清单和 platform 存储，不依赖其他 feature 的模型缓存，不初始化模型。
 */
import {DEFAULT_INFORMATION_HIGHLIGHT_MODEL_ID, getInformationHighlightModel, type InformationHighlightModelId} from '@/src/core/config/informationHighlightModel';
import {createModelArtifactStore} from '@/src/platform/storage/modelArtifacts';
export const INFORMATION_HIGHLIGHT_CACHE = 'fluent-read-information-highlight-model-v1';
type ArtifactStore = ReturnType<typeof createModelArtifactStore>;
const stores = new Map<InformationHighlightModelId, ArtifactStore>();
export function getInformationHighlightArtifacts(modelId: InformationHighlightModelId = DEFAULT_INFORMATION_HIGHLIGHT_MODEL_ID) {
    const model = getInformationHighlightModel(modelId);
    return model.files.map(file => ({...file, url: `https://huggingface.co/${model.repository}/resolve/${model.revision}/${file.path}`}));
}
export function getInformationHighlightArtifactStore(modelId: InformationHighlightModelId = DEFAULT_INFORMATION_HIGHLIGHT_MODEL_ID): ArtifactStore {
    const model = getInformationHighlightModel(modelId);
    const existing = stores.get(model.id);
    if (existing) return existing;
    const cacheName = model.id === DEFAULT_INFORMATION_HIGHLIGHT_MODEL_ID ? INFORMATION_HIGHLIGHT_CACHE : `fluent-read-information-highlight-model-${model.id}-v1`;
    const store = createModelArtifactStore(cacheName, getInformationHighlightArtifacts(model.id));
    stores.set(model.id, store);
    return store;
}
export const informationHighlightArtifacts = getInformationHighlightArtifacts();
export const informationHighlightArtifactStore = getInformationHighlightArtifactStore();
