/**
 * @file src/services/config/googleDriveSyncClient.ts
 * 文件职责：将 Google Drive 设置页接入共用配置云备份客户端。
 * 主要内容：保持现有预览、确认、取消和状态接口，使用独立的 Google Drive 消息类型。
 * 模块边界：不读取配置、口令或令牌；所有网络与加密操作由后台完成。
 */
import {createCloudBackupClient} from './cloudBackupClient';
export const googleDriveSyncClient = createCloudBackupClient('googleDriveEncryptedSync');

/** 微软云盘使用独立的消息协议和事务身份，不复用 Google 的账号记录。 */
export const oneDriveSyncClient = createCloudBackupClient('oneDriveEncryptedSync');
