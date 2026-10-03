/**
 * @file src/services/config/googleDriveSync.ts
 * 文件职责：将 Google Drive 端口接入共用的配置云备份事务。
 * 主要内容：保持现有 Google Drive 服务和类型契约，并提供 Google 账号切换提示。
 * 模块边界：授权、网络和存储由调用方装配；事务与冲突规则由 remoteConfigSync 统一实现。
 */
import {createRemoteConfigSync, type DriveSyncPorts} from './remoteConfigSync';
export type {DriveSyncState, DriveSyncStatus, DriveSyncPreview, DriveSyncDirection, DriveSyncPorts} from './remoteConfigSync';
export function createGoogleDriveSync(ports: DriveSyncPorts) {
    return createRemoteConfigSync({...ports, accountChangedError: 'Google 账号已切换，请重新生成同步预览。'});
}
