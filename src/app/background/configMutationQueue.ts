/**
 * @file src/app/background/configMutationQueue.ts
 * 文件职责：持有后台唯一的配置修改队列实例，让消息保存、计数、历史/备份恢复与右键菜单等后台内部写入串行落盘。
 * 主要内容：导出 backgroundConfigMutations 单例；队列语义由 handlers/configPersistence 的 createConfigMutationCoordinator 定义。
 * 模块边界：本文件只做实例共享，不包含持久化、归一化或消息校验逻辑；调用方负责在队列内读取最新配置并调用 saveConfig。
 */
import {createConfigMutationCoordinator} from './handlers/configPersistence';

/** 后台所有配置写操作共用的单一队列，避免不同入口交叉写入导致互相覆盖。 */
export const backgroundConfigMutations = createConfigMutationCoordinator();
