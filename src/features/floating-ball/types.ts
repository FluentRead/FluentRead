/**
 * @file src/features/floating-ball/types.ts
 * 文件职责：定义悬浮球 feature 在运行时与视图之间传递的展示契约类型，让高级外观配置有唯一的结构来源。
 * 主要内容：FloatingBallPresentation 描述按钮显示方式、展开延迟、点击行为、紧凑尺寸、设置入口可见性与收起不透明度六项可配置外观。
 * 模块边界：本文件只包含类型声明，不读取配置、不包含默认值推导，也不触碰 DOM；归一化属于 core/config，装配与订阅属于 content/runtime，渲染属于 ui。
 */
import type {FloatingBallClickAction, FloatingBallToolsDisplay} from '@/src/core/config/model';

/** 悬浮球的高级外观与交互参数；由 content/runtime 依据实时配置提供给组件。 */
export interface FloatingBallPresentation {
  /** 翻译与设置按钮的显示方式：悬停展开、始终显示或完全隐藏。 */
  toolsDisplay: FloatingBallToolsDisplay;
  /** 指针停留多久（毫秒）后展开按钮；0 表示立即展开。 */
  hoverDelay: number;
  /** 点击悬浮球主体时执行的动作。 */
  clickAction: FloatingBallClickAction;
  /** 是否使用更小的悬浮球尺寸。 */
  compact: boolean;
  /** 是否显示打开设置页的入口按钮。 */
  settingsEntryVisible: boolean;
  /** 收起状态下的不透明度百分比（20-100）。 */
  collapsedOpacity: number;
}
