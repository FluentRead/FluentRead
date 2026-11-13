/**
 * @file src/core/config/videoCourse.ts
 * 文件职责：定义 B 站、Udemy 与 edX 各自的字幕自动开启偏好。
 * 主要内容：只接纳已知站点的布尔值；新站点默认关闭，Udemy 保留已有自动字幕行为。
 * 模块边界：纯配置规范化，不探测网页、不发请求，当前视频的手动开关由字幕运行时拥有。
 */
export const VIDEO_COURSE_PLATFORMS = ['bilibili', 'udemy', 'edx'] as const;
export type VideoCoursePlatform = typeof VIDEO_COURSE_PLATFORMS[number];
export type VideoCourseAutoStart = Record<VideoCoursePlatform, boolean>;

export function normalizeVideoCourseAutoStart(value: unknown): VideoCourseAutoStart {
    const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    return {
        bilibili: typeof source.bilibili === 'boolean' ? source.bilibili : false,
        udemy: typeof source.udemy === 'boolean' ? source.udemy : true,
        edx: typeof source.edx === 'boolean' ? source.edx : false,
    };
}
