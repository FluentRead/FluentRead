/**
 * @file src/features/video-subtitle/content/activeModeController.ts
 * 文件职责：为命令面板与其他页面内交互入口提供统一、解耦的活跃视频字幕模式控制器注册表，使外部调用方无需了解 YouTube、X、HTML 媒体、课程或会议平台的内部状态机，即可安全查询当前活跃播放器的字幕显示模式并按用户配置切换模式。
 * 主要内容：定义 ActiveVideoSubtitleModeController 契约，维护模块级控制器注册列表，提供支持幂等注销的 registerActiveVideoSubtitleModeController 与按后注册优先原则查找当前活跃视频控制器的 getActiveVideoSubtitleModeController。
 * 模块边界：本文件只管理内存中的控制器引用队列，不读写浏览器存储、不绑定 DOM 监听、不直接操作播放器节点或派发通知；活跃性判断、模式状态落盘、课程平台局部关闭语义与提示反馈均由各视频字幕运行时在注册实例内实现。
 */
import type {VideoSubtitleShortcutMenuMode} from '@/src/core/config/videoSubtitleShortcut';

export interface ActiveVideoSubtitleModeController {
    readonly isActive: () => boolean;
    readonly getCurrentMode: () => VideoSubtitleShortcutMenuMode;
    readonly switchMode: () => VideoSubtitleShortcutMenuMode | null;
}

const controllers: ActiveVideoSubtitleModeController[] = [];

/** 注册当前页面上的视频字幕模式控制器，返回幂等注销函数。 */
export function registerActiveVideoSubtitleModeController(controller: ActiveVideoSubtitleModeController): () => void {
    controllers.push(controller);
    return () => {
        const index = controllers.lastIndexOf(controller);
        if (index >= 0) controllers.splice(index, 1);
    };
}

/** 从后往前查找当前页面首个处于活跃状态的视频字幕模式控制器。 */
export function getActiveVideoSubtitleModeController(): ActiveVideoSubtitleModeController | null {
    for (let index = controllers.length - 1; index >= 0; index -= 1) {
        const controller = controllers[index];
        if (controller.isActive()) return controller;
    }
    return null;
}
