/**
 * @file src/features/vocabulary/material/content/public.ts
 * 文件职责：单独公开学习材料的网页恢复与阅读位置生命周期。
 * 主要内容：材料原段落定位、视频恢复及监听资源的统一卸载。
 * 模块边界：由内容 composition root 主动挂载；类型和收藏客户端不导入此浏览器内容运行时。
 */
export {mountMaterialContent} from '../../materialContent';
