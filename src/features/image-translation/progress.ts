/**
 * @file src/features/image-translation/progress.ts
 * 文件职责：定义图片翻译阶段通知、校验跨上下文数据，并把内部处理阶段映射为面向普通用户的稳定文案与单调平滑进度。
 * 主要内容：统一模型准备、初始化、识别、翻译、清除原文、生成译图阶段及消息类型；提供用户侧简短状态文案、首次下载延迟显露阈值与单调平滑进度换算，避免界面在短时间内频繁跳变技术术语。
 * 模块边界：纯协议与纯计算模块，不监听浏览器消息或操作 DOM；Offscreen 发布进度，后台按请求所有者转发，客户端与页面控件按需消费。
 */
export const IMAGE_PROGRESS_MESSAGE_TYPE = 'fluentReadImageProgress' as const;
export const IMAGE_LOADING_MESSAGE = '翻译中…' as const;
export const IMAGE_PREPARING_MESSAGE = '首次准备中…' as const;
export const IMAGE_QUEUED_MESSAGE = '排队中…' as const;
export const IMAGE_PREPARING_REVEAL_DELAY_MS = 450;
export type ImageTranslationStage = 'preparing' | 'initializing' | 'recognizing' | 'translating' | 'cleaning' | 'rendering';
export function isImageTranslationStage(value: unknown): value is ImageTranslationStage {
    return value === 'preparing' || value === 'initializing' || value === 'recognizing' || value === 'translating' || value === 'cleaning' || value === 'rendering';
}

/** 仅接受引擎提供的有效百分比，兼容仅有阶段的旧消息。 */
export function normalizeImageProgress(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
        ? Math.floor(value) : undefined;
}

/** 把多段内部处理阶段映射为单调递增的直观进度条百分比，避免进度条跳回或忽隐忽现。 */
export function imageLoadingProgress(
    stage?: ImageTranslationStage,
    stageProgress?: number,
    previousProgress?: number,
): number {
    const normalized = normalizeImageProgress(stageProgress);
    let target: number;
    if (!stage) target = 8;
    else if (stage === 'preparing') target = 12;
    else if (stage === 'initializing') target = 22;
    else if (stage === 'recognizing') target = normalized === undefined ? 38 : 28 + Math.round(normalized * 0.34);
    else if (stage === 'translating') target = 72;
    else if (stage === 'cleaning') target = normalized === undefined ? 82 : 76 + Math.round(normalized * 0.14);
    else target = 94;
    const previous = normalizeImageProgress(previousProgress);
    return previous === undefined ? target : Math.max(previous, target);
}
