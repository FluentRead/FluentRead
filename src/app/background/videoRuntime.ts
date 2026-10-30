/**
 * @file src/app/background/videoRuntime.ts
 * 文件职责：在应用组合根装配视频字幕和语义断句后台处理器。
 * 主要内容：保留原字幕处理器顺序与对象身份，再接入独立语义断句生命周期。
 * 模块边界：只组合 feature 工厂，不实现字幕算法、供应商协议或重复注册监听器。
 */
import {createVideoSubtitleBackgroundRuntime} from '@/src/features/video-subtitle/background/runtime';
import {createVideoSemanticRuntime} from '@/src/features/video-subtitle/background/semanticRuntime';

export function createBackgroundVideoRuntime() {
    return [...createVideoSubtitleBackgroundRuntime(), ...createVideoSemanticRuntime()];
}
