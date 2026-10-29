/**
 * @file src/features/vocabulary/materialClient.ts
 * 文件职责：提供界面与采集器共用的类型化学习材料后台客户端。
 * 主要内容：列表、采集、位置更新、主题、归档、恢复、引用删除和清空；在发送消息前拒绝无痕扩展页面，错误只携带公开协议码。
 * 模块边界：客户端不直接访问 IndexedDB 或配置同步；生命周期与迟到结果由调用者 guard 和持久化世代共同约束。
 */
import browser from 'webextension-polyfill';
import {MATERIAL_MESSAGE, type MaterialOperationGuard, type MaterialBackup, type MaterialImportResult, type MaterialCaptureInput, type MaterialListOptions, type MaterialPatch, type MaterialRecord, type MaterialReference, type MaterialRequest, type MaterialResponse, type MaterialWorkspaceWriteReceipt} from './materialProtocol';
export class MaterialClientError extends Error {
    constructor(readonly code: string, message: string) {super(message); this.name = 'MaterialClientError';}
}
async function request<T>(message: MaterialRequest): Promise<T> {
    if (browser.extension?.inIncognitoContext === true) throw new MaterialClientError('privacy-disabled', '无痕窗口不读取或保存学习材料');
    const response = await browser.runtime.sendMessage(message) as MaterialResponse<T>;
    if (!response || response.success !== true) throw new MaterialClientError(response?.success === false ? response.error.code : 'storage-error', response?.success === false ? response.error.message : '本地学习材料暂时不可用');
    return response.data;
}
export const materialList = (options?: MaterialListOptions) => request<MaterialRecord[]>({type: MATERIAL_MESSAGE, action: 'list', options});
export const materialGeneration = () => request<number>({type: MATERIAL_MESSAGE, action: 'generation'});
export const materialGet = (id: string) => request<MaterialRecord | null>({type: MATERIAL_MESSAGE, action: 'get', id});
export const materialResolve = (id: string) => request<MaterialRecord | null>({type: MATERIAL_MESSAGE, action: 'resolve', id});
export const materialCapture = (input: MaterialCaptureInput) => request<MaterialRecord>({type: MATERIAL_MESSAGE, action: 'capture', input});
export const materialUpdate = (id: string, patch: MaterialPatch) => request<MaterialRecord>({type: MATERIAL_MESSAGE, action: 'update', id, patch});
export const materialRemoveReference = (id: string, kind: MaterialReference['kind'], referenceId: string) => request<MaterialRecord>({type: MATERIAL_MESSAGE, action: 'removeReference', id, kind, referenceId});
export const materialArchive = (id: string) => request<MaterialRecord>({type: MATERIAL_MESSAGE, action: 'archive', id});
export const materialRestore = (id: string) => request<MaterialRecord>({type: MATERIAL_MESSAGE, action: 'restore', id});
export const materialClear = () => request<boolean>({type: MATERIAL_MESSAGE, action: 'clear'});
/** 设置页写入只接收 ID，结果未知时调用方须刷新而非自动重放。 */
async function workspaceWrite(message:MaterialRequest):Promise<MaterialWorkspaceWriteReceipt> {
    if (browser.extension?.inIncognitoContext === true) throw new MaterialClientError('privacy-disabled','无痕窗口不读取或保存学习材料');
    const unknown = () => new MaterialClientError('storage-error','无法确认操作是否完成，请刷新材料后检查。');
    let response:unknown;
    try {response = await browser.runtime.sendMessage(message);} catch {throw unknown();}
    if (!response || typeof response !== 'object' || Array.isArray(response)) throw unknown();
    const value = response as {success?:unknown;data?:unknown;error?:unknown};
    if (value.success === true && value.data && typeof value.data === 'object' && !Array.isArray(value.data)) {
        const receipt = value.data as Record<string,unknown>;
        if (Object.keys(receipt).length === 1 && typeof receipt.id === 'string' && receipt.id.length > 0 && receipt.id.length <= 256) return {id:receipt.id};
    }
    if (value.success === false && value.error && typeof value.error === 'object' && !Array.isArray(value.error)) {
        const error = value.error as Record<string,unknown>;
        if (typeof error.code === 'string' && ['invalid-input','not-found','privacy-disabled','stale-operation','limit-exceeded','storage-error'].includes(error.code) && typeof error.message === 'string') throw new MaterialClientError(error.code,error.message);
    }
    throw unknown();
}
export const workspaceMaterialCapture = (input: MaterialCaptureInput) => workspaceWrite({type:MATERIAL_MESSAGE,action:'workspaceCapture',input});
export const workspaceMaterialUpdate = (id:string, patch:MaterialPatch) => workspaceWrite({type:MATERIAL_MESSAGE,action:'workspaceUpdate',id,patch});
export const workspaceMaterialRemoveReference = (id:string, kind:MaterialReference['kind'], referenceId:string) => workspaceWrite({type:MATERIAL_MESSAGE,action:'workspaceRemoveReference',id,kind,referenceId});
export const workspaceMaterialArchive = (id:string) => workspaceWrite({type:MATERIAL_MESSAGE,action:'workspaceArchive',id});
export const workspaceMaterialRestore = (id:string) => workspaceWrite({type:MATERIAL_MESSAGE,action:'workspaceRestore',id});

/** 主动下载的私密本地备份包含来源、原文与笔记，不属于配置同步。 */
export const materialExport = () => request<MaterialBackup>({type: MATERIAL_MESSAGE, action: 'exportData'});
export const materialImport = (data: unknown, guard?: MaterialOperationGuard) => request<MaterialImportResult>({type: MATERIAL_MESSAGE, action: 'importData', data, guard});
