/**
 * @file src/features/vocabulary/materialPageProtocol.ts
 * 文件职责：定义设置页与后台之间的材料分页读取协议。
 * 主要内容：版本化端口、查询能力、进度、摘要、完成标记和受限错误码。
 * 模块边界：只导出类型和常量，不访问浏览器、仓库或个人内容。
 */
import type {MaterialSummary, MaterialSummaryQuery} from './materialSummary';
import type {MaterialDetailMetadata} from './materialDetailPage';
import type {MaterialReference} from './materialProtocol';

export const MATERIAL_PAGE_PORT_NAME = 'fluentread-material-page-v1';
export const MATERIAL_PAGE_PROTOCOL_VERSION = 1;
/** 单行超过此预算时明确失败；发送帧另有 24 KiB 限制。 */
export const MATERIAL_PAGE_MAX_LINE_BYTES = 512 * 1024;
export type MaterialPageErrorCode = 'stale-operation'|'invalid-input'|'busy'|'limit-exceeded'|'storage-error'|'not-found';
export type MaterialPageMessage =
    | {type:'progress'; processed:number; total:number}
    | {type:'header'; version:1; operation:'open'|'page'; capability?:string; revision:number; total:number; matched:number; offset:number; nextOffset:number|null}
    | {type:'detail-header'; version:1; revision:number; id:string; total:number; offset:number; nextOffset:number|null}
    | {type:'topics-header'; version:1; revision:number; total:number; matched:number; offset:number; nextOffset:number|null}
    | {type:'topic'; value:string}
    | {type:'metadata'; key:keyof MaterialDetailMetadata; value:MaterialDetailMetadata[keyof MaterialDetailMetadata]}
    | {type:'reference'; value:MaterialReference}
    | {type:'summary'; value:MaterialSummary}
    | {type:'complete'; count:number}
    | {type:'closed'}
    | {type:'error'; code:MaterialPageErrorCode};
export type MaterialPageRequest =
    | {v:1; type:'start'; operation:'open'; options:MaterialSummaryQuery}
    | {v:1; type:'start'; operation:'page'; capability:string; offset:number}
    | {v:1; type:'start'; operation:'detail'; capability:string; id:string; offset:number}
    | {v:1; type:'start'; operation:'topics'; capability:string; offset:number; search?:string}
    | {v:1; type:'start'; operation:'close'; capability:string};
