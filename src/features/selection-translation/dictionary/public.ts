/**
 * @file src/features/selection-translation/dictionary/public.ts
 * 文件职责：向设置 feature 提供词典字段路径的纯校验能力。
 * 主要内容：导出不执行脚本的路径解析器；不暴露网络、词库数据库或后台缓存。
 * 模块边界：设置页只消费此公开纯数据端口，查询与渲染仍归划词 feature。
 */
export {dictionaryPath} from './model';
