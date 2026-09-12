/**
 * @file src/features/floating-ball/public.ts
 * 文件职责：作为悬浮球 feature 的稳定公共出口，供 content composition root 获取挂载、主动切换全文翻译和卸载三个运行时能力。
 * 主要内容：文件精确再导出 mountFloatingBall、toggleFloatingBallTranslation、unmountFloatingBall 与站点可见性判定 isFloatingBallAllowedOnPage，隐藏 Vue 暴露实例、Shadow UI 句柄和配置同步细节。
 * 模块边界：该 barrel 不产生任何副作用；页面注册方只依赖这里，组件实现留在 ui，生命周期与跨 feature 协调留在 content/runtime，避免外部直接触碰内部单例状态。
 */
export {
  isFloatingBallAllowedOnPage,
  mountFloatingBall,
  toggleFloatingBallTranslation,
  unmountFloatingBall,
} from './content/runtime';
export type {FloatingBallPresentation} from './types';
