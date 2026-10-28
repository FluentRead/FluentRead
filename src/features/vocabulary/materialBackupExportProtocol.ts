/**
 * @file src/features/vocabulary/materialBackupExportProtocol.ts
 * 文件职责：定义材料备份导出端口的公共名称与安全错误码。
 * 主要内容：限制可跨进程传递的错误类别，不包含来源地址、正文或私有堆栈。
 * 模块边界：无浏览器、数据库或后台依赖；具体分帧与权限判断由客户端和后台桥接负责。
 */
export const MATERIAL_BACKUP_EXPORT_PORT_NAME = 'fluentread-material-export-v1';
export const MATERIAL_BACKUP_EXPORT_ERROR_CODES = ['storage-error','stale-operation','limit-exceeded','invalid-input'] as const;
export type MaterialBackupExportErrorCode = typeof MATERIAL_BACKUP_EXPORT_ERROR_CODES[number];
