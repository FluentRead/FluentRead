/**
 * @file src/features/vocabulary/materialBackupExportProtocol.ts
 * 文件职责：定义材料备份导出端口的公共名称、安全错误码和恢复容量统计。
 * 主要内容：限制可跨进程传递的错误类别及有界统计结构，不包含来源地址、正文或私有堆栈。
 * 模块边界：无浏览器、数据库或后台依赖；具体分帧与权限判断由客户端和后台桥接负责。
 */
export const MATERIAL_BACKUP_EXPORT_PORT_NAME = 'fluentread-material-export-v1';
export const MATERIAL_BACKUP_EXPORT_ERROR_CODES = ['storage-error','stale-operation','limit-exceeded','invalid-input'] as const;
export type MaterialBackupExportErrorCode = typeof MATERIAL_BACKUP_EXPORT_ERROR_CODES[number];
/** 仅统计材料记录的 JSON UTF-8 载荷；文件元信息和设备可用空间不计入。 */
export interface MaterialBackupExportStatistics {
    records:number;
    recordBytes:number;
    maxRecordBytes:number;
    frames:number;
}
